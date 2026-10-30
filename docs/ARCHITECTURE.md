# Architecture baseline

## Runtime and data boundaries

- `apps/web`: React + Vite merchant console. Merchant routes and tenant-scoped workflows remain in this application.
- `apps/web/src/admin.tsx` and `admin.css`: separate platform-admin UI shell and styling. Do not merge admin navigation or styles into the merchant shell.
- `apps/api`: Node.js/Express API.
- `neon/migrations`: PostgreSQL schema migrations applied to Neon. The runtime uses the `pg` driver and `DATABASE_URL`; Supabase is not part of the target architecture.
- Provider adapters isolate Daraja and Pesapal behind server-side contracts. Provider secrets remain encrypted and server-side.

## Authentication and authorization — current baseline and required boundary

The current branch authenticates merchant and platform-admin requests with Neon Auth JWTs. Platform-admin access is additionally restricted by `PLATFORM_ADMIN_EMAILS`. This is the existing implementation, not the final separation requirement.

The required platform boundary is:
- Merchant authentication remains scoped to the merchant identity/workspace and its membership. Merchant credentials must never authorize platform-wide data access.
- Platform administration must use its own signed, HTTP-only `mobiwave_platform_admin` session, configured by `ADMIN_USERNAME`, `ADMIN_PASSWORD`, optional `PLATFORM_ADMIN_NAME`, and `PLATFORM_ADMIN_SESSION_SECRET`; session lifetime is eight hours.
- Platform endpoints must be isolated under `/api/admin/*`, with their own authentication middleware and rate-limit bucket. Merchant endpoints remain under `/api/v1/*`.
- The admin frontend must call a dedicated admin API client and must not reuse merchant tokens or merchant API clients.
- Platform actions must append an immutable platform-admin audit record. Administrative activation/exception actions must not silently alter PSP settlement state or rotate provider credentials.

Do not claim the final boundary is implemented until the API, frontend, tests, and deployment configuration all enforce it.

## Tenant isolation

Every merchant-owned record carries a tenant ID. API handlers resolve the active tenant from the authenticated principal and a server-side membership lookup. Never trust a tenant ID from a browser payload as proof of access. Every read and write must be scoped to the authenticated tenant. Add cross-tenant denial tests for every sensitive endpoint.

## Transaction lifecycle

`created -> pending -> succeeded | failed | cancelled | expired | unknown`

`unknown` is not equivalent to failure or success. A timeout or missing callback triggers a status inquiry/reconciliation workflow. A verified provider status and immutable provider reference are required before a transaction is treated as paid. Preserve provider, ledger, and reconciliation states independently.

## Provider adapters

### M-Pesa Daraja
- Keep merchant/provider credential ownership explicit and secrets encrypted at rest.
- Validate callback structure, expected shortcode/account, amount, currency, receipt/reference uniqueness, and timestamps where supplied.
- Persist callback delivery before acknowledging it; process asynchronously where supported.
- Idempotently handle repeated callbacks and reconcile against provider records/statements.
- Never log access tokens, consumer secrets, passkeys, or unnecessary personal data.

### Pesapal
- Use the official API for order submission and registered IPN/callback configuration.
- Do not mark an order paid merely because a browser returns to a success URL or an IPN arrives. Fetch and validate transaction status server-side before transitioning to a terminal state.
- Store provider order-tracking identifiers and idempotently process notifications.

### Banks
- Add only through documented APIs or authorized partners with explicit merchant consent and bank approval.
- Keep bank adapter contracts separate; do not collect consumer banking passwords.

## Reconciliation

1. Ingest provider transaction events and/or authorized statements.
2. Normalize amount, currency, provider reference, merchant reference, payer identifier, and timestamp.
3. Match exact provider reference first, then configured merchant reference and amount/date rules.
4. Route ambiguous and unmatched items to an exception queue; never silently force a match.
5. Require a human-approved resolution and append an audit event.
6. Preserve the PSP settlement state when an operational exception is resolved.

## Reliability and security controls

- Database uniqueness for provider transaction IDs and idempotency keys.
- Explicit request schemas, bounded payload sizes, rate limiting, safe error messages, and request correlation IDs.
- Append-only audit history; financial events are corrected with compensating entries, not destructive edits.
- Secrets supplied through deployment secret storage; separate sandbox and production credentials.
- Tests for tenant access, duplicate callbacks, replay, amount mismatch, status polling, admin/merchant session separation, and partial failures.
- No live provider credentials or production payment processing in demo environments.

## Launch gates

Do not enable live payments until automated tests pass, provider sandbox checks are complete, callback URLs are verified, production secrets are configured securely, operational alerts and backups are in place, and Kenyan legal/regulatory review confirms the intended operating model.
