# Persistence and authorization notes

The first Supabase migration is a **locked-down schema baseline**, not a deployed database. It creates tenant memberships, transactions, provider-event deduplication, reconciliation exceptions, and audit events.

## Security posture

- RLS is enabled on every payment table.
- Authenticated users receive read policies only for tenants where they have an active membership.
- Financial writes intentionally have no authenticated-client RLS policies; implement writes through server-side handlers that verify the authenticated user, role, tenant, provider evidence, and state transition.
- Provider event IDs and idempotency keys have unique constraints.
- Transaction status is constrained to explicit lifecycle values; `unknown` is distinct from success and failure.
- Audit events are designed for append-only use. Enforce append-only writes in the service layer and do not grant browser clients mutation privileges.
- Tenant creation and first-owner provisioning must be performed by a trusted server-side onboarding workflow.

## Before applying to a real Supabase project

1. Review this migration against the target project's existing schema and policies.
2. Test RLS using at least two unrelated tenants and users.
3. Add transactional server-side state transitions and immutable audit-write logic.
4. Set retention and data-minimization rules for payer references and event metadata.
5. Apply through a reviewed migration pipeline; do not paste service-role credentials into source control.

No provider credentials, live payment API, or production database is configured by this migration.
