-- Paystack hosted checkout and asynchronous provider verification.
-- Replaces the initial provider allowlists with the supported production set.

alter table public.payment_transactions
  add column if not exists provider_payment_reference text,
  add column if not exists public_checkout_token_hash text,
  add column if not exists public_checkout_expires_at timestamptz,
  add column if not exists provider_verification_attempts integer not null default 0,
  add column if not exists provider_verification_next_at timestamptz not null default now(),
  add column if not exists provider_verification_lease_token text,
  add column if not exists provider_verification_lease_expires_at timestamptz,
  add column if not exists provider_verification_last_error text;

alter table public.payment_transactions
  drop constraint if exists payment_transactions_provider_check,
  drop constraint if exists payment_transactions_provider_supported_check;
alter table public.payment_transactions
  add constraint payment_transactions_provider_supported_check
  check (provider in ('daraja','pesapal','paystack','bank','manual'));

alter table public.payment_transactions
  add constraint payment_transactions_provider_verification_attempts_check
  check (provider_verification_attempts >= 0);

alter table public.payment_transactions
  add constraint payment_transactions_public_checkout_token_hash_check
  check (public_checkout_token_hash is null or public_checkout_token_hash ~ '^[a-f0-9]{64}$');

create unique index if not exists payment_transactions_paystack_reference_idx
  on public.payment_transactions(tenant_id,provider_payment_reference)
  where provider='paystack' and provider_payment_reference is not null;

create index if not exists payment_transactions_public_checkout_token_idx
  on public.payment_transactions(tenant_id,public_checkout_token_hash)
  where public_checkout_token_hash is not null;

create index if not exists payment_transactions_paystack_pending_idx
  on public.payment_transactions(tenant_id,updated_at)
  where provider='paystack' and status in ('created','pending','unknown');

create index if not exists payment_transactions_paystack_verification_queue_idx
  on public.payment_transactions(provider_verification_next_at,created_at)
  where provider='paystack'
    and status in ('pending','unknown')
    and provider_status in ('checkout_created','checkout_result_unknown','pending','verification_retry');

alter table public.payment_provider_events
  drop constraint if exists payment_provider_events_provider_check,
  drop constraint if exists payment_provider_events_provider_supported_check;
alter table public.payment_provider_events
  add constraint payment_provider_events_provider_supported_check
  check (provider in ('daraja','pesapal','paystack','bank'));
