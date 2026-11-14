import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { validPaystackSignature } from "./providerRoutes.js";

const credentials={secretKey:"sk_test_123456789012345678901234567890",webhookSecret:"whsec_123456789012345678901234567890"};

test("Paystack modern webhook signature validates the timestamp and raw request bytes",()=>{
  const raw=Buffer.from('{"event":"charge.success","data":{"reference":"mp_test123","amount":1000}}');
  const timestamp=String(Math.floor(Date.now()/1000));
  const signature=createHmac("sha512",credentials.webhookSecret).update(Buffer.concat([Buffer.from(timestamp+"."),raw])).digest("hex");
  assert.equal(validPaystackSignature(raw,`t=${timestamp},v1=whk_test:${signature}`,undefined,credentials),true);
  assert.equal(validPaystackSignature(Buffer.from(raw.toString()+" "),`t=${timestamp},v1=whk_test:${signature}`,undefined,credentials),false);
});

test("Paystack modern webhook signatures reject stale timestamps",()=>{
  const raw=Buffer.from('{"event":"charge.success"}');
  const timestamp=String(Math.floor(Date.now()/1000)-301);
  const signature=createHmac("sha512",credentials.webhookSecret).update(Buffer.concat([Buffer.from(timestamp+"."),raw])).digest("hex");
  assert.equal(validPaystackSignature(raw,`t=${timestamp},v1=whk_test:${signature}`,undefined,credentials),false);
});

test("Paystack legacy x-paystack-signature remains supported with the secret key",()=>{
  const raw=Buffer.from('{"event":"charge.success"}');
  const signature=createHmac("sha512",credentials.secretKey).update(raw).digest("hex");
  assert.equal(validPaystackSignature(raw,undefined,signature,credentials),true);
  assert.equal(validPaystackSignature(Buffer.from("{}"),undefined,signature,credentials),false);
});
