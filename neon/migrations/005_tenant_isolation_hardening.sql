-- MobiPay tenant-isolation hardening.
-- A reconciliation record must belong to the same tenant as its parent run.
-- Existing transaction and webhook endpoint relationships already use composite tenant FKs.

create unique index if not exists payment_reconciliation_runs_tenant_id_id_idx
  on public.payment_reconciliation_runs(tenant_id, id);

do $constraints$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'payment_reconciliation_records_tenant_run_fk'
      and conrelid = 'public.payment_reconciliation_records'::regclass
  ) then
    alter table public.payment_reconciliation_records
      add constraint payment_reconciliation_records_tenant_run_fk
      foreign key (tenant_id, run_id)
      references public.payment_reconciliation_runs(tenant_id, id)
      on delete restrict;
  end if;
end;
$constraints$;

-- Keep the API's membership checks as the primary authorization boundary.
-- Do not FORCE RLS until every API/background-worker DB operation uses an
-- authenticated transaction context and a dedicated NOBYPASSRLS application role.
