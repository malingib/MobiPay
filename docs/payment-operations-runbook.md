# MobiWave Payments — Payment Operations Runbook

## Scope and safety

This application remains sandbox-only. Live Daraja and Pesapal operations are deliberately disabled. Do not enable live collection or fund movement until Safaricom/Pesapal onboarding, legal/regulatory review, independent security review and the gates below are signed off.

## Database migration

1. Provision a dedicated PostgreSQL database for MobiWave Payments. Do not point this application at another MobiWave product's database.
2. Back up the empty/new database or record the current restore point.
3. Apply `neon/migrations/001_payment_foundation.sql`.
4. Apply `neon/migrations/002_payment_safety_and_operations.sql`.
5. Verify that all tables, indexes, policies and triggers exist. Do not enable the webhook worker before migration 002 has completed.
6. Run the API readiness endpoint (`GET /ready`) and the test suite.

Migrations are not applied automatically by the API. Apply them deliberately through the database owner/approved migration workflow.

## Provider callback setup

- Configure `PUBLIC_API_BASE_URL` to the canonical public HTTPS API origin.
- Set `DARAJA_CALLBACK_TOKEN` to a cryptographically random secret of at least 32 characters and keep it in deployment secret storage.
- Daraja STK initiation passes the tenant-specific callback URL to the provider adapter. Do not configure a separate static callback URL that bypasses tenant routing.
- Callback receipt is not payment confirmation. The API must query Daraja status and verify amount and receipt before marking success.
- Keep the Daraja checkout request ID, M-Pesa receipt and Pesapal order tracking ID in their dedicated columns.
- Pesapal notifications trigger a server-side status inquiry. Do not trust a browser redirect or notification query string as proof of payment.
- An early or ambiguous callback is stored with its payload. Enable `MERCHANT_WEBHOOK_WORKER_ENABLED=true` to run the provider-event recovery worker and merchant webhook worker; monitor retry counts and reconciliation exceptions.

## Idempotency and state transitions

- Require the same `Idempotency-Key` for retries of the same logical initiation.
- Reusing a key with different merchant reference, amount, payer or description returns a conflict.
- Never create a fresh key to work around an unknown provider result until the existing provider status has been checked.
- The database trigger prevents terminal payment states from being rewritten by late callbacks. Investigate conflicting evidence through reconciliation exceptions rather than editing status directly.

## Merchant webhook delivery

1. Configure a random 32+ character deployment secret under the environment variable named in `signingSecretReference`.
2. Register an HTTPS endpoint through `POST /api/v1/tenants/:tenantId/webhook-endpoints`. The API rejects obvious private/local destinations and validates DNS resolution before enabling the endpoint.
3. Enable `MERCHANT_WEBHOOK_WORKER_ENABLED=true` only after migration 002 is applied.
4. Receivers must validate `X-MobiWave-Signature` as `sha256=<hex HMAC-SHA256 of the exact raw request body>`, use `X-MobiWave-Event-Id` for idempotency and return a 2xx response after durable acceptance.
5. Delivery retries use exponential backoff and move to `dead_letter` after eight attempts. Monitor retry and dead-letter counts and investigate before manually requeueing.
6. Webhook endpoints should also be restricted by outbound network egress policy. DNS validation reduces SSRF risk but cannot fully prevent DNS rebinding in every runtime/network configuration.

## Reconciliation operations

- Preserve original provider statement files outside the application and calculate SHA-256 hashes before import.
- Match exact provider references first, then merchant reference only when unique; require amount and currency equality.
- Never auto-resolve ambiguous or amount-mismatch rows.
- Store source hash, run ID, raw record, match outcome and exception decision for audit.
- The migration creates durable reconciliation-run/record tables. A full statement import UI/API and automated scheduled statement ingestion are still required before calling this workflow complete.

## Minimum verification before launch

- [ ] Run `npm ci`, `npm run typecheck`, `npm test`, and `npm run build` on Node 22.
- [ ] Apply both migrations in a dedicated non-production database.
- [ ] Verify tenant isolation with two tenants/users, including CSV exports, exceptions, webhook endpoints and reconciliation records.
- [ ] Test duplicate/concurrent Daraja callbacks, early callbacks, invalid callback token, provider timeout, amount mismatch, duplicate receipt and late callback after terminal state.
- [ ] Test Pesapal notification duplication, status-query timeout, mismatched currency/amount and idempotent checkout replay.
- [ ] Test webhook signature verification, private/local URL rejection, timeout, non-2xx, redirect rejection, retry schedule, dead-letter and worker restart recovery.
- [ ] Verify database backups and perform a restore drill.
- [ ] Configure structured logs, request correlation IDs, alerts for pending/unknown payments, retry provider events, open exceptions and webhook dead letters.
- [ ] Complete provider sandbox tests with real provider-issued sandbox credentials and publicly reachable HTTPS callbacks.
- [ ] Obtain provider approval and Kenyan legal/regulatory confirmation before enabling live operations.

## Current implementation boundaries

- Provider-event retry rows are persisted, but automatic replay of orphaned provider events is not yet implemented as a background job.
- Reconciliation run/record storage exists, but statement file parsing/import API, run orchestration and a review UI remain follow-up work.
- The webhook outbox and worker are implemented, but endpoint configuration, signing-secret storage and outbound egress policy must be operationally validated.
- Database row-level security policies are secondary safeguards. The API's tenant membership checks remain mandatory; test the exact database role and claims configuration used in deployment.
