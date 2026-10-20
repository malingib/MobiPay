# MobiWave Payments

MobiWave Payments is a Kenya-focused multi-tenant payments visibility and reconciliation platform for MobiWave and external merchants.

## Current implementation

- React/Vite sandbox console; its displayed metrics remain illustrative demo data.
- TypeScript/Express API with helmet, CORS allowlist, request-size limits, rate limiting, health and database-readiness endpoints.
- JWT verification through configured issuer, audience, and remote JWKS.
- Neon PostgreSQL migration for tenants, memberships, provider account references, transactions, idempotency, provider events, reconciliation exceptions, and audit history.
- Tenant membership and role checks for transaction APIs and exception resolution.
- Transaction CSV exports with spreadsheet-formula injection protection.
- Conservative reconciliation matching and exception classification.
- Sandbox-only Daraja STK initiation and callback processing. Callback success is not accepted without a server-side STK status query and amount/receipt checks.
- Sandbox-only Pesapal order submission and server-side status inquiry before marking transactions successful.
- Live provider operations are explicitly disabled in the adapters.

## Required server configuration

See `.env.example`. Configure real values only in deployment secret storage:

- `DATABASE_URL` — dedicated Neon PostgreSQL connection string.
- `AUTH_ISSUER`, `AUTH_AUDIENCE`, `AUTH_JWKS_URL` — your chosen identity provider's JWT verification configuration.
- Daraja sandbox credentials and a long random `DARAJA_CALLBACK_TOKEN`.
- Pesapal sandbox credentials and registered `PESAPAL_IPN_ID`.
- `PUBLIC_API_BASE_URL` — public HTTPS API base URL used to construct provider callback URLs.

## Important deployment blocker

The connected Neon organization rejected project creation because it is managed by Vercel. No existing database was modified because the available Neon projects belong to other work or have not been identified as the dedicated MobiWave Payments database. Provision a dedicated database through the owning Vercel/Neon integration, then apply and test `neon/migrations/001_payment_foundation.sql` before deploying the API.

## Production launch gates

- Apply migration and test tenant isolation against two separate users and tenants.
- Configure real authentication and test token issuer/audience/JWKS behavior.
- Verify Daraja and Pesapal sandbox flows end-to-end using actual provider-issued credentials and public HTTPS callbacks.
- Test concurrent callbacks, idempotent retries, amount mismatches, and provider timeouts.
- Add alerts, backups, restore tests, structured monitoring, and incident-response procedures.
- Obtain provider and Kenyan legal/regulatory confirmation before live collection or fund movement.

The platform does not hold customer funds by design. Never store card data, M-Pesa PINs, bank passwords, or live provider secrets in source control.
