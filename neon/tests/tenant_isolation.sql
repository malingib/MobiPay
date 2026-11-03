-- Run against a disposable MobiPay database after migrations 001-005.
-- The transaction rolls back all fixtures. A successful run prints no errors.
begin;

do $test$
declare
  tenant_a uuid;
  tenant_b uuid;
  run_a uuid;
  txn_a uuid;
begin
  insert into public.payment_tenants(name, slug)
  values ('Isolation test A', 'isolation-test-a-' || replace(gen_random_uuid()::text, '-', ''))
  returning id into tenant_a;

  insert into public.payment_tenants(name, slug)
  values ('Isolation test B', 'isolation-test-b-' || replace(gen_random_uuid()::text, '-', ''))
  returning id into tenant_b;

  insert into public.payment_reconciliation_runs
    (tenant_id, provider, source_name, source_sha256, rows_total)
  values (tenant_a, 'manual', 'isolation-test.csv', repeat('a', 64), 0)
  returning id into run_a;

  insert into public.payment_transactions
    (tenant_id, provider, merchant_reference, amount_minor, currency, status)
  values (tenant_a, 'manual', 'isolation-test-a', 100, 'KES', 'created')
  returning id into txn_a;

  begin
    insert into public.payment_reconciliation_records
      (run_id, tenant_id, provider, amount_minor, currency, reconciliation_status)
    values (run_a, tenant_b, 'manual', 100, 'KES', 'unmatched');
    raise exception 'FAIL: cross-tenant reconciliation run association was accepted';
  exception when foreign_key_violation then
    null; -- Expected: tenant B cannot attach a record to tenant A's run.
  end;

  begin
    insert into public.payment_reconciliation_exceptions
      (tenant_id, transaction_id, provider, exception_type)
    values (tenant_b, txn_a, 'manual', 'other');
    raise exception 'FAIL: cross-tenant transaction association was accepted';
  exception when foreign_key_violation then
    null; -- Expected: tenant B cannot attach an exception to tenant A's transaction.
  end;
end;
$test$;

rollback;
