-- MobiWave Payments tenant bootstrap security.
-- The API inserts a tenant with RETURNING before inserting its owner membership.
-- PostgreSQL applies SELECT RLS to INSERT ... RETURNING, so the creator needs
-- a narrowly scoped read policy while the server-only bootstrap flag is active.

create or replace function public.is_payment_tenant_bootstrap_context()
returns boolean language sql stable as $function$
  select coalesce(current_setting('app.tenant_bootstrap',true),'')='true'
$function$;

drop policy if exists payment_tenant_bootstrap_insert on public.payment_tenants;
create policy payment_tenant_bootstrap_insert
  on public.payment_tenants
  for insert
  with check (
    current_payment_user_id() is not null
    and is_payment_tenant_bootstrap_context()
  );

drop policy if exists payment_membership_bootstrap_insert on public.payment_tenant_memberships;
create policy payment_membership_bootstrap_insert
  on public.payment_tenant_memberships
  for insert
  with check (
    is_payment_tenant_bootstrap_context()
    and user_id = current_payment_user_id()
    and role = 'owner'
    and status = 'active'
  );

drop policy if exists payment_tenant_bootstrap_read on public.payment_tenants;
create policy payment_tenant_bootstrap_read
  on public.payment_tenants
  for select
  using (
    current_payment_user_id() is not null
    and is_payment_tenant_bootstrap_context()
  );
