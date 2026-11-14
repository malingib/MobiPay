-- Dedicated non-login application role and server-context RLS policies.
-- The session login remains the Neon connection role; every application transaction
-- switches to this NOBYPASSRLS role with SET LOCAL ROLE before touching payment data.

do $role$
begin
  if not exists (select 1 from pg_roles where rolname='mobipay_runtime') then
    create role mobipay_runtime
      nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  else
    alter role mobipay_runtime
      nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  end if;
  execute format('grant mobipay_runtime to %I', session_user);
end;
$role$;

alter role mobipay_runtime set row_security = on;
grant usage on schema public to mobipay_runtime;
grant select, insert, update on
  public.payment_tenants,
  public.payment_tenant_memberships,
  public.payment_provider_configs,
  public.payment_transactions,
  public.payment_provider_events,
  public.payment_reconciliation_exceptions,
  public.payment_audit_events,
  public.payment_reconciliation_runs,
  public.payment_reconciliation_records,
  public.payment_merchant_webhook_endpoints,
  public.payment_merchant_webhook_deliveries,
  public.platform_admin_audit_logs
to mobipay_runtime;

create or replace function public.current_payment_tenant_role(target_tenant uuid)
returns text language sql stable security definer set search_path = public, pg_temp as $$
  select m.role
  from public.payment_tenant_memberships m
  where m.tenant_id=target_tenant
    and m.user_id=public.current_payment_user_id()
    and m.status='active'
  limit 1
$$;

create or replace function public.is_payment_provider_tenant_scope(target_tenant uuid, target_provider text)
returns boolean language sql stable as $$
  select coalesce(current_setting('app.provider_system_tenant_id',true),'')=target_tenant::text
    and coalesce(current_setting('app.provider_system_provider',true),'')=target_provider
$$;

create or replace function public.is_payment_provider_tenant_context(target_tenant uuid)
returns boolean language sql stable as $func$
  select coalesce(current_setting('app.provider_system_tenant_id',true),'')=target_tenant::text
$func$;

create or replace function public.is_payment_provider_event_scope(target_tenant uuid, target_provider text, target_event text)
returns boolean language sql stable as $$
  select public.is_payment_provider_tenant_scope(target_tenant,target_provider)
    and coalesce(current_setting('app.provider_system_event_id',true),'')=coalesce(target_event,'')
$$;

create or replace function public.is_payment_worker_context()
returns boolean language sql stable as $$
  select coalesce(current_setting('app.payment_worker',true),'')='true'
$$;

create or replace function public.is_payment_platform_admin_context()
returns boolean language sql stable as $$
  select coalesce(current_setting('app.platform_admin',true),'')='true'
$$;

create or replace function public.is_payment_tenant_bootstrap_context()
returns boolean language sql stable as $$
  select coalesce(current_setting('app.tenant_bootstrap',true),'')='true'
$$;

grant execute on function public.current_payment_tenant_role(uuid) to mobipay_runtime;
grant execute on function public.is_payment_provider_tenant_scope(uuid,text) to mobipay_runtime;
grant execute on function public.is_payment_provider_event_scope(uuid,text,text) to mobipay_runtime;
grant execute on function public.is_payment_provider_tenant_context(uuid) to mobipay_runtime;
grant execute on function public.is_payment_worker_context() to mobipay_runtime;
grant execute on function public.is_payment_platform_admin_context() to mobipay_runtime;
grant execute on function public.is_payment_tenant_bootstrap_context() to mobipay_runtime;
grant execute on function public.current_payment_user_id() to mobipay_runtime;
grant execute on function public.is_payment_tenant_member(uuid) to mobipay_runtime;

-- Tenant creation is the only merchant path allowed to create an owner membership.
drop policy if exists payment_tenant_bootstrap_insert on public.payment_tenants;
create policy payment_tenant_bootstrap_insert on public.payment_tenants
  for insert with check (
    public.current_payment_user_id() is not null
    and public.is_payment_tenant_bootstrap_context()
  );
drop policy if exists payment_tenant_platform_read on public.payment_tenants;
create policy payment_tenant_platform_read on public.payment_tenants
  for select using (public.is_payment_platform_admin_context());
drop policy if exists payment_tenant_platform_update on public.payment_tenants;
create policy payment_tenant_platform_update on public.payment_tenants
  for update using (public.is_payment_platform_admin_context())
  with check (public.is_payment_platform_admin_context());

drop policy if exists payment_membership_platform_read on public.payment_tenant_memberships;
create policy payment_membership_platform_read on public.payment_tenant_memberships
  for select using (public.is_payment_platform_admin_context());
drop policy if exists payment_membership_bootstrap_insert on public.payment_tenant_memberships;
create policy payment_membership_bootstrap_insert on public.payment_tenant_memberships
  for insert with check (
    public.is_payment_tenant_bootstrap_context()
    and user_id=public.current_payment_user_id()
    and role='owner'
    and status='active'
  );

-- Provider configuration: merchant owners/admins manage credentials; callbacks and
-- workers can read only the configuration required by their scoped execution path.
drop policy if exists payment_provider_config_system_read on public.payment_provider_configs;
create policy payment_provider_config_system_read on public.payment_provider_configs
  for select using (
    public.is_payment_provider_tenant_scope(tenant_id,provider)
    or public.is_payment_worker_context()
    or public.is_payment_platform_admin_context()
  );
drop policy if exists payment_provider_config_insert on public.payment_provider_configs;
create policy payment_provider_config_insert on public.payment_provider_configs
  for insert with check (public.current_payment_tenant_role(tenant_id) in ('owner','admin'));
drop policy if exists payment_provider_config_update on public.payment_provider_configs;
create policy payment_provider_config_update on public.payment_provider_configs
  for update using (public.current_payment_tenant_role(tenant_id) in ('owner','admin'))
  with check (public.current_payment_tenant_role(tenant_id) in ('owner','admin'));

-- Transaction rows are writable by merchant finance roles, by a provider callback
-- only when its event correlation matches the row, or by the leased worker.
drop policy if exists payment_transaction_system_read on public.payment_transactions;
create policy payment_transaction_system_read on public.payment_transactions
  for select using (
    public.is_payment_provider_event_scope(
      tenant_id,provider,
      coalesce(provider_checkout_request_id,provider_order_tracking_id,provider_payment_reference)
    )
    or public.is_payment_worker_context()
    or public.is_payment_platform_admin_context()
  );
drop policy if exists payment_transaction_insert on public.payment_transactions;
create policy payment_transaction_insert on public.payment_transactions
  for insert with check (public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance'));
drop policy if exists payment_transaction_update on public.payment_transactions;
create policy payment_transaction_update on public.payment_transactions
  for update using (
    public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance')
    or public.is_payment_provider_event_scope(
      tenant_id,provider,
      coalesce(provider_checkout_request_id,provider_order_tracking_id,provider_payment_reference)
    )
    or public.is_payment_worker_context()
  )
  with check (
    public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance')
    or public.is_payment_provider_event_scope(
      tenant_id,provider,
      coalesce(provider_checkout_request_id,provider_order_tracking_id,provider_payment_reference)
    )
    or public.is_payment_worker_context()
  );

-- Provider event intake is restricted to the exact provider/tenant/event tuple.
drop policy if exists payment_event_system_read on public.payment_provider_events;
create policy payment_event_system_read on public.payment_provider_events
  for select using (
    public.is_payment_provider_event_scope(tenant_id,provider,provider_event_id)
    or public.is_payment_worker_context()
    or public.is_payment_platform_admin_context()
  );
drop policy if exists payment_event_provider_insert on public.payment_provider_events;
create policy payment_event_provider_insert on public.payment_provider_events
  for insert with check (public.is_payment_provider_event_scope(tenant_id,provider,provider_event_id));
drop policy if exists payment_event_system_update on public.payment_provider_events;
create policy payment_event_system_update on public.payment_provider_events
  for update using (
    public.is_payment_provider_event_scope(tenant_id,provider,provider_event_id)
    or public.is_payment_worker_context()
  )
  with check (
    public.is_payment_provider_event_scope(tenant_id,provider,provider_event_id)
    or public.is_payment_worker_context()
  );

-- Reconciliation exceptions may be created by finance users, verified provider
-- callbacks or workers. Resolution remains tenant-role scoped.
drop policy if exists payment_exception_platform_read on public.payment_reconciliation_exceptions;
create policy payment_exception_platform_read on public.payment_reconciliation_exceptions
  for select using (public.is_payment_platform_admin_context());
drop policy if exists payment_exception_insert on public.payment_reconciliation_exceptions;
create policy payment_exception_insert on public.payment_reconciliation_exceptions
  for insert with check (
    public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance')
    or public.is_payment_provider_tenant_scope(tenant_id,provider)
    or public.is_payment_worker_context()
  );
drop policy if exists payment_exception_update on public.payment_reconciliation_exceptions;
create policy payment_exception_update on public.payment_reconciliation_exceptions
  for update using (
    public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance')
    or public.is_payment_worker_context()
  )
  with check (
    public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance')
    or public.is_payment_worker_context()
  );

-- Append-only tenant audit events are generated by finance actions, provider callbacks,
-- workers and platform administrators.
drop policy if exists payment_audit_platform_read on public.payment_audit_events;
create policy payment_audit_platform_read on public.payment_audit_events
  for select using (public.is_payment_platform_admin_context());
drop policy if exists payment_audit_insert on public.payment_audit_events;
create policy payment_audit_insert on public.payment_audit_events
  for insert with check (
    public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance')
    or public.is_payment_provider_tenant_context(tenant_id)
    or public.is_payment_worker_context()
    or public.is_payment_platform_admin_context()
  );

-- Merchant reconciliation import and exception review.
drop policy if exists payment_reconciliation_run_platform_read on public.payment_reconciliation_runs;
create policy payment_reconciliation_run_platform_read on public.payment_reconciliation_runs
  for select using (public.is_payment_platform_admin_context());
drop policy if exists payment_reconciliation_run_insert on public.payment_reconciliation_runs;
create policy payment_reconciliation_run_insert on public.payment_reconciliation_runs
  for insert with check (public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance'));
drop policy if exists payment_reconciliation_run_update on public.payment_reconciliation_runs;
create policy payment_reconciliation_run_update on public.payment_reconciliation_runs
  for update using (public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance'))
  with check (public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance'));

drop policy if exists payment_reconciliation_record_platform_read on public.payment_reconciliation_records;
create policy payment_reconciliation_record_platform_read on public.payment_reconciliation_records
  for select using (public.is_payment_platform_admin_context());
drop policy if exists payment_reconciliation_record_insert on public.payment_reconciliation_records;
create policy payment_reconciliation_record_insert on public.payment_reconciliation_records
  for insert with check (public.current_payment_tenant_role(tenant_id) in ('owner','admin','finance'));

-- Webhook endpoints are managed by merchant owners/admins. Only the worker may
-- claim and mutate delivery rows; the SQL outbox trigger remains SECURITY DEFINER.
drop policy if exists payment_webhook_endpoint_system_read on public.payment_merchant_webhook_endpoints;
create policy payment_webhook_endpoint_system_read on public.payment_merchant_webhook_endpoints
  for select using (public.is_payment_worker_context() or public.is_payment_platform_admin_context());
drop policy if exists payment_webhook_endpoint_insert on public.payment_merchant_webhook_endpoints;
create policy payment_webhook_endpoint_insert on public.payment_merchant_webhook_endpoints
  for insert with check (public.current_payment_tenant_role(tenant_id) in ('owner','admin'));
drop policy if exists payment_webhook_endpoint_update on public.payment_merchant_webhook_endpoints;
create policy payment_webhook_endpoint_update on public.payment_merchant_webhook_endpoints
  for update using (public.current_payment_tenant_role(tenant_id) in ('owner','admin'))
  with check (public.current_payment_tenant_role(tenant_id) in ('owner','admin'));

drop policy if exists payment_webhook_delivery_system_read on public.payment_merchant_webhook_deliveries;
create policy payment_webhook_delivery_system_read on public.payment_merchant_webhook_deliveries
  for select using (public.is_payment_worker_context() or public.is_payment_platform_admin_context());
drop policy if exists payment_webhook_delivery_worker_insert on public.payment_merchant_webhook_deliveries;
create policy payment_webhook_delivery_worker_insert on public.payment_merchant_webhook_deliveries
  for insert with check (public.is_payment_worker_context());
drop policy if exists payment_webhook_delivery_worker_update on public.payment_merchant_webhook_deliveries;
create policy payment_webhook_delivery_worker_update on public.payment_merchant_webhook_deliveries
  for update using (public.is_payment_worker_context())
  with check (public.is_payment_worker_context());

-- The platform audit log is isolated from merchant audit events and append-only.
alter table public.platform_admin_audit_logs enable row level security;
drop policy if exists platform_admin_audit_read on public.platform_admin_audit_logs;
create policy platform_admin_audit_read on public.platform_admin_audit_logs
  for select using (public.is_payment_platform_admin_context());
drop policy if exists platform_admin_audit_insert on public.platform_admin_audit_logs;
create policy platform_admin_audit_insert on public.platform_admin_audit_logs
  for insert with check (public.is_payment_platform_admin_context());

-- Make sure the runtime role itself can never inherit a bypass flag or own payment tables.
do $verify_role$
declare
  runtime_oid oid;
  owner_count integer;
begin
  select oid into runtime_oid from pg_roles where rolname='mobipay_runtime';
  if runtime_oid is null then raise exception 'mobipay_runtime role was not created'; end if;
  if exists (select 1 from pg_roles where oid=runtime_oid and (rolsuper or rolbypassrls or rolcanlogin)) then
    raise exception 'mobipay_runtime must be NOLOGIN, NOSUPERUSER and NOBYPASSRLS';
  end if;
  select count(*) into owner_count
  from pg_class c join pg_namespace n on n.oid=c.relnamespace
  where n.nspname='public' and c.relkind in ('r','p')
    and c.relname like 'payment\_%' escape '\' and c.relowner=runtime_oid;
  if owner_count<>0 then raise exception 'mobipay_runtime must not own payment tables'; end if;
end;
$verify_role$;
