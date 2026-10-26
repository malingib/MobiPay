import test from "node:test";
import assert from "node:assert/strict";
import { parseStatementCsv, sha256Statement } from "./statementImport.js";

test("parses a normal statement CSV", () => {
  const rows=parseStatementCsv("provider_reference,merchant_reference,amount_minor,currency,occurred_at\nRCP123,ORDER-1,12500,KES,2026-10-25T10:00:00Z");
  assert.equal(rows.length,1);
  assert.equal(rows[0]?.providerReference,"RCP123");
  assert.equal(rows[0]?.amountMinor,12500);
  assert.equal(rows[0]?.currency,"KES");
});

test("supports quoted commas, escaped quotes and embedded newlines", () => {
  const rows=parseStatementCsv('provider_reference,merchant_reference,amount_minor,currency,description\nRCP123,ORDER-1,12500,KES,"line one, ""quoted""\nline two"');
  assert.equal(rows[0]?.raw.description,'line one, "quoted"\nline two');
});

test("rejects malformed or unsafe numeric records", () => {
  assert.throws(()=>parseStatementCsv("provider_reference,merchant_reference,amount_minor,currency\nR,ORDER,-1,KES"),/invalid amount/);
  assert.throws(()=>parseStatementCsv('provider_reference,merchant_reference,amount_minor,currency\nR,ORDER,12500,KES,"unterminated'),/unterminated quoted/);
  assert.throws(()=>parseStatementCsv("provider_reference,merchant_reference,amount_minor,currency\nR,ORDER,12500,USDD"),/invalid currency/);
});

test("statement hash is stable and content-sensitive", () => {
  assert.equal(sha256Statement("abc"),sha256Statement("abc"));
  assert.notEqual(sha256Statement("abc"),sha256Statement("abd"));
});
