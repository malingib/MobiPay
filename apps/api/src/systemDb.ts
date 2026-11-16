import { createHash, randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./db.js";

export type ProviderName = "daraja" | "pesapal" | "paystack";
const providerBrand: unique symbol = Symbol("provider-system-capability");
const workerBrand: unique symbol = Symbol("payment-worker-capability");

export interface ProviderSystemCapability {
  readonly [providerBrand]: true;
}
export interface PaymentWorkerCapability {
  readonly [workerBrand]: true;
}
const providerCapabilities = new WeakMap<object, { provider: ProviderName; tenantId: string; eventId: string }>();
const workerCapabilities = new WeakSet<object>();

/** Mint only after the provider callback route has validated its provider-specific intake. */
export function issueProviderSystemCapability(provider: ProviderName, tenantId: string, eventId: string): ProviderSystemCapability {
  if (!tenantId || !eventId || eventId.length > 200) throw new Error("Provider capability requires a bounded tenant and event correlation");
  const capability = Object.freeze({ [providerBrand]: true as const });
  providerCapabilities.set(capability, { provider, tenantId, eventId });
  return capability;
}

/** Mint only inside the private worker process path; never from an HTTP request. */
export function issuePaymentWorkerCapability(): PaymentWorkerCapability {
  const capability = Object.freeze({ [workerBrand]: true as const });
  workerCapabilities.add(capability);
  return capability;
}

export function providerCapabilityScope(value: unknown) {
  return typeof value === "object" && value !== null ? providerCapabilities.get(value) : undefined;
}
export function isPaymentWorkerCapability(value: unknown): value is PaymentWorkerCapability {
  return typeof value === "object" && value !== null && workerCapabilities.has(value);
}

async function inTransaction<T>(operation: (client: pg.PoolClient) => Promise<T>, pool: Pick<pg.Pool, "connect"> = getPool()): Promise<T> {
  const client = await pool.connect();
  let active = false;
  try {
    await client.query("BEGIN");
    active = true;
    await client.query("SET LOCAL ROLE mobipay_runtime");
    const result = await operation(client);
    await client.query("COMMIT");
    active = false;
    return result;
  } catch (error) {
    if (active) await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function withProviderSystemTransaction<T>(
  capability: ProviderSystemCapability,
  operation: (client: pg.PoolClient, scope: { provider: ProviderName; tenantId: string; eventId: string }) => Promise<T>,
  pool?: Pick<pg.Pool, "connect">,
): Promise<T> {
  const scope = providerCapabilityScope(capability);
  if (!scope) throw new Error("A provider-system capability issued by the callback boundary is required");
  return inTransaction(async (client) => {
    await client.query("SELECT set_config('app.provider_system_tenant_id', $1, true)", [scope.tenantId]);
    await client.query("SELECT set_config('app.provider_system_provider', $1, true)", [scope.provider]);
    await client.query("SELECT set_config('app.provider_system_event_id', $1, true)", [scope.eventId]);
    return operation(client, scope);
  }, pool);
}

export async function withPaymentWorkerTransaction<T>(
  capability: PaymentWorkerCapability,
  operation: (client: pg.PoolClient) => Promise<T>,
  pool?: Pick<pg.Pool, "connect">,
): Promise<T> {
  if (!isPaymentWorkerCapability(capability)) throw new Error("A payment-worker capability is required");
  return inTransaction(async (client) => {
    await client.query("SELECT set_config('app.payment_worker', $1, true)", ["true"]);
    return operation(client);
  }, pool);
}

export function newLeaseToken(): string {
  return randomUUID();
}


/** Read-only public checkout status, authorized by an unguessable 256-bit bearer token. */
export async function readPublicCheckout(tenantId: string, token: string) {
  if (!/^[A-Za-z0-9_-]{40,64}$/.test(token)) return undefined;
  const tokenHash=createHash("sha256").update(token).digest("hex");
  const result=await inTransaction(async(client)=>{
    await client.query("select set_config('app.public_checkout_token_hash',$1,true)",[tokenHash]);
    return client.query(
      "select id,provider,merchant_reference,amount_minor,currency,status,provider_receipt,confirmed_at,created_at from public.payment_transactions where tenant_id=$1 and public_checkout_token_hash=$2 and public_checkout_expires_at>now()",
      [tenantId,tokenHash],
    );
  });
  return result.rows[0] as {id:string;provider:string;merchant_reference:string;amount_minor:string|number;currency:string;status:string;provider_receipt:string|null;confirmed_at:string|null;created_at:string}|undefined;
}
