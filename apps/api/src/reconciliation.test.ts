import test from "node:test";
import assert from "node:assert/strict";
import { reconcileRecords } from "./reconciliation.js";

const payment = (overrides: Partial<{id:string;provider:string;providerReference:string;merchantReference:string;amountMinor:number;currency:string}> = {}) => ({
  id: "payment-1", provider: "daraja", providerReference: "ws_CO_123", merchantReference: "ORDER-1", amountMinor: 12500, currency: "KES", ...overrides,
});
const record = (overrides: Partial<{id:string;provider:string;providerReference:string;merchantReference:string;amountMinor:number;currency:string}> = {}) => ({
  id: "record-1", provider: "daraja", providerReference: "ws_CO_123", merchantReference: "ORDER-1", amountMinor: 12500, currency: "KES", ...overrides,
});

test("reconciles a unique provider-reference match with amount and currency", () => {
  const [result] = reconcileRecords([payment()], [record()]);
  assert.equal(result?.status, "matched");
  assert.equal(result?.paymentId, "payment-1");
});

test("flags amount mismatch instead of auto-confirming", () => {
  const [result] = reconcileRecords([payment()], [record({amountMinor: 12400})]);
  assert.equal(result?.status, "amount_mismatch");
});

test("flags ambiguous matches for manual review", () => {
  const [result] = reconcileRecords([payment(), payment({id:"payment-2"})], [record()]);
  assert.equal(result?.status, "ambiguous");
});

test("detects repeated provider references within a statement batch", () => {
  const results = reconcileRecords([payment()], [record(), record({id:"record-2"})]);
  assert.equal(results[0]?.status, "matched");
  assert.equal(results[1]?.status, "duplicate");
});

test("does not match records across providers", () => {
  const [result] = reconcileRecords([payment()], [record({provider:"pesapal"})]);
  assert.equal(result?.status, "unmatched");
});
