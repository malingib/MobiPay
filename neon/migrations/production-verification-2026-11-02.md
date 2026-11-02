# Production schema verification — migration 004

**Verification date:** 2026-11-02  
**Neon project:** `mobiwave-paymenrs` (`patient-tree-34849432`)  
**Branch:** `main` (`br-divine-haze-b72htl61`)  
**Pre-change snapshot:** `mobipay-prod-before-platform-audit-migration-2026-11-02`  
**Snapshot ID:** `snap-morning-wildflower-b7tcj94i`

## Verified postconditions

The production database catalog was queried directly and returned:

- `public.platform_admin_audit_logs` table
- `platform_admin_audit_immutable` trigger, defined for UPDATE and DELETE
- `public.prevent_platform_admin_audit_mutation()` trigger function
- `platform_admin_audit_logs_created_at_idx`
- `platform_admin_audit_logs_entity_idx`

These objects match the definitions in `004_platform_admin_audit.sql` (repository blob SHA `7cc2fb52f28e74c293431538de4d04654bc02571`).

## Migration-history limitation

A catalog search found no migration ledger table (including `schema_migrations`, `drizzle_migrations`, or `_prisma_migrations`), and no other public migration/version table. Therefore, the database does **not** contain an authoritative migration-004 application record.

The verified schema objects establish that migration 004's postconditions are present. They do **not**, by themselves, prove the exact time, operator, or execution event by which those objects were created. This document records a postcondition verification, not a retroactive claim that a migration ledger entry exists or that a particular migration command was executed.

Do not insert a fabricated historical migration row. If a formal ledger is introduced, use a documented baseline/adoption procedure that explicitly distinguishes previously verified schema from migrations executed under that ledger.

## Operational status

This verification is not authorization to enable live Daraja or Pesapal collection. Provider launch gates and sandbox callback/reconciliation tests remain separate requirements.
