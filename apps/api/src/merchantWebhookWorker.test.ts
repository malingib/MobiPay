import test from "node:test";
import assert from "node:assert/strict";
import { signMerchantWebhookPayload } from "./merchantWebhookWorker.js";

test("merchant webhook signatures are deterministic for the exact JSON payload", () => {
  const payload = { id: "txn-1.succeeded", type: "payment.succeeded", data: { amountMinor: 12500 } };
  const first = signMerchantWebhookPayload(payload, "test-secret");
  const second = signMerchantWebhookPayload(payload, "test-secret");
  assert.equal(first, second);
  assert.match(first, /^[a-f0-9]{64}$/);
});

test("merchant webhook signatures change when payload or secret changes", () => {
  const payload = { id: "txn-1.succeeded", amountMinor: 12500 };
  assert.notEqual(signMerchantWebhookPayload(payload, "secret-a"), signMerchantWebhookPayload(payload, "secret-b"));
  assert.notEqual(signMerchantWebhookPayload(payload, "secret-a"), signMerchantWebhookPayload({ ...payload, amountMinor: 12501 }, "secret-a"));
});
