-- Persist payer email as part of the idempotent provider checkout request.
-- Pesapal and Paystack both accept email; it must be compared on replay.
alter table public.payment_transactions
  add column if not exists payer_email text;

create index if not exists payment_transactions_tenant_payer_email_idx
  on public.payment_transactions(tenant_id, payer_email)
  where payer_email is not null;
