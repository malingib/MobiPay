import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { withUserTransaction } from "./db.js";
import { issueProviderSystemCapability, withProviderSystemTransaction } from "./systemDb.js";
import type { ProviderSystemCapability } from "./systemDb.js";
import { randomUUID } from "node:crypto";
import { requireAuth } from "./auth.js";
import { getTenantProviderCredentials } from "./providerConnections.js";
import { initiateDarajaStk, queryDarajaStk, queryPesapalStatus, sha256Payload, submitPesapalOrder } from "./providers.js";

const router = Router();
const idSchema = z.string().uuid();
const stkSchema = z.object({
  phone: z.string().regex(/^254[17][0-9]{8}$/),
  amountMinor: z.number().int().positive().max(10_000_000).refine((n) => n % 100 === 0, "M-Pesa STK amount must be whole KES"),
  merchantReference: z.string().trim().min(1).max(120),
  description: z.string().trim().max(100).default("MobiWave payment"),
});
const pesapalSchema = z.object({
  amountMinor: z.number().int().positive().max(100_000_000),
  merchantReference: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().trim().max(30).optional(),
});

async function getMembership(userId: string, tenantId: string) {
  const r = await withUserTransaction(userId, (client) => client.query("select m.role from public.payment_tenant_memberships m join public.payment_tenants t on t.id=m.tenant_id where m.tenant_id=$1 and m.user_id=$2 and m.status='active' and t.status='active'", [tenantId,userId]));
  return r.rows[0] as { role: string } | undefined;
}
function tokenMatches(supplied: string, expected: string) {
  const a = Buffer.from(supplied), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a,b);
}
function baseUrl() {
  const base = process.env.PUBLIC_API_BASE_URL;
  if (!base || !base.startsWith("https://")) throw new Error("PUBLIC_API_BASE_URL must be an HTTPS URL");
  return base.replace(/\/$/, "");
}

router.post("/tenants/:tenantId/daraja/stk-push", requireAuth, async (req,res,next) => {
  const tenantId = String(req.params.tenantId ?? "");
  const parsed = stkSchema.safeParse(req.body);
  if (!idSchema.safeParse(tenantId).success || !parsed.success) return res.status(400).json({ error:"invalid_request",details:parsed.success ? undefined : parsed.error.flatten() });
  try {
    const member = await getMembership(req.authUser!.id,tenantId);
    if (!member) return res.status(404).json({ error:"tenant_not_found" });
    if (!["owner","admin","finance"].includes(member.role)) return res.status(403).json({ error:"insufficient_role" });
    let providerCredentials: Record<string, string>;
    try { providerCredentials = await getTenantProviderCredentials(tenantId, "daraja", {kind:"merchant",userId:req.authUser!.id}) as Record<string, string>; }
    catch { return res.status(409).json({ error: "daraja_not_connected", message: "Connect and verify this merchant’s Daraja sandbox credentials first." }); }
    if ((process.env.DARAJA_ENV ?? "sandbox") !== "sandbox") return res.status(403).json({ error:"live_payments_disabled" });
    const idempotencyKey = req.header("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 160) return res.status(400).json({ error:"idempotency_key_required" });
    const d = parsed.data;
    const outcome = await withUserTransaction(req.authUser!.id, async (client) => {
      const inserted = await client.query(
        "insert into public.payment_transactions(tenant_id,provider,merchant_reference,idempotency_key,amount_minor,currency,status,payer_reference,description) values($1,'daraja',$2,$3,$4,'KES','created',$5,$6) on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing returning id,provider_transaction_id,status",
        [tenantId,d.merchantReference,idempotencyKey,d.amountMinor,d.phone,d.description],
      );
      if (inserted.rows[0]) return { transaction: inserted.rows[0], created: true };
      const prior = await client.query("select id,provider,merchant_reference,amount_minor,idempotency_key,provider_checkout_request_id,status,payer_reference,description from public.payment_transactions where tenant_id=$1 and idempotency_key=$2",[tenantId,idempotencyKey]);
      return { transaction: prior.rows[0], created: false };
    });
    const transaction = outcome.transaction;
    if (!outcome.created) {
      if (!transaction || transaction.provider!=="daraja" || transaction.merchant_reference!==d.merchantReference || Number(transaction.amount_minor)!==d.amountMinor || transaction.payer_reference!==d.phone || transaction.description!==d.description) return res.status(409).json({error:"idempotency_conflict"});
      return res.status(200).json({transactionId:transaction.id,status:transaction.status,checkoutRequestId:transaction.provider_checkout_request_id,idempotentReplay:true});
    }

    const callbackToken = process.env.DARAJA_CALLBACK_TOKEN;
    if (!callbackToken || callbackToken.length < 32) return res.status(503).json({error:"daraja_callback_token_not_configured",transactionId:transaction.id});
    const callbackUrl = `${baseUrl()}/api/v1/webhooks/daraja/${tenantId}/${callbackToken}`;
    try {
      const provider = await initiateDarajaStk({phone:d.phone,amount:d.amountMinor/100,accountReference:d.merchantReference,description:d.description,callbackUrl}, providerCredentials);
      await withUserTransaction(req.authUser!.id, async (client) => {
        await client.query("update public.payment_transactions set provider_transaction_id=$1,provider_checkout_request_id=$1,provider_status='accepted_pending_confirmation',status='pending',updated_at=now() where id=$2 and tenant_id=$3",[provider.checkoutRequestId,transaction.id,tenantId]);
        await client.query("insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,'daraja.stk.initiated','transaction',$3,$4::jsonb)",[tenantId,req.authUser!.id,transaction.id,JSON.stringify({checkoutRequestId:provider.checkoutRequestId})]);
      });
      return res.status(202).json({transactionId:transaction.id,status:"pending",checkoutRequestId:provider.checkoutRequestId,message:"STK request accepted; payment remains pending until provider confirmation."});
    } catch {
      await withUserTransaction(req.authUser!.id, (client) => client.query("update public.payment_transactions set status='unknown',provider_status='initiation_result_unknown',updated_at=now() where id=$1 and tenant_id=$2",[transaction.id,tenantId]));
      return res.status(502).json({error:"provider_result_unknown",transactionId:transaction.id,message:"The provider outcome is uncertain. Check status before retrying with a new idempotency key."});
    }
  } catch(error) { return next(error); }
});

router.post("/tenants/:tenantId/pesapal/checkout", requireAuth, async (req,res,next) => {
  const tenantId = String(req.params.tenantId ?? "");
  const parsed = pesapalSchema.safeParse(req.body);
  if (!idSchema.safeParse(tenantId).success || !parsed.success) return res.status(400).json({error:"invalid_request",details:parsed.success ? undefined : parsed.error.flatten()});
  try {
    const member = await getMembership(req.authUser!.id,tenantId);
    if (!member) return res.status(404).json({error:"tenant_not_found"});
    if (!["owner","admin","finance"].includes(member.role)) return res.status(403).json({error:"insufficient_role"});
    let providerCredentials: Record<string, string>;
    try { providerCredentials = await getTenantProviderCredentials(tenantId, "pesapal", {kind:"merchant",userId:req.authUser!.id}) as Record<string, string>; }
    catch { return res.status(409).json({ error: "pesapal_not_connected", message: "Connect and verify this merchant’s Pesapal sandbox credentials first." }); }
    if ((process.env.PESAPAL_ENV ?? "sandbox")!=="sandbox") return res.status(403).json({error:"live_payments_disabled"});
    const key=req.header("idempotency-key")?.trim();
    if (!key || key.length>160) return res.status(400).json({error:"idempotency_key_required"});
    const d=parsed.data;
    const outcome=await withUserTransaction(req.authUser!.id, async (client) => {
      const inserted=await client.query("insert into public.payment_transactions(tenant_id,provider,merchant_reference,idempotency_key,amount_minor,currency,status,description,payer_reference) values($1,'pesapal',$2,$3,$4,'KES','created',$5,$6) on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing returning id",[tenantId,d.merchantReference,key,d.amountMinor,d.description,d.phone??null]);
      if (inserted.rows[0]) return {row:inserted.rows[0],created:true};
      const prior=await client.query("select id,provider,merchant_reference,amount_minor,description,payer_reference,provider_order_tracking_id,provider_checkout_url,status from public.payment_transactions where tenant_id=$1 and idempotency_key=$2",[tenantId,key]);
      return {row:prior.rows[0],created:false};
    });
    if (!outcome.created) {
      const row=outcome.row;
      if (!row || row.provider!=="pesapal" || row.merchant_reference!==d.merchantReference || Number(row.amount_minor)!==d.amountMinor || row.description!==d.description || row.payer_reference!==(d.phone??null)) return res.status(409).json({error:"idempotency_key_reused_with_different_request"});
      if (row.provider_order_tracking_id && row.provider_checkout_url) return res.status(200).json({transactionId:row.id,status:row.status,redirectUrl:row.provider_checkout_url,orderTrackingId:row.provider_order_tracking_id,idempotentReplay:true});
      return res.status(202).json({transactionId:row.id,status:row.status,message:"The provider outcome is being reconciled. Check transaction status before retrying."});
    }
    const transactionId=outcome.row.id as string;
    try {
      const callbackUrl=`${baseUrl()}/api/v1/webhooks/pesapal/${tenantId}`;
      const provider=await submitPesapalOrder({reference:transactionId,amount:d.amountMinor/100,description:d.description,callbackUrl,email:d.email,phone:d.phone}, providerCredentials);
      await withUserTransaction(req.authUser!.id, async (client) => {
        await client.query("update public.payment_transactions set provider_transaction_id=$1,provider_order_tracking_id=$1,provider_checkout_url=$2,status='pending',provider_status='checkout_created',updated_at=now() where id=$3 and tenant_id=$4",[provider.orderTrackingId,provider.redirectUrl,transactionId,tenantId]);
        await client.query("insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,'pesapal.checkout.created','transaction',$3,$4::jsonb)",[tenantId,req.authUser!.id,transactionId,JSON.stringify({orderTrackingId:provider.orderTrackingId})]);
      });
      return res.status(201).json({transactionId,status:"pending",redirectUrl:provider.redirectUrl});
    } catch {
      await withUserTransaction(req.authUser!.id, (client) => client.query("update public.payment_transactions set status='unknown',provider_status='checkout_result_unknown',updated_at=now() where id=$1",[transactionId]));
      return res.status(502).json({error:"provider_result_unknown",transactionId,message:"Checkout outcome is uncertain; query provider status before retrying."});
    }
  } catch(error) { return next(error); }
});

async function persistProviderNotification(
  provider: "daraja" | "pesapal",
  tenantId: string,
  eventId: string,
  eventType: string,
  payload: unknown,
  eventHash: string,
  statusLookup: (capability: ProviderSystemCapability) => Promise<{ code: number; amountMinor?: number; currency?: string; receipt?: string }>,
  response: { success: (message: string) => void; duplicate: () => void; unmatched: () => void },
) {
  const capability = issueProviderSystemCapability(provider, tenantId, eventId);
  const claimToken = randomUUID();
  const claimed = await withProviderSystemTransaction(capability, async (client, scope) => {
    const correlationColumn = scope.provider === "daraja" ? "provider_checkout_request_id" : "provider_order_tracking_id";
    const tx = await client.query(
      `select id,amount_minor,currency,status from public.payment_transactions
       where tenant_id=$1 and provider=$2 and ${correlationColumn}=$3 for update`,
      [scope.tenantId, scope.provider, scope.eventId],
    );
    const row = tx.rows[0];
    const inserted = await client.query(
      `insert into public.payment_provider_events
       (tenant_id,provider,provider_event_id,event_type,payload_sha256,payload,processing_status,processing_attempts,processing_started_at,claim_token,lease_expires_at,last_error)
       values($1,$2,$3,$4,$5,$6::jsonb,$7,1,case when $7='received' then now() else null end,$8,case when $7='received' then now()+interval '5 minutes' else null end,$9)
       on conflict (tenant_id,provider,provider_event_id) do nothing returning id`,
      [scope.tenantId,scope.provider,scope.eventId,eventType,eventHash,JSON.stringify(payload),row ? "received" : "retry",row ? claimToken : null,row ? null : "Provider notification is waiting for transaction correlation"],
    );
    if (!inserted.rows[0]) return { kind: "duplicate" as const };
    if (!row) return { kind: "unmatched" as const };
    return { kind: "claimed" as const, eventDbId: inserted.rows[0].id, transaction: row };
  });
  if (claimed.kind === "duplicate") { response.duplicate(); return; }
  if (claimed.kind === "unmatched") { response.unmatched(); return; }

  let verified: { code: number; amountMinor?: number; currency?: string; receipt?: string };
  try {
    verified = await statusLookup(capability);
  } catch {
    await withProviderSystemTransaction(capability, async (client, scope) => {
      await client.query(
        "update public.payment_provider_events set processing_status='retry',retry_at=now()+interval '60 seconds',processing_started_at=null,claim_token=null,lease_expires_at=null,last_error='Independent provider status query failed' where id=$1 and tenant_id=$2 and provider=$3 and provider_event_id=$4 and claim_token=$5",
        [claimed.eventDbId,scope.tenantId,scope.provider,scope.eventId,claimToken],
      );
    });
    response.success("Accepted for provider status recovery");
    return;
  }

  await withProviderSystemTransaction(capability, async (client, scope) => {
    const current = await client.query(
      "select id,status,amount_minor,currency from public.payment_transactions where id=$1 and tenant_id=$2 and provider=$3 for update",
      [claimed.transaction.id,scope.tenantId,scope.provider],
    );
    if (!current.rows[0]) throw new Error("Provider callback correlation changed during verification");
    const tx = current.rows[0];
    const amountMatches = verified.amountMinor === Number(tx.amount_minor);
    const currencyMatches = (verified.currency ?? String(tx.currency)).toUpperCase() === String(tx.currency).toUpperCase();
    const terminalCode = scope.provider === "daraja" ? verified.code === 0 : verified.code === 1 || verified.code === 2;
    const evidenceMatches = terminalCode && amountMatches && currencyMatches &&
      (scope.provider !== "daraja" || (typeof verified.receipt === "string" && verified.receipt.length > 0));

    if (evidenceMatches && ["pending","unknown"].includes(tx.status)) {
      const outcome = scope.provider === "pesapal" && verified.code === 2 ? "failed" : "succeeded";
      await client.query(
        "update public.payment_transactions set status=$1,provider_status=$2,provider_receipt=coalesce($3,provider_receipt),confirmed_at=case when $1='succeeded' then coalesce(confirmed_at,now()) else confirmed_at end,updated_at=now() where id=$4 and tenant_id=$5 and status in ('pending','unknown')",
        [outcome,scope.provider+"_status_query_verified",verified.receipt ?? null,tx.id,scope.tenantId],
      );
      await client.query(
        "insert into public.payment_audit_events(tenant_id,action,entity_type,entity_id,correlation_id,metadata) values($1,$2,'transaction',$3,$4,$5::jsonb)",
        [scope.tenantId,scope.provider+".callback.verified",tx.id,scope.eventId,JSON.stringify({providerCode:verified.code,amountMinor:verified.amountMinor,currency:verified.currency ?? tx.currency,receipt:verified.receipt ?? null})],
      );
    } else if (!evidenceMatches || !["created","pending","unknown"].includes(tx.status)) {
      await client.query(
        "update public.payment_transactions set status='unknown',provider_status=$1,updated_at=now() where id=$2 and tenant_id=$3 and status in ('created','pending')",
        [scope.provider+"_callback_requires_review",tx.id,scope.tenantId],
      );
      await client.query(
        "insert into public.payment_reconciliation_exceptions(tenant_id,transaction_id,provider,provider_reference,exception_type,details) values($1,$2,$3,$4,'status_mismatch',$5::jsonb)",
        [scope.tenantId,tx.id,scope.provider,scope.eventId,JSON.stringify({reason:"Provider status, amount, currency, or current ledger state requires manual review.",providerCode:verified.code,amountMinor:verified.amountMinor ?? null,currency:verified.currency ?? null})],
      );
    }
    const completed = await client.query(
      "update public.payment_provider_events set processing_status='processed',processed_at=now(),processing_started_at=null,claim_token=null,lease_expires_at=null,last_error=null where id=$1 and tenant_id=$2 and provider=$3 and provider_event_id=$4 and claim_token=$5 returning id",
      [claimed.eventDbId,scope.tenantId,scope.provider,scope.eventId,claimToken],
    );
    if (!completed.rowCount) throw new Error("Provider callback lease was lost before completion");
  });
  response.success("Accepted");
}

router.post("/webhooks/daraja/:tenantId/:token", async (req,res,next) => {
  const tenantId=String(req.params.tenantId ?? ""), token=String(req.params.token ?? ""), expected=process.env.DARAJA_CALLBACK_TOKEN;
  if (!idSchema.safeParse(tenantId).success || !expected || expected.length < 32 || !tokenMatches(token,expected)) return res.status(404).json({ResultCode:1,ResultDesc:"Not found"});
  const callback=(req.body as any)?.Body?.stkCallback;
  if (!callback || typeof callback.CheckoutRequestID!=="string" || typeof callback.ResultCode!=="number") return res.status(400).json({ResultCode:1,ResultDesc:"Invalid callback"});
  const items=callback.CallbackMetadata?.Item;
  const amount=Array.isArray(items) ? Number(items.find((item:any)=>item.Name==="Amount")?.Value) : NaN;
  const receipt=Array.isArray(items) ? items.find((item:any)=>item.Name==="MpesaReceiptNumber")?.Value : undefined;
  try {
    await persistProviderNotification("daraja",tenantId,callback.CheckoutRequestID,"stk_callback",req.body,sha256Payload(req.body),async(capability)=>{
      const credentials=await getTenantProviderCredentials(tenantId,"daraja",{kind:"provider",capability}) as Record<string,string>;
      const status=await queryDarajaStk(callback.CheckoutRequestID,credentials);
      return {code:Number(status.ResultCode),amountMinor:Number.isFinite(amount)?Math.round(amount*100):undefined,currency:"KES",receipt:typeof receipt==="string"?receipt:undefined};
    },{
      success:(message)=>res.status(200).json({ResultCode:0,ResultDesc:message}),
      duplicate:()=>res.status(200).json({ResultCode:0,ResultDesc:"Duplicate accepted"}),
      unmatched:()=>res.status(200).json({ResultCode:0,ResultDesc:"Accepted for transaction correlation"}),
    });
  } catch(error) { return next(error); }
});

router.get("/webhooks/pesapal/:tenantId", async (req,res,next) => {
  const tenantId=String(req.params.tenantId ?? "");
  if (!idSchema.safeParse(tenantId).success) return res.status(404).send("Not found");
  const trackingId=String(req.query.OrderTrackingId ?? req.query.orderTrackingId ?? "");
  if (!trackingId || trackingId.length>200) return res.status(400).send("Missing order tracking id");
  try {
    await persistProviderNotification("pesapal",tenantId,trackingId,"ipn_status_query",{query:req.query},sha256Payload({query:req.query}),async(capability)=>{
      const credentials=await getTenantProviderCredentials(tenantId,"pesapal",{kind:"provider",capability}) as Record<string,string>;
      const status=await queryPesapalStatus(trackingId,credentials);
      return {code:Number(status.status_code),amountMinor:Number.isFinite(Number(status.amount))?Math.round(Number(status.amount)*100):undefined,currency:String(status.currency_code??status.currency??"")};
    },{
      success:(message)=>res.status(200).send(message),
      duplicate:()=>res.status(200).send("Duplicate accepted"),
      unmatched:()=>res.status(200).send("Accepted for transaction correlation"),
    });
  } catch(error) { return next(error); }
});

export default router;
