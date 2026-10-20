import { Router } from "express";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { getPool } from "./db.js";
import { requireAuth } from "./auth.js";

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
const resolveSchema = z.object({
  status: z.enum(["resolved", "dismissed"]),
  resolutionNote: z.string().trim().min(3).max(1000),
});

async function membership(userId: string, tenantId: string) {
  const result = await getPool().query(
    "select role from public.payment_tenant_memberships m join public.payment_tenants t on t.id=m.tenant_id where m.user_id=$1 and m.tenant_id=$2 and m.status='active' and t.status='active'",
    [userId, tenantId],
  );
  return result.rows[0] as { role: string } | undefined;
}

function validTenantParam(value: string) {
  return tenantIdSchema.safeParse(value).success;
}

router.use(requireAuth);

router.post("/tenants", async (req, res, next) => {
  const parsed = createTenantSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  const client = await getPool().connect().catch(next);
  if (!client) return;
  const userId = req.authUser!.id;
  try {
    await client.query("begin");
    const created = await client.query(
      "insert into public.payment_tenants(name,slug) values($1,$2) returning id,name,slug,status,created_at",
      [parsed.data.name, parsed.data.slug],
    );
    const tenant = created.rows[0];
    await client.query(
      "insert into public.payment_tenant_memberships(tenant_id,user_id,role,status) values($1,$2,'owner','active')",
      [tenant.id, userId],
    );
    await client.query(
      "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,'tenant.created','tenant',$1,$3::jsonb)",
      [tenant.id, userId, JSON.stringify({ slug: tenant.slug })],
    );
    await client.query("commit");
    return res.status(201).json({ tenant });
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    if ((error as { code?: string }).code === "23505") return res.status(409).json({ error: "tenant_slug_taken" });
    return next(error);
  } finally {
    client.release();
  }
});

router.get("/tenants", async (req, res, next) => {
  try {
    const result = await getPool().query(
      "select t.id,t.name,t.slug,t.status,m.role,m.created_at from public.payment_tenants t join public.payment_tenant_memberships m on m.tenant_id=t.id where m.user_id=$1 and m.status='active' and t.status='active' order by t.created_at desc",
      [req.authUser!.id],
    );
    return res.json({ tenants: result.rows });
  } catch (error) { return next(error); }
});

router.get("/tenants/:tenantId/transactions", async (req, res, next) => {
  const tenantId = req.params.tenantId!;
  if (!validTenantParam(tenantId)) return res.status(400).json({ error: "invalid_tenant_id" });
  try {
    if (!await membership(req.authUser!.id, tenantId)) return res.status(404).json({ error: "tenant_not_found" });
    const limit = Math.min(Math.max(Number(req.query.limit ?? 50) || 50, 1), 200);
    const result = await getPool().query(
      "select id,provider,provider_transaction_id,merchant_reference,amount_minor,currency,status,payer_reference,description,provider_status,occurred_at,confirmed_at,created_at,updated_at from public.payment_transactions where tenant_id=$1 order by created_at desc limit $2",
      [tenantId, limit],
    );
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
    const member = await membership(req.authUser!.id, tenantId);
    if (!member) return res.status(404).json({ error: "tenant_not_found" });
    if (!["owner", "admin", "finance"].includes(member.role)) return res.status(403).json({ error: "insufficient_role" });
    const d = parsed.data;
    const result = await getPool().query(
      "insert into public.payment_transactions(tenant_id,provider,merchant_reference,idempotency_key,amount_minor,currency,status,payer_reference,description) values($1,$2,$3,$4,$5,$6,'created',$7,$8) on conflict (tenant_id,idempotency_key) where idempotency_key is not null do nothing returning id,provider,merchant_reference,amount_minor,currency,status,created_at",
      [tenantId,d.provider,d.merchantReference,idempotencyKey,d.amountMinor,d.currency,d.payerReference ?? null,d.description ?? null],
    );
    if (result.rows[0]) {
      await getPool().query(
        "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,correlation_id,metadata) values($1,$2,'transaction.created','transaction',$3,$4,$5::jsonb)",
        [tenantId,req.authUser!.id,result.rows[0].id,randomUUID(),JSON.stringify({ provider: d.provider, amountMinor: d.amountMinor })],
      );
      return res.status(201).json({ transaction: result.rows[0], idempotentReplay: false });
    }
    const existing = await getPool().query(
      "select id,provider,merchant_reference,amount_minor,currency,status,created_at from public.payment_transactions where tenant_id=$1 and idempotency_key=$2",
      [tenantId,idempotencyKey],
    );
    if (!existing.rows[0]) return res.status(409).json({ error: "idempotency_conflict" });
    const row = existing.rows[0];
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
    if (!await membership(req.authUser!.id, tenantId)) return res.status(404).json({ error: "tenant_not_found" });
    const result = await getPool().query(
      "select id,transaction_id,provider,provider_reference,exception_type,details,status,resolution_note,resolved_by,resolved_at,created_at,updated_at from public.payment_reconciliation_exceptions where tenant_id=$1 order by created_at desc limit 200",
      [tenantId],
    );
    return res.json({ exceptions: result.rows });
  } catch (error) { return next(error); }
});

router.post("/tenants/:tenantId/exceptions/:exceptionId/resolve", async (req, res, next) => {
  const tenantId = req.params.tenantId!, exceptionId = req.params.exceptionId!;
  if (!validTenantParam(tenantId) || !validTenantParam(exceptionId)) return res.status(400).json({ error: "invalid_id" });
  const parsed = resolveSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  try {
    const member = await membership(req.authUser!.id, tenantId);
    if (!member) return res.status(404).json({ error: "tenant_not_found" });
    if (!["owner", "admin", "finance"].includes(member.role)) return res.status(403).json({ error: "insufficient_role" });
    const client = await getPool().connect();
    try {
      await client.query("begin");
      const result = await client.query(
        "update public.payment_reconciliation_exceptions set status=$1,resolution_note=$2,resolved_by=$3,resolved_at=now(),updated_at=now() where id=$4 and tenant_id=$5 and status in ('open','investigating') returning id,status,resolution_note,resolved_at",
        [parsed.data.status,parsed.data.resolutionNote,req.authUser!.id,exceptionId,tenantId],
      );
      if (!result.rows[0]) { await client.query("rollback"); return res.status(404).json({ error: "open_exception_not_found" }); }
      await client.query(
        "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,entity_id,metadata) values($1,$2,'reconciliation.exception.resolved','exception',$3,$4::jsonb)",
        [tenantId,req.authUser!.id,exceptionId,JSON.stringify({ status: parsed.data.status, note: parsed.data.resolutionNote })],
      );
      await client.query("commit");
      return res.json({ exception: result.rows[0] });
    } catch (error) { await client.query("rollback").catch(() => undefined); throw error; }
    finally { client.release(); }
  } catch (error) { return next(error); }
});

router.get("/tenants/:tenantId/reports/transactions.csv", async (req, res, next) => {
  const tenantId = req.params.tenantId!;
  if (!validTenantParam(tenantId)) return res.status(400).json({ error: "invalid_tenant_id" });
  try {
    if (!await membership(req.authUser!.id, tenantId)) return res.status(404).json({ error: "tenant_not_found" });
    const result = await getPool().query(
      "select id,provider,merchant_reference,amount_minor,currency,status,provider_transaction_id,created_at,confirmed_at from public.payment_transactions where tenant_id=$1 order by created_at desc limit 10000",
      [tenantId],
    );
    const safe = (value: unknown) => {
      const raw = value == null ? "" : String(value);
      const escaped = raw.replace(/"/g, '""');
      return /^[=+@\-\t\r]/.test(raw) ? "'" + escaped : escaped;
    };
    const columns = ["id","provider","merchant_reference","amount_minor","currency","status","provider_transaction_id","created_at","confirmed_at"];
    const lines = [columns.join(","), ...result.rows.map((row) => columns.map((key) => `"${safe(row[key])}"`).join(","))];
    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", "attachment; filename=\"mobiwave-transactions.csv\"");
    return res.send(lines.join("\r\n"));
  } catch (error) { return next(error); }
});

export default router;
