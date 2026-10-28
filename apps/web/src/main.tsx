import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { createAuthClient } from "@neondatabase/auth";
import "./styles.css";
import AdminApp from "./admin.js";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || window.location.origin).replace(/\/$/, "");
const authClient = authUrl ? createAuthClient(authUrl) : null;
type Page = "Overview" | "Transactions" | "Collect payment" | "Reconciliation" | "Payment providers" | "Webhooks" | "Developer API";
type Tenant = { id: string; name: string; slug: string; role: string };
type Connection = { provider: string; connection_status: string; enabled: boolean; environment: string; last_tested_at?: string | null; last_error_code?: string | null };
type Tx = { id: string; provider: string; merchant_reference: string; amount_minor: number; currency: string; status: string; payer_reference?: string | null; description?: string | null; provider_receipt?: string | null; provider_status?: string | null; created_at: string; confirmed_at?: string | null };
type Exception = { id: string; provider: string; provider_reference?: string | null; exception_type: string; status: string; details?: Record<string, unknown>; created_at: string; resolution_note?: string | null };
type Webhook = { id: string; url: string; subscribed_events: string[]; enabled: boolean; created_at: string };
type Provider = "daraja" | "pesapal";
const pages: Page[] = ["Overview", "Transactions", "Collect payment", "Reconciliation", "Payment providers", "Webhooks", "Developer API"];
const cash = (minor: number, currency = "KES") => new Intl.NumberFormat("en-KE", { style: "currency", currency, maximumFractionDigits: 2 }).format(minor / 100);
const stamp = (value?: string | null) => value ? new Date(value).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" }) : "—";
const label = (value: string) => value.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
const errorMessage = (e: unknown) => e instanceof Error ? e.message : "Request failed. Please try again.";

function App() {
  const [user, setUser] = useState<{ id?: string; name?: string; email?: string } | null>(null);
  const [authMode, setAuthMode] = useState<"sign-in" | "sign-up">("sign-in");
  const [email, setEmail] = useState(""); const [password, setPassword] = useState(""); const [fullName, setFullName] = useState("");
  const [tenants, setTenants] = useState<Tenant[]>([]); const [tenantId, setTenantId] = useState(""); const [tenantName, setTenantName] = useState("");
  const [page, setPage] = useState<Page>("Overview"); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const [transactions, setTransactions] = useState<Tx[]>([]); const [exceptions, setExceptions] = useState<Exception[]>([]);
  const [connections, setConnections] = useState<Connection[]>([]); const [webhooks, setWebhooks] = useState<Webhook[]>([]);
  const [search, setSearch] = useState(""); const [statusFilter, setStatusFilter] = useState("all");
  const [checkoutProvider, setCheckoutProvider] = useState<Provider>("daraja"); const [connectionProvider, setConnectionProvider] = useState<Provider>("daraja");
  const [consumerKey, setConsumerKey] = useState(""); const [consumerSecret, setConsumerSecret] = useState("");
  const [shortCode, setShortCode] = useState(""); const [passkey, setPasskey] = useState(""); const [ipnId, setIpnId] = useState("");
  const [amount, setAmount] = useState(""); const [phone, setPhone] = useState(""); const [payerEmail, setPayerEmail] = useState("");
  const [reference, setReference] = useState(""); const [description, setDescription] = useState("MobiWave payment"); const [checkoutResult, setCheckoutResult] = useState<{ message?: string; redirectUrl?: string; transactionId?: string } | null>(null);
  const [statementProvider, setStatementProvider] = useState("daraja"); const [statementName, setStatementName] = useState(""); const [statementCsv, setStatementCsv] = useState("");
  const [webhookUrl, setWebhookUrl] = useState(""); const [webhookSecretRef, setWebhookSecretRef] = useState("MOBIWAVE_WEBHOOK_SIGNING_SECRET");
  const [exceptionNote, setExceptionNote] = useState("");

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
    const result = await api("/api/v1/tenants");
    const items = (result.tenants ?? []) as Tenant[];
    setTenants(items);
    setTenantId((current) => items.some((item) => item.id === current) ? current : (items[0]?.id ?? ""));
  }, [api]);

  const loadWorkspace = useCallback(async () => {
    if (!tenantId) return;
    const id = encodeURIComponent(tenantId);
    const [tx, recon, conn, hooks] = await Promise.all([
      api(`/api/v1/tenants/${id}/transactions?limit=200`),
      api(`/api/v1/tenants/${id}/exceptions`),
      api(`/api/v1/tenants/${id}/provider-connections`),
      api(`/api/v1/tenants/${id}/webhook-endpoints`)
    ]);
    setTransactions((tx.transactions ?? []) as Tx[]);
    setExceptions((recon.exceptions ?? []) as Exception[]);
    setConnections((conn.connections ?? []) as Connection[]);
    setWebhooks((hooks.endpoints ?? []) as Webhook[]);
  }, [api, tenantId]);

  useEffect(() => {
    let active = true;
    if (authClient) authClient.getSession().then((result) => { if (active && !result.error && result.data?.user) setUser(result.data.user); }).catch(() => undefined);
    setLoading(false);
    return () => { active = false; };
  }, []);
  useEffect(() => { if (user) void loadTenants().catch((e: unknown) => setError(errorMessage(e))); }, [user, loadTenants]);
  useEffect(() => { if (user && tenantId) void loadWorkspace().catch((e: unknown) => setError(errorMessage(e))); }, [user, tenantId, loadWorkspace]);

  async function action(fn: () => Promise<unknown>, success: string) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); setNotice(success); if (tenantId) { try { await loadWorkspace(); } catch { setNotice(success + " The action succeeded, but refreshing the latest records failed. Refresh before retrying."); } } }
    catch (e) { setError(errorMessage(e)); }
    finally { setBusy(false); }
  }
  async function submitAuth(event: React.FormEvent) {
    event.preventDefault(); if (!authClient) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (authMode === "sign-up") {
        const result = await authClient.signUp.email({ email, password, name: fullName });
        if (result.error) throw new Error(result.error.message);
        const session = await authClient.getSession();
        if (!session.error && session.data?.user) setUser(session.data.user);
        else { setAuthMode("sign-in"); setNotice("Account created. Verify your email if prompted, then sign in."); }
      } else {
        const result = await authClient.signIn.email({ email, password });
        if (result.error) throw new Error(result.error.message);
        if (result.data?.user) setUser(result.data.user);
      }
    } catch (e) { setError(errorMessage(e)); } finally { setBusy(false); }
  }
  async function createWorkspace(event: React.FormEvent) {
    event.preventDefault();
    const clean = tenantName.trim();
    const slug = clean.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
    if (slug.length < 3) { setError("Use a workspace name with at least three letters or numbers."); return; }
    await action(async () => { const result = await api("/api/v1/tenants", { method: "POST", body: JSON.stringify({ name: clean, slug }) }); await loadTenants(); if (result.tenant?.id) setTenantId(result.tenant.id); setTenantName(""); }, "Workspace created.");
  }
  async function saveCredentials(event: React.FormEvent) {
    event.preventDefault(); if (!tenantId) return;
    const credentials = connectionProvider === "daraja" ? { consumerKey, consumerSecret, shortCode, passkey } : { consumerKey, consumerSecret, ipnId };
    await action(async () => {
      await api(`/api/v1/tenants/${tenantId}/provider-connections/${connectionProvider}`, { method: "PUT", body: JSON.stringify(credentials) });
      setConsumerKey(""); setConsumerSecret(""); setShortCode(""); setPasskey(""); setIpnId("");
    }, "Sandbox credentials encrypted and saved. Test the connection before checkout.");
  }
  async function testConnection(p: Provider) {
    await action(async () => { await api(`/api/v1/tenants/${tenantId}/provider-connections/${p}/test`, { method: "POST", body: "{}" }); }, "Provider sandbox authentication verified.");
  }
  async function removeConnection(p: Provider) {
    if (!window.confirm(`Remove the ${p} connection from this workspace?`)) return;
    await action(() => api(`/api/v1/tenants/${tenantId}/provider-connections/${p}`, { method: "DELETE" }), "Provider connection removed.");
  }
  async function collectPayment(event: React.FormEvent) {
    event.preventDefault(); setCheckoutResult(null);
    const amountValue = Number(amount);
    if (!Number.isFinite(amountValue) || amountValue <= 0 || (checkoutProvider === "daraja" && !Number.isInteger(amountValue))) { setError(checkoutProvider === "daraja" ? "M-Pesa STK amount must be a whole KES amount." : "Enter a valid payment amount."); return; }
    const amountMinor = Math.round(amountValue * 100);
    await action(async () => {
      const key = crypto.randomUUID();
      const payload = checkoutProvider === "daraja"
        ? { phone: phone.replace(/[+\s-]/g, "").replace(/^0/, "254"), amountMinor, merchantReference: reference.trim(), description }
        : { amountMinor, merchantReference: reference.trim(), description, email: payerEmail || undefined, phone: phone || undefined };
      const result = await api(`/api/v1/tenants/${tenantId}/${checkoutProvider === "daraja" ? "daraja/stk-push" : "pesapal/checkout"}`, {
        method: "POST", headers: { "idempotency-key": key }, body: JSON.stringify(payload)
      });
      setCheckoutResult({ message: result.message ?? (result.status ? `Payment status: ${result.status}` : "Checkout request created."), redirectUrl: result.redirectUrl, transactionId: result.transactionId });
      setAmount(""); setPhone(""); setPayerEmail(""); setReference(""); setDescription("MobiWave payment");
    }, checkoutProvider === "daraja" ? "STK request submitted to Daraja sandbox. Await provider verification." : "Pesapal sandbox checkout created.");
  }
  async function importStatement(event: React.FormEvent) {
    event.preventDefault();
    await action(async () => {
      const result = await api(`/api/v1/tenants/${tenantId}/reconciliation/import`, { method: "POST", body: JSON.stringify({ provider: statementProvider, sourceName: statementName || "provider-statement.csv", csvContent: statementCsv }) });
      setStatementCsv(""); setStatementName("");
      setNotice(result.idempotentReplay ? "This statement was already imported; existing reconciliation result returned." : `Statement imported: ${result.run?.rows_matched ?? 0} matched, ${result.run?.rows_unmatched ?? 0} unmatched, ${result.run?.rows_exception ?? 0} exceptions.`);
    }, "Statement import completed.");
  }
  async function resolveException(item: Exception, status: "resolved" | "dismissed") {
    const note = exceptionNote.trim() || window.prompt("Add a resolution note (required):")?.trim() || "";
    if (note.length < 3) { setError("Add a resolution note of at least three characters."); return; }
    await action(() => api(`/api/v1/tenants/${tenantId}/exceptions/${item.id}/resolve`, { method: "POST", body: JSON.stringify({ status, resolutionNote: note }) }), `Exception ${status}.`);
    setExceptionNote("");
  }
  async function addWebhook(event: React.FormEvent) {
    event.preventDefault();
    await action(() => api(`/api/v1/tenants/${tenantId}/webhook-endpoints`, { method: "POST", body: JSON.stringify({ url: webhookUrl, signingSecretReference: webhookSecretRef.trim(), subscribedEvents: ["payment.succeeded", "payment.failed", "payment.cancelled"] }) }), "Webhook endpoint registered.");
    setWebhookUrl("");
  }
  async function disableWebhook(id: string) {
    if (!window.confirm("Disable delivery to this webhook endpoint?")) return;
    await action(() => api(`/api/v1/tenants/${tenantId}/webhook-endpoints/${id}/disable`, { method: "POST", body: "{}" }), "Webhook endpoint disabled.");
  }
  async function exportTransactions() {
    setError(""); setNotice("");
    try {
      const jwt = await token();
      const response = await fetch(`${apiBase}/api/v1/tenants/${tenantId}/reports/transactions.csv`, { headers: { authorization: `Bearer ${jwt}` } });
      if (!response.ok) throw new Error(`Export failed (${response.status})`);
      const blob = await response.blob(); const url = URL.createObjectURL(blob); const link = document.createElement("a");
      link.href = url; link.download = "mobiwave-transactions.csv"; link.click(); URL.revokeObjectURL(url); setNotice("Transaction export downloaded.");
    } catch (e) { setError(errorMessage(e)); }
  }
  async function signOut() { try { await authClient?.signOut(); } finally { setUser(null); setTenants([]); setTenantId(""); setTransactions([]); setExceptions([]); setConnections([]); setWebhooks([]); } }

  const visibleTransactions = useMemo(() => transactions.filter((t) => {
    const haystack = [t.id, t.provider, t.merchant_reference, t.payer_reference, t.status, t.provider_receipt].join(" ").toLowerCase();
    return haystack.includes(search.toLowerCase()) && (statusFilter === "all" || t.status === statusFilter);
  }), [transactions, search, statusFilter]);
  const successful = transactions.filter((t) => t.status === "succeeded");
  const volume = successful.reduce((sum, t) => sum + Number(t.amount_minor || 0), 0);
  const pending = transactions.filter((t) => ["created", "pending", "unknown"].includes(t.status)).length;
  const activeConnections = connections.filter((c) => c.connection_status === "verified" && c.enabled).length;
  const selectedTenant = tenants.find((t) => t.id === tenantId);
  const configured = Boolean(authClient && apiBase);

  if (loading) return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">MW</div><p>Loading secure workspace…</p></section></main>;
  if (!configured) return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">MW</div><p className="eyebrow">MOBIWAVE PAYMENTS</p><h1>Secure setup required</h1><p>Configure <code>VITE_NEON_AUTH_URL</code> and the API origin. Database credentials and encryption keys must remain server-side.</p></section></main>;
  if (!user) return <main className="auth-shell"><section className="auth-card"><div className="brand-mark">MW</div><p className="eyebrow">MOBIWAVE PAYMENTS</p><h1>{authMode === "sign-up" ? "Create merchant account" : "Welcome back"}</h1><p className="muted">Payment collection, operational visibility and reconciliation for Kenyan businesses.</p><form className="auth-form" onSubmit={submitAuth}>{authMode === "sign-up" && <label>Full name<input value={fullName} onChange={(e) => setFullName(e.target.value)} autoComplete="name" required maxLength={120}/></label>}<label>Work email<input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required maxLength={254}/></label><label>Password<input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete={authMode === "sign-up" ? "new-password" : "current-password"} minLength={8} maxLength={128} required/></label>{error && <p className="alert error" role="alert">{error}</p>}{notice && <p className="alert" role="status">{notice}</p>}<button className="primary-button" disabled={busy}>{busy ? "Please wait…" : authMode === "sign-up" ? "Create account" : "Sign in securely"}</button></form><p className="auth-switch">{authMode === "sign-up" ? "Already registered?" : "New to MobiWave Payments?"} <button className="text-button" type="button" onClick={() => { setAuthMode(authMode === "sign-up" ? "sign-in" : "sign-up"); setError(""); setNotice(""); }}>{authMode === "sign-up" ? "Sign in" : "Create an account"}</button></p><p className="security-note">Sandbox environment · Live processing is disabled</p></section></main>;

  return <div className="shell">
    <aside className="sidebar"><div className="brand-row"><div className="brand-mark">MW</div><div className="brand-name">MobiWave <span>Payments</span></div></div>
      <div className="tenant"><span className="tenant-label">ACTIVE WORKSPACE</span><strong>{selectedTenant?.name ?? "No workspace selected"}</strong><small>{selectedTenant ? `${selectedTenant.role} · ${selectedTenant.slug}` : "Create a workspace to begin"}</small></div>
      <p className="nav-label">WORKSPACE</p><nav aria-label="Main navigation">{pages.map((item) => <button key={item} className={page === item ? "nav-item active" : "nav-item"} onClick={() => { setPage(item); setError(""); setNotice(""); }}>{item}</button>)}</nav>
      <div className="sidebar-bottom"><span className="status-dot"/><span>Sandbox · Live payments off</span><button className="text-button" onClick={signOut}>Sign out</button></div>
    </aside>
    <main className="content">
      <header className="topbar"><div><p className="eyebrow">PAYMENT OPERATIONS</p><h1>{page}</h1><p className="muted">{selectedTenant ? `Workspace: ${selectedTenant.name}` : "Create a workspace to start managing payments."}</p></div><div className="top-actions"><label className="workspace-picker"><span>Workspace</span><select value={tenantId} onChange={(e) => setTenantId(e.target.value)}><option value="">Select workspace</option>{tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label><span className="sandbox-pill">SANDBOX</span></div></header>
      {error && <div className="alert error" role="alert">{error}</div>}{notice && <div className="alert" role="status">{notice}</div>}
      {!tenantId && <section className="panel"><h2>Set up your workspace</h2><p className="muted">Workspace data is stored in PostgreSQL and scoped to your signed-in account.</p><form className="inline-form" onSubmit={createWorkspace}><label>Business or organisation name<input value={tenantName} onChange={(e) => setTenantName(e.target.value)} placeholder="e.g. Acme Kenya Ltd" required maxLength={160}/></label><button className="primary-button" disabled={busy}>Create workspace</button></form></section>}
      {tenantId && page === "Overview" && <>
        <div className="notice"><strong>Sandbox environment</strong><span>Provider requests use sandbox credentials. Successful payments are recorded only after provider-side verification. Live charging is locked.</span></div>
        <section className="metrics"><article className="metric"><span>Transactions</span><strong>{transactions.length.toLocaleString("en-KE")}</strong><small>Latest 200 records</small></article><article className="metric"><span>Confirmed volume</span><strong>{cash(volume)}</strong><small>Provider-verified successes only</small></article><article className="metric"><span>Awaiting confirmation</span><strong>{pending}</strong><small>Created, pending or unknown</small></article><article className="metric"><span>Open exceptions</span><strong>{exceptions.filter((e) => e.status !== "resolved" && e.status !== "dismissed").length}</strong><small>{activeConnections} verified provider connection(s)</small></article></section>
        <section className="panel"><div className="panel-heading"><div><h2>Recent transactions</h2><p className="muted">Latest payment activity from the database.</p></div><button className="secondary-button" onClick={() => setPage("Transactions")}>View all transactions</button></div><TransactionTable items={transactions.slice(0, 8)}/></section>
        <div className="two-col"><section className="panel"><div className="panel-heading"><div><h2>Provider connections</h2><p className="muted">Merchant-owned credentials</p></div><button className="secondary-button" onClick={() => setPage("Payment providers")}>Manage</button></div>{connections.length ? connections.map((c) => <div className="list-row" key={c.provider}><div><strong>{c.provider === "daraja" ? "M-Pesa Daraja" : label(c.provider)}</strong><small>{c.environment} · {label(c.connection_status)}</small></div><Status value={c.connection_status}/></div>) : <Empty>No provider accounts connected yet.</Empty>}</section><section className="panel"><div className="panel-heading"><div><h2>Reconciliation queue</h2><p className="muted">Items that need review</p></div><button className="secondary-button" onClick={() => setPage("Reconciliation")}>Review queue</button></div>{exceptions.filter((e) => e.status !== "resolved" && e.status !== "dismissed").slice(0, 5).map((e) => <div className="list-row" key={e.id}><div><strong>{label(e.exception_type)}</strong><small>{e.provider_reference || e.id.slice(0, 8)} · {stamp(e.created_at)}</small></div><Status value={e.status}/></div>)}{!exceptions.some((e) => e.status !== "resolved" && e.status !== "dismissed") && <Empty>No open reconciliation exceptions.</Empty>}</section></div>
      </>}
      {tenantId && page === "Transactions" && <section className="panel"><div className="panel-heading"><div><h2>Transaction ledger</h2><p className="muted">Search, filter and export provider-backed records.</p></div><button className="primary-button" onClick={() => setPage("Collect payment")}>Collect payment</button></div><div className="toolbar"><input aria-label="Search transactions" placeholder="Search reference, receipt, payer…" value={search} onChange={(e) => setSearch(e.target.value)}/><select aria-label="Filter by status" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}><option value="all">All statuses</option>{["created","pending","succeeded","failed","cancelled","expired","unknown"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select><button className="secondary-button" onClick={() => void exportTransactions()}>Export CSV</button><button className="secondary-button" onClick={() => void loadWorkspace().catch((e: unknown) => setError(errorMessage(e)))}>Refresh</button></div><TransactionTable items={visibleTransactions}/></section>}
      {tenantId && page === "Collect payment" && <section className="panel form-panel"><div className="panel-heading"><div><h2>New sandbox checkout</h2><p className="muted">This sends a request to the selected provider sandbox. It does not use live credentials.</p></div><span className="sandbox-pill">LIVE OFF</span></div><form className="form-grid" onSubmit={collectPayment}><label>Payment provider<select value={checkoutProvider} onChange={(e) => setCheckoutProvider(e.target.value as Provider)}><option value="daraja">M-Pesa Daraja · STK Push</option><option value="pesapal">Pesapal · Hosted checkout</option></select></label><label>Amount (KES)<input type="number" min="1" step={checkoutProvider === "daraja" ? "1" : "0.01"} value={amount} onChange={(e) => setAmount(e.target.value)} required/></label><label>Order or invoice reference<input value={reference} onChange={(e) => setReference(e.target.value)} required maxLength={120} placeholder="INV-2026-0001"/></label><label>Description<input value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={checkoutProvider === "daraja" ? 100 : 200}/></label><label>Customer phone<input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder={checkoutProvider === "daraja" ? "2547XXXXXXXX" : "+254 7XX XXX XXX"} required={checkoutProvider === "daraja"}/></label>{checkoutProvider === "pesapal" && <label>Customer email (optional)<input type="email" value={payerEmail} onChange={(e) => setPayerEmail(e.target.value)}/></label>}<div className="form-actions"><button className="primary-button" disabled={busy || !connections.some((c) => c.provider === checkoutProvider && c.connection_status === "verified" && c.enabled)}>{busy ? "Submitting…" : checkoutProvider === "daraja" ? "Send STK request" : "Create hosted checkout"}</button><span className="muted tiny">Requires a verified sandbox connection.</span></div></form>{checkoutResult && <div className="result-box"><strong>Provider response</strong><p>{checkoutResult.message}</p>{checkoutResult.transactionId && <small>Transaction ID: {checkoutResult.transactionId}</small>}{checkoutResult.redirectUrl && <p><a className="primary-link" href={checkoutResult.redirectUrl} target="_blank" rel="noreferrer">Continue to Pesapal checkout</a></p>}</div>}</section>}
      {tenantId && page === "Payment providers" && <><section className="panel"><div className="panel-heading"><div><h2>Provider status</h2><p className="muted">Credentials are encrypted at rest; only connection metadata is returned.</p></div></div>{(["daraja","pesapal"] as Provider[]).map((p) => { const c = connections.find((item) => item.provider === p); return <div className="provider-row" key={p}><div className="provider-symbol">{p === "daraja" ? "MP" : "PS"}</div><div className="provider-copy"><strong>{p === "daraja" ? "M-Pesa Daraja" : "Pesapal"}</strong><small>{c ? `${label(c.connection_status)} · ${c.environment} · Last tested ${stamp(c.last_tested_at)}` : "Not connected"}</small>{c?.last_error_code && <small className="danger-text">Last error: {c.last_error_code}</small>}</div><Status value={c?.connection_status ?? "not_configured"}/><div className="provider-actions"><button className="secondary-button" disabled={busy || !c} onClick={() => void testConnection(p)}>Test</button><button className="secondary-button danger-button" disabled={busy || !c} onClick={() => void removeConnection(p)}>Remove</button></div></div>; })}</section>
        <section className="panel form-panel"><div className="panel-heading"><div><h2>Connect sandbox credentials</h2><p className="muted">Enter provider sandbox credentials only. Do not enter live credentials here.</p></div></div><form className="form-grid" onSubmit={saveCredentials}><label>Provider<select value={connectionProvider} onChange={(e) => setConnectionProvider(e.target.value as Provider)}><option value="daraja">M-Pesa Daraja</option><option value="pesapal">Pesapal</option></select></label><label>Consumer key<input value={consumerKey} onChange={(e) => setConsumerKey(e.target.value)} required autoComplete="off"/></label><label>Consumer secret<input type="password" value={consumerSecret} onChange={(e) => setConsumerSecret(e.target.value)} required autoComplete="new-password"/></label>{connectionProvider === "daraja" ? <><label>Business shortcode<input value={shortCode} onChange={(e) => setShortCode(e.target.value)} required/></label><label>STK passkey<input type="password" value={passkey} onChange={(e) => setPasskey(e.target.value)} required autoComplete="new-password"/></label></> : <label>Pesapal IPN ID<input value={ipnId} onChange={(e) => setIpnId(e.target.value)} required/></label>}<div className="form-actions"><button className="primary-button" disabled={busy}>{busy ? "Saving…" : "Save encrypted credentials"}</button><span className="muted tiny">Saving does not initiate a payment.</span></div></form></section></>}
      {tenantId && page === "Reconciliation" && <><section className="panel form-panel"><div className="panel-heading"><div><h2>Import provider statement</h2><p className="muted">CSV import is deduplicated by content hash. Matching is conservative; mismatches require review.</p></div></div><p className="code-hint">Required columns: provider_reference, merchant_reference, amount_minor, currency. Optional: occurred_at.</p><form className="form-grid" onSubmit={importStatement}><label>Provider<select value={statementProvider} onChange={(e) => setStatementProvider(e.target.value)}>{["daraja","pesapal","bank","manual"].map((s) => <option key={s} value={s}>{label(s)}</option>)}</select></label><label>Statement name<input value={statementName} onChange={(e) => setStatementName(e.target.value)} placeholder="October statement.csv"/></label><label className="full-field">CSV statement file<input type="file" accept=".csv,text/csv" onChange={async (e) => { const file = e.currentTarget.files?.[0]; if (!file) return; setStatementName(file.name); setStatementCsv(await file.text()); }} /><small className="muted">Choose a CSV file or paste/edit its content below. Maximum file size: 1.8 MB.</small></label><label className="full-field">CSV content<textarea value={statementCsv} onChange={(e) => setStatementCsv(e.target.value)} rows={5} required placeholder={"provider_reference,merchant_reference,amount_minor,currency\nABC123,INV-001,10000,KES"}/></label><div className="form-actions"><button className="primary-button" disabled={busy || !statementCsv.trim()}>{busy ? "Reconciling…" : "Import and reconcile"}</button></div></form></section><section className="panel"><div className="panel-heading"><div><h2>Exceptions</h2><p className="muted">A statement match alone never confirms a payment.</p></div></div>{exceptions.length ? <div className="exception-list">{exceptions.map((item) => <article className="exception" key={item.id}><div><strong>{label(item.exception_type)}</strong><small>{item.provider} · {item.provider_reference || "No provider reference"} · {stamp(item.created_at)}</small><p>{String(item.details?.reason ?? item.details?.status ?? item.resolution_note ?? "Manual review required.")}</p></div><div className="exception-actions"><Status value={item.status}/>{!["resolved","dismissed"].includes(item.status) && <><input aria-label="Resolution note" placeholder="Resolution note" value={exceptionNote} onChange={(e) => setExceptionNote(e.target.value)}/><button className="secondary-button" disabled={busy} onClick={() => void resolveException(item,"resolved")}>Resolve</button><button className="secondary-button" disabled={busy} onClick={() => void resolveException(item,"dismissed")}>Dismiss</button></>}</div></article>)}</div> : <Empty>No reconciliation exceptions yet. Import a provider statement to begin.</Empty>}</section></>}
      {tenantId && page === "Webhooks" && <><section className="panel form-panel"><div className="panel-heading"><div><h2>Register a webhook endpoint</h2><p className="muted">HTTPS destinations only. Delivery requires the named signing secret in server-side secrets and an active delivery worker. Do not assume delivery is running until operations confirms the worker is enabled.</p></div></div><form className="form-grid" onSubmit={addWebhook}><label className="full-field">HTTPS endpoint URL<input type="url" value={webhookUrl} onChange={(e) => setWebhookUrl(e.target.value)} placeholder="https://merchant.example.com/webhooks/mobiwave" required/></label><label className="full-field">Signing secret environment variable<input value={webhookSecretRef} onChange={(e) => setWebhookSecretRef(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g,"_"))} required pattern="[A-Z][A-Z0-9_]{2,127}"/></label><div className="form-actions"><button className="primary-button" disabled={busy}>Register endpoint</button></div></form></section><section className="panel"><div className="panel-heading"><div><h2>Configured endpoints</h2><p className="muted">Secrets are never returned to the browser.</p></div></div>{webhooks.length ? webhooks.map((w) => <div className="list-row" key={w.id}><div><strong>{w.url}</strong><small>{(w.subscribed_events ?? []).join(", ")} · Added {stamp(w.created_at)}</small></div><Status value={w.enabled ? "enabled" : "disabled"}/>{w.enabled && <button className="secondary-button" onClick={() => void disableWebhook(w.id)} disabled={busy}>Disable</button>}</div>) : <Empty>No webhook endpoints registered.</Empty>}</section></>}
      {tenantId && page === "Developer API" && <section className="panel"><h2>API operations</h2><p className="muted">Requests use a short-lived Neon Auth JWT. Keep provider credentials and database URLs on the server.</p><div className="api-list">{[["GET","/api/v1/tenants","List your workspaces"],["GET","/api/v1/tenants/:tenantId/transactions","List payment transactions"],["POST","/api/v1/tenants/:tenantId/daraja/stk-push","Initiate a Daraja sandbox STK request"],["POST","/api/v1/tenants/:tenantId/pesapal/checkout","Create a Pesapal sandbox checkout"],["POST","/api/v1/tenants/:tenantId/reconciliation/import","Import and reconcile a CSV statement"],["GET","/api/v1/tenants/:tenantId/exceptions","List reconciliation exceptions"],["POST","/api/v1/tenants/:tenantId/webhook-endpoints","Register a signed webhook endpoint"]].map(([method,path,desc]) => <div className="api-row" key={path}><code className={method === "GET" ? "method get" : "method post"}>{method}</code><code>{path}</code><span>{desc}</span></div>)}</div><div className="notice"><strong>Production status</strong><span>Live payments remain disabled. Sandbox authentication does not prove successful checkout, callbacks, settlement or regulatory readiness.</span></div></section>}
      <footer><span>MobiWave Payments · Kenya</span><span>PostgreSQL-backed · Tenant-scoped · Sandbox only</span></footer>
    </main>
  </div>;
}

function Status({ value }: { value?: string }) { const v = value ?? "unknown"; return <span className={`state state-${v}`}>{label(v)}</span>; }
function Empty({ children }: { children: React.ReactNode }) { return <div className="empty-state">{children}</div>; }
function TransactionTable({ items }: { items: Tx[] }) {
  if (!items.length) return <Empty>No transactions yet. Initiate a sandbox checkout to create a real database record.</Empty>;
  return <div className="table-wrap"><table><thead><tr><th>REFERENCE</th><th>PROVIDER</th><th>AMOUNT</th><th>STATUS</th><th>PROVIDER RECEIPT</th><th>CREATED</th></tr></thead><tbody>{items.map((t) => <tr key={t.id}><td><strong>{t.merchant_reference}</strong><small className="table-sub">{t.payer_reference || t.id}</small></td><td>{label(t.provider)}</td><td className="amount">{cash(Number(t.amount_minor), t.currency || "KES")}</td><td><Status value={t.status}/></td><td>{t.provider_receipt || "—"}</td><td>{stamp(t.created_at)}</td></tr>)}</tbody></table></div>;
}
createRoot(document.getElementById("root")!).render(<React.StrictMode>{window.location.pathname.startsWith("/admin") ? <AdminApp /> : <App />}</React.StrictMode>);
