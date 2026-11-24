import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "./app.js";

test("merchant payment routes reject unauthenticated tenant and reconciliation requests", async () => {
  const server = createApp().listen(0);
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const requests: Array<[string, RequestInit?]> = [
      ["/api/v1/tenants"],
      ["/api/v1/tenants", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Test merchant", slug: "test-merchant" }) }],
      ["/api/v1/tenants/00000000-0000-4000-8000-000000000001/reconciliation/runs"],
      ["/api/v1/tenants/00000000-0000-4000-8000-000000000001/provider-connections"],
      ["/api/v1/tenants/00000000-0000-4000-8000-000000000001/daraja/stk-push", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }],
    ];
    for (const [path, init] of requests) {
      const response = await fetch(base + path, init);
      assert.equal(response.status, 401, `${init?.method ?? "GET"} ${path} must require Neon Auth`);
      assert.deepEqual(await response.json(), { error: "authentication_required" });
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
