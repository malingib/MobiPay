import { Router } from "express";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { getPool } from "./db.js";
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
  const r = await getPool().query("select m.role from public.payment_tenant_memberships m join public.payment_tenants t on t.id=m.tenant_id where m.tenant_id=$1 and m.user_id=$2 and m.status='active' and t.status='active'", [tenantId,userId]);
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
    try { providerCredentials = await getTenantProviderCredentials(tenantId, "daraja") as Record<string, string>; }
    catch { return res.status(409).json({ error: "daraja_not_connected", message: "Connect and verify this merchant’s Daraja sandbox credentials first." }); }
    if ((process.env.DARAJA_ENV ?? "sandbox") !== "sandbox") return res.status(403).json({ error:"live_payments_disabled" });
    const idempotencyKey = req.header("idempotency-key")?.trim();
    if (!idempotencyKey || idempotencyKey.length > 160) return res.status(400).json({ error:"idempotency_key_required" });
    const d = parsed.data;
    const client = await getPool().connect();
    let transaction: { id:string; provider_transaction_id:string|null; status:string } | undefined;
    try {
      await client.query("begin");
      const inserted = await client.query(
        "insert into public.payment_transactions(tenant_id,provider,merchant_reference,idempotency_key,amount_minor,currency,status,payer_reference,description) values($1,'daraja',$2,$3,$4,'KES','created',$5,$6) on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing returning id,provider_transaction_id,status",
        [tenantId,d.merchantReference,idempotencyKey,d.amountMinor,d.phone,d.description],
      );
      transaction = inserted.rows[0];
      if (!transaction) {
        const prior = await client.query("select id,provider,merchant_reference,amount_minor,idempotency_key,provider_checkout_request_id,status,payer_reference,description from public.payment_transactions where tenant_id=$1 and idempotency_key=$2",[tenantId,idempotencyKey]);
        const row = prior.rows[0];
        if (!row || row.provider!=="daraja" || row.merchant_reference!==d.merchantReference || Number(row.amount_minor)!==d.amountMinor || row.payer_reference!==d.phone || row.description!==d.description) {
          await client.query("rollback"); return res.status(409).json({error:"idempotency_conflict"});
        }
        await client.query("commit");
        return res.status(200).json({transactionId:row.id,status:row.status,checkoutRequestId:row.provider_checkout_request_id,idempotentReplay:true});
      }
      await client.query("commit");
    } catch (error) { await client.query("rollback").catch(()=>undefined); throw error; }
    finally { client.release(); }

    const callbackToken = process.env.DARAJA_CALLBACK_TOKEN;
    if (!callbackToken || callbackToken.length < 32) return res.status(503).json({error:"daraja_callback_token_not_configured",transactionId:transaction.id});
    const callbackUrl = `${baseUrl()}/api/v1/webhooks/daraja/${tenantId}/${callbackToken}`;
    try {
      const provider = await initiateDarajaStk({phone:d.phone,amount:d.amountMinor/100,accountReference:d.merchantReference,description:d.description,callbackUrl}, providerCredentials);
      await getPool().query("update public.payment_transactions set provider_transaction_id=$1,provider_checkout_request_id=$1,provider_status='accepted_pending_confirmation',status='pending',updated_at=now() where id=$2 and tenant_id=$3",[provider.checkoutRequestId,transaction.id,tenantId]);
      await getPool().query("insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,'daraja.stk.initiated','transaction',$3,$4::jsonb)",[tenantId,req.authUser!.id,transaction.id,JSON.stringify({checkoutRequestId:provider.checkoutRequestId})]);
      return res.status(202).json({transactionId:transaction.id,status:"pending",checkoutRequestId:provider.checkoutRequestId,message:"STK request accepted; payment remains pending until provider confirmation."});
    } catch {
      await getPool().query("update public.payment_transactions set status='unknown',provider_status='initiation_result_unknown',updated_at=now() where id=$1 and tenant_id=$2",[transaction.id,tenantId]);
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
    try { providerCredentials = await getTenantProviderCredentials(tenantId, "pesapal") as Record<string, string>; }
    catch { return res.status(409).json({ error: "pesapal_not_connected", message: "Connect and verify this merchant’s Pesapal sandbox credentials first." }); }
    if ((process.env.PESAPAL_ENV ?? "sandbox")!=="sandbox") return res.status(403).json({error:"live_payments_disabled"});
    const key=req.header("idempotency-key")?.trim();
    if (!key || key.length>160) return res.status(400).json({error:"idempotency_key_required"});
    const d=parsed.data;
    const ins=await getPool().query("insert into public.payment_transactions(tenant_id,provider,merchant_reference,idempotency_key,amount_minor,currency,status,description,payer_reference) values($1,'pesapal',$2,$3,$4,'KES','created',$5,$6) on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing returning id",[tenantId,d.merchantReference,key,d.amountMinor,d.description,d.phone??null]);
    if (!ins.rows[0]) {
      const prior=await getPool().query("select id,provider,merchant_reference,amount_minor,description,payer_reference,provider_order_tracking_id,provider_checkout_url,status from public.payment_transactions where tenant_id=$1 and idempotency_key=$2",[tenantId,key]);
      const row=prior.rows[0];
      if (!row || row.provider!=="pesapal" || row.merchant_reference!==d.merchantReference || Number(row.amount_minor)!==d.amountMinor || row.description!==d.description || row.payer_reference!==(d.phone??null)) return res.status(409).json({error:"idempotency_key_reused_with_different_request"});
      if (row.provider_order_tracking_id && row.provider_checkout_url) return res.status(200).json({transactionId:row.id,status:row.status,redirectUrl:row.provider_checkout_url,orderTrackingId:row.provider_order_tracking_id,idempotentReplay:true});
      return res.status(202).json({transactionId:row.id,status:row.status,message:"The provider outcome is being reconciled. Check transaction status before retrying."});
    }
    const transactionId=ins.rows[0].id as string;
    try {
      const callbackUrl=`${baseUrl()}/api/v1/webhooks/pesapal/${tenantId}`;
      const provider=await submitPesapalOrder({reference:transactionId,amount:d.amountMinor/100,description:d.description,callbackUrl,email:d.email,phone:d.phone}, providerCredentials);
      await getPool().query("update public.payment_transactions set provider_transaction_id=$1,provider_order_tracking_id=$1,provider_checkout_url=$2,status='pending',provider_status='checkout_created',updated_at=now() where id=$3 and tenant_id=$4",[provider.orderTrackingId,provider.redirectUrl,transactionId,tenantId]);
      await getPool().query("insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,'pesapal.checkout.created','transaction',$3,$4::jsonb)",[tenantId,req.authUser!.id,transactionId,JSON.stringify({orderTrackingId:provider.orderTrackingId})]);
      return res.status(201).json({transactionId,status:"pending",redirectUrl:provider.redirectUrl});
    } catch {
      await getPool().query("update public.payment_transactions set status='unknown',provider_status='checkout_result_unknown',updated_at=now() where id=$1",[transactionId]);
      return res.status(502).json({error:"provider_result_unknown",transactionId,message:"Checkout outcome is uncertain; query provider status before retrying."});
    }
  } catch(error) { return next(error); }
});

router.post("/webhooks/daraja/:tenantId/:token", async (req,res,next) => {
  const tenantId=String(req.params.tenantId ?? ""), token=String(req.params.token ?? ""), expected=process.env.DARAJA_CALLBACK_TOKEN;
  if (!idSchema.safeParse(tenantId).success || !expected || expected.length < 32 || !tokenMatches(token,expected)) return res.status(404).json({ResultCode:1,ResultDesc:"Not found"});
  const callback=(req.body as any)?.Body?.stkCallback;
  if (!callback || typeof callback.CheckoutRequestID!=="string" || typeof callback.ResultCode!=="number") return res.status(400).json({ResultCode:1,ResultDesc:"Invalid callback"});
  try {
    const eventId=callback.CheckoutRequestID;
    const tx=await getPool().query("select id,amount_minor,status from public.payment_transactions where tenant_id=$1 and provider='daraja' and provider_checkout_request_id=$2",[tenantId,eventId]);
    if (!tx.rows[0]) {
      await getPool().query("insert into public.payment_provider_events(tenant_id,provider,provider_event_id,event_type,payload_sha256,payload,processing_status,last_error) values($1,'daraja',$2,'stk_callback',$3,$4::jsonb,'retry','Callback arrived before checkout ID was attached to a transaction') on conflict do nothing",[tenantId,eventId,sha256Payload(req.body),JSON.stringify(req.body)]);
      return res.status(200).json({ResultCode:0,ResultDesc:"Accepted for review"});
    }
    const row=tx.rows[0];
    const event=await getPool().query("insert into public.payment_provider_events(tenant_id,provider,provider_event_id,event_type,payload_sha256,payload,processing_status,processing_attempts,processing_started_at) values($1,'daraja',$2,'stk_callback',$3,$4::jsonb,'received',1,now()) on conflict (tenant_id,provider,provider_event_id) do update set processing_status='received',processing_attempts=payment_provider_events.processing_attempts+1,processing_started_at=now(),last_error=null,payload=excluded.payload where payment_provider_events.processing_status='retry' returning id",[tenantId,eventId,sha256Payload(req.body),JSON.stringify(req.body)]);
    if (!event.rows[0]) return res.status(200).json({ResultCode:0,ResultDesc:"Duplicate accepted"});
    let verified=false;
    let callbackAmount:number|undefined;
    let receipt:string|undefined;
    const items=callback.CallbackMetadata?.Item;
    if (Array.isArray(items)) {
      callbackAmount=Number(items.find((i:any)=>i.Name==="Amount")?.Value);
      receipt=items.find((i:any)=>i.Name==="MpesaReceiptNumber")?.Value;
    }
    try {
      const credentials = await getTenantProviderCredentials(tenantId, "daraja") as Record<string, string>;
      const status=await queryDarajaStk(eventId, credentials);
      verified=String(status.ResultCode)==="0" && callback.ResultCode===0 && callbackAmount!==undefined && callbackAmount*100===Number(row.amount_minor) && typeof receipt==="string" && receipt.length>0;
    } catch { verified=false; }
    if (verified) {
      await getPool().query("update public.payment_transactions set status='succeeded',provider_status='status_query_verified',provider_receipt=$1,confirmed_at=coalesce(confirmed_at,now()),updated_at=now() where id=$2 and tenant_id=$3 and status in ('created','pending','unknown')",[receipt,row.id,tenantId]);
      await getPool().query("update public.payment_provider_events set processing_status='processed',processed_at=now(),processing_started_at=null,last_error=null where id=$1",[event.rows[0].id]);
      await getPool().query("insert into public.payment_audit_events(tenant_id,action,entity_type,entity_id,metadata) values($1,'daraja.callback.verified','transaction',$2,$3::jsonb)",[tenantId,row.id,JSON.stringify({receipt})]);
    } else {
      await getPool().query("update public.payment_transactions set status='unknown',provider_status='callback_received_unverified',updated_at=now() where id=$1 and tenant_id=$2 and status in ('created','pending')",[row.id,tenantId]);
      await getPool().query("insert into public.payment_reconciliation_exceptions(tenant_id,transaction_id,provider,provider_reference,exception_type,details) values($1,$2,'daraja',$3,'status_mismatch',$4::jsonb)",[tenantId,row.id,eventId,JSON.stringify({reason:"Callback could not be independently verified; manual review required."})]);
      await getPool().query("update public.payment_provider_events set processing_status='retry',processing_started_at=null,last_error='Provider status could not be verified' where id=$1",[event.rows[0].id]);
    }
    return res.status(200).json({ResultCode:0,ResultDesc:"Accepted"});
  } catch(error) { return next(error); }
});

router.get("/webhooks/pesapal/:tenantId", async (req,res,next) => {
  const tenantId=String(req.params.tenantId ?? "");
  if (!idSchema.safeParse(tenantId).success) return res.status(404).send("Not found");
  const trackingId=String(req.query.OrderTrackingId ?? req.query.orderTrackingId ?? "");
  if (!trackingId || trackingId.length>200) return res.status(400).send("Missing order tracking id");
  try {
    const tx=await getPool().query("select id,amount_minor,currency,status from public.payment_transactions where tenant_id=$1 and provider='pesapal' and provider_order_tracking_id=$2",[tenantId,trackingId]);
    if (!tx.rows[0]) {
      await getPool().query("insert into public.payment_provider_events(tenant_id,provider,provider_event_id,event_type,payload_sha256,payload,processing_status,last_error) values($1,'pesapal',$2,'ipn_status_query',$3,$4::jsonb,'retry','Notification arrived before tracking ID was attached to a transaction') on conflict do nothing",[tenantId,trackingId,sha256Payload({query:req.query}),JSON.stringify({query:req.query})]);
      return res.status(200).send("Accepted for review");
    }
    const row=tx.rows[0];
    const event=await getPool().query("insert into public.payment_provider_events(tenant_id,provider,provider_event_id,event_type,payload_sha256,payload,processing_status,processing_attempts,processing_started_at) values($1,'pesapal',$2,'ipn_status_query',$3,$4::jsonb,'received',1,now()) on conflict (tenant_id,provider,provider_event_id) do update set processing_status='received',processing_attempts=payment_provider_events.processing_attempts+1,processing_started_at=now(),last_error=null,payload=excluded.payload where payment_provider_events.processing_status='retry' returning id",[tenantId,trackingId,sha256Payload({query:req.query}),JSON.stringify({query:req.query})]);
    if (!event.rows[0]) return res.status(200).send("Duplicate accepted");
    try {
      const credentials = await getTenantProviderCredentials(tenantId, "pesapal") as Record<string, string>;
      const status=await queryPesapalStatus(trackingId, credentials);
      const code=Number(status.status_code);
      const amount=Number(status.amount);
      const currency=String(status.currency_code ?? status.currency ?? "");
      const amountMatches=Number.isFinite(amount) && Math.round(amount*100)===Number(row.amount_minor) && currency.toUpperCase()==="KES";
      if (code===1 && amountMatches) {
        await getPool().query("update public.payment_transactions set status='succeeded',provider_status='pesapal_status_verified',confirmed_at=now(),updated_at=now() where id=$1 and tenant_id=$2 and status in ('created','pending','unknown')",[row.id,tenantId]);
        await getPool().query("update public.payment_provider_events set processing_status='processed',processed_at=now() where id=$1",[event.rows[0].id]);
      } else if (code===2 && amountMatches) {
        await getPool().query("update public.payment_transactions set status='failed',provider_status='pesapal_status_verified_failed',updated_at=now() where id=$1 and tenant_id=$2 and status in ('created','pending','unknown')",[row.id,tenantId]);
        await getPool().query("update public.payment_provider_events set processing_status='processed',processed_at=now() where id=$1",[event.rows[0].id]);
      } else {
        await getPool().query("update public.payment_transactions set status='unknown',provider_status='pesapal_status_requires_review',updated_at=now() where id=$1 and tenant_id=$2 and status in ('created','pending')",[row.id,tenantId]);
        await getPool().query("insert into public.payment_reconciliation_exceptions(tenant_id,transaction_id,provider,provider_reference,exception_type,details) values($1,$2,'pesapal',$3,'status_mismatch',$4::jsonb)",[tenantId,row.id,trackingId,JSON.stringify({reason:"Provider status or amount/currency could not be safely reconciled."})]);
        await getPool().query("update public.payment_provider_events set processing_status='retry' where id=$1",[event.rows[0].id]);
      }
    } catch {
      await getPool().query("update public.payment_transactions set status='unknown',provider_status='pesapal_status_query_failed',updated_at=now() where id=$1 and tenant_id=$2 and status in ('created','pending')",[row.id,tenantId]);
      await getPool().query("update public.payment_provider_events set processing_status='retry' where id=$1",[event.rows[0].id]);
    }
    return res.status(200).send("Accepted");
  } catch(error) { return next(error); }
});

export default router;
