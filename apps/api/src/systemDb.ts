import { randomUUID } from "node:crypto";
import type pg from "pg";
import { getPool } from "./db.js";

export type ProviderName = "daraja" | "pesapal";
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
  return inTransaction((client) => operation(client, scope), pool);
}

export async function withPaymentWorkerTransaction<T>(
  capability: PaymentWorkerCapability,
  operation: (client: pg.PoolClient) => Promise<T>,
  pool?: Pick<pg.Pool, "connect">,
): Promise<T> {
  if (!isPaymentWorkerCapability(capability)) throw new Error("A payment-worker capability is required");
  return inTransaction(operation, pool);
}

export function newLeaseToken(): string {
  return randomUUID();
}
