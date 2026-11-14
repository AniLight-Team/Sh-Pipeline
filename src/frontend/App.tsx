import React, { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Activity, ArrowRight, Box, Check, ChevronRight, Cloud, Cpu, HardDrive, LayoutDashboard, ListVideo, Loader2, Plus, RefreshCw, Settings2, Sparkles, Terminal, X } from "lucide-react";
import { JobTable } from "./components/JobTable.js";
const BatchViewer = lazy(() => import("./components/BatchViewer.js").then(m => ({ default: m.BatchViewer })));
const LiveTerminal = lazy(() => import("./components/LiveTerminal.js").then(m => ({ default: m.LiveTerminal })));
const EnqueueModal = lazy(() => import("./components/EnqueueModal.js").then(m => ({ default: m.EnqueueModal })));
const KaggleAccountsModal = lazy(() => import("./components/KaggleAccountsModal.js").then(m => ({ default: m.KaggleAccountsModal })));
const HuggingFaceModal = lazy(() => import("./components/HuggingFaceModal.js").then(m => ({ default: m.HuggingFaceModal })));
const StagingExplorerModal = lazy(() => import("./components/StagingExplorerModal.js").then(m => ({ default: m.StagingExplorerModal })));
import { usePipelineStream } from "./hooks/usePipelineStream.js";
import { api } from "./api.js";

const views = [
  { id: "dashboard", label: "Overview", icon: LayoutDashboard },
  { id: "jobs", label: "Episode queue", icon: ListVideo },
  { id: "batches", label: "Processing", icon: Cpu },
  { id: "terminal", label: "Activity log", icon: Terminal },
  { id: "settings", label: "Operations", icon: Settings2 },
];
const gb = (n: number) => (n / 1024 ** 3).toFixed(1);

export default function App() {
  const { stats, logs, connected, lastUpdated } = usePipelineStream();
  const [view, setView] = useState("dashboard");
  const [modal, setModal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState("all");
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const actionLock = useRef(false);
  const showNotice = (message: string) => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    setNotice(message); noticeTimer.current = setTimeout(() => setNotice(null), 7000);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setModal("enqueue"); }
      if (e.key === "Escape") setModal(null);
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); if (noticeTimer.current) clearTimeout(noticeTimer.current); };
  }, []);
  const action = async (endpoint: string, body?: unknown) => {
    if (actionLock.current) return;
    actionLock.current = true; setBusy(endpoint);
    try {
      const data = await api(endpoint, { method: "POST", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
      showNotice(data.message || "Request completed.");
    } catch (error) { showNotice(error instanceof Error ? error.message : "Request failed. Try again."); }
    finally { actionLock.current = false; setBusy(null); }
  };
  const showJobs = (status: string) => { setFilter(status); setView("jobs"); };
  const q = stats?.queue;
  const active = (q?.downloading ?? 0) + (q?.encoding ?? 0);
  const capacity = stats ? Math.min(100, stats.storage.stagedBytes / Math.max(1, stats.storage.maxStagingBytes) * 100) : 0;
  const flush = () => { void action("/api/batches/flush"); };

  return <div className="workspace">
    <aside className="workspace-nav">
      <a className="brand" href="#" onClick={e => { e.preventDefault(); setView("dashboard"); }}>
        <span className="brand-mark"><Sparkles size={22} /></span><span>AniLight<span className="brand-sub">PIPELINE WORKSPACE</span></span>
      </a>
      <button className="btn-primary nav-create" onClick={() => setModal("enqueue")}><Plus size={17} /> Add episodes <kbd>⌘ K</kbd></button>
      <span className="nav-label">Workspace</span>
      <nav aria-label="Main navigation">{views.map(({ id, label, icon: Icon }) =>
        <button key={id} aria-current={view === id ? "page" : undefined} className={view === id ? "nav-item selected" : "nav-item"} onClick={() => setView(id)}>
          <Icon size={18} /><span>{label}</span>{id === "jobs" && !!q?.failed && <span className="nav-count">{q.failed}</span>}
        </button>)}</nav>
      <div className="nav-bottom">
        <span className="nav-label">Connected services</span>
        <button className="nav-item" onClick={() => setModal("kaggle")}><Cpu size={17} /> GPU accounts <ChevronRight size={14} /></button>
        <button className="nav-item" onClick={() => setModal("hf")}><Cloud size={17} /> Hugging Face <ChevronRight size={14} /></button>
        <div className="nav-health"><span className={connected ? "status-dot live" : "status-dot"} /><div>{connected ? "Live connection" : "Reconnecting…"}<small>{lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : "Waiting for pipeline"}</small></div></div>
      </div>
    </aside>
    <div className="workspace-main">
      <header className="workspace-top"><span>Workspace <ChevronRight size={13} /> <strong>{views.find(v => v.id === view)?.label}</strong></span><div className="top-status"><span className={connected ? "status-dot live" : "status-dot"} />{!connected ? "Connection interrupted" : stats?.engine.isPaused ? "Pipeline paused" : "Live updates"}<button className="icon-button" aria-label="Open operations" onClick={() => setView("settings")}><Settings2 size={18} /></button></div></header>
      <main className="workspace-content">
        {!connected && <div className="connection-notice" role="status">Connecting to the pipeline. {stats ? "Showing the last received data; it may be out of date." : "Your queue will appear when the service responds."}</div>}
        <div className="page-heading"><div><span className="eyebrow">ANILIGHT / KIRA</span><h1>{view === "dashboard" ? "A little clarity for your pipeline." : views.find(v => v.id === view)?.label}</h1><p>{view === "dashboard" ? "From discovery to delivery. Everything moving, all in one place." : view === "jobs" ? "Find an episode, follow its progress, or pick up where it stopped." : view === "batches" ? "Follow local conversion and GPU batch processing." : view === "terminal" ? "A live record of what your pipeline is doing." : "Manage execution, storage, and recovery."}</p></div><button className="btn-primary" onClick={() => setModal("enqueue")}><Plus size={16} /> Add episodes</button></div>

        {view === "dashboard" && <>
          <div className="metric-grid">
            {[
              { label: "In progress", value: active, detail: "Downloading & processing", status: "encoding", icon: Activity },
              { label: "Ready to process", value: q?.staged, detail: "Safely staged on disk", status: "staged", icon: Box },
              { label: "Delivered", value: q?.completed, detail: "Completed episodes", status: "completed", icon: Check },
              { label: "Needs attention", value: q?.failed, detail: "Review errors & retry", status: "failed", icon: RefreshCw },
            ].map(({ label, value, detail, status, icon: Icon }) => <button key={label} className={status === "failed" && q?.failed ? "metric-card attention" : "metric-card"} onClick={() => showJobs(status === "encoding" ? "active" : status)}>
              <span className="metric-label">{label}<Icon size={17} /></span><strong>{stats ? (value ?? 0).toLocaleString() : "—"}</strong><span className="metric-detail">{detail}<ArrowRight size={14} /></span>
            </button>)}
          </div>
          <div className="overview-grid">
            <section className="panel flow-panel"><div className="section-heading"><div><span className="eyebrow">THE BIG PICTURE</span><h2>Your delivery flow</h2></div><span className="pill">{stats ? stats.engine.isPaused ? "Paused" : stats.engine.isRunning ? "Running" : "Idle" : "Connecting"}</span></div>
              <div className="flow-steps">{[{ label: "Waiting", count: q?.queued, status: "queued" }, { label: "Downloading", count: q?.downloading, status: "downloading" }, { label: "Staged", count: q?.staged, status: "staged" }, { label: "Processing", count: q?.encoding, status: "encoding" }].map((step, i) => <React.Fragment key={step.label}><button onClick={() => showJobs(step.status)}><span className="step-number">0{i + 1}</span><strong>{stats ? step.count : "—"}</strong><span>{step.label}</span></button>{i < 3 && <ChevronRight className="flow-arrow" size={18} />}</React.Fragment>)}</div>
              <div className="flow-note"><HardDrive size={16} /><span>{q?.paused ? `${q.paused} download(s) waiting for storage space.` : "Staged files stay available for recovery."}</span><button onClick={() => setModal("staging")}>Inspect storage <ArrowRight size={14} /></button></div>
            </section>
            <section className="panel resource-panel"><div className="section-heading"><h2>Resources</h2><button className="text-button" onClick={() => setView("settings")}>Manage</button></div>
              <div className="resource-row"><span><HardDrive size={16} /> Staging space</span><strong>{stats ? `${gb(stats.storage.stagedBytes)} / ${gb(stats.storage.maxStagingBytes)} GB` : "—"}</strong></div>
              <progress aria-label="Staging space used" value={capacity} max={100} />
              <div className="resource-row"><span><Cpu size={16} /> Local workers</span><strong>{stats ? `${stats.concurrency.vmActive ?? 0} / ${stats.concurrency.vmMax ?? 2}` : "—"}</strong></div>
              <div className="resource-row"><span><Cloud size={16} /> GPU slots</span><strong>{stats ? `${stats.concurrency.active} / ${stats.concurrency.max}` : "—"}</strong></div>
              <div className="resource-footer">{stats?.engine.pendingCallbacks ? `${stats.engine.pendingCallbacks} delivery callback(s) awaiting retry` : "Storage and worker availability at a glance"}</div>
            </section>
          </div>
          <JobTable compact onOpenEnqueue={() => setModal("enqueue")} onNotice={showNotice} onViewAll={() => showJobs("all")} />
          <section className="panel activity-preview"><div className="section-heading"><h2>Recent activity</h2><button className="text-button" onClick={() => setView("terminal")}>Open log <ArrowRight size={14} /></button></div>{logs.length ? logs.slice(-3).reverse().map(entry => <div className="activity-row" key={entry.id}><span className={`status-dot ${entry.level === "error" ? "error" : entry.level === "success" ? "live" : ""}`} /><p>{entry.message}</p><time>{new Date(entry.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time></div>) : <p className="empty-description">Activity will appear here as jobs move through the pipeline.</p>}</section>
        </>}
        {view === "jobs" && <JobTable key={filter} externalStatusFilter={filter} onOpenEnqueue={() => setModal("enqueue")} onNotice={showNotice} />}
        {view === "batches" && <Suspense fallback={<div className="panel" role="status">Loading processing…</div>}><BatchViewer onForceFlush={flush} stagedCount={stats?.storage.stagedCount ?? 0} onNotice={showNotice} /></Suspense>}
        {view === "terminal" && <Suspense fallback={<div className="panel" role="status">Loading activity…</div>}><LiveTerminal logs={logs} /></Suspense>}
        {view === "settings" && <div className="operations-grid">
          <section className="panel"><h2>Processing preference</h2><p className="empty-description">Choose which workers can accept new work.</p><label className="field-label" htmlFor="policy">Execution policy</label><select id="policy" value={stats?.executionPolicy ?? "all"} disabled={!!busy || !stats} onChange={e => void action("/api/pipeline/policy", { policy: e.target.value, requeueSkipped: e.target.value === "all" })}><option value="all">Local + GPU processing</option><option value="vm_remux_only">Local conversion only</option><option value="kaggle_gpu_only">GPU encoding only</option></select></section>
          <section className="panel"><h2>Storage & accounts</h2><p className="empty-description">Inspect retained files and configured upload destinations.</p><div className="operation-buttons"><button className="btn-secondary" onClick={() => setModal("staging")}><HardDrive size={16} /> Staged files</button><button className="btn-secondary" onClick={() => setModal("hf")}><Cloud size={16} /> Hugging Face</button><button className="btn-secondary" onClick={() => setModal("kaggle")}><Cpu size={16} /> GPU accounts</button></div></section>
          <section className="panel"><h2>Recovery & reconciliation</h2><p className="empty-description">Recover stale work and verify remote worker status.</p><div className="operation-buttons"><button className="btn-secondary" disabled={!!busy} onClick={() => void action("/api/jobs/retry-all-failed")}>Retry failed episodes</button><button className="btn-secondary" disabled={!!busy} onClick={() => void action("/api/system/sync-callbacks")}>Retry delivery callbacks</button><button className="btn-secondary" disabled={!!busy} onClick={() => void action("/api/system/recovery")}>Run recovery</button><button className="btn-secondary" disabled={!!busy} onClick={() => void action("/api/system/sync-encoding")}>Check GPU status</button><button className="btn-secondary" disabled={!!busy} onClick={() => void action("/api/jobs/requeue-skipped")}>Recheck skipped episodes</button></div></section>
          <section className="panel"><h2>Start a partial GPU batch</h2><p className="empty-description">Send available staged GPU jobs to processing without waiting for a full batch.</p><button className="btn-secondary" disabled={!!busy} onClick={flush}>Process staged batch <ArrowRight size={16} /></button></section>
        </div>}
        <footer className="workspace-footer"><span>AniLight · A quieter place to keep things moving.</span><span>{connected ? "Live · refreshes automatically" : "Awaiting connection"}</span></footer>
      </main>
    </div>
    {notice && <div className="toast" role="status"><span>{notice}</span><button aria-label="Dismiss notification" onClick={() => setNotice(null)}><X size={17} /></button></div>}
    {busy && <div className="action-progress" role="status"><Loader2 size={15} className="animate-spin" /> Working…</div>}
    <Suspense fallback={<div className="action-progress" role="status">Opening…</div>}>
    {modal === "enqueue" && <EnqueueModal isOpen={modal === "enqueue"} onClose={() => setModal(null)} onSuccess={() => showNotice("Episodes added to the discovery queue.")} />}
    {modal === "kaggle" && <KaggleAccountsModal isOpen={modal === "kaggle"} onClose={() => setModal(null)} stats={stats} />}
    {modal === "hf" && <HuggingFaceModal isOpen={modal === "hf"} onClose={() => setModal(null)} stats={stats} />}
    {modal === "staging" && <StagingExplorerModal isOpen={modal === "staging"} onClose={() => setModal(null)} onNotice={showNotice} />}
    </Suspense>
  </div>;
}
