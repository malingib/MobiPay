# MobiPay production release gates

Passing GitHub Actions against disposable PostgreSQL does not authorize production schema changes or live payment activation.

## Merge order

1. PR #15 — capability, callback and worker lease hardening.
2. PR #18 — Paystack checkout and public checkout status.
3. PR #19 — least-privilege runtime role, RLS write policies and Paystack recovery.
4. PR #20 — merchant/platform UI and audit/security screens.
5. PR #21 — JavaScript SDK.

Retarget stacked PRs to `main` after each parent merges. Keep every PR unmerged until its exact head has passing CI.

## Neon production database

Before applying migrations 005–009:

- Reconnect the Neon account containing the production project `mobiwave-paymenrs`.
- Confirm project, main branch, region and database name against Vercel production `DATABASE_URL` metadata without printing or copying the secret.
- Inspect `session_user` and confirm the migration runner uses the same login role as the Vercel API runtime, or explicitly grant `mobipay_runtime` membership to the verified runtime login role.
- Review migration 008 role creation/grants and all RLS policies against the live schema.
- Apply migrations 005–009 in order using the approved migration process. Do not create Neon branches or substitute another project.
- Deploy the API and call `GET /api/admin/security/database-role`.
- Confirm `runtime_role=mobipay_runtime`, `is_superuser=false`, `bypasses_rls=false`, `payment_tables_owned_by_runtime_role=0`, and expected payment tables have RLS enabled.
- Verify tenant isolation using two separate merchant workspaces.
- Keep live payments disabled if any role, grant, policy or isolation result is unexpected.

## Worker scheduler

- Vercel production has encrypted `WORKER_CRON_SECRET`.
- In Cloudflare Worker `mobipay-payment-worker-cron`, set secret binding `MOBIPAY_WORKER_CRON_SECRET` to the same value.
- Confirm `MOBIPAY_API_URL=https://pay.mobiwave.co.ke`.
- Add Cron Trigger `* * * * *` only after the API containing `POST /api/worker` is deployed.
- Verify an authenticated invocation returns HTTP 200 and inspect provider-event recovery, Paystack polling and merchant webhook delivery counts. Never log the secret.

## Provider sandbox verification

- Configure Daraja, Pesapal and Paystack sandbox credentials per merchant.
- Register the displayed Paystack webhook URL and dedicated signing secret.
- Test successful, failed, pending, duplicate, delayed, amount-mismatch and lost-webhook cases.
- Confirm provider verification, ledger transitions, audit events, reconciliation exceptions and merchant webhook retries.
- Verify idempotent retries do not create duplicate provider charges.

## UI and checkout verification

- Wait for the Vercel deployment quota to reset, then verify the preview before merging UI changes.
- Test all merchant pages at desktop and mobile widths.
- Test platform overview, merchant suspension/reactivation, transactions, database security diagnostics and audit history.
- Test public checkout return with valid, expired and invalid tokens.
- Test the SDK against sandbox APIs; never use a production token in browser bundles.

## Live release

Live provider credentials, live payment modes and production payment activation require separate explicit approval after database, worker, provider, reconciliation, security and UI gates pass.
