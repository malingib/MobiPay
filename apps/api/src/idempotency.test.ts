import test from "node:test";
import assert from "node:assert/strict";
import { matchesIdempotentPaymentRequest } from "./idempotency.js";

const request = {
  provider: "manual",
  merchantReference: "ORDER-100",
  amountMinor: 12500,
  currency: "KES",
  payerReference: "254712345678",
  payerEmail: "payer@example.com",
  description: "Invoice 100",
};
const record = {
  provider: "manual",
  merchant_reference: "ORDER-100",
  amount_minor: "12500",
  currency: "KES",
  payer_reference: "254712345678",
  payer_email: "payer@example.com",
  description: "Invoice 100",
};

test("accepts an exact idempotent payment replay", () => {
  assert.equal(matchesIdempotentPaymentRequest(record, request), true);
});

test("rejects a replay with a changed payer reference", () => {
  assert.equal(matchesIdempotentPaymentRequest(record, { ...request, payerReference: "254700000000" }), false);
});

test("rejects a replay with a changed description", () => {
  assert.equal(matchesIdempotentPaymentRequest(record, { ...request, description: "Different invoice" }), false);
});

test("normalizes absent optional fields to null", () => {
  const existing = { ...record, payer_reference: null, description: null };
  const requested = { ...request, payerReference: undefined, description: undefined };
  assert.equal(matchesIdempotentPaymentRequest(existing, requested), true);
});

test("rejects a replay with a changed payer email", () => {
  assert.equal(matchesIdempotentPaymentRequest(record, { ...request, payerEmail: "other@example.com" }), false);
});
