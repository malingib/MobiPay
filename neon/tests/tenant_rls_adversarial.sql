-- Adversarial RLS test against disposable PostgreSQL only.
-- The application role must see and mutate its own tenant, while cross-tenant
-- reads/writes remain blocked even though the role has table-level DML grants.
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
  perform set_config('test.tenant_a',tenant_a::text,true);
  perform set_config('test.tenant_b',tenant_b::text,true);
end;
$fixtures$;

set local role mobipay_runtime;
select set_config('app.user_id','rls-user-a',true);

do $assertions$
declare
  visible_rows integer;
  cross_tenant_updates integer;
  own_tenant_updates integer;
  write_rejected boolean := false;
  runtime_bypass boolean;
begin
  select (rolsuper or rolbypassrls) into runtime_bypass
    from pg_roles where rolname=current_user;
  if runtime_bypass then raise exception 'FAIL: runtime role bypasses RLS'; end if;

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
      values(current_setting('test.tenant_b')::uuid,'manual','rls-forbidden-insert',100,'KES','created');
    raise exception 'FAIL: cross-tenant insert was accepted';
  exception when insufficient_privilege then
    write_rejected := true;
  end;
  if not write_rejected then raise exception 'FAIL: cross-tenant insert was not rejected'; end if;

  insert into public.payment_transactions(tenant_id,provider,merchant_reference,amount_minor,currency,status)
    values(current_setting('test.tenant_a')::uuid,'manual','rls-allowed-insert',100,'KES','created');

  update public.payment_transactions set description='same-tenant-update'
    where merchant_reference='rls-visible-a';
  get diagnostics own_tenant_updates = row_count;
  if own_tenant_updates <> 1 then
    raise exception 'FAIL: same-tenant update did not succeed';
  end if;

  select count(*) into visible_rows from public.payment_transactions;
  if visible_rows <> 2 then
    raise exception 'FAIL: expected two tenant-visible transactions after own insert, got %', visible_rows;
  end if;
end;
$assertions$;

rollback;
