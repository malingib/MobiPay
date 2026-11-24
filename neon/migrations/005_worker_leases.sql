-- MobiWave Payments worker leasing hardening.
-- Apply after 004_platform_admin_audit.sql. Adds durable lease ownership
-- required by provider callback recovery and merchant webhook delivery workers.

alter table public.payment_provider_events
  add column if not exists claim_token text,
  add column if not exists lease_expires_at timestamptz;

alter table public.payment_merchant_webhook_deliveries
  add column if not exists claim_token text,
  add column if not exists lease_expires_at timestamptz;

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname='payment_provider_events_lease_pair_check'
      and conrelid='public.payment_provider_events'::regclass
  ) then
    alter table public.payment_provider_events
      add constraint payment_provider_events_lease_pair_check
      check ((claim_token is null) = (lease_expires_at is null)) not valid;
  end if;

  if not exists (
    select 1 from pg_constraint
    where conname='payment_webhook_deliveries_lease_pair_check'
      and conrelid='public.payment_merchant_webhook_deliveries'::regclass
  ) then
    alter table public.payment_merchant_webhook_deliveries
      add constraint payment_webhook_deliveries_lease_pair_check
      check ((claim_token is null) = (lease_expires_at is null)) not valid;
  end if;
end;
$constraints$;

alter table public.payment_provider_events
  validate constraint payment_provider_events_lease_pair_check;
alter table public.payment_merchant_webhook_deliveries
  validate constraint payment_webhook_deliveries_lease_pair_check;

create index if not exists payment_provider_events_recovery_queue_idx
  on public.payment_provider_events(retry_at, received_at)
  where processing_status in ('received','retry');

create index if not exists payment_provider_events_expired_lease_idx
  on public.payment_provider_events(lease_expires_at)
  where claim_token is not null;

create index if not exists payment_webhook_deliveries_expired_lease_idx
  on public.payment_merchant_webhook_deliveries(lease_expires_at, next_attempt_at)
  where status='delivering';
