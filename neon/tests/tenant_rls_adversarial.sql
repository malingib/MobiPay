-- Adversarial RLS test against a disposable PostgreSQL database only.
-- This creates a non-owner NOBYPASSRLS role, verifies tenant-filtered reads,
-- and verifies that tenant writes are rejected by the current SELECT-only policies.
do $role$
begin
  if not exists (select 1 from pg_roles where rolname='mobipay_test_runtime') then
    create role mobipay_test_runtime nologin nobypassrls;
  end if;
end;
$role$;
grant usage on schema public to mobipay_test_runtime;
grant select,insert,update,delete on all tables in schema public to mobipay_test_runtime;
grant execute on function public.is_payment_tenant_member(uuid) to mobipay_test_runtime;

begin;
do $fixtures$
declare
  tenant_a uuid;
  tenant_b uuid;
begin
  insert into public.payment_tenants(name,slug)
    values('RLS tenant A','rls-a-'||replace(gen_random_uuid()::text,'-','')) returning id into tenant_a;
  insert into public.payment_tenants(name,slug)
    values('RLS tenant B','rls-b-'||replace(gen_random_uuid()::text,'-','')) returning id into tenant_b;
  insert into public.payment_tenant_memberships(tenant_id,user_id,role,status)
    values(tenant_a,'rls-user-a','owner','active');
  insert into public.payment_transactions(tenant_id,provider,merchant_reference,amount_minor,currency,status)
    values(tenant_a,'manual','rls-visible-a',100,'KES','created'),
          (tenant_b,'manual','rls-hidden-b',100,'KES','created');
end;
$fixtures$;

set local role mobipay_test_runtime;
select set_config('app.user_id','rls-user-a',true);

do $assertions$
declare
  visible_rows integer;
  cross_tenant_updates integer;
  write_rejected boolean := false;
begin
  select count(*) into visible_rows from public.payment_transactions;
  if visible_rows <> 1 then
    raise exception 'FAIL: expected exactly one tenant-visible transaction, got %', visible_rows;
  end if;

  update public.payment_transactions set description='cross-tenant-tamper'
    where merchant_reference='rls-hidden-b';
  get diagnostics cross_tenant_updates = row_count;
  if cross_tenant_updates <> 0 then
    raise exception 'FAIL: cross-tenant update affected % rows', cross_tenant_updates;
  end if;

  begin
    insert into public.payment_transactions(tenant_id,provider,merchant_reference,amount_minor,currency,status)
      select id,'manual','rls-forbidden-insert',100,'KES','created'
      from public.payment_tenants where slug like 'rls-b-%';
    raise exception 'FAIL: cross-tenant insert was accepted';
  exception when insufficient_privilege then
    write_rejected := true;
  end;
  if not write_rejected then raise exception 'FAIL: cross-tenant insert was not rejected'; end if;
end;
$assertions$;
rollback;
