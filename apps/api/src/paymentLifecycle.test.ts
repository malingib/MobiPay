import test from "node:test";
import assert from "node:assert/strict";
import { assertAllowedPaymentTransition, isAllowedPaymentTransition } from "./paymentLifecycle.js";

test("payment lifecycle permits expected provider-confirmation paths", () => {
  assert.equal(isAllowedPaymentTransition("created", "pending"), true);
  assert.equal(isAllowedPaymentTransition("pending", "succeeded"), true);
  assert.equal(isAllowedPaymentTransition("pending", "unknown"), true);
  assert.equal(isAllowedPaymentTransition("unknown", "succeeded"), true);
  assert.equal(isAllowedPaymentTransition("unknown", "pending"), true);
});

test("payment lifecycle prevents late callbacks from rewriting terminal outcomes", () => {
  for (const terminal of ["succeeded", "failed", "cancelled", "expired"] as const) {
    assert.equal(isAllowedPaymentTransition(terminal, "pending"), false);
    assert.equal(isAllowedPaymentTransition(terminal, "succeeded"), terminal === "succeeded");
  }
  assert.throws(() => assertAllowedPaymentTransition("succeeded", "failed"), /Invalid payment status transition/);
});

test("same-state callback retries remain idempotent", () => {
  assert.equal(isAllowedPaymentTransition("succeeded", "succeeded"), true);
});
