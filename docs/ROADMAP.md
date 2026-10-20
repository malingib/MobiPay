# Delivery roadmap

## Phase 0 — Foundation
- Establish this dedicated repository and architecture.
- Define API/web boundaries, configuration, lint/build/test commands, and secrets policy.
- Keep demo mode visibly separate from production.

## Phase 1 — Reconciliation MVP
- Tenant auth and membership checks.
- Import authorized M-Pesa statements/transaction exports and ingest Daraja C2B/STK callback events.
- Transaction ledger, matching rules, exception review, audit trail, and CSV reports.
- Idempotency and duplicate/replay tests.

## Phase 2 — Provider adapters
- Daraja sandbox integration for merchant-owned credentials.
- Pesapal order submission, IPN registration, server-side status verification, and refunds/status support only where officially supported.
- Bank adapters only after access approval and documented integration contracts.

## Phase 3 — Pilot and operational readiness
- Pilot with a small set of merchants using their own Paybill/Till/provider accounts.
- Measure match rate, time saved, exception rate, and support burden.
- Review data protection obligations, retention, incident response, backups, and Kenyan regulatory classification with counsel and providers.

## Out of scope until separately approved
- Custody of merchant/customer funds or internal pooled balances.
- Claiming licensed-PSP status without authorization.
- Storing cardholder data or M-Pesa PINs.
- Unofficial bank integrations or credential collection.
