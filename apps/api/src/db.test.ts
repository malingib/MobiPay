import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { withUserTransaction } from "./db.js";
import { issueMerchantDatabaseCapability } from "./auth.js";

function fixture() {
  const calls: Array<{ sql: string; values?: unknown[] }> = [];
  let released = 0;
  const client = {
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [], rowCount: 0 };
    },
    release() { released += 1; },
  } as unknown as PoolClient;
  const pool = {
    async connect() { return client; },
  } as unknown as Pick<Pool, "connect">;
  return { calls, pool, get released() { return released; } };
}

test("withUserTransaction sets verified identity transaction-locally on the checked-out client", async () => {
  const f = fixture();
  const result = await withUserTransaction(issueMerchantDatabaseCapability("auth0|verified-user"), async (client) => {
    await client.query("select 42");
    return "ok";
  }, f.pool);

  assert.equal(result, "ok");
  assert.deepEqual(f.calls, [
    { sql: "BEGIN", values: undefined },
    { sql: "SELECT set_config('app.user_id', $1, true)", values: ["auth0|verified-user"] },
    { sql: "select 42", values: undefined },
    { sql: "COMMIT", values: undefined },
  ]);
  assert.equal(f.released, 1);
});

test("withUserTransaction rolls back on operation failure and always releases the client", async () => {
  const f = fixture();
  await assert.rejects(
    withUserTransaction(issueMerchantDatabaseCapability("verified-user"), async () => {
      throw new Error("operation failed");
    }, f.pool),
    /operation failed/,
  );
  assert.deepEqual(f.calls.map((call) => call.sql), [
    "BEGIN",
    "SELECT set_config('app.user_id', $1, true)",
    "ROLLBACK",
  ]);
  assert.equal(f.released, 1);
});

test("withUserTransaction rejects missing identity before checking out a connection", async () => {
  let connects = 0;
  const pool = {
    async connect() { connects += 1; throw new Error("should not connect"); },
  } as unknown as Pick<Pool, "connect">;

  await assert.rejects(
    withUserTransaction({} as never, async () => undefined, pool),
    /verified merchant database capability is required/,
  );
  assert.equal(connects, 0);
});
