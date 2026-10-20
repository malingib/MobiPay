# Neon persistence and authorization

The canonical migration is `neon/migrations/001_payment_foundation.sql`. It is written for Neon PostgreSQL and does not depend on Supabase's `auth.users` schema.

## Implemented API boundary

- JWT verification uses a configured issuer, audience, and remote JWKS URL.
- Tenant IDs from requests are treated as untrusted; every tenant API checks an active membership before reading or mutating data.
- Roles are checked on transaction creation and exception resolution.
- Transaction creation requires an idempotency key and rejects reuse with different payment details.
- Payment rows, provider events, exceptions, and audit events persist in PostgreSQL.
- CSV export is bounded and protects against spreadsheet formula injection.
- RLS is enabled as a secondary guard; the backend's database role must remain server-only and must never be exposed to browsers.

## Required configuration

- `DATABASE_URL`: Neon pooled or direct PostgreSQL connection string held in deployment secrets.
- `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL`: issuer-specific JWT verification settings.
- Configure provider secrets in server-side deployment settings only. Never commit them.

## Before production

1. Apply this migration to the dedicated MobiWave Payments Neon project using a reviewed migration workflow.
2. Test tenant isolation with two users and two unrelated tenants.
3. Test membership revocation, suspended tenants, duplicate idempotency keys, and concurrent callbacks.
4. Use a non-owner database role for the API where practical; validate RLS policies using that exact role.
5. Add database-backed integration tests and backup/restore checks.
6. Configure production secrets only after provider onboarding, callback URLs, and legal/provider approval.

The current provider adapters are sandbox-only. Daraja callbacks are not treated as proof of payment unless a server-side STK status query and amount/receipt checks succeed. Pesapal status must be queried server-side; uncertain or mismatched results become `unknown` and are routed for review.

**Operational limitation:** the connected Neon organization currently rejects project creation because it is managed by Vercel. No existing Neon project has been modified or used as a substitute, to avoid accidentally migrating an unrelated product database.
