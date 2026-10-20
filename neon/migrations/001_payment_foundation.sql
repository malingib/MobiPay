-- MobiWave Payments / Neon PostgreSQL schema.
-- This migration intentionally does not depend on Supabase auth.users.
create extension if not exists pgcrypto;

create table if not exists public.payment_tenants (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 1 and 160),
  slug text not null unique check (slug ~ '^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$'),
  status text not null default 'active' check (status in ('active', 'suspended', 'closed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.payment_tenant_memberships (
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  user_id text not null,
  role text not null check (role in ('owner', 'admin', 'finance', 'viewer')),
  status text not null default 'active' check (status in ('invited', 'active', 'suspended')),
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index if not exists payment_memberships_user_idx on public.payment_tenant_memberships(user_id, status);

create table if not exists public.payment_provider_configs (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  provider text not null check (provider in ('daraja', 'pesapal', 'bank')),
  account_reference text not null,
  secret_reference text not null,
  environment text not null default 'sandbox' check (environment in ('sandbox', 'production')),
  enabled boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, account_reference)
);

create table if not exists public.payment_transactions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  provider text not null check (provider in ('daraja', 'pesapal', 'bank', 'manual')),
  provider_transaction_id text,
  merchant_reference text not null,
  idempotency_key text,
  amount_minor bigint not null check (amount_minor > 0),
  currency char(3) not null default 'KES' check (currency ~ '^[A-Z]{3}$'),
  status text not null default 'pending' check (status in ('created', 'pending', 'succeeded', 'failed', 'cancelled', 'expired', 'unknown')),
  payer_reference text,
  description text,
  provider_status text,
  occurred_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (tenant_id, provider, provider_transaction_id)
);
create unique index if not exists payment_transactions_idempotency_idx
  on public.payment_transactions(tenant_id, idempotency_key) where idempotency_key is not null;
create index if not exists payment_transactions_tenant_created_idx on public.payment_transactions(tenant_id, created_at desc);
create index if not exists payment_transactions_tenant_status_idx on public.payment_transactions(tenant_id, status, created_at desc);

create table if not exists public.payment_provider_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  provider text not null check (provider in ('daraja', 'pesapal', 'bank')),
  provider_event_id text not null,
  event_type text not null,
  payload_sha256 text not null check (payload_sha256 ~ '^[a-f0-9]{64}$'),
  processing_status text not null default 'received' check (processing_status in ('received', 'processed', 'duplicate', 'rejected', 'retry')),
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (tenant_id, provider, provider_event_id)
);
create index if not exists payment_provider_events_pending_idx on public.payment_provider_events(received_at) where processing_status in ('received', 'retry');

create table if not exists public.payment_reconciliation_exceptions (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  transaction_id uuid references public.payment_transactions(id) on delete restrict,
  provider text not null,
  provider_reference text,
  exception_type text not null check (exception_type in ('unmatched', 'amount_mismatch', 'duplicate', 'status_mismatch', 'missing_provider_record', 'other')),
  details jsonb not null default '{}'::jsonb,
  status text not null default 'open' check (status in ('open', 'investigating', 'resolved', 'dismissed')),
  resolution_note text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists payment_reconciliation_open_idx on public.payment_reconciliation_exceptions(tenant_id, status, created_at desc);

create table if not exists public.payment_audit_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.payment_tenants(id) on delete restrict,
  actor_user_id text,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  correlation_id text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists payment_audit_tenant_created_idx on public.payment_audit_events(tenant_id, created_at desc);

-- Tenant policies are enforced by authenticated API queries. RLS is a secondary guard
-- for any non-owner database roles; the backend must never trust tenant IDs without membership checks.
create or replace function public.current_payment_user_id()
returns text language sql stable as $$
  select nullif(current_setting('app.user_id', true), '')
$$;

create or replace function public.is_payment_tenant_member(target_tenant uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.payment_tenant_memberships m
    where m.tenant_id = target_tenant
      and m.user_id = public.current_payment_user_id()
      and m.status = 'active'
  )
$$;

alter table public.payment_tenants enable row level security;
alter table public.payment_tenant_memberships enable row level security;
alter table public.payment_provider_configs enable row level security;
alter table public.payment_transactions enable row level security;
alter table public.payment_provider_events enable row level security;
alter table public.payment_reconciliation_exceptions enable row level security;
alter table public.payment_audit_events enable row level security;

drop policy if exists payment_tenant_read on public.payment_tenants;
create policy payment_tenant_read on public.payment_tenants for select using (public.is_payment_tenant_member(id));
drop policy if exists payment_membership_read on public.payment_tenant_memberships;
create policy payment_membership_read on public.payment_tenant_memberships for select using (public.is_payment_tenant_member(tenant_id));
drop policy if exists payment_provider_config_read on public.payment_provider_configs;
create policy payment_provider_config_read on public.payment_provider_configs for select using (public.is_payment_tenant_member(tenant_id));
drop policy if exists payment_transaction_read on public.payment_transactions;
create policy payment_transaction_read on public.payment_transactions for select using (public.is_payment_tenant_member(tenant_id));
drop policy if exists payment_event_read on public.payment_provider_events;
create policy payment_event_read on public.payment_provider_events for select using (public.is_payment_tenant_member(tenant_id));
drop policy if exists payment_exception_read on public.payment_reconciliation_exceptions;
create policy payment_exception_read on public.payment_reconciliation_exceptions for select using (public.is_payment_tenant_member(tenant_id));
drop policy if exists payment_audit_read on public.payment_audit_events;
create policy payment_audit_read on public.payment_audit_events for select using (public.is_payment_tenant_member(tenant_id));

-- There are intentionally no browser-client write policies. The server owns all financial mutations.
