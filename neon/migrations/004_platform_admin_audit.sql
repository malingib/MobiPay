-- Separate platform-level audit trail. No PSP settlement or merchant credential mutation.
create table if not exists public.platform_admin_audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_username text not null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists platform_admin_audit_logs_created_at_idx
  on public.platform_admin_audit_logs (created_at desc);
create index if not exists platform_admin_audit_logs_entity_idx
  on public.platform_admin_audit_logs (entity_type, entity_id, created_at desc);
