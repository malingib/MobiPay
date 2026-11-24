-- Reproducible application/runtime security contexts and least-privilege database role.
-- These objects existed in production but were missing from the original migration chain.

create or replace function public.current_payment_tenant_role(target_tenant uuid)
returns text
language sql stable security definer
set search_path = public, pg_temp
as $function$
  select m.role
  from public.payment_tenant_memberships m
  where m.tenant_id=target_tenant
    and m.user_id=public.current_payment_user_id()
    and m.status='active'
  limit 1
$function$;

create or replace function public.is_payment_platform_admin_context()
returns boolean language sql stable as $function$
  select coalesce(current_setting('app.platform_admin',true),'')='true'
$function$;

create or replace function public.is_payment_provider_tenant_context(target_tenant uuid)
returns boolean language sql stable as $function$
  select coalesce(current_setting('app.provider_system_tenant_id',true),'')=target_tenant::text
$function$;

create or replace function public.is_payment_provider_tenant_scope(target_tenant uuid,target_provider text)
returns boolean language sql stable as $function$
  select coalesce(current_setting('app.provider_system_tenant_id',true),'')=target_tenant::text
    and coalesce(current_setting('app.provider_system_provider',true),'')=target_provider
$function$;

create or replace function public.is_payment_provider_event_scope(target_tenant uuid,target_provider text,target_event text)
returns boolean language sql stable as $function$
  select public.is_payment_provider_tenant_scope(target_tenant,target_provider)
    and coalesce(current_setting('app.provider_system_event_id',true),'')=coalesce(target_event,'')
$function$;

create or replace function public.is_payment_worker_context()
returns boolean language sql stable as $function$
  select coalesce(current_setting('app.payment_worker',true),'')='true'
$function$;

-- Payment audit events: member/provider/worker/platform writes; members and platform admins read.
drop policy if exists payment_audit_insert on public.payment_audit_events;
create policy payment_audit_insert on public.payment_audit_events
  for insert with check (
    current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance'])
    or is_payment_provider_tenant_context(tenant_id)
    or is_payment_worker_context()
    or is_payment_platform_admin_context()
  );
drop policy if exists payment_audit_platform_read on public.payment_audit_events;
create policy payment_audit_platform_read on public.payment_audit_events
  for select using (is_payment_platform_admin_context());

-- Merchant webhook endpoints are merchant-managed; delivery rows are worker-managed.
drop policy if exists payment_webhook_endpoint_insert on public.payment_merchant_webhook_endpoints;
create policy payment_webhook_endpoint_insert on public.payment_merchant_webhook_endpoints
  for insert with check (current_payment_tenant_role(tenant_id) = any(array['owner','admin']));
drop policy if exists payment_webhook_endpoint_system_read on public.payment_merchant_webhook_endpoints;
create policy payment_webhook_endpoint_system_read on public.payment_merchant_webhook_endpoints
  for select using (is_payment_worker_context() or is_payment_platform_admin_context());
drop policy if exists payment_webhook_endpoint_update on public.payment_merchant_webhook_endpoints;
create policy payment_webhook_endpoint_update on public.payment_merchant_webhook_endpoints
  for update using (current_payment_tenant_role(tenant_id) = any(array['owner','admin']))
  with check (current_payment_tenant_role(tenant_id) = any(array['owner','admin']));

drop policy if exists payment_webhook_delivery_system_read on public.payment_merchant_webhook_deliveries;
create policy payment_webhook_delivery_system_read on public.payment_merchant_webhook_deliveries
  for select using (is_payment_worker_context() or is_payment_platform_admin_context());
drop policy if exists payment_webhook_delivery_worker_insert on public.payment_merchant_webhook_deliveries;
create policy payment_webhook_delivery_worker_insert on public.payment_merchant_webhook_deliveries
  for insert with check (is_payment_worker_context());
drop policy if exists payment_webhook_delivery_worker_update on public.payment_merchant_webhook_deliveries;
create policy payment_webhook_delivery_worker_update on public.payment_merchant_webhook_deliveries
  for update using (is_payment_worker_context()) with check (is_payment_worker_context());

-- Provider credentials can only be changed by merchant owners/admins. System reads
-- are constrained to the tenant/provider capability or worker/platform context.
drop policy if exists payment_provider_config_insert on public.payment_provider_configs;
create policy payment_provider_config_insert on public.payment_provider_configs
  for insert with check (current_payment_tenant_role(tenant_id) = any(array['owner','admin']));
drop policy if exists payment_provider_config_system_read on public.payment_provider_configs;
create policy payment_provider_config_system_read on public.payment_provider_configs
  for select using (
    is_payment_provider_tenant_scope(tenant_id,provider)
    or is_payment_worker_context()
    or is_payment_platform_admin_context()
  );
drop policy if exists payment_provider_config_update on public.payment_provider_configs;
create policy payment_provider_config_update on public.payment_provider_configs
  for update using (current_payment_tenant_role(tenant_id) = any(array['owner','admin']))
  with check (current_payment_tenant_role(tenant_id) = any(array['owner','admin']));

-- Provider callbacks and recovery workers receive narrowly scoped event access.
drop policy if exists payment_event_provider_insert on public.payment_provider_events;
create policy payment_event_provider_insert on public.payment_provider_events
  for insert with check (is_payment_provider_event_scope(tenant_id,provider,provider_event_id));
drop policy if exists payment_event_system_read on public.payment_provider_events;
create policy payment_event_system_read on public.payment_provider_events
  for select using (
    is_payment_provider_event_scope(tenant_id,provider,provider_event_id)
    or is_payment_worker_context()
    or is_payment_platform_admin_context()
  );
drop policy if exists payment_event_system_update on public.payment_provider_events;
create policy payment_event_system_update on public.payment_provider_events
  for update using (
    is_payment_provider_event_scope(tenant_id,provider,provider_event_id)
    or is_payment_worker_context()
  ) with check (
    is_payment_provider_event_scope(tenant_id,provider,provider_event_id)
    or is_payment_worker_context()
  );

-- Reconciliation is merchant-finance controlled; workers may create/update exceptions.
drop policy if exists payment_exception_insert on public.payment_reconciliation_exceptions;
create policy payment_exception_insert on public.payment_reconciliation_exceptions
  for insert with check (
    current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance'])
    or is_payment_provider_tenant_scope(tenant_id,provider)
    or is_payment_worker_context()
  );
drop policy if exists payment_exception_platform_read on public.payment_reconciliation_exceptions;
create policy payment_exception_platform_read on public.payment_reconciliation_exceptions
  for select using (is_payment_platform_admin_context());
drop policy if exists payment_exception_update on public.payment_reconciliation_exceptions;
create policy payment_exception_update on public.payment_reconciliation_exceptions
  for update using (
    current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance'])
    or is_payment_worker_context()
  ) with check (
    current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance'])
    or is_payment_worker_context()
  );

drop policy if exists payment_reconciliation_record_insert on public.payment_reconciliation_records;
create policy payment_reconciliation_record_insert on public.payment_reconciliation_records
  for insert with check (current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance']));
drop policy if exists payment_reconciliation_record_platform_read on public.payment_reconciliation_records;
create policy payment_reconciliation_record_platform_read on public.payment_reconciliation_records
  for select using (is_payment_platform_admin_context());

drop policy if exists payment_reconciliation_run_insert on public.payment_reconciliation_runs;
create policy payment_reconciliation_run_insert on public.payment_reconciliation_runs
  for insert with check (current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance']));
drop policy if exists payment_reconciliation_run_platform_read on public.payment_reconciliation_runs;
create policy payment_reconciliation_run_platform_read on public.payment_reconciliation_runs
  for select using (is_payment_platform_admin_context());
drop policy if exists payment_reconciliation_run_update on public.payment_reconciliation_runs;
create policy payment_reconciliation_run_update on public.payment_reconciliation_runs
  for update using (current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance']))
  with check (current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance']));

-- Platform administration is separately capability-gated.
drop policy if exists payment_tenant_platform_read on public.payment_tenants;
create policy payment_tenant_platform_read on public.payment_tenants
  for select using (is_payment_platform_admin_context());
drop policy if exists payment_tenant_platform_update on public.payment_tenants;
create policy payment_tenant_platform_update on public.payment_tenants
  for update using (is_payment_platform_admin_context())
  with check (is_payment_platform_admin_context());
drop policy if exists payment_membership_platform_read on public.payment_tenant_memberships;
create policy payment_membership_platform_read on public.payment_tenant_memberships
  for select using (is_payment_platform_admin_context());

-- Transaction visibility includes the one-time public checkout capability. Provider
-- and worker reads remain limited to the exact transaction/event scope.
drop policy if exists payment_transaction_read on public.payment_transactions;
create policy payment_transaction_read on public.payment_transactions
  for select using (
    is_payment_tenant_member(tenant_id)
    or (
      public_checkout_token_hash is not null
      and public_checkout_token_hash = nullif(current_setting('app.public_checkout_token_hash',true),'')
    )
  );
drop policy if exists payment_transaction_insert on public.payment_transactions;
create policy payment_transaction_insert on public.payment_transactions
  for insert with check (current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance']));
drop policy if exists payment_transaction_system_read on public.payment_transactions;
create policy payment_transaction_system_read on public.payment_transactions
  for select using (
    is_payment_provider_event_scope(
      tenant_id,provider,
      coalesce(provider_checkout_request_id,provider_order_tracking_id,provider_payment_reference)
    )
    or is_payment_worker_context()
    or is_payment_platform_admin_context()
  );
drop policy if exists payment_transaction_update on public.payment_transactions;
create policy payment_transaction_update on public.payment_transactions
  for update using (
    current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance'])
    or is_payment_provider_event_scope(
      tenant_id,provider,
      coalesce(provider_checkout_request_id,provider_order_tracking_id,provider_payment_reference)
    )
    or is_payment_worker_context()
  ) with check (
    current_payment_tenant_role(tenant_id) = any(array['owner','admin','finance'])
    or is_payment_provider_event_scope(
      tenant_id,provider,
      coalesce(provider_checkout_request_id,provider_order_tracking_id,provider_payment_reference)
    )
    or is_payment_worker_context()
  );

-- A dedicated NOLOGIN role is assumed by API transactions. It never owns tables,
-- has no DELETE privilege, and cannot bypass row-level security.
do $role$
declare
  runtime_role record;
begin
  select rolsuper,rolbypassrls,rolcanlogin,rolcreatedb,rolcreaterole,rolinherit
    into runtime_role
    from pg_roles where rolname='mobipay_runtime';

  if not found then
    create role mobipay_runtime nologin nosuperuser nocreatedb nocreaterole noinherit nobypassrls;
  elsif runtime_role.rolsuper
     or runtime_role.rolbypassrls
     or runtime_role.rolcanlogin
     or runtime_role.rolcreatedb
     or runtime_role.rolcreaterole
     or runtime_role.rolinherit then
    raise exception 'Existing mobipay_runtime role is not least-privilege; remediate role attributes with a database administrator';
  end if;
end;
$role$;

grant usage on schema public to mobipay_runtime;

do $grants$
declare
  item record;
begin
  for item in
    select c.relname
    from pg_class c
    join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public'
      and c.relkind in ('r','p')
      and (c.relname like 'payment\_%' escape '\' or c.relname='platform_admin_audit_logs')
  loop
    execute format('grant select,insert,update on table public.%I to mobipay_runtime',item.relname);
  end loop;
end;
$grants$;

do $membership$
begin
  if not pg_has_role(current_user,'mobipay_runtime','member') then
    execute format('grant mobipay_runtime to %I with admin option',current_user);
  end if;
end;
$membership$;
alter default privileges in schema public
  grant select,insert,update on tables to mobipay_runtime;
