# MobiWave Payments

MobiWave Payments is a Kenya-focused multi-tenant payments visibility and reconciliation platform for MobiWave and external merchants.

## Current implementation

- React/Vite sandbox console; its displayed metrics remain illustrative demo data.
- TypeScript/Express API with helmet, CORS allowlist, request-size limits, rate limiting, health and database-readiness endpoints.
- JWT verification through configured issuer, audience, and remote JWKS.
- Neon PostgreSQL migrations for tenants, memberships, provider account references, transactions, idempotency, provider events, reconciliation exceptions, audit history, provider-specific identifiers, reconciliation run storage, and merchant webhook outbox.
- Tenant membership and role checks for transaction APIs and exception resolution.
- Transaction CSV exports with spreadsheet-formula injection protection.
- Conservative reconciliation matching and exception classification.
- Sandbox-only Daraja STK initiation and callback processing. The tenant-specific callback URL is passed to the provider adapter; callback success is not accepted without a server-side STK status query and amount/receipt checks.
- Separate Daraja checkout-request ID, M-Pesa receipt and Pesapal tracking ID columns; database-enforced payment-state transitions.
- Sandbox-only Pesapal order submission and server-side status inquiry before marking transactions successful; idempotent checkout replay returns the original checkout URL when available.
- Signed merchant webhook endpoints with transactional outbox, retry/backoff, dead-lettering and an optional delivery worker.
- Live provider operations are explicitly disabled in the adapters.

## Required server configuration

See `.env.example` and [the payment operations runbook](docs/payment-operations-runbook.md). Configure real values only in deployment secret storage:

- `DATABASE_URL` — dedicated Neon PostgreSQL connection string.
- `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` — your chosen identity provider's JWT verification configuration.
- Daraja sandbox credentials and a long random `DARAJA_CALLBACK_TOKEN`.
- Pesapal sandbox credentials and registered `PESAPAL_IPN_ID`.
- `PUBLIC_API_BASE_URL` — public HTTPS API base URL used to construct provider callback URLs.

## Migration and operational requirements

Apply `neon/migrations/001_payment_foundation.sql` followed by `neon/migrations/002_payment_safety_and_operations.sql` to a dedicated database before deploying this branch. The API does not apply migrations automatically. Keep `MERCHANT_WEBHOOK_WORKER_ENABLED=false` until migration 002 and endpoint secret configuration are complete.

## Important deployment blocker

The connected Neon organization rejected project creation because it is managed by Vercel. No existing database was modified because the available Neon projects belong to other work or have not been identified as the dedicated MobiWave Payments database. Provision a dedicated database through the owning Vercel/Neon integration, then apply and test `neon/migrations/001_payment_foundation.sql` before deploying the API.

## Production launch gates

- Apply migration and test tenant isolation against two separate users and tenants.
- Configure real authentication and test token issuer/audience/JWKS behavior.
- Verify Daraja and Pesapal sandbox flows end-to-end using actual provider-issued credentials and public HTTPS callbacks.
- Test concurrent callbacks, idempotent retries, amount mismatches, and provider timeouts.
- Add alerts, backups, restore tests, structured monitoring, and incident-response procedures.
- Obtain provider and Kenyan legal/regulatory confirmation before live collection or fund movement.

A durable reconciliation-run schema is present, but statement-file parsing/import API, scheduled ingestion and review UI remain follow-up work. Early callbacks are stored for review/retry, but automated replay of orphaned provider events remains a launch blocker until implemented.

The platform does not hold customer funds by design. Never store card data, M-Pesa PINs, bank passwords, or live provider secrets in source control.
