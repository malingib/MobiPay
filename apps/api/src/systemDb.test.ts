import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import {
  issuePaymentWorkerCapability,
  issueProviderSystemCapability,
  providerCapabilityScope,
  withPaymentWorkerTransaction,
  withProviderSystemTransaction,
} from "./systemDb.js";

function fixture() {
  const calls: string[] = [];
  let released = 0;
  const client = {
    async query(sql: string) { calls.push(sql); return { rows: [], rowCount: 0 }; },
    release() { released++; },
  } as unknown as PoolClient;
  const pool = { async connect() { return client; } } as unknown as Pick<Pool, "connect">;
  return { calls, pool, get released() { return released; } };
}

test("provider capability is opaque and bound to one provider correlation", async () => {
  const f = fixture();
  const cap = issueProviderSystemCapability("daraja", "tenant-a", "checkout-1");
  assert.deepEqual(providerCapabilityScope(cap), { provider: "daraja", tenantId: "tenant-a", eventId: "checkout-1" });
  assert.equal(providerCapabilityScope({ provider: "daraja", tenantId: "tenant-a", eventId: "checkout-1" }), undefined);
  await withProviderSystemTransaction(cap, async (_client, scope) => {
    assert.equal(scope.tenantId, "tenant-a");
    assert.equal(scope.eventId, "checkout-1");
  }, f.pool);
  assert.deepEqual(f.calls, ["BEGIN", "COMMIT"]);
  assert.equal(f.released, 1);
});

test("provider and worker capabilities cannot be substituted", async () => {
  const f = fixture();
  const provider = issueProviderSystemCapability("pesapal", "tenant-b", "tracking-2");
  await assert.rejects(withPaymentWorkerTransaction(provider as never, async () => undefined, f.pool), /payment-worker capability/);
  const worker = issuePaymentWorkerCapability();
  await assert.rejects(withProviderSystemTransaction(worker as never, async () => undefined, f.pool), /provider-system capability/);
});

test("worker transaction rolls back and releases on failure", async () => {
  const f = fixture();
  await assert.rejects(
    withPaymentWorkerTransaction(issuePaymentWorkerCapability(), async () => { throw new Error("worker failed"); }, f.pool),
    /worker failed/,
  );
  assert.deepEqual(f.calls, ["BEGIN", "ROLLBACK"]);
  assert.equal(f.released, 1);
});
