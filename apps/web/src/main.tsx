import React from "react";
import { createRoot } from "react-dom/client";
import "./styles.css";

function App() {
  return (
    <main className="shell">
      <aside className="sidebar">
        <div className="brand-mark">M</div>
        <div className="brand-name">MobiWave <span>Payments</span></div>
        <div className="tenant"><span className="tenant-label">WORKSPACE</span><strong>MobiWave Demo</strong><small>Sandbox environment</small></div>
        <nav aria-label="Main navigation">
          <a className="active" href="#overview">Overview</a>
          <a href="#transactions">Transactions</a>
          <a href="#reconciliation">Reconciliation</a>
          <a href="#exceptions">Exceptions</a>
          <a href="#merchants">Merchants</a>
          <a href="#developers">Developers</a>
          <a href="#settings">Settings</a>
        </nav>
        <div className="sidebar-bottom"><span className="status-dot" /> Demo data only</div>
      </aside>
      <section className="content">
        <header className="topbar"><div><span className="eyebrow">PAYMENTS OPERATIONS</span><h1>Overview</h1></div><div className="top-actions"><span className="sandbox-pill">SANDBOX</span><div className="avatar">MW</div></div></header>
        <div className="notice"><strong>Sandbox workspace</strong><span>These figures are illustrative. No live payment is initiated or received by this console.</span></div>
        <section className="metrics" aria-label="Demo metrics">
          <article className="metric"><span>Payments received</span><strong>KES 248,650</strong><small>Demo period · October</small></article>
          <article className="metric"><span>Transactions</span><strong>1,284</strong><small>Illustrative ledger count</small></article>
          <article className="metric"><span>Reconciled</span><strong>96.8%</strong><small>Match-rate example</small></article>
          <article className="metric"><span>Needs review</span><strong>17</strong><small>Example exceptions</small></article>
        </section>
        <section className="panel" id="transactions"><div className="panel-heading"><div><h2>Recent transactions</h2><p>Unified view across connected payment providers.</p></div><button type="button" onClick={() => window.location.href = "#reconciliation"}>Open reconciliation</button></div>
          <div className="table-wrap"><table><thead><tr><th>REFERENCE</th><th>CHANNEL</th><th>MERCHANT</th><th>AMOUNT</th><th>STATUS</th><th>DATE</th></tr></thead><tbody>
            <tr><td><strong>MW-2026-10428</strong></td><td><span className="channel">M-Pesa</span></td><td>Demo School</td><td>KES 12,500.00</td><td><span className="state success">Succeeded</span></td><td>20 Oct 2026</td></tr>
            <tr><td><strong>MW-2026-10427</strong></td><td><span className="channel">Pesapal</span></td><td>Demo Clinic</td><td>KES 4,200.00</td><td><span className="state pending">Pending</span></td><td>20 Oct 2026</td></tr>
            <tr><td><strong>MW-2026-10426</strong></td><td><span className="channel">M-Pesa</span></td><td>Demo SACCO</td><td>KES 8,000.00</td><td><span className="state review">Needs review</span></td><td>20 Oct 2026</td></tr>
            <tr><td><strong>MW-2026-10425</strong></td><td><span className="channel">Bank transfer</span></td><td>Demo School</td><td>KES 23,750.00</td><td><span className="state success">Succeeded</span></td><td>19 Oct 2026</td></tr>
            <tr><td><strong>MW-2026-10424</strong></td><td><span className="channel">M-Pesa</span></td><td>Demo Clinic</td><td>KES 1,500.00</td><td><span className="state failed">Failed</span></td><td>19 Oct 2026</td></tr>
          </tbody></table></div>
        </section>
        <section className="lower-grid"><article className="panel" id="reconciliation"><div className="panel-heading"><div><h2>Reconciliation health</h2><p>Illustrative matching overview</p></div></div><div className="recon-line"><span>Automatically matched</span><strong>96.8%</strong></div><div className="progress"><span /></div><div className="recon-line"><span>Awaiting confirmation</span><strong>2.1%</strong></div><div className="progress muted"><span /></div><div className="recon-line"><span>Unmatched / exception</span><strong>1.1%</strong></div><div className="progress warn"><span /></div></article>
          <article className="panel" id="developers"><div className="panel-heading"><div><h2>Integration readiness</h2><p>Provider setup status</p></div></div><div className="provider"><div className="provider-icon mpesa">M</div><div><strong>M-Pesa Daraja</strong><small>Adapter planned · sandbox credentials required</small></div><span className="provider-state">Not connected</span></div><div className="provider"><div className="provider-icon pesapal">P</div><div><strong>Pesapal</strong><small>Adapter planned · merchant onboarding required</small></div><span className="provider-state">Not connected</span></div><div className="provider"><div className="provider-icon bank">B</div><div><strong>Bank APIs</strong><small>Per-bank approval and API contract</small></div><span className="provider-state">Planned</span></div></article></section>
        <footer>© 2026 MobiWave Payments <span>Built for secure payment visibility and reconciliation.</span></footer>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
