import { Router } from "express";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { z } from "zod";
import { getPool } from "./db.js";
import { requireAuth } from "./auth.js";

const router = Router();
const idSchema = z.string().uuid();
const providerSchema = z.enum(["daraja", "pesapal"]);
const darajaCredentials = z.object({
  consumerKey: z.string().trim().min(8).max(512),
  consumerSecret: z.string().min(8).max(512),
  shortCode: z.string().trim().min(1).max(32),
  passkey: z.string().min(8).max(1024),
}).strict();
const pesapalCredentials = z.object({
  consumerKey: z.string().trim().min(8).max(512),
  consumerSecret: z.string().min(8).max(512),
  ipnId: z.string().trim().min(1).max(256),
}).strict();

type ProviderCredentials = z.infer<typeof darajaCredentials> | z.infer<typeof pesapalCredentials>;

function encryptionKey() {
  const encoded = process.env.PROVIDER_CREDENTIALS_ENCRYPTION_KEY;
  if (!encoded) throw new Error("PROVIDER_CREDENTIALS_ENCRYPTION_KEY is not configured");
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new Error("PROVIDER_CREDENTIALS_ENCRYPTION_KEY must be a base64-encoded 32-byte key");
  return key;
}

function encryptCredentials(value: ProviderCredentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString("base64url")}:${tag.toString("base64url")}:${ciphertext.toString("base64url")}`;
}

function decryptCredentials(payload: string): ProviderCredentials {
  const [version, ivText, tagText, ciphertextText] = payload.split(":");
  if (version !== "v1" || !ivText || !tagText || !ciphertextText) throw new Error("Unsupported credential ciphertext format");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const clear = Buffer.concat([decipher.update(Buffer.from(ciphertextText, "base64url")), decipher.final()]).toString("utf8");
  return JSON.parse(clear) as ProviderCredentials;
}

async function memberRole(userId: string, tenantId: string) {
  const result = await getPool().query(
    "select m.role from public.payment_tenant_memberships m join public.payment_tenants t on t.id=m.tenant_id where m.user_id=$1 and m.tenant_id=$2 and m.status='active' and t.status='active'",
    [userId, tenantId],
  );
  return result.rows[0]?.role as string | undefined;
}

function providerMetadata(provider: string, credentials: ProviderCredentials) {
  if (provider === "daraja" && "shortCode" in credentials) {
    return { accountLabel: `Short code ending ${credentials.shortCode.slice(-4)}` };
  }
  if (provider === "pesapal" && "consumerKey" in credentials) {
    return { accountLabel: `Consumer key ending ${credentials.consumerKey.slice(-4)}` };
  }
  return { accountLabel: "Connected account" };
}

async function verifySandbox(provider: "daraja" | "pesapal", credentials: ProviderCredentials) {
  if (provider === "daraja" && "shortCode" in credentials) {
    const response = await fetch("https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials", {
      headers: { authorization: "Basic " + Buffer.from(`${credentials.consumerKey}:${credentials.consumerSecret}`).toString("base64") },
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof body.access_token !== "string") throw new Error("provider_credentials_rejected");
    return;
  }
  if (provider === "pesapal" && "ipnId" in credentials) {
    const response = await fetch("https://cybqa.pesapal.com/pesapalv3/api/Auth/RequestToken", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ consumer_key: credentials.consumerKey, consumer_secret: credentials.consumerSecret }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok || typeof body.token !== "string") throw new Error("provider_credentials_rejected");
    return;
  }
  throw new Error("provider_credentials_invalid");
}

router.use(requireAuth);

router.get("/tenants/:tenantId/provider-connections", async (req, res, next) => {
  const tenantId = String(req.params.tenantId ?? "");
  if (!idSchema.safeParse(tenantId).success) return res.status(400).json({ error: "invalid_tenant_id" });
  try {
    if (!await memberRole(req.authUser!.id, tenantId)) return res.status(404).json({ error: "tenant_not_found" });
    const result = await getPool().query(
      "select provider,connection_status,enabled,environment,last_tested_at,last_error_code,updated_at from public.payment_provider_configs where tenant_id=$1 and account_reference='primary' order by provider",
      [tenantId],
    );
    return res.json({ connections: result.rows });
  } catch (error) { return next(error); }
});

router.put("/tenants/:tenantId/provider-connections/:provider", async (req, res, next) => {
  const tenantId = String(req.params.tenantId ?? "");
  const providerParsed = providerSchema.safeParse(req.params.provider);
  if (!idSchema.safeParse(tenantId).success || !providerParsed.success) return res.status(400).json({ error: "invalid_request" });
  const parsed = providerParsed.data === "daraja" ? darajaCredentials.safeParse(req.body) : pesapalCredentials.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "invalid_credentials", details: parsed.error.flatten() });
  try {
    const role = await memberRole(req.authUser!.id, tenantId);
    if (!role) return res.status(404).json({ error: "tenant_not_found" });
    if (!["owner", "admin"].includes(role)) return res.status(403).json({ error: "insufficient_role" });
    let encrypted: string;
    try { encrypted = encryptCredentials(parsed.data); }
    catch { return res.status(503).json({ error: "credential_encryption_unavailable", message: "Provider credential encryption is not configured correctly." }); }
    const result = await getPool().query(
      `insert into public.payment_provider_configs(tenant_id,provider,account_reference,secret_reference,environment,enabled,encrypted_credentials,connection_status,last_error_code,created_by,updated_at)
       values($1,$2,'primary','db-encrypted:aes-256-gcm:v1','sandbox',false,$3,'configured',null,$4,now())
       on conflict (tenant_id,provider) where account_reference='primary'
       do update set secret_reference='db-encrypted:aes-256-gcm:v1',environment='sandbox',enabled=false,encrypted_credentials=excluded.encrypted_credentials,connection_status='configured',last_tested_at=null,last_error_code=null,created_by=excluded.created_by,updated_at=now()
       returning provider,connection_status,enabled,environment,updated_at`,
      [tenantId, providerParsed.data, encrypted, req.authUser!.id],
    );
    await getPool().query(
      "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,metadata) values($1,$2,'provider.credentials.updated','provider_config',$3::jsonb)",
      [tenantId, req.authUser!.id, JSON.stringify({ provider: providerParsed.data, environment: "sandbox" })],
    );
    return res.status(200).json({ connection: result.rows[0], message: "Credentials encrypted and saved. Test the connection before enabling it." });
  } catch (error) { return next(error); }
});

router.post("/tenants/:tenantId/provider-connections/:provider/test", async (req, res, next) => {
  const tenantId = String(req.params.tenantId ?? "");
  const providerParsed = providerSchema.safeParse(req.params.provider);
  if (!idSchema.safeParse(tenantId).success || !providerParsed.success) return res.status(400).json({ error: "invalid_request" });
  try {
    const role = await memberRole(req.authUser!.id, tenantId);
    if (!role) return res.status(404).json({ error: "tenant_not_found" });
    if (!["owner", "admin"].includes(role)) return res.status(403).json({ error: "insufficient_role" });
    const found = await getPool().query(
      "select encrypted_credentials from public.payment_provider_configs where tenant_id=$1 and provider=$2 and account_reference='primary' and encrypted_credentials is not null",
      [tenantId, providerParsed.data],
    );
    if (!found.rows[0]) return res.status(404).json({ error: "provider_credentials_not_found" });
    let credentials: ProviderCredentials;
    try { credentials = decryptCredentials(String(found.rows[0].encrypted_credentials)); }
    catch { return res.status(503).json({ error: "credential_decryption_failed", message: "Credentials could not be decrypted. Verify the encryption key has not changed." }); }
    try {
      await verifySandbox(providerParsed.data, credentials);
      const updated = await getPool().query(
        "update public.payment_provider_configs set connection_status='verified',enabled=true,last_tested_at=now(),last_error_code=null,updated_at=now() where tenant_id=$1 and provider=$2 and account_reference='primary' returning provider,connection_status,enabled,environment,last_tested_at,updated_at",
        [tenantId, providerParsed.data],
      );
      await getPool().query(
        "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,metadata) values($1,$2,'provider.connection.verified','provider_config',$3::jsonb)",
        [tenantId, req.authUser!.id, JSON.stringify({ provider: providerParsed.data, environment: "sandbox" })],
      );
      return res.json({ connection: updated.rows[0], message: "Sandbox credentials verified. This verifies authentication only; a live payment has not been tested." });
    } catch {
      await getPool().query(
        "update public.payment_provider_configs set connection_status='error',enabled=false,last_tested_at=now(),last_error_code='provider_credentials_rejected',updated_at=now() where tenant_id=$1 and provider=$2 and account_reference='primary'",
        [tenantId, providerParsed.data],
      );
      return res.status(422).json({ error: "provider_credentials_rejected", message: "The provider rejected these sandbox credentials. Check the credentials and environment in the provider portal." });
    }
  } catch (error) { return next(error); }
});

router.delete("/tenants/:tenantId/provider-connections/:provider", async (req, res, next) => {
  const tenantId = String(req.params.tenantId ?? "");
  const providerParsed = providerSchema.safeParse(req.params.provider);
  if (!idSchema.safeParse(tenantId).success || !providerParsed.success) return res.status(400).json({ error: "invalid_request" });
  try {
    const role = await memberRole(req.authUser!.id, tenantId);
    if (!role) return res.status(404).json({ error: "tenant_not_found" });
    if (!["owner", "admin"].includes(role)) return res.status(403).json({ error: "insufficient_role" });
    const result = await getPool().query(
      "update public.payment_provider_configs set enabled=false,connection_status='disabled',encrypted_credentials=null,last_error_code=null,updated_at=now() where tenant_id=$1 and provider=$2 and account_reference='primary' returning provider,connection_status,enabled,updated_at",
      [tenantId, providerParsed.data],
    );
    if (!result.rows[0]) return res.status(404).json({ error: "provider_connection_not_found" });
    await getPool().query(
      "insert into public.payment_audit_events(tenant_id,actor_user_id,action,entity_type,metadata) values($1,$2,'provider.connection.removed','provider_config',$3::jsonb)",
      [tenantId, req.authUser!.id, JSON.stringify({ provider: providerParsed.data })],
    );
    return res.json({ connection: result.rows[0] });
  } catch (error) { return next(error); }
});

export default router;
