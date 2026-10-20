import assert from "node:assert/strict";
import { test } from "node:test";
import { reconcileRecords, type LedgerPayment, type ProviderRecord } from "../src/reconciliation.js";

const payments: LedgerPayment[] = [
  { id: "p1", provider: "daraja", providerReference: "QWE123", merchantReference: "INV-100", amountMinor: 125000, currency: "KES" },
  { id: "p2", provider: "pesapal", providerReference: "PESA-9", merchantReference: "INV-101", amountMinor: 420000, currency: "KES" },
];

test("matches unique provider reference with exact amount and currency", () => {
  const records: ProviderRecord[] = [{ id: "r1", provider: "DARAJA", providerReference: " qwe123 ", merchantReference: "INV-100", amountMinor: 125000, currency: "kes" }];
  assert.deepEqual(reconcileRecords(payments, records).map((r) => [r.status, r.paymentId]), [["matched", "p1"]]);
});

test("flags amount mismatch without treating the payment as successful", () => {
  const records: ProviderRecord[] = [{ id: "r1", provider: "daraja", providerReference: "QWE123", merchantReference: "INV-100", amountMinor: 1, currency: "KES" }];
  assert.equal(reconcileRecords(payments, records)[0]?.status, "amount_mismatch");
});

test("falls back to exact merchant reference when provider reference is unavailable", () => {
  const records: ProviderRecord[] = [{ id: "r1", provider: "pesapal", merchantReference: "INV-101", amountMinor: 420000, currency: "KES" }];
  assert.equal(reconcileRecords(payments, records)[0]?.paymentId, "p2");
});

test("does not force a match when merchant reference is ambiguous", () => {
  const duplicatePayments = [...payments, { ...payments[0]!, id: "p3", providerReference: "OTHER" }];
  const records: ProviderRecord[] = [{ id: "r1", provider: "daraja", merchantReference: "INV-100", amountMinor: 125000, currency: "KES" }];
  assert.equal(reconcileRecords(duplicatePayments, records)[0]?.status, "ambiguous");
});

test("flags duplicate provider records in a batch", () => {
  const records: ProviderRecord[] = [
    { id: "r1", provider: "daraja", providerReference: "QWE123", merchantReference: "INV-100", amountMinor: 125000, currency: "KES" },
    { id: "r2", provider: "daraja", providerReference: "QWE123", merchantReference: "INV-100", amountMinor: 125000, currency: "KES" },
  ];
  assert.deepEqual(reconcileRecords(payments, records).map((r) => r.status), ["matched", "duplicate"]);
});

test("keeps unmatched provider records in the exception path", () => {
  const records: ProviderRecord[] = [{ id: "r1", provider: "daraja", providerReference: "MISSING", merchantReference: "MISSING", amountMinor: 200, currency: "KES" }];
  assert.equal(reconcileRecords(payments, records)[0]?.status, "unmatched");
});
