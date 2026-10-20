import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import app from "../src/app.js";

let server: ReturnType<typeof app.listen>;
let baseUrl: string;

before(async () => {
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Test server did not bind to a TCP port");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test("health endpoint reports service status without payment claims", async () => {
  const response = await fetch(`${baseUrl}/health`);
  const body = await response.json() as { service: string; status: string };
  assert.equal(response.status, 200);
  assert.equal(body.service, "mobiwave-payments-api");
  assert.equal(body.status, "ok");
});

test("API version endpoint explicitly keeps live payments disabled", async () => {
  const response = await fetch(`${baseUrl}/api/v1`);
  const body = await response.json() as { status: string; livePaymentsEnabled: boolean };
  assert.equal(response.status, 200);
  assert.equal(body.status, "foundation");
  assert.equal(body.livePaymentsEnabled, false);
});

test("unknown routes return a stable 404 response", async () => {
  const response = await fetch(`${baseUrl}/not-a-route`);
  const body = await response.json() as { error: string };
  assert.equal(response.status, 404);
  assert.equal(body.error, "not_found");
});

test("malformed JSON is rejected with a 400 response", async () => {
  const response = await fetch(`${baseUrl}/api/v1`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{invalid",
  });
  const body = await response.json() as { error: string };
  assert.equal(response.status, 400);
  assert.equal(body.error, "invalid_json");
});

test("disallowed browser origins are rejected", async () => {
  const response = await fetch(`${baseUrl}/health`, { headers: { origin: "https://untrusted.example" } });
  const body = await response.json() as { error: string };
  assert.equal(response.status, 403);
  assert.equal(body.error, "origin_not_allowed");
});
