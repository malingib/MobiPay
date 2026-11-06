import { Router } from "express";
import { z } from "zod";
import { getPool } from "./db.js";
import { adminUsername, requirePlatformAdmin } from "./platformAdminSession.js";

const router = Router();
const statusSchema = z.object({ status: z.enum(["active", "suspended"]) });
const idSchema = z.string().uuid();
router.use(requirePlatformAdmin);
router.get("/security/database-role", async (_req, res, next) => {
  try {
    // Read-only diagnostics: no schema, data, role, or grant changes.
    const result = await getPool().query(`
      select current_user as runtime_role,
        r.rolsuper as is_superuser,
        r.rolbypassrls as bypasses_rls,
        (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p') and c.relname like 'payment\\_%' escape '\\'
            and c.relowner=r.oid) as payment_tables_owned_by_runtime_role,
        (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p') and c.relname like 'payment\\_%' escape '\\'
            and c.relrowsecurity) as payment_tables_with_rls,
        (select count(*)::int from pg_class c join pg_namespace n on n.oid=c.relnamespace
          where n.nspname='public' and c.relkind in ('r','p') and c.relname like 'payment\\_%' escape '\\'
            and c.relforcerowsecurity) as payment_tables_with_force_rls,
        (select count(*)::int from pg_policies p where p.schemaname='public' and p.tablename like 'payment\\_%' escape '\\') as payment_policy_count,
        (select coalesce(jsonb_agg(jsonb_build_object(
          'table', c.relname,
          'owner', pg_get_userbyid(c.relowner),
          'rls_enabled', c.relrowsecurity,
          'rls_forced', c.relforcerowsecurity,
          'select', has_table_privilege(current_user, c.oid, 'SELECT'),
          'insert', has_table_privilege(current_user, c.oid, 'INSERT'),
          'update', has_table_privilege(current_user, c.oid, 'UPDATE'),
          'delete', has_table_privilege(current_user, c.oid, 'DELETE'),
          'truncate', has_table_privilege(current_user, c.oid, 'TRUNCATE'),
          'references', has_table_privilege(current_user, c.oid, 'REFERENCES'),
          'trigger', has_table_privilege(current_user, c.oid, 'TRIGGER')
        ) order by c.relname), '[]'::jsonb)
        from pg_class c join pg_namespace n on n.oid=c.relnamespace
        where n.nspname='public' and c.relkind in ('r','p') and c.relname like 'payment\\_%' escape '\\') as payment_table_privileges
      from pg_roles r where r.rolname=current_user
    `);
    return res.json({ databaseSecurity: result.rows[0] });
  } catch (error) { return next(error); }
});

router.get("/overview", async (_req, res, next) => {
  try {
    const [tenants, transactions, providers, exceptions] = await Promise.all([
      getPool().query(`select count(*)::int as total,
        count(*) filter (where status='active')::int as active,
        count(*) filter (where status='suspended')::int as suspended from public.payment_tenants`),
      getPool().query(`select count(*)::int as total,
        count(*) filter (where status='succeeded')::int as succeeded,
        count(*) filter (where status='pending')::int as pending,
        count(*) filter (where status='failed')::int as failed,
        coalesce(sum(amount_minor) filter (where status='succeeded'),0)::text as succeeded_amount_minor
        from public.payment_transactions`),
      getPool().query(`select provider, connection_status, count(*)::int as total
        from public.payment_provider_configs group by provider, connection_status order by provider, connection_status`),
      getPool().query(`select count(*)::int as open from public.payment_reconciliation_exceptions where status not in ('resolved','dismissed')`),
    ]);
    return res.json({ tenants: tenants.rows[0], transactions: transactions.rows[0], providers: providers.rows, exceptions: exceptions.rows[0] });
  } catch (error) { return next(error); }
});
router.get("/tenants", async (req, res, next) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim().slice(0, 120) : "";
  try {
    const result = await getPool().query(`
      select t.id,t.name,t.slug,t.status,t.created_at,
        (select count(*)::int from public.payment_tenant_memberships m where m.tenant_id=t.id and m.status='active') as members,
        (select count(*)::int from public.payment_transactions tx where tx.tenant_id=t.id) as transactions,
        coalesce((select sum(tx.amount_minor) from public.payment_transactions tx where tx.tenant_id=t.id and tx.status='succeeded'),0)::text as succeeded_amount_minor
      from public.payment_tenants t
      where ($1='' or t.name ilike '%'||$1||'%' or t.slug ilike '%'||$1||'%')
      order by t.created_at desc limit 250`, [q]);
    return res.json({ tenants: result.rows });
  } catch (error) { return next(error); }
});
router.get("/transactions", async (req, res, next) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100));
  try {
    const result = await getPool().query(`
      select tx.id,tx.tenant_id,t.name as tenant_name,tx.provider,tx.merchant_reference,
        tx.amount_minor,tx.currency,tx.status,tx.provider_receipt,tx.provider_status,tx.created_at,tx.confirmed_at
      from public.payment_transactions tx join public.payment_tenants t on t.id=tx.tenant_id
      order by tx.created_at desc limit $1`, [limit]);
    return res.json({ transactions: result.rows });
  } catch (error) { return next(error); }
});
router.patch("/tenants/:tenantId/status", async (req, res, next) => {
  const tenantId = String(req.params.tenantId ?? "");
  if (!idSchema.safeParse(tenantId).success) return res.status(400).json({ error: "invalid_tenant_id" });
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() });
  const client = await getPool().connect();
  try {
    await client.query("begin");
    const result = await client.query(
      "update public.payment_tenants set status=$1,updated_at=now() where id=$2 returning id,name,slug,status,updated_at",
      [parsed.data.status, tenantId],
    );
    if (!result.rows[0]) { await client.query("rollback"); return res.status(404).json({ error: "tenant_not_found" }); }
    await client.query(
      "insert into public.platform_admin_audit_logs(actor_username,action,entity_type,entity_id,metadata) values($1,$2,'tenant',$3,$4::jsonb)",
      [adminUsername(req), parsed.data.status === "suspended" ? "tenant.suspended" : "tenant.activated", tenantId, JSON.stringify({ status: parsed.data.status, merchantName: result.rows[0].name })],
    );
    await client.query("commit");
    return res.json({ tenant: result.rows[0] });
  } catch (error) { await client.query("rollback").catch(() => undefined); return next(error); }
  finally { client.release(); }
});
export default router;
