-- Merchant-owned provider credentials and tenant security hardening.
-- Apply after 002_payment_safety_and_operations.sql.
-- Credentials are encrypted by the API with AES-256-GCM before reaching this table.
alter table public.payment_provider_configs
  add column if not exists encrypted_credentials text,
  add column if not exists credential_key_version integer not null default 1 check (credential_key_version > 0),
  add column if not exists connection_status text not null default 'not_configured'
    check (connection_status in ('not_configured','configured','verified','error','disabled')),
  add column if not exists last_tested_at timestamptz,
  add column if not exists last_error_code text,
  add column if not exists created_by text;

-- The first release allows one active credential set per provider per merchant.
-- Keep the existing historical table structure but make "primary" a stable account reference.
create unique index if not exists payment_provider_configs_tenant_provider_primary_idx
  on public.payment_provider_configs(tenant_id, provider)
  where account_reference = 'primary';

create index if not exists payment_provider_configs_tenant_status_idx
  on public.payment_provider_configs(tenant_id, connection_status);

-- Restrict provider configuration reads to active members. No browser write policy is added.
drop policy if exists payment_provider_config_read on public.payment_provider_configs;
create policy payment_provider_config_read on public.payment_provider_configs
  for select using (public.is_payment_tenant_member(tenant_id));

-- Reject blank or malformed encrypted payloads at the database boundary.
alter table public.payment_provider_configs
  add constraint payment_provider_config_ciphertext_format
  check (encrypted_credentials is null or encrypted_credentials ~ '^v1:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+:[A-Za-z0-9_-]+$');


-- Database-level tenant binding: a transaction or webhook endpoint from one tenant
-- cannot be attached to another tenant's reconciliation or delivery records.
create unique index if not exists payment_transactions_tenant_id_id_idx
  on public.payment_transactions(tenant_id, id);
create unique index if not exists payment_webhook_endpoints_tenant_id_id_idx
  on public.payment_merchant_webhook_endpoints(tenant_id, id);

do $constraints$
begin
  if not exists (select 1 from pg_constraint where conname='payment_exceptions_tenant_transaction_fk') then
    alter table public.payment_reconciliation_exceptions
      add constraint payment_exceptions_tenant_transaction_fk
      foreign key (tenant_id, transaction_id)
      references public.payment_transactions(tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname='payment_reconciliation_records_tenant_transaction_fk') then
    alter table public.payment_reconciliation_records
      add constraint payment_reconciliation_records_tenant_transaction_fk
      foreign key (tenant_id, transaction_id)
      references public.payment_transactions(tenant_id, id);
  end if;
  if not exists (select 1 from pg_constraint where conname='payment_webhook_deliveries_tenant_endpoint_fk') then
    alter table public.payment_merchant_webhook_deliveries
      add constraint payment_webhook_deliveries_tenant_endpoint_fk
      foreign key (tenant_id, endpoint_id)
      references public.payment_merchant_webhook_endpoints(tenant_id, id);
  end if;
end;
$constraints$;
