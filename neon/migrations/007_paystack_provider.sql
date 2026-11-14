-- Paystack merchant-provider support. This is additive and preserves all existing rows.
-- Apply after migration 006_worker_lease_ownership.sql.

alter table public.payment_transactions
  add column if not exists provider_payment_reference text;

create unique index if not exists payment_transactions_paystack_reference_idx
  on public.payment_transactions(tenant_id, provider_payment_reference)
  where provider = 'paystack' and provider_payment_reference is not null;

-- Expand provider checks without assuming the generated constraint names from
-- earlier PostgreSQL versions. Only provider-related CHECK constraints are replaced.
do $$
declare
  item record;
begin
  for item in
    select c.conrelid::regclass as table_name, c.conname
    from pg_constraint c
    where c.contype = 'c'
      and c.conrelid in (
        'public.payment_provider_configs'::regclass,
        'public.payment_transactions'::regclass,
        'public.payment_provider_events'::regclass,
        'public.payment_reconciliation_runs'::regclass,
        'public.payment_reconciliation_records'::regclass
      )
      and pg_get_constraintdef(c.oid) ilike '%provider%'
  loop
    execute format('alter table %s drop constraint %I', item.table_name, item.conname);
  end loop;
end;
$$;

alter table public.payment_provider_configs
  add constraint payment_provider_configs_provider_supported_check
  check (provider in ('daraja','pesapal','paystack','bank'));

alter table public.payment_transactions
  add constraint payment_transactions_provider_supported_check
  check (provider in ('daraja','pesapal','paystack','bank','manual'));

alter table public.payment_provider_events
  add constraint payment_provider_events_provider_supported_check
  check (provider in ('daraja','pesapal','paystack','bank'));

alter table public.payment_reconciliation_runs
  add constraint payment_reconciliation_runs_provider_supported_check
  check (provider in ('daraja','pesapal','paystack','bank','manual'));

alter table public.payment_reconciliation_records
  add constraint payment_reconciliation_records_provider_supported_check
  check (provider in ('daraja','pesapal','paystack','bank','manual'));

create index if not exists payment_transactions_paystack_pending_idx
  on public.payment_transactions(tenant_id, updated_at)
  where provider = 'paystack' and status in ('created','pending','unknown');
