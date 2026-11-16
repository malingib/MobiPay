do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_transactions' and column_name='provider_payment_reference'
  ) then raise exception 'Paystack provider reference column is missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_transactions' and column_name='public_checkout_token_hash'
  ) then raise exception 'Public checkout token hash column is missing'; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.payment_transactions'::regclass
      and conname='payment_transactions_provider_supported_check'
  ) then raise exception 'Paystack transaction provider constraint is missing'; end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid='public.payment_provider_events'::regclass
      and conname='payment_provider_events_provider_supported_check'
  ) then raise exception 'Paystack provider event constraint is missing'; end if;
  if not exists (
    select 1 from pg_policies
    where schemaname='public' and tablename='payment_transactions'
      and policyname='payment_transaction_read'
      and qual like '%app.public_checkout_token_hash%'
  ) then raise exception 'Public checkout token RLS policy is missing'; end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and indexname='payment_transactions_paystack_reference_idx'
  ) then raise exception 'Paystack reference uniqueness index is missing'; end if;
  if not exists (
    select 1 from information_schema.columns
    where table_schema='public' and table_name='payment_transactions' and column_name='provider_verification_attempts'
  ) then raise exception 'Paystack verification attempt counter is missing'; end if;
  if not exists (
    select 1 from pg_indexes
    where schemaname='public' and indexname='payment_transactions_paystack_verification_queue_idx'
  ) then raise exception 'Paystack recovery queue index is missing'; end if;
end;
$$;

do $race$
declare
  tenant_id uuid;
  transaction_id uuid;
  affected integer;
begin
  insert into public.payment_tenants(name,slug)
    values('Paystack lease race','paystack-race-'||replace(gen_random_uuid()::text,'-',''))
    returning id into tenant_id;
  insert into public.payment_transactions(tenant_id,provider,merchant_reference,amount_minor,currency,status,provider_payment_reference,provider_verification_lease_token)
    values(tenant_id,'paystack','paystack-lease-race',1000,'KES','pending','mp-lease-race','stale-lease')
    returning id into transaction_id;
  update public.payment_transactions
    set status='succeeded',provider_status='success'
    where id=transaction_id;
  update public.payment_transactions
    set status='pending',provider_status='pending'
    where id=transaction_id
      and provider_verification_lease_token='stale-lease'
      and status in ('pending','unknown');
  get diagnostics affected = row_count;
  if affected<>0 then raise exception 'Stale Paystack recovery lease overwrote a terminal transaction'; end if;
end;
$race$;
