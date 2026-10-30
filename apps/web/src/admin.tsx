import React, { useCallback, useEffect, useState } from "react";
import "./admin.css";

const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || window.location.origin).replace(/\/$/, "");
type Admin = { username: string };
type Tenant = { id: string; name: string; slug: string; status: string; created_at: string; members: number; transactions: number; succeeded_amount_minor: string };
type Tx = { id: string; tenant_name: string; provider: string; merchant_reference: string; amount_minor: number; currency: string; status: string; provider_receipt?: string | null; created_at: string };
type Overview = { tenants: { total: number; active: number; suspended: number }; transactions: { total: number; succeeded: number; pending: number; failed: number; succeeded_amount_minor: string }; providers: { provider: string; connection_status: string; total: number }[]; exceptions: { open: number } };
type Tab = "Overview" | "Merchants" | "Transactions";
const money = (minor: number | string, currency = "KES") => new Intl.NumberFormat("en-KE", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(minor || 0) / 100);
const date = (v: string) => new Date(v).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
const title = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function AdminApp() {
  const [admin, setAdmin] = useState<Admin | null>(null);
  const [username, setUsername] = useState(""); const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("Overview"); const [overview, setOverview] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]); const [transactions, setTransactions] = useState<Tx[]>([]);
  const [query, setQuery] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");

  const api = useCallback(async (path: string, init: RequestInit = {}) => {
    const response = await fetch(apiBase + path, { ...init, credentials: "include", headers: { "content-type": "application/json", ...(init.headers ?? {}) } });
    const body = await response.json().catch(() => ({})) as Record<string, any>;
    if (!response.ok) throw new Error(body.message || body.error || `Request failed (\${response.status})`);
    return body;
  }, []);
  const refresh = useCallback(async () => {
    setError("");
    const [o, t, tx] = await Promise.all([api("/api/admin/overview"), api("/api/admin/tenants"), api("/api/admin/transactions?limit=100")]);
    setOverview(o as Overview); setTenants((t.tenants ?? []) as Tenant[]); setTransactions((tx.transactions ?? []) as Tx[]);
  }, [api]);
  useEffect(() => {
    let alive = true;
    api("/api/admin/session").then((result) => { if (alive) setAdmin(result.administrator as Admin); }).catch(() => undefined).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [api]);
  useEffect(() => { if (admin) void refresh().catch((e) => setError(e instanceof Error ? e.message : "Unable to load admin data.")); }, [admin, refresh]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      const result = await api("/api/admin/session", { method: "POST", body: JSON.stringify({ username, password }) });
      setAdmin(result.administrator as Admin); setPassword("");
    } catch (e) { setError(e instanceof Error ? e.message : "Sign in failed."); }
    finally { setBusy(false); }
  }
  async function signOut() {
    setBusy(true);
    try { await api("/api/admin/session", { method: "DELETE" }); setAdmin(null); setOverview(null); setTenants([]); setTransactions([]); }
    catch (e) { setError(e instanceof Error ? e.message : "Sign out failed."); }
    finally { setBusy(false); }
  }
  async function changeStatus(tenant: Tenant) {
    const status = tenant.status === "suspended" ? "active" : "suspended";
    const action = status === "suspended" ? "suspend" : "reactivate";
    if (!window.confirm(`Are you sure you want to \${action} \${tenant.name}? This affects new payment operations for this merchant.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`/api/admin/tenants/\${encodeURIComponent(tenant.id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setNotice(`\${tenant.name} \${status === "suspended" ? "suspended" : "reactivated"}.`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to update merchant."); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="admin-shell"><div className="admin-loading">Loading MobiWave Payments…</div></div>;
  if (!admin) return <div className="admin-shell admin-auth"><form className="admin-login" onSubmit={signIn}><div className="admin-mark">MW<span> / PAYMENTS</span></div><p className="admin-eyebrow">PLATFORM CONTROL</p><h1>Administrator sign in</h1><p className="admin-muted">Separate platform credentials. Merchant accounts cannot access this console.</p>{error && <div className="admin-alert error">{error}</div>}<label>Administrator username<input type="text" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label><button className="admin-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in securely"}</button><a className="admin-back" href="/">Back to merchant workspace</a></form></div>;

  const visibleTenants = tenants.filter((t) => [t.name,t.slug,t.status].some((v) => v.toLowerCase().includes(query.toLowerCase())));
  return <div className="admin-shell"><aside className="admin-sidebar"><a className="admin-brand" href="/"><span className="admin-logo">MW</span><span><strong>MobiWave</strong><small>PAYMENTS PLATFORM</small></span></a><div className="admin-nav-label">OPERATIONS</div>{(["Overview","Merchants","Transactions"] as Tab[]).map((item) => <button key={item} className={tab === item ? "admin-nav active" : "admin-nav"} onClick={() => setTab(item)}>{item}</button>)}<div className="admin-sidebar-bottom"><span className="admin-live-dot"/> Live payment operations disabled <button className="admin-nav" onClick={() => void signOut()} disabled={busy}>Sign out</button></div></aside><main className="admin-main"><header className="admin-topbar"><div><p className="admin-eyebrow">MOBIWAVE / PLATFORM</p><h1>{tab}</h1></div><div className="admin-user"><span className="admin-avatar">{admin.username.slice(0,1).toUpperCase()}</span><span><strong>{admin.username}</strong><small>Platform administrator</small></span></div></header>{error && <div className="admin-alert error">{error}</div>}{notice && <div className="admin-alert success">{notice}</div>}
  {tab === "Overview" && <><div className="admin-metrics">{[{label:"Merchants",value:overview?.tenants.total ?? "—",sub:`\${overview?.tenants.active ?? 0} active · \${overview?.tenants.suspended ?? 0} suspended`},{label:"Transactions",value:overview?.transactions.total ?? "—",sub:`\${overview?.transactions.succeeded ?? 0} succeeded`},{label:"Successful volume",value:money(overview?.transactions.succeeded_amount_minor ?? 0),sub:"Verified successful transactions"},{label:"Open exceptions",value:overview?.exceptions.open ?? "—",sub:"Reconciliation requires review"}].map((m) => <section className="admin-metric" key={m.label}><span>{m.label}</span><strong>{m.value}</strong><small>{m.sub}</small></section>)}</div><section className="admin-panel"><div className="admin-panel-head"><div><h2>Payment operations</h2><p>Provider connections and transaction states from the Neon database.</p></div><button className="admin-secondary" onClick={() => void refresh()} disabled={busy}>Refresh data</button></div><div className="admin-provider-grid">{(overview?.providers ?? []).map((p) => <div className="admin-provider" key={p.provider + p.connection_status}><span>{title(p.provider)}</span><strong>{p.total}</strong><small>{title(p.connection_status)} connections</small></div>)}{!overview?.providers.length && <p className="admin-muted">No provider connections recorded.</p>}</div><div className="admin-state-strip"><span>Pending <strong>{overview?.transactions.pending ?? 0}</strong></span><span>Failed <strong>{overview?.transactions.failed ?? 0}</strong></span><span>Mode <strong>Sandbox only</strong></span></div></section><section className="admin-panel"><div className="admin-panel-head"><div><h2>Latest transactions</h2><p>Most recent transactions across all merchant workspaces.</p></div><button className="admin-secondary" onClick={() => setTab("Transactions")}>View all shown</button></div><TxTable items={transactions.slice(0,8)} /></section></>}
  {tab === "Merchants" && <section className="admin-panel"><div className="admin-panel-head"><div><h2>Merchant workspaces</h2><p>Account status, membership count and payment activity.</p></div><input className="admin-search" placeholder="Search merchants…" value={query} onChange={(e) => setQuery(e.target.value)} /></div><div className="admin-table-wrap"><table><thead><tr><th>MERCHANT</th><th>STATUS</th><th>MEMBERS</th><th>TRANSACTIONS</th><th>SUCCESSFUL VOLUME</th><th>CREATED</th><th>ACTION</th></tr></thead><tbody>{visibleTenants.map((t) => <tr key={t.id}><td><strong>{t.name}</strong><small>{t.slug}</small></td><td><span className={`admin-status status-\${t.status}`}>{title(t.status)}</span></td><td>{t.members}</td><td>{t.transactions}</td><td>{money(t.succeeded_amount_minor)}</td><td>{date(t.created_at)}</td><td><button className={t.status === "suspended" ? "admin-secondary" : "admin-danger"} disabled={busy || t.status === "closed"} onClick={() => void changeStatus(t)}>{t.status === "suspended" ? "Reactivate" : "Suspend"}</button></td></tr>)}</tbody></table>{!visibleTenants.length && <div className="admin-empty">No merchant workspaces match this search.</div>}</div></section>}
  {tab === "Transactions" && <section className="admin-panel"><div className="admin-panel-head"><div><h2>Platform transaction ledger</h2><p>Read-only view across all merchant workspaces.</p></div><button className="admin-secondary" onClick={() => void refresh()} disabled={busy}>Refresh data</button></div><TxTable items={transactions} /></section>}
  <footer className="admin-footer"><span>MobiWave Payments · Kenya</span><span>Platform admin · Separate session · Live processing disabled</span></footer></main></div>;
}
function TxTable({ items }: { items: Tx[] }) {
  if (!items.length) return <div className="admin-empty">No transaction records in the database yet.</div>;
  return <div className="admin-table-wrap"><table><thead><tr><th>MERCHANT</th><th>REFERENCE</th><th>PROVIDER</th><th>AMOUNT</th><th>STATUS</th><th>RECEIPT</th><th>CREATED</th></tr></thead><tbody>{items.map((t) => <tr key={t.id}><td>{t.tenant_name}</td><td><strong>{t.merchant_reference}</strong></td><td>{title(t.provider)}</td><td>{money(t.amount_minor,t.currency)}</td><td><span className={`admin-status status-\${t.status}`}>{title(t.status)}</span></td><td>{t.provider_receipt || "—"}</td><td>{date(t.created_at)}</td></tr>)}</tbody></table></div>;
}
