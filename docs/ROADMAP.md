# Delivery roadmap

## Implemented in repository
- Dedicated monorepo, API/web scaffold, CI typecheck/build/test.
- Neon-native schema migration for tenants, memberships, provider references, transactions, provider events, reconciliation exceptions, and audit events.
- Configurable JWT/JWKS validation, server-side Neon connection pool, tenant membership/role checks.
- Idempotent transaction API, exception-resolution API, CSV export, and readiness probe.
- Deterministic reconciliation matcher with unit tests.
- Sandbox-only Daraja STK initiation and callback status-query verification.
- Sandbox-only Pesapal checkout and server-side transaction-status verification.

## Blocked on dedicated Neon provisioning
- The connected Neon organization is managed by Vercel and the Neon project-creation action is rejected. Do not use another product's database as a substitute.
- Apply `neon/migrations/001_payment_foundation.sql` to the dedicated MobiWave Payments database and verify the migration in that database.
- Run two-tenant RLS/isolation integration tests using the deployed API's actual database role.

## Remaining pre-production work
- Configure the chosen identity provider and validate issuer/audience/JWKS settings against real signed tokens.
- Supply actual Daraja and Pesapal sandbox credentials, public HTTPS callback URL, and registered IPN; execute end-to-end test transactions.
- Add provider-specific event fixtures, timeout/retry tests, callback concurrency tests, and reconciliation batch persistence.
- Add scheduled reconciliation against authorized statement/provider exports and operational alerting/backup restore tests.
- Validate provider terms and Kenyan legal/regulatory classification before enabling live payments.

## Not enabled
- Live provider operations (adapter code rejects production mode).
- Custody of merchant/customer funds or pooled balances.
- Unofficial bank integrations or credential collection.
