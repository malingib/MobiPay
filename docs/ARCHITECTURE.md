# Architecture baseline

## Deployment boundaries

- `apps/api`: Node.js HTTP API for authentication, merchant workspaces, payment intents, provider callbacks, reconciliation, audit events, and reports.
- `apps/web`: React + Vite merchant console.
- Supabase Postgres/Auth may be used for persistence and identity; apply row-level security and server-side authorization. Service-role credentials must stay server-side.
- Provider adapters isolate Daraja, Pesapal, and future bank integrations behind a common internal contract.

## Tenant isolation

Every merchant-owned record carries a tenant/workspace ID. API handlers resolve the active tenant from the authenticated principal and a server-side membership lookup. Never trust `tenant_id` from a browser payload as proof of access. Database policies must enforce the same boundary as the API.

## Transaction lifecycle

`created -> pending -> succeeded | failed | cancelled | expired | unknown`

`unknown` is not equivalent to failure or success. A timeout or missing callback triggers a status inquiry/reconciliation workflow. A verified provider status and immutable provider reference are required before a transaction is treated as paid.

## Provider adapters

### M-Pesa Daraja

- Merchant-owned Daraja credentials and short-lived OAuth access tokens.
- Validate callback structure, expected business shortcode/account, amount, currency, receipt/reference uniqueness, and timestamps where supplied.
- Persist callback delivery before returning success; process asynchronously where supported.
- Idempotently handle repeated callbacks and reconcile against provider records/statements.
- Never log access tokens, consumer secrets, passkeys, phone numbers in full, or callback payloads containing unnecessary personal data.

### Pesapal

- Use the official API for order submission and registered IPN/callback configuration.
- Do not mark an order paid merely because a browser returns to the success URL or an IPN arrives. Fetch and validate transaction status server-side before transitioning to a terminal state.
- Store provider order-tracking identifiers and idempotently process notifications.

### Banks

- Add only through documented APIs or authorized partners with explicit merchant consent and bank approval.
- Keep bank adapter contracts separate; do not scrape consumer banking interfaces or collect banking passwords.

## Reconciliation

1. Ingest provider transaction events and/or authorized statements.
2. Normalize amount, currency, provider reference, merchant reference, payer identifier, and timestamp.
3. Match exact provider reference first, then configured merchant reference and amount/date rules.
4. Route ambiguous and unmatched items to an exception queue; never silently force a match.
5. Require a human-approved resolution for exceptions and append an audit event.
6. Export reconciled/unmatched rows and daily summaries.

## Reliability and security controls

- Database uniqueness for `(provider, provider_transaction_id)` and idempotency keys.
- Explicit request schemas, bounded payload sizes, rate limiting, safe error messages, and request correlation IDs.
- Append-only audit history; financial events are corrected with compensating entries, not destructive edits.
- Secrets supplied through environment/secret manager; separate sandbox and production credentials.
- Tests for tenant access, duplicate callbacks, replay, amount mismatch, status polling, and partial failures.
- No live provider credentials or production payment processing in demo environments.

## Launch gates

Do not enable live payments until automated tests pass, provider sandbox checks are complete, callback URLs are verified, production secrets are configured securely, operational alerts and backups are in place, and Kenyan legal/regulatory review confirms the intended operating model.