-- Durable Paystack status polling for transactions whose webhook is delayed or lost.
alter table public.payment_transactions
  add column if not exists provider_verification_attempts integer not null default 0
    check (provider_verification_attempts >= 0),
  add column if not exists provider_verification_next_at timestamptz not null default now(),
  add column if not exists provider_verification_lease_token text,
  add column if not exists provider_verification_lease_expires_at timestamptz,
  add column if not exists provider_verification_last_error text;

create index if not exists payment_transactions_paystack_verification_queue_idx
  on public.payment_transactions(provider_verification_next_at, created_at)
  where provider='paystack'
    and status in ('pending','unknown')
    and provider_status in ('checkout_created','checkout_result_unknown','pending','verification_retry');
