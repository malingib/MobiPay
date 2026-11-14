import test from "node:test";
import assert from "node:assert/strict";
import { initiatePaystackCheckout, verifyPaystackCredentials, verifyPaystackTransaction } from "./providers.js";

const credentials={secretKey:"sk_test_123456789012345678901234567890",webhookSecret:"whsec_123456789012345678901234567890"};
const originalFetch=globalThis.fetch;

test("Paystack credential verification uses a read-only authenticated balance request",async()=>{
  let requested="";
  globalThis.fetch=(async(input,init)=>{
    requested=String(input);
    assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${credentials.secretKey}`);
    return new Response(JSON.stringify({status:true,data:[{currency:"KES",balance:1000}]}),{status:200});
  }) as typeof fetch;
  try {
    assert.equal(await verifyPaystackCredentials(credentials),true);
    assert.equal(requested,"https://api.paystack.co/balance");
  } finally { globalThis.fetch=originalFetch; }
});

test("Paystack hosted checkout sends KES minor units and only supported checkout channels",async()=>{
  let requestBody:Record<string,unknown>|undefined;
  globalThis.fetch=(async(_input,init)=>{
    requestBody=JSON.parse(String(init?.body));
    return new Response(JSON.stringify({status:true,data:{authorization_url:"https://checkout.paystack.com/example",access_code:"access",reference:"mp-test123"}}),{status:200});
  }) as typeof fetch;
  try {
    const result=await initiatePaystackCheckout({amountMinor:12550,email:"customer@example.com",reference:"mp-test123",callbackUrl:"https://pay.mobiwave.co.ke/checkout/complete",metadata:{tenantId:"tenant"}},credentials);
    assert.equal(result.authorizationUrl,"https://checkout.paystack.com/example");
    assert.equal(requestBody?.amount,"12550");
    assert.equal(requestBody?.currency,"KES");
    assert.deepEqual(requestBody?.channels,["card","mobile_money"]);
    assert.equal(requestBody?.reference,"mp-test123");
  } finally { globalThis.fetch=originalFetch; }
});

test("Paystack transaction verification encodes the reference and authenticates the request",async()=>{
  let requested="";
  globalThis.fetch=(async(input,init)=>{
    requested=String(input);
    assert.equal(new Headers(init?.headers).get("authorization"),`Bearer ${credentials.secretKey}`);
    return new Response(JSON.stringify({status:true,data:{status:"success",amount:12550,currency:"KES",reference:"mp-test123"}}),{status:200});
  }) as typeof fetch;
  try {
    const result=await verifyPaystackTransaction("mp-test123",credentials);
    assert.equal(result.status,"success");
    assert.equal(requested,"https://api.paystack.co/transaction/verify/mp-test123");
  } finally { globalThis.fetch=originalFetch; }
});
