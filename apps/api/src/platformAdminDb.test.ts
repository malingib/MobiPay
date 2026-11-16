import assert from "node:assert/strict";
import test from "node:test";
import type { Pool, PoolClient } from "pg";
import { createAdminSession, requirePlatformAdmin } from "./platformAdminSession.js";
import { withPlatformAdminTransaction } from "./platformAdminDb.js";

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

test("platform admin DB path rejects a forged structural capability before connecting", async () => {
  let connects = 0;
  const pool = { async connect() { connects++; throw new Error("must not connect"); } } as unknown as Pick<Pool,"connect">;
  await assert.rejects(
    withPlatformAdminTransaction({ username: "admin" } as never, async () => undefined, pool),
    /verified platform-admin capability/,
  );
  assert.equal(connects,0);
});

test("platform admin DB path accepts only a session-middleware-issued capability", async () => {
  const prior = process.env.PLATFORM_ADMIN_SESSION_SECRET;
  process.env.PLATFORM_ADMIN_SESSION_SECRET = "test-session-secret-that-is-long-enough-123456";
  const f=fixture();
  try {
    const token=createAdminSession("ops");
    const req={headers:{cookie:"mobiwave_platform_admin="+token}} as any;
    const res={status(){return this;},json(){return this;}} as any;
    let nextCalled=false;
    requirePlatformAdmin(req,res,()=>{nextCalled=true;});
    assert.equal(nextCalled,true);
    const actor=await withPlatformAdminTransaction(req.platformAdminCapability,async(_client,username)=>username,f.pool);
    assert.equal(actor,"ops");
    assert.deepEqual(f.calls,["BEGIN","COMMIT"]);
    assert.equal(f.released,1);
  } finally {
    if(prior===undefined) delete process.env.PLATFORM_ADMIN_SESSION_SECRET;
    else process.env.PLATFORM_ADMIN_SESSION_SECRET=prior;
  }
});

test("platform admin DB path rolls back failed writes", async () => {
  const prior = process.env.PLATFORM_ADMIN_SESSION_SECRET;
  process.env.PLATFORM_ADMIN_SESSION_SECRET = "test-session-secret-that-is-long-enough-123456";
  const f=fixture();
  try {
    const token=createAdminSession("ops");
    const req={headers:{cookie:"mobiwave_platform_admin="+token}} as any;
    const res={status(){return this;},json(){return this;}} as any;
    requirePlatformAdmin(req,res,()=>undefined);
    await assert.rejects(withPlatformAdminTransaction(req.platformAdminCapability,async()=>{throw new Error("admin write failed");},f.pool),/admin write failed/);
    assert.deepEqual(f.calls,["BEGIN","ROLLBACK"]);
    assert.equal(f.released,1);
  } finally {
    if(prior===undefined) delete process.env.PLATFORM_ADMIN_SESSION_SECRET;
    else process.env.PLATFORM_ADMIN_SESSION_SECRET=prior;
  }
});
