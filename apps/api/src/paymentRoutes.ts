import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { withUserTransaction } from "./db.js";
import { requireAuth, merchantCapabilityUserId } from "./auth.js";
import type { MerchantDatabaseCapability } from "./auth.js";
import { assertSafeWebhookUrl } from "./merchantWebhookWorker.js";
import { reconcileRecords } from "./reconciliation.js";
import { parseStatementCsv, sha256Statement } from "./statementImport.js";

const router = Router();
const tenantIdSchema = z.string().uuid();
const createTenantSchema = z.object({
  name: z.string().trim().min(1).max(160),
  slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/),
});
const createTransactionSchema = z.object({
  provider: z.enum(["daraja", "pesapal", "bank", "manual"]),
  merchantReference: z.string().trim().min(1).max(120),
  amountMinor: z.number().int().positive().max(9_000_000_000_000),
  currency: z.string().regex(/^[A-Z]{3}$/).default("KES"),
  payerReference: z.string().trim().max(120).optional(),
  description: z.string().trim().max(500).optional(),
});
const statementImportSchema = z.object({
  provider: z.enum(["daraja","pesapal","bank","manual"]),
  sourceName: z.string().trim().min(1).max(255),
  csvContent: z.string().min(1).max(1_800_000),
});
const webhookEndpointSchema = z.object({
  url: z.string().url().max(2048),
  signingSecretReference: z.string().regex(/^[A-Z][A-Z0-9_]{2,127}$/),
  subscribedEvents: z.array(z.enum(["payment.succeeded","payment.failed","payment.cancelled"])).min(1).max(3).default(["payment.succeeded","payment.failed"]),
});
const resolveSchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(3).max(1000),
});

async function membership(capability: MerchantDatabaseCapability, tenantId: string) {
  const userId = merchantCapabilityUserId(capability);
  if (!userId) throw new Error("Verified merchant capability is required");
  return withUserTransaction(capability, async (client) => {
    const result = await client.query(
      "select role from public.payment_tenant_memberships m join public.payment_tenants t on t.id=m.tenant_id where m.user_id=$1 and m.tenant_id=$2 and m.status='active' and t.status='active'",
      [userId, tenantId],
    );
    return result.rows[0] as { role: string } | undefined;
  });
}

function validTenantParam(value: string) {
  return tenantIdSchema.safeParse(value).success;
}

router.use(requireAuth);


router.post("/tenants/:tenantId/reconciliation/import", async (req,res,next) => {
  const tenantId=String(req.params.tenantId ?? "");
  if (!validTenantParam(tenantId)) return res.status(400).json({error:"invalid_tenant_id"});
  const parsed=statementImportSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:"invalid_request",details:parsed.error.flatten()});
  let rows;
  try { rows=parseStatementCsv(parsed.data.csvContent); }
  catch(error) { return res.status(400).json({error:"invalid_statement_csv",message:error instanceof Error ? error.message : "CSV could not be parsed"}); }
  try {
    const member=await membership(req.merchantDbCapability!,tenantId);
    if (!member) return res.status(404).json({error:"tenant_not_found"});
    if (!["owner","admin","finance"].includes(member.role)) return res.status(403).json({error:"insufficient_role"});
    const sourceHash=sha256Statement(parsed.data.csvContent);
    const outcome = await withUserTransaction(req.merchantDbCapability!, async (client) => {
      const created=await client.query(
        "insert into public.payment_reconciliation_runs(tenant_id,provider,source_name,source_sha256,status,rows_total,created_by) values($1,$2,$3,$4,'processing',$5,$6) on conflict (tenant_id,provider,source_sha256) do nothing returning id",
        [tenantId,parsed.data.provider,parsed.data.sourceName,sourceHash,rows.length,req.authUser!.id],
      );
      if (!created.rows[0]) {
        const existing=await client.query("select id,status,rows_total,rows_matched,rows_unmatched,rows_exception,created_at from public.payment_reconciliation_runs where tenant_id=$1 and provider=$2 and source_sha256=$3",[tenantId,parsed.data.provider,sourceHash]);
        return { run: existing.rows[0], idempotentReplay: true };
      }
      const runId=created.rows[0].id as string;
      const ledger=await client.query(
        "select id,provider,coalesce(provider_receipt,provider_order_tracking_id,provider_checkout_request_id,provider_transaction_id) as provider_reference,merchant_reference,amount_minor,currency from public.payment_transactions where tenant_id=$1 and provider=$2 order by created_at desc",
        [tenantId,parsed.data.provider],
      );
      const matches=reconcileRecords(
        ledger.rows.map((row:any)=>({id:String(row.id),provider:String(row.provider),providerReference:row.provider_reference,merchantReference:String(row.merchant_reference),amountMinor:Number(row.amount_minor),currency:String(row.currency)})),
        rows.map((row:any,index:number)=>({id:String(index),provider:parsed.data.provider,providerReference:row.providerReference || null,merchantReference:row.merchantReference || null,amountMinor:row.amountMinor,currency:row.currency})),
      );
      let matched=0,unmatched=0,exceptions=0;
      for (let index=0;index<rows.length;index++) {
        const row=rows[index]!;
        const result=matches[index]!;
        const transactionId=result.paymentId ?? null;
        await client.query(
          "insert into public.payment_reconciliation_records(run_id,tenant_id,provider,provider_reference,merchant_reference,amount_minor,currency,occurred_at,raw_record,reconciliation_status,transaction_id,reason) values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,$12)",
          [runId,tenantId,parsed.data.provider,row.providerReference || null,row.merchantReference || null,row.amountMinor,row.currency,row.occurredAt,row.raw,result.status,transactionId,result.reason],
        );
        if (result.status==="matched") matched++;
        else {
          exceptions++;
          if (result.status==="unmatched") unmatched++;
          const exceptionType=result.status==="amount_mismatch" ? "amount_mismatch" : result.status==="duplicate" ? "duplicate" : result.status==="unmatched" ? "unmatched" : "other";
          await client.query(
            "insert into public.payment_reconciliation_exceptions(tenant_id,transaction_id,provider,provider_reference,exception_type,details) values($1,$2,$3,$4,$5,$6::jsonb)",
            [tenantId,transactionId,parsed.data.provider,row.providerReference || null,exceptionType,JSON.stringify({runId,rowNumber:index+2,status:result.status,reason:result.reason,merchantReference:row.merchantReference,amountMinor:row.amountMinor,currency:row.currency})],
          );
        }
      }
      const updated=await client.query(
        "update public.payment_reconciliation_runs set status='completed',rows_matched=$1,rows_unmatched=$2,rows_exception=$3,completed_at=now() where id=$4 returning id,status,rows_total,rows_matched,rows_unmatched,rows_exception,created_at,completed_at",
        [matched,unmatched,exceptions,runId],
      );
      await client.query(
        "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,'reconciliation.import.completed','reconciliation_run',$3,$4::jsonb)",
        [tenantId,req.authUser!.id,runId,JSON.stringify({provider:parsed.data.provider,sourceName:parsed.data.sourceName,sourceSha256:sourceHash,rowsTotal:rows.length,rowsMatched:matched,rowsUnmatched:unmatched,rowsException:exceptions})],
      );
      return { run: updated.rows[0], idempotentReplay: false };
      });
      return res.status(outcome.idempotentReplay ? 200 : 201).json(outcome);
  } catch(error) { return next(error); }
});

router.get("/tenants/:tenantId/webhook-endpoints", async (req,res,next) => {
  const tenantId=String(req.params.tenantId ?? "");
  if (!validTenantParam(tenantId)) return res.status(400).json({error:"invalid_tenant_id"});
  try {
    if (!await membership(req.merchantDbCapability!,tenantId)) return res.status(404).json({error:"tenant_not_found"});
    const result=await withUserTransaction(req.merchantDbCapability!, (client) => client.query(
      "select id,url,subscribed_events,enabled,created_at,updated_at from public.payment_merchant_webhook_endpoints where tenant_id=$1 order by created_at desc",
      [tenantId],
    ));
    return res.json({endpoints:result.rows});
  } catch(error) { return next(error); }
});

router.post("/tenants/:tenantId/webhook-endpoints", async (req,res,next) => {
  const tenantId=String(req.params.tenantId ?? "");
  if (!validTenantParam(tenantId)) return res.status(400).json({error:"invalid_tenant_id"});
  const parsed=webhookEndpointSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({error:"invalid_request",details:parsed.error.flatten()});
  try {
    const member=await membership(req.merchantDbCapability!,tenantId);
    if (!member) return res.status(404).json({error:"tenant_not_found"});
    if (!["owner","admin"].includes(member.role)) return res.status(403).json({error:"insufficient_role"});
    const secret=process.env[parsed.data.signingSecretReference];
    if (!secret || secret.length<32) return res.status(400).json({error:"webhook_secret_not_configured",message:"Configure a random signing secret of at least 32 characters in deployment secret storage before registering this endpoint."});
    try { await assertSafeWebhookUrl(parsed.data.url); }
    catch { return res.status(400).json({error:"unsafe_webhook_url",message:"Endpoint must be a publicly routable HTTPS URL. Local, private, credentialed and non-HTTPS destinations are rejected."}); }
    const result=await withUserTransaction(req.merchantDbCapability!, async (client) => {
      const created=await client.query(
        "insert into public.payment_merchant_webhook_endpoints(tenant_id,url,signing_secret_reference,subscribed_events,enabled) values($1,$2,$3,$4::text[],true) returning id,url,subscribed_events,enabled,created_at",
        [tenantId,parsed.data.url,parsed.data.signingSecretReference,parsed.data.subscribedEvents],
      );
      await client.query(
        "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,'webhook.endpoint.created','webhook_endpoint',$3,$4::jsonb)",
        [tenantId,req.authUser!.id,created.rows[0].id,JSON.stringify({url:parsed.data.url,subscribedEvents:parsed.data.subscribedEvents})],
      );
      return created;
    });
    return res.status(201).json({endpoint:result.rows[0]});
  } catch(error) { return next(error); }
});

router.post("/tenants/:tenantId/webhook-endpoints/:endpointId/disable", async (req,res,next) => {
  const tenantId=String(req.params.tenantId ?? ""), endpointId=String(req.params.endpointId ?? "");
  if (!validTenantParam(tenantId) || !validTenantParam(endpointId)) return res.status(400).json({error:"invalid_id"});
  try {
    const member=await membership(req.merchantDbCapability!,tenantId);
    if (!member) return res.status(404).json({error:"tenant_not_found"});
    if (!["owner","admin"].includes(member.role)) return res.status(403).json({error:"insufficient_role"});
    const result=await withUserTransaction(req.merchantDbCapability!, async (client) => {
      const disabled=await client.query("update public.payment_merchant_webhook_endpoints set enabled=false,updated_at=now() where id=$1 and tenant_id=$2 returning id,enabled",[endpointId,tenantId]);
      if (!disabled.rows[0]) return disabled;
      await client.query("insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id) values($1,$2,'webhook.endpoint.disabled','webhook_endpoint',$3)",[tenantId,req.authUser!.id,endpointId]);
      return disabled;
    });
    if (!result.rows[0]) return res.status(404).json({error:"webhook_endpoint_not_found"});
    return res.json({endpoint:result.rows[0]});
  } catch(error) { return next(error); }
});


router.post("/tenants", async (req, res, next) => {
  const parsed = createTenantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  const userId = req.authUser!.id;
  try {
    const tenant = await withUserTransaction(req.merchantDbCapability!, async (client) => {
      const created = await client.query("insert into public.payment_tenants(name,slug) values($1,$2) returning id,name,slug,status,created_at", [parsed.data.name, parsed.data.slug]);
      const row = created.rows[0];
      await client.query("insert into public.payment_tenant_memberships(tenant_id,user_id,role,status) values($1,$2,$3,$4)", [row.id, userId, "owner", "active"]);
      await client.query("insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,$3,$4,$1,$5::jsonb)", [row.id, userId, "tenant.created", "tenant", JSON.stringify({ slug: row.slug })]);
      return row;
    });
    return res.status(201).json({ tenant });
  } catch (error) {
    if ((error as { code?: string }).code === "23505") return res.status(409).json({ error: "tenant_slug_taken" });
    return next(error);
  }
});

router.get("/tenants", async (req, res, next) => {
  try {
    const result = await withUserTransaction(req.merchantDbCapability!, (client) => client.query(
      "select t.id,t.name,t.slug,t.status,m.role,m.created_at from public.payment_tenants t join public.payment_tenant_memberships m on m.tenant_id=t.id where m.user_id=$1 and m.status='active' and t.status='active' order by t.created_at desc",
      [req.authUser!.id],
    ));
    return res.json({ tenants: result.rows });
  } catch (error) { return next(error); }
});

router.get("/tenants/:tenantId/transactions", async (req, res, next) => {
  const tenantId = req.params.tenantId!;
  if (!validTenantParam(tenantId)) return res.status(400).json({ error: "invalid_tenant_id" });
  try {
    if (!await membership(req.merchantDbCapability!, tenantId)) return res.status(404).json({ error: "tenant_not_found" });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const result = await withUserTransaction(req.merchantDbCapability!, (client) => client.query(
      "select id,provider,provider_transaction_id,provider_checkout_request_id,provider_receipt,provider_order_tracking_id,merchant_reference,amount_minor,currency,status,payer_reference,description,provider_status,occurred_at,confirmed_at,created_at,updated_at from public.payment_transactions where tenant_id=$1 order by created_at desc limit $2",
      [tenantId, limit],
    ));
    return res.json({ transactions: result.rows });
  } catch (error) { return next(error); }
});

router.post("/tenants/:tenantId/transactions", async (req, res, next) => {
  const tenantId = req.params.tenantId!;
  if (!validTenantParam(tenantId)) return res.status(400).json({ error: "invalid_tenant_id" });
  const parsed = createTransactionSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  const idempotencyKey = req.header("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length > 160) return res.status(400).json({ error: "idempotency_key_required" });
  try {
    const member = await membership(req.merchantDbCapability!, tenantId);
    if (!member) return res.status(404).json({ error: "tenant_not_found" });
    if (!["owner", "admin", "finance"].includes(member.role)) return res.status(403).json({ error: "insufficient_role" });
    const d = parsed.data;
    const outcome = await withUserTransaction(req.merchantDbCapability!, async (client) => {
      const inserted = await client.query(
        "insert into public.payment_transactions(tenant_id,provider,merchant_reference,idempotency_key,amount_minor,currency,status,payer_reference,description) values($1,$2,$3,$4,$5,$6,'created',$7,$8) on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing returning id,provider,merchant_reference,amount_minor,currency,status,created_at",
        [tenantId,d.provider,d.merchantReference,idempotencyKey,d.amountMinor,d.currency,d.payerReference ?? null,d.description ?? null],
      );
      if (inserted.rows[0]) {
        await client.query(
          "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,correlation_id,metadata) values($1,$2,'transaction.created','transaction',$3,$4,$5::jsonb)",
          [tenantId,req.authUser!.id,inserted.rows[0].id,randomUUID(),JSON.stringify({ provider: d.provider, amountMinor: d.amountMinor })],
        );
        return { row: inserted.rows[0], created: true };
      }
      const existing = await client.query(
        "select id,provider,merchant_reference,amount_minor,currency,status,created_at from public.payment_transactions where tenant_id=$1 and idempotency_key=$2",
        [tenantId,idempotencyKey],
      );
      return { row: existing.rows[0], created: false };
    });
    if (outcome.created) return res.status(201).json({ transaction: outcome.row, idempotentReplay: false });
    if (!outcome.row) return res.status(409).json({ error: "idempotency_conflict" });
    const row = outcome.row;
    if (row.provider !== d.provider || row.merchant_reference !== d.merchantReference || Number(row.amount_minor) !== d.amountMinor || row.currency !== d.currency) {
      return res.status(409).json({ error: "idempotency_key_reused_with_different_request" });
    }
    return res.status(200).json({ transaction: row, idempotentReplay: true });
  } catch (error) { return next(error); }
});

router.get("/tenants/:tenantId/exceptions", async (req, res, next) => {
  const tenantId = req.params.tenantId!;
  if (!validTenantParam(tenantId)) return res.status(400).json({ error: "invalid_tenant_id" });
  try {
    if (!await membership(req.merchantDbCapability!, tenantId)) return res.status(404).json({ error: "tenant_not_found" });
    const result = await withUserTransaction(req.merchantDbCapability!, (client) => client.query(
      "select id,transaction_id,provider,provider_reference,exception_type,details,status,resolution_note,resolved_by,resolved_at,created_at,updated_at from public.payment_reconciliation_exceptions where tenant_id=$1 order by created_at desc limit 200",
      [tenantId],
    ));
    return res.json({ exceptions: result.rows });
  } catch (error) { return next(error); }
});

router.post("/tenants/:tenantId/exceptions/:exceptionId/resolve", async (req, res, next) => {
  const tenantId = req.params.tenantId!, exceptionId = req.params.exceptionId!;
  if (!validTenantParam(tenantId) || !validTenantParam(exceptionId)) return res.status(400).json({ error: "invalid_id" });
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  try {
    const member = await membership(req.merchantDbCapability!, tenantId);
    if (!member) return res.status(404).json({ error: "tenant_not_found" });
    if (!["owner", "admin", "finance"].includes(member.role)) return res.status(403).json({ error: "insufficient_role" });
    const result = await withUserTransaction(req.merchantDbCapability!, async (client) => {
      const updated = await client.query("update public.payment_reconciliation_exceptions set status=$1,resolution_note=$2,resolved_by=$3,resolved_at=now(),updated_at=now() where id=$4 and tenant_id=$5 and status in ($6,$7) returning id,status,resolution_note,resolved_at", [parsed.data.status,parsed.data.resolutionNote,req.authUser!.id,exceptionId,tenantId,"open","investigating"]);
      if (!updated.rows[0]) return null;
      await client.query("insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,$3,$4,$5,$6::jsonb)", [tenantId,req.authUser!.id,"reconciliation.exception.resolved","exception",exceptionId,JSON.stringify({status:parsed.data.status,note:parsed.data.resolutionNote})]);
      return updated.rows[0];
    });
    if (!result) return res.status(404).json({ error: "open_exception_not_found" });
    return res.json({ exception: result });
  } catch (error) { return next(error); }
});

router.get("/tenants/:tenantId/reports/transactions.csv", async (req, res, next) => {
  const tenantId = req.params.tenantId!;
  if (!validTenantParam(tenantId)) return res.status(400).json({ error: "invalid_tenant_id" });
  try {
    if (!await membership(req.merchantDbCapability!, tenantId)) return res.status(404).json({ error: "tenant_not_found" });
    const result = await withUserTransaction(req.merchantDbCapability!, (client) => client.query(
      "select id,provider,merchant_reference,amount_minor,currency,status,provider_transaction_id,provider_checkout_request_id,provider_receipt,provider_order_tracking_id,created_at,confirmed_at from public.payment_transactions where tenant_id=$1 order by created_at desc limit 10000",
      [tenantId],
    ));
    const safe = (value: unknown) => {
      const raw = value == null ? "" : String(value);
      const escaped = raw.replace(/"/g, '""');
      return /^[=+@\-\t\r]/.test(raw) ? "'" + escaped : escaped;
    };
    const columns = ["id","provider","merchant_reference","amount_minor","currency","status","provider_transaction_id","provider_checkout_request_id","provider_receipt","provider_order_tracking_id","created_at","confirmed_at"];
    const lines = [columns.join(","), ...result.rows.map((row) => columns.map((key) => `"${safe(row[key])}"`).join(","))];
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", "attachment; filename=\"mobiwave-transactions.csv\"");
    return res.send(lines.join("\r\n"));
  } catch (error) { return next(error); }
});

export default router;
