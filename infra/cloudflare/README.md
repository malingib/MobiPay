# MobiPay scheduled payment workers

The API worker entrypoint is `api/worker.ts`. It is intentionally an authenticated, bounded, one-iteration endpoint; it does not start an in-process timer inside a Vercel Function.

Vercel Hobby permits only daily Cron Jobs, which is not frequent enough for payment callback recovery and merchant webhook delivery. The scheduler therefore runs as a Cloudflare Worker with a five-minute Cron Trigger. The deployed scheduler source is `infra/cloudflare/mobipay-payment-worker-cron.js`.

Required Cloudflare bindings:
- `MOBIPAY_API_URL`: `https://pay.mobiwave.co.ke` (plain text).
- `MOBIPAY_WORKER_CRON_SECRET`: the same random secret stored as Vercel's encrypted `WORKER_CRON_SECRET`.

Trigger: `*/5 * * * *` (UTC).

The scheduler sends one authenticated POST to `/api/worker`. The API claims work using database lease tokens and `FOR UPDATE SKIP LOCKED`; duplicate scheduler invocations are safe. Do not point preview schedulers at production databases. Do not log or expose either secret.

Deployment order:
1. Deploy the API branch containing `api/worker.ts` after its CI and security dependencies pass.
2. Set Vercel `WORKER_CRON_SECRET` for production.
3. Deploy the Cloudflare Worker, bind the production API URL and same secret, and configure the five-minute Cron Trigger.
4. Verify an authorized invocation returns HTTP 200 and inspect worker queue metrics before enabling live payments.
