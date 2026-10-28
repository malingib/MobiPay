import React, { useCallback, useEffect, useState } from "react";
import { createAuthClient } from "@neondatabase/auth";
import "./admin.css";

const authUrl = import.meta.env.VITE_NEON_AUTH_URL as string | undefined;
const apiBase = ((import.meta.env.VITE_API_BASE_URL as string | undefined) || window.location.origin).replace(/\/$/, "");
const authClient = authUrl ? createAuthClient(authUrl) : null;
type Tenant = { id: string; name: string; slug: string; status: string; created_at: string; members: number; transactions: number; succeeded_amount_minor: string };
type Tx = { id: string; tenant_name: string; provider: string; merchant_reference: string; amount_minor: number; currency: string; status: string; provider_receipt?: string | null; created_at: string };
type Overview = { tenants: { total: number; active: number; suspended: number }; transactions: { total: number; succeeded: number; pending: number; failed: number; succeeded_amount_minor: string }; providers: { provider: string; connection_status: string; total: number }[]; exceptions: { open: number } };
type Tab = "Overview" | "Merchants" | "Transactions";
const money = (minor: number | string, currency = "KES") => new Intl.NumberFormat("en-KE", { style: "currency", currency, maximumFractionDigits: 2 }).format(Number(minor || 0) / 100);
const date = (v: string) => new Date(v).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short" });
const title = (v: string) => v.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export default function AdminApp() {
  const [user, setUser] = useState<{ id?: string; email?: string; name?: string } | null>(null);
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [tab, setTab] = useState<Tab>("Overview"); const [overview, setOverview] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<Tenant[]>([]); const [transactions, setTransactions] = useState<Tx[]>([]);
  const [query, setQuery] = useState(""); const [busy, setBusy] = useState(false); const [loading, setLoading] = useState(true);
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");

  const token = useCallback(async () => {
    if (!authClient) throw new Error("Neon Auth is not configured for this deployment.");
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

  const refresh = useCallback(async () => {
    setError("");
    const [o, t, tx] = await Promise.all([api("/api/v1/platform/admin/overview"), api("/api/v1/platform/admin/tenants"), api("/api/v1/platform/admin/transactions?limit=100")]);
    setOverview(o as Overview); setTenants((t.tenants ?? []) as Tenant[]); setTransactions((tx.transactions ?? []) as Tx[]);
  }, [api]);

  useEffect(() => {
    let alive = true;
    if (authClient) authClient.getSession().then((result) => { if (alive && !result.error && result.data?.user) setUser(result.data.user); }).catch(() => undefined);
    setLoading(false);
    return () => { alive = false; };
  }, []);
  useEffect(() => { if (user) void refresh().catch((e) => setError(e instanceof Error ? e.message : "Unable to load admin data.")); }, [user, refresh]);

  async function signIn(e: React.FormEvent) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      if (!authClient) throw new Error("Neon Auth is not configured. Set VITE_NEON_AUTH_URL.");
      const result = await authClient.signIn.email({ email, password });
      if (result.error) throw new Error(result.error.message);
      const session = await authClient.getSession();
      if (session.error || !session.data?.user) throw new Error("Sign-in succeeded but no session was returned.");
      setUser(session.data.user);
    } catch (e) { setError(e instanceof Error ? e.message : "Sign in failed."); }
    finally { setBusy(false); }
  }
  async function changeStatus(tenant: Tenant) {
    const status = tenant.status === "suspended" ? "active" : "suspended";
    const action = status === "suspended" ? "suspend" : "reactivate";
    if (!window.confirm(`Are you sure you want to ${action} ${tenant.name}? This affects new payment operations for this merchant.`)) return;
    setBusy(true); setError(""); setNotice("");
    try {
      await api(`/api/v1/platform/admin/tenants/${encodeURIComponent(tenant.id)}/status`, { method: "PATCH", body: JSON.stringify({ status }) });
      setNotice(`${tenant.name} ${status === "suspended" ? "suspended" : "reactivated"}.`);
      await refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to update merchant."); }
    finally { setBusy(false); }
  }

  if (loading) return <div className="admin-shell"><div className="admin-loading">Loading MobiWave Payments…</div></div>;
  if (!user) return <div className="admin-shell admin-auth"><form className="admin-login" onSubmit={signIn}><div className="admin-mark">MW<span> / PAYMENTS</span></div><p className="admin-eyebrow">PLATFORM CONTROL</p><h1>Administrator sign in</h1><p className="admin-muted">Restricted access for authorised MobiWave platform administrators.</p>{error && <div className="admin-alert error">{error}</div>}<label>Email address<input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label><label>Password<input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label><button className="admin-primary" disabled={busy}>{busy ? "Signing in…" : "Sign in securely"}</button><a className="admin-back" href="/">Back to merchant workspace</a></form></div>;

  const visibleTenants = tenants.filter((t) => [t.name,t.slug,t.status].some((v) => v.toLowerCase().includes(query.toLowerCase())));
  return <div className="admin-shell"><aside className="admin-sidebar"><a className="admin-brand" href="/"><span className="admin-logo">MW</span><span><strong>MobiWave</strong><small>PAYMENTS PLATFORM</small></span></a><div className="admin-nav-label">OPERATIONS</div>{(["Overview","Merchants","Transactions"] as Tab[]).map((item) => <button key={item} className={tab === item ? "admin-nav active" : "admin-nav"} onClick={() => setTab(item)}>{item}</button>)}<div className="admin-sidebar-bottom"><span className="admin-live-dot"/> Live payment operations disabled <button className="admin-nav" onClick={async () => { await authClient?.signOut(); setUser(null); }}>Sign out</button></div></aside><main className="admin-main"><header className="admin-topbar"><div><p className="admin-eyebrow">MOBIWAVE / PLATFORM</p><h1>{tab}</h1></div><div className="admin-user"><span className="admin-avatar">{(user.email ?? user.name ?? "A").slice(0,1).toUpperCase()}</span><span><strong>{user.name || "Administrator"}</strong><small>{user.email}</small></span></div></header>{error && <div className="admin-alert error">{error}</div>}{notice && <div className="admin-alert success">{notice}</div>}
  {tab === "Overview" && <><div className="admin-metrics">{[{label:"Merchants",value:overview?.tenants.total ?? "—",sub:`${overview?.tenants.active ?? 0} active · ${overview?.tenants.suspended ?? 0} suspended`},{label:"Transactions",value:overview?.transactions.total ?? "—",sub:`${overview?.transactions.succeeded ?? 0} succeeded`},{label:"Successful volume",value:money(overview?.transactions.succeeded_amount_minor ?? 0),sub:"Verified successful transactions"},{label:"Open exceptions",value:overview?.exceptions.open ?? "—",sub:"Reconciliation requires review"}].map((m) => <section className="admin-metric" key={m.label}><span>{m.label}</span><strong>{m.value}</strong><small>{m.sub}</small></section>)}</div><section className="admin-panel"><div className="admin-panel-head"><div><h2>Payment operations</h2><p>Provider connections and transaction states from the production database.</p></div><button className="admin-secondary" onClick={() => void refresh()} disabled={busy}>Refresh data</button></div><div className="admin-provider-grid">{(overview?.providers ?? []).map((p) => <div className="admin-provider" key={p.provider + p.connection_status}><span>{title(p.provider)}</span><strong>{p.total}</strong><small>{title(p.connection_status)} connections</small></div>)}{!overview?.providers.length && <p className="admin-muted">No provider connections recorded.</p>}</div><div className="admin-state-strip"><span>Pending <strong>{overview?.transactions.pending ?? 0}</strong></span><span>Failed <strong>{overview?.transactions.failed ?? 0}</strong></span><span>Mode <strong>Sandbox only</strong></span></div></section><section className="admin-panel"><div className="admin-panel-head"><div><h2>Latest transactions</h2><p>Most recent transactions across all merchant workspaces.</p></div><button className="admin-secondary" onClick={() => setTab("Transactions")}>View all shown</button></div><TxTable items={transactions.slice(0,8)} /></section></>}
  {tab === "Merchants" && <section className="admin-panel"><div className="admin-panel-head"><div><h2>Merchant workspaces</h2><p>Account status, membership count and payment activity.</p></div><input className="admin-search" placeholder="Search merchants…" value={query} onChange={(e) => setQuery(e.target.value)} /></div><div className="admin-table-wrap"><table><thead><tr><th>MERCHANT</th><th>STATUS</th><th>MEMBERS</th><th>TRANSACTIONS</th><th>SUCCESSFUL VOLUME</th><th>CREATED</th><th>ACTION</th></tr></thead><tbody>{visibleTenants.map((t) => <tr key={t.id}><td><strong>{t.name}</strong><small>{t.slug}</small></td><td><span className={`admin-status status-${t.status}`}>{title(t.status)}</span></td><td>{t.members}</td><td>{t.transactions}</td><td>{money(t.succeeded_amount_minor)}</td><td>{date(t.created_at)}</td><td><button className={t.status === "suspended" ? "admin-secondary" : "admin-danger"} disabled={busy || t.status === "closed"} onClick={() => void changeStatus(t)}>{t.status === "suspended" ? "Reactivate" : "Suspend"}</button></td></tr>)}</tbody></table>{!visibleTenants.length && <div className="admin-empty">No merchant workspaces match this search.</div>}</div></section>}
  {tab === "Transactions" && <section className="admin-panel"><div className="admin-panel-head"><div><h2>Platform transaction ledger</h2><p>Read-only view across all merchant workspaces.</p></div><button className="admin-secondary" onClick={() => void refresh()} disabled={busy}>Refresh data</button></div><TxTable items={transactions} /></section>}
  <footer className="admin-footer"><span>MobiWave Payments · Kenya</span><span>Platform admin · Authenticated · Live processing disabled</span></footer></main></div>;
}

function TxTable({ items }: { items: Tx[] }) {
  if (!items.length) return <div className="admin-empty">No transaction records in the database yet.</div>;
  return <div className="admin-table-wrap"><table><thead><tr><th>MERCHANT</th><th>REFERENCE</th><th>PROVIDER</th><th>AMOUNT</th><th>STATUS</th><th>RECEIPT</th><th>CREATED</th></tr></thead><tbody>{items.map((t) => <tr key={t.id}><td>{t.tenant_name}</td><td><strong>{t.merchant_reference}</strong></td><td>{title(t.provider)}</td><td>{money(t.amount_minor,t.currency)}</td><td><span className={`admin-status status-${t.status}`}>{title(t.status)}</span></td><td>{t.provider_receipt || "—"}</td><td>{date(t.created_at)}</td></tr>)}</tbody></table></div>;
}
