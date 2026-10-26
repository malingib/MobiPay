import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { createAuthClient } from "@neondatabase/auth";
import "./styles.css";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || window.location.origin).replace(/\/$/, "");
const authClient = authUrl ? createAuthClient(authUrl) : null;
type Tenant = { id: string; name: string; slug: string; role: string };
type Connection = { provider: string; connection_status: string; enabled: boolean; environment: string; last_tested_at?: string | null };
type Provider = "daraja" | "pesapal";

function App() {
  const [user, setUser] = useState<{ id?: string; name?: string; email?: string } | null>(null);
  const [mode, setMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [name, setName] = useState("");
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [tenants, setTenants] = useState<Tenant[]>([]); const [tenantId, setTenantId] = useState(""); const [tenantName, setTenantName] = useState("");
  const [connections, setConnections] = useState<Connection[]>([]); const [provider, setProvider] = useState<Provider>("daraja");
  const [consumerKey, setConsumerKey] = useState(""); const [consumerSecret, setConsumerSecret] = useState(""); const [shortCode, setShortCode] = useState(""); const [passkey, setPasskey] = useState(""); const [ipnId, setIpnId] = useState("");
  const configured = Boolean(authClient && apiBase);
  const token = useCallback(async () => {
    if (!authClient) throw new Error("Neon Auth is not configured.");
    const result = await authClient.token();
    if (result.error || !result.data?.token) throw new Error(result.error?.message ?? "Session expired. Sign in again.");
    return result.data.token;
  }, []);
  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const jwt = await token();
    const response = await fetch(apiBase + path, { ...init, headers: { "content-type": "application/json", authorization: `Bearer ${jwt}`, ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new Error(body.message || body.error || `Request failed (${response.status})`);
    return body;
  }, [token]);
  const loadTenants = useCallback(async () => {
    const result = await api("/api/v1/tenants"); const items = (result.tenants ?? []) as Tenant[];
    setTenants(items); setTenantId((current) => items.some((item) => item.id === current) ? current : (items[0]?.id ?? ""));
  }, [api]);
  const loadConnections = useCallback(async (id: string) => {
    if (!id) { setConnections([]); return; }
    const result = await api(`/api/v1/tenants/${id}/provider-connections`); setConnections((result.connections ?? []) as Connection[]);
  }, [api]);
  useEffect(() => {
    let active = true;
    if (authClient) authClient.getSession().then((result) => { if (active && !result.error && result.data?.user) setUser(result.data.user); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  useEffect(() => { if (user) loadTenants().catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load workspaces.")); }, [user, loadTenants]);
  useEffect(() => { if (user && tenantId) loadConnections(tenantId).catch((e: unknown) => setError(e instanceof Error ? e.message : "Could not load provider connections.")); }, [user, tenantId, loadConnections]);

  async function submitAuth(event: React.FormEvent) {
    event.preventDefault(); if (!authClient) return; setBusy(true); setError(""); setNotice("");
    try {
      if (mode === "sign-up") {
        const result = await authClient.signUp.email({ email, password, name });
        if (result.error) throw new Error(result.error.message);
        const session = await authClient.getSession();
        if (!session.error && session.data?.user) setUser(session.data.user);
        else { setMode("sign-in"); setNotice("Account created. Complete any email verification, then sign in."); }
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message);
        if (result.data?.user) setUser(result.data.user);
        else setNotice("Sign-in did not create an active session. Check your email verification and try again.");
      }
    } catch (e) { setError(e instanceof Error ? e.message : "Authentication failed."); } finally { setBusy(false); }
  }
  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault(); const clean = tenantName.trim(); const slug = clean.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    if (slug.length < 3) { setError("Use a workspace name with at least three letters or numbers."); return; }
    setBusy(true); setError(""); setNotice("");
    try { const result = await api("/api/v1/tenants", { method: "POST", body: JSON.stringify({ name: clean, slug }) }); await loadTenants(); if (result.tenant?.id) setTenantId(result.tenant.id); setTenantName(""); setNotice("Workspace created."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not create workspace."); } finally { setBusy(false); }
  }
  async function saveCredentials(event: React.FormEvent) {
    event.preventDefault(); if (!tenantId) return;
    const credentials = provider === "daraja" ? { consumerKey, consumerSecret, shortCode, passkey } : { consumerKey, consumerSecret, ipnId };
    setBusy(true); setError(""); setNotice("");
    try { await api(`/api/v1/tenants/${tenantId}/provider-connections/${provider}`, { method: "PUT", body: JSON.stringify(credentials) }); setConsumerKey(""); setConsumerSecret(""); setShortCode(""); setPasskey(""); setIpnId(""); await loadConnections(tenantId); setNotice("Credentials encrypted and saved. Test the connection to enable it."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not save credentials."); } finally { setBusy(false); }
  }
  async function testConnection(p: Provider) {
    if (!tenantId) { setError("Select or create a workspace first."); return; }
    setBusy(true); setError(""); setNotice("");
    try { const result = await api(`/api/v1/tenants/${tenantId}/provider-connections/${p}/test`, { method: "POST", body: "{}" }); await loadConnections(tenantId); setNotice(result.message ?? "Sandbox authentication verified."); }
    catch (e) { setError(e instanceof Error ? e.message : "Provider test failed."); await loadConnections(tenantId).catch(() => undefined); } finally { setBusy(false); }
  }
  async function removeConnection(p: Provider) {
    if (!tenantId || !window.confirm(`Remove the ${p} connection?`)) return;
    setBusy(true); setError(""); setNotice("");
    try { await api(`/api/v1/tenants/${tenantId}/provider-connections/${p}`, { method: "DELETE" }); await loadConnections(tenantId); setNotice("Connection removed."); }
    catch (e) { setError(e instanceof Error ? e.message : "Could not remove connection."); } finally { setBusy(false); }
  }
  async function signOut() { try { await authClient?.signOut(); } finally { setUser(null); setTenants([]); setTenantId(""); setConnections([]); } }

  if (!configured) return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">M</div><p className="eyebrow">MOBIWAVE PAYMENTS</p><h1>Secure setup required</h1><p>Configure <code>VITE_NEON_AUTH_URL</code> with the Neon Auth URL for the dedicated MobiPay project and <code>VITE_API_BASE_URL</code> with the API origin. Never put database passwords or server secrets in frontend variables.</p></section></main>;
  if (!user) return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">M</div><p className="eyebrow">MOBIWAVE PAYMENTS</p><h1>{mode === "sign-up" ? "Create merchant account" : "Sign in"}</h1><p className="auth-subtitle">Secure payment visibility and reconciliation for Kenyan businesses.</p>
    <form className="auth-form" onSubmit={submitAuth}>{mode === "sign-up" && <label>Full name<input autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required maxLength={120}/></label>}<label>Work email<input type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} required maxLength={254}/></label><label>Password<input type="password" autoComplete={mode === "sign-up" ? "new-password" : "current-password"} value={password} onChange={(e) => setPassword(e.target.value)} minLength={8} maxLength={128} required/></label>{error && <p className="alert error" role="alert">{error}</p>}{notice && <p className="alert" role="status">{notice}</p>}<button className="primary-button" disabled={busy}>{busy ? "Please wait…" : mode === "sign-up" ? "Create account" : "Sign in"}</button></form>
    <p className="auth-switch">{mode === "sign-up" ? "Already registered?" : "New merchant?"} <button className="text-button" type="button" onClick={() => { setMode(mode === "sign-up" ? "sign-in" : "sign-up"); setError(""); setNotice(""); }}>{mode === "sign-up" ? "Sign in" : "Create account"}</button></p><p className="security-note">Provider secrets are encrypted by the API and never displayed again.</p>
  </section></main>;

  return <main className="shell"><aside className="sidebar"><div className="brand-mark">M</div><div className="brand-name">MobiWave <span>Payments</span></div><div className="tenant"><span className="tenant-label">MERCHANT WORKSPACE</span><strong>{tenants.find(t => t.id === tenantId)?.name ?? "Create a workspace"}</strong><small>Sandbox environment</small></div><nav aria-label="Main navigation"><a className="active" href="#overview">Overview</a><a href="#connections">Payment providers</a><a href="#security">Security</a></nav><div className="sidebar-bottom"><span className="status-dot"/> Authenticated session</div></aside>
    <section className="content"><header className="topbar"><div><span className="eyebrow">MERCHANT CONSOLE</span><h1 id="overview">Workspace overview</h1></div><div className="top-actions"><span className="sandbox-pill">SANDBOX ONLY</span><span className="user-email">{user.email}</span><button className="secondary-button" onClick={signOut}>Sign out</button></div></header>
    <div className="notice"><strong>Merchant-owned integrations</strong><span>Connect your own Daraja and/or Pesapal sandbox account. Credentials are encrypted at rest and scoped to this workspace.</span></div>{error && <p className="alert error" role="alert">{error}</p>}{notice && <p className="alert" role="status">{notice}</p>}
    <section className="panel"><div className="panel-heading"><div><h2>Your workspaces</h2><p>Each workspace has isolated payment records and provider credentials.</p></div></div><label className="workspace-select">Current workspace<select value={tenantId} onChange={e => setTenantId(e.target.value)}><option value="">Select a workspace</option>{tenants.map(t => <option key={t.id} value={t.id}>{t.name} · {t.role}</option>)}</select></label><form className="workspace-create" onSubmit={createWorkspace}><label>Business name<input value={tenantName} onChange={e => setTenantName(e.target.value)} placeholder="e.g. Acme Kenya Ltd" required maxLength={160}/></label><button className="primary-button" disabled={busy}>Create workspace</button></form></section>
    <section className="panel" id="connections"><div className="panel-heading"><div><h2>Payment provider connections</h2><p>Connect your own sandbox credentials. Live mode remains disabled.</p></div></div>
      {connections.map(c => <div className="provider" key={c.provider}><div className={`provider-icon ${c.provider === "daraja" ? "mpesa" : "pesapal"}`}>{c.provider === "daraja" ? "M" : "P"}</div><div className="provider-info"><strong>{c.provider === "daraja" ? "M-Pesa Daraja" : "Pesapal"}</strong><small>{c.environment} · {c.last_tested_at ? `Tested ${new Date(c.last_tested_at).toLocaleString()}` : "Not tested yet"}</small></div><span className={`state ${c.connection_status === "verified" && c.enabled ? "success" : c.connection_status === "error" ? "failed" : "pending"}`}>{c.connection_status.replaceAll("_", " ")}</span><button className="secondary-button" type="button" disabled={busy} onClick={() => void testConnection(c.provider as Provider)}>Test</button><button className="text-button danger-text" type="button" disabled={busy} onClick={() => void removeConnection(c.provider as Provider)}>Remove</button></div>)}
      <form className="provider-form" onSubmit={saveCredentials}><h3>Connect a sandbox account</h3><label>Provider<select value={provider} onChange={e => setProvider(e.target.value as Provider)}><option value="daraja">M-Pesa Daraja</option><option value="pesapal">Pesapal</option></select></label><label>Consumer key<input autoComplete="off" value={consumerKey} onChange={e => setConsumerKey(e.target.value)} required maxLength={512}/></label><label>Consumer secret<input type="password" autoComplete="new-password" value={consumerSecret} onChange={e => setConsumerSecret(e.target.value)} required maxLength={512}/></label>{provider === "daraja" ? <><label>Shortcode<input value={shortCode} onChange={e => setShortCode(e.target.value)} required maxLength={32}/></label><label>STK passkey<input type="password" autoComplete="new-password" value={passkey} onChange={e => setPasskey(e.target.value)} required maxLength={1024}/></label></> : <label>Registered IPN ID<input value={ipnId} onChange={e => setIpnId(e.target.value)} required maxLength={256}/></label>}<p className="security-note">Secret fields are cleared after save and cannot be retrieved through the UI.</p><button className="primary-button" disabled={busy || !tenantId}>{busy ? "Saving…" : "Encrypt and save credentials"}</button></form>
    </section><section className="panel" id="security"><div className="panel-heading"><div><h2>Security safeguards</h2><p>Account-level controls</p></div></div><ul className="security-list"><li>Neon Auth required for API access</li><li>AES-256-GCM encrypted provider credentials</li><li>Owner/admin-only provider configuration</li><li>Tenant-scoped records and audit events</li><li>Sandbox-only payment initiation</li></ul></section><footer>© 2026 MobiWave Payments <span>Secure payment visibility and reconciliation.</span></footer></section></main>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode><App/></React.StrictMode>);
