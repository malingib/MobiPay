# MobiWave Payments

MobiWave Payments is a Kenya-focused, multi-tenant payment and reconciliation platform for MobiWave and external merchants.

## Product direction

The first release prioritizes payment visibility and reconciliation rather than holding customer funds or claiming to be a licensed payment service provider. Provider integrations are enabled only for merchant-owned accounts and approved credentials, subject to provider terms and Kenyan legal/regulatory review.

### Initial scope

- Tenant-isolated merchant workspaces and role-based access.
- M-Pesa Daraja callback ingestion with signature/credential verification where supported, strict input validation, idempotency, and replay-safe processing.
- Reconciliation of provider transactions against invoices or member references, with an exception queue and human-approved resolution.
- Pesapal checkout/status adapter, where merchant onboarding and credentials permit it.
- Bank/account-to-account options only through documented, authorized bank APIs or approved partners.
- Append-only audit events, exportable reports, and operational monitoring.

## Security principles

- Never store raw card data, M-Pesa PINs, or provider secrets in source control.
- Keep tenants isolated at every API and data-access boundary; derive tenant identity from authenticated server-side claims, not request body fields alone.
- Treat provider callbacks as untrusted until verified and confirmed against the provider's status API where available.
- Use idempotency keys, unique provider references, rate limits, strict schemas, and explicit transaction states.
- Separate demo data from production data and never represent simulated payments as real transactions.

## Delivery status

This repository is being initialized. No live payment processing should be assumed until authentication, persistence, provider credentials, callback verification, reconciliation tests, deployment controls, and legal/provider approvals have been completed.

## Provider documentation

- Safaricom Daraja: https://developer.safaricom.co.ke/
- Pesapal API: https://developer.pesapal.com/

## Regulatory note

This software is not legal advice. Before enabling payment collection, settlement, or fund movement, obtain Kenyan legal advice and written confirmation from relevant providers on the operating model and licensing requirements.
