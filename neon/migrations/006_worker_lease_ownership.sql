-- Durable worker ownership. A stale worker cannot complete work after a
-- later worker has reclaimed the same row. This migration is additive only.
alter table public.payment_provider_events
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz;

alter table public.payment_merchant_webhook_deliveries
  add column if not exists claim_token uuid,
  add column if not exists lease_expires_at timestamptz;

create index if not exists payment_provider_events_lease_queue_idx
  on public.payment_provider_events(retry_at, received_at)
  where processing_status in ('received','retry');

create index if not exists payment_webhook_deliveries_lease_queue_idx
  on public.payment_merchant_webhook_deliveries(next_attempt_at, created_at)
  where status in ('pending','retry');
