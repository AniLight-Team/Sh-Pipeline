import React, { useEffect, useRef, useState } from "react";
import { ArrowRight, ChevronLeft, ChevronRight, Download, Film, Loader2, MoreHorizontal, Plus, RefreshCw, Search, X } from "lucide-react";
import { api } from "../api.js";
import { JobDetailsModal } from "./JobDetailsModal.js";

interface Job { id: number; episodeNumber: number; status: string; types: string[]; torrentTitle?: string; knownTitles?: string[]; metadata?: Record<string, any>; pipelineType?: string; lastError?: string; qualityCount?: number; stagedQualities?: Record<string, string>; [key: string]: any; }
interface Props { compact?: boolean; onOpenEnqueue?: () => void; externalStatusFilter?: string; onNotice?: (message: string) => void; onViewAll?: () => void; }
const statuses = ["all", "active", "queued", "downloading", "download_paused", "staged", "encoding", "completed", "failed", "skipped"];
const statusLabels: Record<string, string> = { all: "All episodes", active: "In progress", queued: "Queued", downloading: "Downloading", download_paused: "Awaiting space", staged: "Staged", encoding: "Processing", completed: "Delivered", failed: "Needs attention", skipped: "Skipped" };
const isBusyJob = (job: Job) => ["encoding", "downloading"].includes(job.status) || !!job.batchId && !["failed", "completed"].includes(job.status);

export function JobTable({ compact = false, externalStatusFilter = "all", onOpenEnqueue, onNotice, onViewAll }: Props) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState(externalStatusFilter);
  const [search, setSearch] = useState("");
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState("all");
  const [page, setPage] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [detail, setDetail] = useState<Job | null>(null);
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const actionLock = useRef(false);
  const limit = compact ? 6 : 25;
  useEffect(() => { const t = setTimeout(() => { setQuery(search.trim()); setPage(0); }, 300); return () => clearTimeout(t); }, [search]);
  useEffect(() => {
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    let current: AbortController | null = null;
    setLoading(true); setSelected(new Set()); setConfirmDelete(false);
    const refresh = async () => {
      current = new AbortController();
      const params = new URLSearchParams({ limit: String(limit), offset: String(page * limit), status, search: query, mode });
      try {
        const data = await api<{ jobs: Job[]; total: number }>(`/api/jobs?${params}`, { signal: AbortSignal.any([current.signal, AbortSignal.timeout(25_000)]) });
        if (!disposed) {
          setJobs(data.jobs); setTotal(data.total); setError(null);
          setDetail(prev => prev ? data.jobs.find(j => j.id === prev.id) ?? prev : null);
          if (page > 0 && !data.jobs.length) setPage(p => p - 1);
        }
      } catch (e) { if (!disposed) setError(e instanceof Error ? e.message : "Could not refresh episodes."); }
      finally { if (!disposed) { setLoading(false); timer = setTimeout(refresh, 6000); } }
    };
    void refresh();
    return () => { disposed = true; clearTimeout(timer); current?.abort(); };
  }, [limit, page, status, query, mode, revision]);

  const refresh = () => setRevision(r => r + 1);
  const changeStatus = (value: string) => { setStatus(value); setPage(0); };
  const runAction = async (action: string, ids = [...selected]) => {
    if (actionLock.current || !ids.length) return;
    actionLock.current = true; setBusy(true);
    try {
      const data = await api("/api/jobs/bulk", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action, jobIds: ids }) });
      onNotice?.(data.message || "Jobs updated."); setSelected(new Set()); setConfirmDelete(false); refresh();
    } catch (e) { onNotice?.(e instanceof Error ? e.message : "Unable to update jobs."); }
    finally { actionLock.current = false; setBusy(false); }
  };
  const eligible = jobs.filter(j => !isBusyJob(j));
  const allChecked = eligible.length > 0 && eligible.every(j => selected.has(j.id));
  const exportSelected = () => {
    const blob = new Blob([JSON.stringify(jobs.filter(j => selected.has(j.id)), null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a");
    anchor.href = url; anchor.download = "anilight-episodes.json"; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <section className="panel queue-panel" aria-busy={loading}>
    <div className="section-heading"><div><h2>{compact ? "Latest episodes" : "Episode queue"}</h2><span className="queue-caption">{loading && !jobs.length ? "Loading episodes…" : `${total.toLocaleString()} episode${total === 1 ? "" : "s"}`}</span></div><div className="inline-actions"><button className="icon-button" title="Refresh episodes" aria-label="Refresh episodes" onClick={refresh} disabled={loading}><RefreshCw size={16} className={loading ? "animate-spin" : ""} /></button>{compact ? <button className="text-button" onClick={onViewAll}>View queue <ArrowRight size={14} /></button> : <button className="btn-secondary" onClick={onOpenEnqueue}><Plus size={15} /> Add episodes</button>}</div></div>
    {!compact && <div className="queue-toolbar"><label className="search-field"><Search size={16} /><input placeholder="Search titles, job or anime ID…" aria-label="Search all episodes" value={search} onChange={e => setSearch(e.target.value)} />{search && <button aria-label="Clear search" onClick={() => setSearch("")}><X size={14} /></button>}</label><select aria-label="Episode status" value={status} onChange={e => changeStatus(e.target.value)}>{statuses.map(s => <option key={s} value={s}>{statusLabels[s]}</option>)}</select><select aria-label="Processing mode" value={mode} onChange={e => { setMode(e.target.value); setPage(0); }}><option value="all">All workers</option><option value="vm_remux">Local conversion</option><option value="kaggle_gpu">GPU encoding</option></select></div>}
    {selected.size > 0 && <div className="selection-bar"><strong>{selected.size} selected</strong><button disabled={busy} onClick={() => void runAction("retry")}>Retry</button><details><summary>More actions <MoreHorizontal size={14} /></summary><div className="action-menu"><button disabled={busy} onClick={() => void runAction("force_remux")}>Use local conversion</button><button disabled={busy} onClick={() => void runAction("force_gpu")}>Use GPU encoding</button><button disabled={busy} onClick={() => void runAction("sync_callbacks")}>Retry delivery callbacks</button><button onClick={exportSelected}><Download size={13} /> Export selected</button><button disabled={busy} onClick={() => setConfirmDelete(true)}>Delete selected…</button></div></details><button aria-label="Clear selection" onClick={() => setSelected(new Set())}><X size={15} /></button></div>}
    {confirmDelete && <div className="inline-confirm" role="alert"><span>Delete {selected.size} job(s) and their retained local files? This cannot be undone.</span><button className="btn-secondary" disabled={busy} onClick={() => setConfirmDelete(false)}>Cancel</button><button className="btn-danger" disabled={busy} onClick={() => void runAction("delete")}>Delete files & jobs</button></div>}
    {error && <div className="inline-error" role="alert">{error} {jobs.length > 0 && "Showing the last available results."}<button onClick={refresh}>Try again</button></div>}
    <div className="queue-scroll"><table className="episode-table"><thead><tr>{!compact && <th className="select-cell"><input type="checkbox" aria-label="Select all eligible episodes on this page" checked={allChecked} onChange={() => setSelected(allChecked ? new Set() : new Set(eligible.map(j => j.id)))} /></th>}<th>Episode</th><th>Status</th><th>Worker</th><th>Quality</th><th><span className="sr-only">Actions</span></th></tr></thead><tbody>
      {jobs.map(job => <tr key={job.id}>
        {!compact && <td className="select-cell"><input type="checkbox" aria-label={`Select job ${job.id}`} disabled={isBusyJob(job)} checked={selected.has(job.id)} onChange={e => setSelected(prev => { const next = new Set(prev); e.target.checked ? next.add(job.id) : next.delete(job.id); return next; })} /></td>}
        <td><button className="episode-title" onClick={() => setDetail(job)}><span className="episode-art"><Film size={18} /></span><span><strong>{job.metadata?.primaryTitle || job.knownTitles?.[0] || job.torrentTitle || `Episode job #${job.id}`}</strong><small>Episode {job.episodeNumber} <span>·</span> #{job.id} <span>·</span> {(job.types || []).join(" / ").toUpperCase()}</small></span></button></td>
        <td><span className={`job-status status-${job.status}`}><span className="status-dot" />{statusLabels[job.status] || job.status}</span>{job.lastError && <button className="error-detail" onClick={() => setDetail(job)}>View diagnostic</button>}</td>
        <td><span className="worker-label">{(job.pipelineType || job.metadata?.processingMode) === "kaggle_gpu" ? "GPU encode" : "Local conversion"}</span></td>
        <td><span className="quality-label">{Object.keys(job.stagedQualities || {}).join(" · ") || (job.qualityCount ? `${job.qualityCount} qualities` : "—")}</span></td>
        <td><button className="icon-button" aria-label={`View job ${job.id}`} onClick={() => setDetail(job)}><ChevronRight size={17} /></button></td>
      </tr>)}
    </tbody></table></div>
    {!jobs.length && <div className="queue-empty">{loading ? <Loader2 className="animate-spin" size={25} /> : <Film size={27} />}<h3>{loading ? "Fetching your episodes" : error ? "The queue is unavailable" : query || status !== "all" || mode !== "all" ? "No matching episodes" : "A fresh start"}</h3><p>{error ? "Check the connection and try again." : query || status !== "all" || mode !== "all" ? "Try another search or filter." : "Add episodes to start discovery and processing."}</p>{!loading && !error && status === "all" && !query && <button className="btn-secondary" onClick={onOpenEnqueue}>Add episodes</button>}</div>}
    {!compact && <div className="queue-pagination"><span>{total ? `${page * limit + 1}–${Math.min((page + 1) * limit, total)} of ${total}` : "0 episodes"} · Updates automatically</span><div><button className="icon-button" aria-label="Previous page" disabled={!page || loading} onClick={() => setPage(p => p - 1)}><ChevronLeft size={17} /></button><span>Page {page + 1}</span><button className="icon-button" aria-label="Next page" disabled={(page + 1) * limit >= total || loading} onClick={() => setPage(p => p + 1)}><ChevronRight size={17} /></button></div></div>}
    {detail && <JobDetailsModal key={detail.id} job={detail} onClose={() => setDetail(null)} onUpdated={message => { if (message) onNotice?.(message); refresh(); }} />}
  </section>;
}
