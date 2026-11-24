import test from "node:test";
import assert from "node:assert/strict";
import { providerEventRecoverySelectionSql } from "./providerEventRecoveryWorker.js";

test("provider recovery SQL correlates all supported provider identifiers", () => {
  assert.match(providerEventRecoverySelectionSql, /provider_checkout_request_id=e\.provider_event_id/);
  assert.match(providerEventRecoverySelectionSql, /provider_order_tracking_id=e\.provider_event_id/);
  assert.match(providerEventRecoverySelectionSql, /provider_payment_reference=e\.provider_event_id/);
});

test("provider recovery SQL contains real line breaks, not escaped newline text", () => {
  assert.equal(providerEventRecoverySelectionSql.includes("\\n"), false);
  assert.match(providerEventRecoverySelectionSql, /\) or\s+\(e\.provider='paystack'/);
});

test("provider recovery claims rows with a lease and skip-locked concurrency control", () => {
  assert.match(providerEventRecoverySelectionSql, /lease_expires_at <= now\(\)/);
  assert.match(providerEventRecoverySelectionSql, /for update of e skip locked/i);
});
