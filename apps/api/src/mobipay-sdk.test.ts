import assert from "node:assert/strict";
import test from "node:test";
import { MobiPayClient, MobiPayError } from "../../../sdk/index.js";

test("SDK sends a verified bearer token and creates Paystack checkout idempotently", async () => {
  let requestUrl="";
  let requestInit:RequestInit|undefined;
  const client=new MobiPayClient({
    baseUrl:"https://pay.mobiwave.co.ke/",
    accessToken:async()=>"verified-neon-token",
    fetch:async(input,init)=>{
      requestUrl=String(input);requestInit=init;
      return new Response(JSON.stringify({transactionId:"txn-1",redirectUrl:"https://checkout.paystack.com/test"}),{status:201,headers:{"content-type":"application/json"}});
    },
  });
  const result=await client.createPaystackCheckout("tenant/one",{amountMinor:12500,merchantReference:"INV-1042",description:"Invoice 1042",email:"customer@example.com"},"idem-1042");
  assert.equal(requestUrl,"https://pay.mobiwave.co.ke/api/v1/tenants/tenant%2Fone/paystack/checkout");
  assert.equal(new Headers(requestInit?.headers).get("authorization"),"Bearer verified-neon-token");
  assert.equal(new Headers(requestInit?.headers).get("idempotency-key"),"idem-1042");
  assert.equal(JSON.parse(String(requestInit?.body)).amountMinor,12500);
  assert.equal(result.redirectUrl,"https://checkout.paystack.com/test");
});

test("SDK public checkout status lookup does not send merchant credentials", async () => {
  let requestInit:RequestInit|undefined;
  const client=new MobiPayClient({
    accessToken:"must-not-be-sent",
    fetch:async(_input,init)=>{
      requestInit=init;
      return new Response(JSON.stringify({transaction:{status:"succeeded"}}),{status:200});
    },
  });
  const result=await client.getPublicCheckoutStatus("tenant-1","opaque-token");
  assert.equal(new Headers(requestInit?.headers).has("authorization"),false);
  assert.equal(result.transaction.status,"succeeded");
});

test("SDK surfaces structured API errors", async () => {
  const client=new MobiPayClient({
    accessToken:"verified-token",
    fetch:async()=>new Response(JSON.stringify({error:"paystack_not_connected",message:"Connect Paystack first."}),{status:409}),
  });
  await assert.rejects(client.listTenants(),(error:unknown)=>{
    assert.ok(error instanceof MobiPayError);
    assert.equal(error.status,409);
    assert.equal(error.code,"paystack_not_connected");
    return true;
  });
});
