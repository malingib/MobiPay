-- MobiWave Payments operational hardening.
-- Apply after 001_payment_foundation.sql. This migration is additive and safe for existing rows.

alter table public.payment_transactions
  add column if not exists provider_checkout_request_id text,
  add column if not exists provider_receipt text,
  add column if not exists provider_order_tracking_id text,
  add column if not exists provider_checkout_url text,
  add column if not exists initiation_attempts integer not null default 0 check (initiation_attempts >= 0),
  add column if not exists last_provider_error text;

create unique index if not exists payment_transactions_daraja_checkout_idx
  on public.payment_transactions(tenant_id, provider_checkout_request_id)
  where provider = 'daraja' and provider_checkout_request_id is not null;
create unique index if not exists payment_transactions_daraja_receipt_idx
  on public.payment_transactions(tenant_id, provider_receipt)
  where provider = 'daraja' and provider_receipt is not null;
create unique index if not exists payment_transactions_pesapal_tracking_idx
  on public.payment_transactions(tenant_id, provider_order_tracking_id)
  where provider = 'pesapal' and provider_order_tracking_id is not null;

alter table public.payment_provider_events
  add column if not exists processing_attempts integer not null default 0 check (processing_attempts >= 0),
  add column if not exists last_error text,
  add column if not exists processing_started_at timestamptz;

-- Store imported provider statement rows independently from the application transaction
-- so unmatched, duplicate and amount-mismatch rows remain auditable.
create table if not exists public.payment_reconciliation_runs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  provider text not null check (provider in ('daraja','pesapal','bank','manual')),
  source_name text not null check (length(trim(source_name)) between 1 and 255),
  source_sha256 text not null check (source_sha256 ~ '^[a-f0-9]{64}$'),
  status text not null default 'received' check (status in ('received','processing','completed','failed')),
  rows_total integer not null default 0 check (rows_total >= 0),
  rows_matched integer not null default 0 check (rows_matched >= 0),
  rows_unmatched integer not null default 0 check (rows_unmatched >= 0),
  rows_exception integer not null default 0 check (rows_exception >= 0),
  created_by text,
  created_at timestamptz not null default now(),
  completed_at timestamptz,
  unique (tenant_id, provider, source_sha256)
);
create table if not exists public.payment_reconciliation_records (
  id uuid primary key default gen_random_uuid(),
  run_id uuid not null references public.payment_reconciliation_runs(id) on delete restrict,
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  provider text not null check (provider in ('daraja','pesapal','bank','manual')),
  provider_reference text,
  merchant_reference text,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  occurred_at timestamptz,
  raw_record jsonb not null default '{}'::jsonb,
  reconciliation_status text not null default 'unmatched' check (reconciliation_status in ('matched','unmatched','amount_mismatch','ambiguous','duplicate')),
  transaction_id uuid references public.payment_transactions(id) on delete restrict,
  reason text,
  created_at timestamptz not null default now(),
  unique (run_id, id)
);
create index if not exists payment_reconciliation_records_tenant_status_idx
  on public.payment_reconciliation_records(tenant_id, reconciliation_status, created_at desc);
create index if not exists payment_reconciliation_records_provider_ref_idx
  on public.payment_reconciliation_records(tenant_id, provider, provider_reference);

-- Durable merchant webhook outbox: application code may enqueue events transactionally;
-- delivery workers should claim rows with FOR UPDATE SKIP LOCKED.
create table if not exists public.payment_merchant_webhook_endpoints (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  url text not null check (url ~ '^https://'),
  signing_secret_reference text not null,
  subscribed_events text[] not null default array['payment.succeeded','payment.failed']::text[],
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table if not exists public.payment_merchant_webhook_deliveries (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  endpoint_id uuid not null references public.payment_merchant_webhook_endpoints(id) on delete restrict,
  event_id text not null,
  event_type text not null,
  payload jsonb not null,
  status text not null default 'pending' check (status in ('pending','delivering','delivered','retry','dead_letter')),
  attempts integer not null default 0 check (attempts >= 0),
  next_attempt_at timestamptz not null default now(),
  last_http_status integer,
  last_error text,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique (endpoint_id, event_id)
);
create index if not exists payment_webhook_delivery_queue_idx
  on public.payment_merchant_webhook_deliveries(next_attempt_at, created_at)
  where status in ('pending','retry');

alter table public.payment_reconciliation_runs enable row level security;
alter table public.payment_reconciliation_records enable row level security;
alter table public.payment_merchant_webhook_endpoints enable row level security;
alter table public.payment_merchant_webhook_deliveries enable row level security;

drop policy if exists payment_reconciliation_run_read on public.payment_reconciliation_runs;
create policy payment_reconciliation_run_read on public.payment_reconciliation_runs
  for select using (public.is_payment_tenant_member(tenant_id));
drop policy if exists payment_reconciliation_record_read on public.payment_reconciliation_records;
create policy payment_reconciliation_record_read on public.payment_reconciliation_records
  for select using (public.is_payment_tenant_member(tenant_id));
drop policy if exists payment_merchant_webhook_endpoint_read on public.payment_merchant_webhook_endpoints;
create policy payment_merchant_webhook_endpoint_read on public.payment_merchant_webhook_endpoints
  for select using (public.is_payment_tenant_member(tenant_id));
drop policy if exists payment_merchant_webhook_delivery_read on public.payment_merchant_webhook_deliveries;
create policy payment_merchant_webhook_delivery_read on public.payment_merchant_webhook_deliveries
  for select using (public.is_payment_tenant_member(tenant_id));

-- No browser write policies are added. Server-side code owns all payment mutations.


-- Enforce a monotonic payment lifecycle. Terminal outcomes cannot silently be
-- overwritten by late callbacks; conflicting provider evidence must be reviewed.
create or replace function public.enforce_payment_status_transition()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then
    return new;
  end if;
  if not (
    (old.status = 'created' and new.status in ('pending','failed','cancelled','unknown')) or
    (old.status = 'pending' and new.status in ('succeeded','failed','cancelled','expired','unknown')) or
    (old.status = 'unknown' and new.status in ('pending','succeeded','failed','cancelled','expired')) 
  ) then
    raise exception 'invalid payment status transition: % -> %', old.status, new.status
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists payment_transaction_status_transition on public.payment_transactions;
create trigger payment_transaction_status_transition
before update of status on public.payment_transactions
for each row execute function public.enforce_payment_status_transition();


-- Transactional outbox: enqueue a merchant event in the same database transaction
-- that records the terminal payment state. Delivery is performed asynchronously.
create or replace function public.enqueue_payment_merchant_webhooks()
returns trigger language plpgsql as $$
declare
  event_name text;
  endpoint record;
  stable_event_id text;
begin
  if new.status = old.status then return new; end if;
  if new.status = 'succeeded' then
    event_name := 'payment.succeeded';
  elsif new.status = 'failed' then
    event_name := 'payment.failed';
  elsif new.status = 'cancelled' then
    event_name := 'payment.cancelled';
  else
    return new;
  end if;

  stable_event_id := new.id::text || '.' || new.status;
  for endpoint in
    select id from public.payment_merchant_webhook_endpoints
    where tenant_id = new.tenant_id and enabled = true and event_name = any(subscribed_events)
  loop
    insert into public.payment_merchant_webhook_deliveries
      (tenant_id, endpoint_id, event_id, event_type, payload)
    values (
      new.tenant_id, endpoint.id, stable_event_id, event_name,
      jsonb_build_object(
        'id', stable_event_id,
        'type', event_name,
        'createdAt', now(),
        'data', jsonb_build_object(
          'transactionId', new.id,
          'merchantReference', new.merchant_reference,
          'provider', new.provider,
          'providerTransactionId', new.provider_transaction_id,
          'providerCheckoutRequestId', new.provider_checkout_request_id,
          'providerReceipt', new.provider_receipt,
          'providerOrderTrackingId', new.provider_order_tracking_id,
          'amountMinor', new.amount_minor,
          'currency', new.currency,
          'status', new.status,
          'confirmedAt', new.confirmed_at
        )
      )
    )
    on conflict (endpoint_id, event_id) do nothing;
  end loop;
  return new;
end;
$$;

drop trigger if exists payment_transaction_webhook_outbox on public.payment_transactions;
create trigger payment_transaction_webhook_outbox
after update of status on public.payment_transactions
for each row execute function public.enqueue_payment_merchant_webhooks();
