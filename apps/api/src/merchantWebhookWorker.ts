import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { getPool } from "./db.js";

const MAX_ATTEMPTS = 8;
const DELIVERY_TIMEOUT_MS = 8_000;

function privateIp(address: string): boolean {
  if (isIP(address) === 4) {
    const p = address.split(".").map(Number);
    return p[0] === 0 || p[0] === 10 || p[0] === 127 ||
      (p[0] === 169 && p[1] === 254) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
      (p[0] === 192 && p[1] === 168) || (p[0] === 100 && p[1] >= 64 && p[1] <= 127) ||
      p[0] >= 224;
  }
  const normalized = address.toLowerCase();
  return normalized === "::" || normalized === "::1" || normalized.startsWith("fc") ||
    normalized.startsWith("fd") || normalized.startsWith("fe8") || normalized.startsWith("fe9") ||
    normalized.startsWith("fea") || normalized.startsWith("feb") || normalized.startsWith("::ffff:127.") ||
    normalized.startsWith("::ffff:10.") || normalized.startsWith("::ffff:192.168.");
}

export async function assertSafeWebhookUrl(raw: string) {
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new Error("Webhook URL must be a credential-free HTTPS URL on port 443");
  }
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("Webhook hostname is not publicly routable");
  }
  if (isIP(host)) {
    if (privateIp(host)) throw new Error("Private IP webhook destinations are not allowed");
    return;
  }
  const addresses = await lookup(host, { all: true, verbatim: true });
  if (!addresses.length || addresses.some((entry) => privateIp(entry.address))) {
    throw new Error("Webhook hostname resolves to a non-public address");
  }
}

export function signMerchantWebhookPayload(payload: unknown, secret: string): string {
  return createHmac("sha256", secret).update(JSON.stringify(payload)).digest("hex");
}

function resolveSecret(reference: string): string {
  if (!/^[A-Z][A-Z0-9_]{2,127}$/.test(reference)) throw new Error("Invalid webhook secret reference");
  const value = process.env[reference];
  if (!value || value.length < 32) throw new Error("Webhook signing secret is missing or too short");
  return value;
}

/** Deliver a bounded batch. Safe to run repeatedly; rows are claimed using SKIP LOCKED. */
export async function processDueMerchantWebhookDeliveries(batchSize = 20): Promise<{ delivered: number; retried: number; deadLettered: number }> {
  const counts = { delivered: 0, retried: 0, deadLettered: 0 };
  for (let i = 0; i < Math.max(1, Math.min(100, batchSize)); i++) {
    const client = await getPool().connect();
    let delivery: { id: string; endpoint_id: string; event_id: string; event_type: string; payload: unknown; attempts: number; url: string; signing_secret_reference: string } | undefined;
    try {
      await client.query("begin");
      const selected = await client.query(
        `select d.id,d.endpoint_id,d.event_id,d.event_type,d.payload,d.attempts,e.url,e.signing_secret_reference
         from public.payment_merchant_webhook_deliveries d
         join public.payment_merchant_webhook_endpoints e on e.id=d.endpoint_id and e.enabled=true
         where ((d.status in ('pending','retry') and d.next_attempt_at <= now()) or (d.status='delivering' and d.claimed_at < now()-interval '5 minutes'))
         order by d.next_attempt_at,d.created_at
         limit 1 for update of d skip locked`,
      );
      delivery = selected.rows[0];
      if (!delivery) { await client.query("commit"); break; }
      await client.query(
        "update public.payment_merchant_webhook_deliveries set status='delivering',attempts=attempts+1,claimed_at=now(),updated_at=now(),last_error=null where id=$1",
        [delivery.id],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }

    const attempt = Number(delivery.attempts) + 1;
    try {
      await assertSafeWebhookUrl(delivery.url);
      const secret = resolveSecret(delivery.signing_secret_reference);
      const body = JSON.stringify(delivery.payload);
      const signature = signMerchantWebhookPayload(delivery.payload, secret);
      const response = await fetch(delivery.url, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-mobiwave-event-id": delivery.event_id,
          "x-mobiwave-event-type": delivery.event_type,
          "x-mobiwave-signature": `sha256=${signature}`,
          "user-agent": "MobiWave-Payments-Webhooks/1.0",
        },
        body,
        signal: AbortSignal.timeout(DELIVERY_TIMEOUT_MS),
      });
      if (!response.ok) throw Object.assign(new Error(`Webhook endpoint returned HTTP ${response.status}`), { status: response.status });
      await getPool().query(
        "update public.payment_merchant_webhook_deliveries set status='delivered',last_http_status=$2,delivered_at=now(),claimed_at=null,updated_at=now(),last_error=null where id=$1",
        [delivery.id,response.status],
      );
      counts.delivered++;
    } catch (error) {
      const status = (error as { status?: number }).status ?? null;
      const message = (error instanceof Error ? error.message : "Unknown webhook delivery error").slice(0, 1000);
      const dead = attempt >= MAX_ATTEMPTS;
      const delaySeconds = Math.min(21_600, 30 * (2 ** Math.min(attempt - 1, 10)));
      await getPool().query(
        "update public.payment_merchant_webhook_deliveries set status=$2,last_http_status=$3,last_error=$4,claimed_at=null,updated_at=now(),next_attempt_at=now()+($5 * interval '1 second') where id=$1",
        [delivery.id,dead ? "dead_letter" : "retry",status,message,delaySeconds],
      );
      if (dead) counts.deadLettered++; else counts.retried++;
    }
  }
  return counts;
}
