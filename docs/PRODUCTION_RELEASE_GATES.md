# MobiPay production release gates

This checklist is intentionally separate from CI. Passing GitHub Actions against disposable PostgreSQL does not authorize production schema changes or live payment activation.

## Merge order

1. PR #15 — capability, callback and worker lease hardening.
2. PR #18 — Paystack checkout and public checkout status.
3. PR #19 — least-privilege runtime role, RLS write policies and Paystack recovery.
4. PR #20 — merchant/platform UI and audit/security screens.
5. PR #21 — JavaScript SDK.

Retarget stacked PRs to `main` after their parent PR is merged. Keep every PR unmerged until its exact head has passing CI.

## Neon production database

Before applying migrations 005–009:

- Reconnect the Neon account containing the production project `mobiwave-paymenrs`.
- Confirm the project, main branch, region and database name against the Vercel production `DATABASE_URL` metadata without printing or copying the secret.
- Inspect `session_user` and confirm the migration runner uses the same login role as the Vercel API runtime, or explicitly grant `mobipay_runtime` membership to the verified runtime login role.
- Review migration 008 role creation/grants and all RLS policies against the live schema.
- Apply migrations 005–009 in order using the approved migration process. Do not create Neon branches or substitute a different project.
- Deploy the API and call `GET /api/admin/security/database-role`.
- Confirm `runtime_role=mobipay_runtime`, `is_superuser=false`, `bypasses_rls=false`, `payment_tables_owned_by_runtime_role=0`, and that all expected payment tables have RLS enabled.
- Verify tenant isolation through authenticated API requests using two separate merchant workspaces.
- Keep live payments disabled if any role, grant, policy or isolation result is unexpected.

## Worker scheduler

- Vercel production already has encrypted `WORKER_CRON_SECRET`.
- In Cloudflare Worker `mobipay-payment-worker-cron`, set secret binding `MOBIPAY_WORKER_CRON_SECRET` to the same value.
- Confirm plain-text binding `MOBIPAY_API_URL=https://pay.mobiwave.co.ke`.
- Add Cron Trigger `* * * * *` only after the API containing `POST /api/worker` is deployed.
- Verify a single authenticated invocation returns HTTP 200. Confirm provider-event recovery, Paystack checkout polling and merchant webhook delivery counts; do not expose the secret in logs.

## Provider sandbox verification

- Configure Daraja and Pesapal sandbox credentials per merchant.
- Configure Paystack test secret key and dedicated webhook signing secret per merchant.
- Register the displayed Paystack webhook URL in the provider dashboard.
- Test successful, failed, pending, duplicate, delayed, amount-mismatch and lost-webhook cases.
- Confirm provider verification, ledger transitions, audit events, reconciliation exceptions and merchant webhook retries.
- Verify idempotent retries do not create duplicate provider charges.

## UI and checkout verification

- Wait for the Vercel deployment quota to reset, then verify the preview before merging UI changes.
- Test all merchant pages at desktop and mobile widths.
- Test platform overview, merchant suspension/reactivation, transactions, database security diagnostics and audit history.
- Test the public checkout return page with valid, expired and invalid tokens.
- Test the SDK against sandbox APIs; never use a production token in browser bundles.

## Live release

Live provider credentials, live payment modes and production payment activation require a separate explicit approval after all database, worker, provider, reconciliation, security and UI gates pass.
