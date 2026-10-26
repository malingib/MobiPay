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
- Merchant-owned Daraja and Pesapal sandbox credential connections, encrypted at rest with AES-256-GCM and isolated by tenant. Merchant owners/admins can save credentials, test provider authentication, inspect connection metadata without secret disclosure, and remove credentials.
- Sandbox-only Daraja STK initiation and callback processing. The tenant-specific callback URL is passed to the provider adapter; callback success is not accepted without a server-side STK status query and amount/receipt checks. Provider checkout, callbacks and retry recovery use the owning merchant’s credentials.
- Separate Daraja checkout-request ID, M-Pesa receipt and Pesapal tracking ID columns; database-enforced payment-state transitions.
- Sandbox-only Pesapal order submission and server-side status inquiry before marking transactions successful; idempotent checkout replay returns the original checkout URL when available.
- Signed merchant webhook endpoints with transactional outbox, retry/backoff, dead-lettering and an optional delivery worker.
- Live provider operations are explicitly disabled in the adapters.

## Required server configuration

See `.env.example` and [the payment operations runbook](docs/payment-operations-runbook.md). Configure real values only in deployment secret storage:

- `DATABASE_URL` — dedicated Neon PostgreSQL connection string.
- `PROVIDER_CREDENTIALS_ENCRYPTION_KEY` — base64-encoded 32-byte key for AES-256-GCM encryption of merchant-owned Daraja/Pesapal credentials. Generate with `openssl rand -base64 32`; store only in deployment secrets and preserve it securely. If lost, stored credentials cannot be decrypted.
- `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` — your chosen identity provider's JWT verification configuration.
- A long random `DARAJA_CALLBACK_TOKEN`; each merchant supplies their own Daraja sandbox credentials through the authenticated provider-connections API.
- Each merchant supplies their own Pesapal sandbox credentials and registered IPN ID through the authenticated provider-connections API.
- `PUBLIC_API_BASE_URL` — public HTTPS API base URL used to construct provider callback URLs.

## Migration and operational requirements

Apply `neon/migrations/001_payment_foundation.sql`, `neon/migrations/002_payment_safety_and_operations.sql`, then `neon/migrations/003_merchant_provider_security.sql` to a dedicated database before deploying this branch. The API does not apply migrations automatically. Keep `MERCHANT_WEBHOOK_WORKER_ENABLED=false` until migration 002 and endpoint secret configuration are complete.

## Deployment configuration

The dedicated Neon project `mobiwave-paymenrs` is connected to the MobiPay Vercel project. Migrations 001–003 are applied to the production branch and the required payment tables, provider-encryption columns, and read policies have been verified. A separate `mobipay-preview` Neon branch is used for preview deployments so preview testing does not write to production data.

The Vercel project builds the React/Vite frontend and exposes the Express API through `api/[...path].ts`. Keep `DATABASE_URL`, `AUTH_ISSUER`, `AUTH_JWKS_URL`, and `PROVIDER_CREDENTIALS_ENCRYPTION_KEY` in server-side deployment secrets. Do not put database credentials or encryption keys in `VITE_*` variables. The frontend uses the same deployment origin for API calls when `VITE_API_BASE_URL` is blank.

## Neon Auth merchant onboarding

The web console uses Neon Auth (Managed Better Auth) for merchant registration and sign-in. Configure Neon Auth on the dedicated MobiPay project branch and set the following deployment variables:

- Frontend build variables: `VITE_NEON_AUTH_URL` (the branch Auth URL) and `VITE_API_BASE_URL` (the API origin). These are public URLs, not secrets.
- API variables: `AUTH_ISSUER` (the exact issuer value emitted in Neon Auth JWTs), `AUTH_JWKS_URL` (the branch JWKS URL), and optionally `AUTH_AUDIENCE` only if the configured token includes an audience that should be enforced.
- Set custom SMTP and verify email before production; do not rely on shared development email delivery for launch.

The sign-up screen creates a Neon Auth user; the authenticated user can then create a merchant workspace. Workspace creation makes that user its owner. API requests send a short-lived Neon Auth JWT in the Authorization header. The API validates the signature using the configured JWKS and validates issuer before processing requests.

## Merchant onboarding and provider connections

1. A merchant registers/signs in through Neon Auth and creates a tenant via `POST /api/v1/tenants`; the authenticated user becomes its owner.
2. An owner/admin saves sandbox credentials using `PUT /api/v1/tenants/:tenantId/provider-connections/daraja` or `.../pesapal`. The API encrypts the secret payload before database persistence and never returns the secret.
3. Verify sandbox authentication using `POST /api/v1/tenants/:tenantId/provider-connections/:provider/test`. This verifies API authentication only; it does not prove checkout, callbacks, settlement or live readiness.
4. List connection metadata using `GET /api/v1/tenants/:tenantId/provider-connections`, or remove a connection using `DELETE /api/v1/tenants/:tenantId/provider-connections/:provider`.

Provider credentials are scoped to a tenant and are not shared between merchants. Only tenant owners/admins can change credentials; finance/admin/owner roles can initiate supported sandbox payment flows. Keep `DARAJA_ENV=sandbox` and `PESAPAL_ENV=sandbox`; live processing remains disabled. A configured identity provider and migration 003 are required before these endpoints are usable.

## Production launch gates

- Apply migration and test tenant isolation against two separate users and tenants.
- Configure real authentication and test token issuer/audience/JWKS behavior.
- Verify Daraja and Pesapal sandbox flows end-to-end using actual provider-issued credentials and public HTTPS callbacks.
- Test concurrent callbacks, idempotent retries, amount mismatches, and provider timeouts.
- Add alerts, backups, restore tests, structured monitoring, and incident-response procedures.
- Obtain provider and Kenyan legal/regulatory confirmation before live collection or fund movement.

A durable reconciliation-run schema is present, but statement-file parsing/import API, scheduled ingestion and review UI remain follow-up work. Early callbacks are persisted with their payloads and retried by the optional provider-event recovery worker.

The platform does not hold customer funds by design. Never store card data, M-Pesa PINs, bank passwords, or live provider secrets in source control.
