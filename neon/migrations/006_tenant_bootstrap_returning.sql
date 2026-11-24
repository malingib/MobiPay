-- MobiWave Payments tenant bootstrap RETURNING support.
-- The API inserts a tenant with RETURNING before inserting its owner membership.
-- PostgreSQL applies SELECT RLS to INSERT ... RETURNING, so the creator needs
-- a narrowly scoped read policy while the server-side bootstrap flag is active.

drop policy if exists payment_tenant_bootstrap_read on public.payment_tenants;
create policy payment_tenant_bootstrap_read
  on public.payment_tenants
  for select
  using (
    current_payment_user_id() is not null
    and is_payment_tenant_bootstrap_context()
  );
