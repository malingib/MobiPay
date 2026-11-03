# MobiWave Payments — Payment Operations Runbook

## Scope and safety

This application remains sandbox-only. Live Daraja and Pesapal operations are deliberately disabled. Do not enable live collection or fund movement until Safaricom/Pesapal onboarding, legal/regulatory review, independent security review and the launch gates below are signed off.

## Database migration

1. Confirm the target is the dedicated MobiPay Neon production project/database. Never point this application at another MobiWave product's database.
2. Record a restore point and confirm that a tested backup is available before applying schema changes.
3. Apply migrations in order:
   - `neon/migrations/001_payment_foundation.sql`
   - `neon/migrations/002_payment_safety_and_operations.sql`
   - `neon/migrations/003_merchant_provider_security.sql`
   - `neon/migrations/004_platform_admin_audit.sql`
4. Verify the expected tables, indexes, constraints, policies and triggers, including `platform_admin_audit_logs` and its append-only trigger.
5. Run `GET /ready` against the intended deployment and confirm it reports database connectivity.
6. Run the automated checks on Node.js 22: `npm install`, `npm run typecheck`, `npm test`, and `npm run build`.

Migrations are not applied automatically by the API. Apply them deliberately through the database owner/approved migration workflow. Do not infer migration state from repository files or a successful frontend deployment. The repository currently has no committed root `package-lock.json`; until a lockfile is generated, reviewed and committed, use `npm install` for verification and treat dependency resolution as non-reproducible. The Vercel install step clears cached `node_modules` and any generated lockfile before resolving dependencies so stale build-cache versions cannot override current root dependency overrides.

## Provider callback setup

- Configure `PUBLIC_API_BASE_URL` to the canonical public HTTPS API origin for each deployment environment.
- Set `DARAJA_CALLBACK_TOKEN` to a cryptographically random secret of at least 32 characters and keep it in deployment secret storage.
- Daraja STK initiation passes the tenant-specific callback URL to the provider adapter. Do not configure a separate static callback URL that bypasses tenant routing.
- Callback receipt is not payment confirmation. The API must query Daraja status and verify amount and receipt before marking success.
- Keep the Daraja checkout request ID, M-Pesa receipt and Pesapal order tracking ID in their dedicated columns.
- Pesapal notifications trigger a server-side status inquiry. Do not trust a browser redirect or notification query string as proof of payment.
- Early or ambiguous provider events are persisted. The retry records exist, but automatic replay of orphaned provider events is not yet implemented as a background job. Do not claim recovery is automatic until that worker is implemented, enabled and verified.

## Idempotency and state transitions

- Require the same `Idempotency-Key` for retries of the same logical initiation.
- Reusing a key with a different logical request must return a conflict.
- Never create a fresh key to work around an unknown provider result until the existing provider status has been checked.
- The database trigger prevents terminal payment states from being rewritten by late callbacks. Investigate conflicting evidence through reconciliation exceptions rather than editing status directly.
- Verify concurrent requests and duplicate callbacks against the database uniqueness constraints, not only sequential application tests.

## Merchant webhook delivery

1. Configure a random 32+ character deployment secret under the environment-variable name stored in `signingSecretReference`.
2. Register an HTTPS endpoint through `POST /api/v1/tenants/:tenantId/webhook-endpoints`. The API rejects obvious private/local destinations and validates DNS resolution before enabling the endpoint.
3. Enable `MERCHANT_WEBHOOK_WORKER_ENABLED=true` only after migration 002 is applied and the endpoint signing-secret references are configured.
4. Receivers must validate `X-MobiWave-Signature` as `sha256=<hex HMAC-SHA256 of the exact raw request body>`, use `X-MobiWave-Event-Id` for idempotency and return a 2xx response after durable acceptance.
5. Delivery retries use exponential backoff and move to `dead_letter` after eight attempts. Monitor retry and dead-letter counts and investigate before manually requeueing.
6. Webhook endpoints should also be restricted by outbound network egress policy. DNS validation reduces SSRF risk but cannot fully prevent DNS rebinding in every runtime/network configuration.
7. Validate worker startup, graceful shutdown, retry behavior and restart recovery in a non-production environment before enabling it in production.

## Reconciliation operations

- Preserve original provider statement files outside the application and calculate SHA-256 hashes before import.
- The API supports bounded CSV imports through `POST /api/v1/tenants/:tenantId/reconciliation/import`. Required headers are `provider_reference`, `merchant_reference`, `amount_minor`, and `currency`; optional `occurred_at` is accepted. Imports are limited to 5,000 data rows and are deduplicated by tenant, provider and source-content hash.
- Match exact provider references first, then merchant reference only when unique; require amount and currency equality.
- Never auto-resolve ambiguous, duplicate or amount-mismatch rows. Review and resolve exceptions through the authenticated merchant workflow.
- Store source hash, run ID, raw record, match outcome and exception decision for audit.
- Durable reconciliation-run/record storage and the CSV import API are implemented. A dedicated reconciliation review UI and automated scheduled statement ingestion remain follow-up work.

## Minimum verification before launch

- [ ] Run `npm install`, `npm run typecheck`, `npm test`, and `npm run build` on Node 22.
- [ ] Verify all four migrations on a dedicated non-production database before production migration approval.
- [ ] Verify tenant isolation with two tenants/users, including CSV exports, exceptions, webhook endpoints and reconciliation records.
- [ ] Test duplicate/concurrent Daraja callbacks, early callbacks, invalid callback token, provider timeout, amount mismatch, duplicate receipt and late callback after terminal state.
- [ ] Test Pesapal notification duplication, status-query timeout, mismatched currency/amount and idempotent checkout replay.
- [ ] Test webhook signature verification, private/local URL rejection, timeout, non-2xx, redirect rejection, retry schedule, dead-letter and worker restart recovery.
- [ ] Import the same CSV twice and verify idempotency; test malformed CSV, ambiguous matches, duplicates, amount mismatch and cross-tenant import attempts.
- [ ] Verify platform-admin login, cookie flags, expiry, login rate limit, merchant/admin session separation, tenant status changes and append-only audit logging.
- [ ] Verify database backups and perform a restore drill.
- [ ] Configure structured logs and alerts for pending/unknown payments, provider-event retries, open exceptions and webhook dead letters.
- [ ] Complete provider sandbox tests with real provider-issued sandbox credentials and publicly reachable HTTPS callbacks.
- [ ] Obtain provider approval and Kenyan legal/regulatory confirmation before enabling live operations.

## Current implementation boundaries

- Provider-event retry rows are persisted, but automatic replay of orphaned provider events is not yet implemented as a background job.
- Reconciliation CSV parsing/import API and durable run/record storage are implemented; a dedicated review UI and scheduled statement ingestion remain follow-up work.
- The webhook outbox and worker are implemented, but endpoint configuration, signing-secret storage, outbound egress policy and production worker operations must be validated.
- Platform-admin endpoints use a separate signed HTTP-only session under `/api/admin/*`; merchant APIs remain under `/api/v1/*`. Migration 004 is required for platform-admin audit-backed merchant status actions.
- Database row-level security policies are secondary safeguards. The API's tenant membership checks remain mandatory; test the exact database role and claims configuration used in deployment.
- Production provider adapters remain disabled. A READY Vercel deployment is not evidence that production database migrations, provider callbacks or end-to-end payment flows have passed.
