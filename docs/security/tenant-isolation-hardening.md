# MobiPay tenant isolation hardening

## Implemented in this change

- Migration 005 adds a composite foreign key from reconciliation records
  `(tenant_id, run_id)` to reconciliation runs `(tenant_id, id)`.
- This closes a cross-tenant parent-association gap that a single-column
  `run_id` foreign key does not prevent.
- Existing composite foreign keys continue to bind reconciliation exceptions
  to same-tenant transactions, reconciliation records to same-tenant
  transactions, and webhook deliveries to same-tenant endpoints.
- `neon/tests/tenant_isolation.sql` is a rollback-only adversarial database
  test for cross-tenant reconciliation-run and transaction associations.

## Important remaining database boundary work

The current RLS policies depend on `app.user_id` via
`current_payment_user_id()`. The API currently uses pooled queries without
setting that identity transaction-locally on every operation. The API also
has background/provider callback operations that need a separately designed
privileged execution path.

Therefore this change deliberately does **not** enable `FORCE ROW LEVEL
SECURITY` or claim RLS is an effective production boundary yet. Doing so
before introducing a dedicated `NOBYPASSRLS` application role and
transaction-scoped identity propagation would risk either denying legitimate
requests or leaving privileged paths unprotected.

## Required next release gates

1. Provision a least-privilege runtime DB role with `NOBYPASSRLS`; keep
   schema ownership/migrations on a separate role.
2. Route merchant database work through a transaction-scoped context that
   sets `app.user_id` using a bound parameter and always clears it before
   returning a connection to the pool.
3. Give unauthenticated provider callbacks and workers narrowly scoped
   database functions/roles rather than sharing merchant request credentials.
4. Enable and force RLS table-by-table only after all paths are migrated.
5. Run the rollback-only SQL tests plus two-live-merchant API attack tests
   (read, write, export, provider credentials, callbacks, revoked membership,
   suspended tenant and role escalation) in CI against an isolated database.

Never apply this migration to production until it has been reviewed and
validated against a disposable Neon branch.
