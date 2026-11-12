import React, { useState, useEffect, useMemo } from "react";
import {
  Search,
  RefreshCw,
  Trash2,
  ExternalLink,
  Info,
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  HardDrive,
  Plus,
  LayoutGrid,
  List,
  Zap,
  Cpu,
  Send,
  Download,
  Film,
  Subtitles,
  Play,
  PauseCircle,
  CheckSquare,
  Square,
} from "lucide-react";
import { JobDetailsModal } from "./JobDetailsModal.js";

interface Job {
  id: number;
  anilistId?: number | null;
  animeId?: number | null;
  anidbId?: number | null;
  episodeNumber: number;
  types: string[];
  status: string;
  pipelineType?: "vm_remux" | "kaggle_gpu" | string | null;
  selectionTier?: "h264_multi" | "h264_single_1080p" | "hevc_av1_gpu" | string | null;
  releaseGroup?: string | null;
  videoCodec?: string | null;
  isBatchTorrent?: boolean | null;
  qualityCount?: number | null;
  stagedQualities?: Record<string, string> | null;
  torrentTitle?: string | null;
  sizeBytes?: number | null;
  lastError?: string | null;
  metadata?: any;
  knownTitles?: string[];
  createdAt: string;
  stagedAt?: string | null;
  completedAt?: string | null;
}

interface JobTableProps {
  onOpenEnqueue?: () => void;
  externalStatusFilter?: string;
  onNotice?: (msg: string) => void;
}

export function JobTable({
  onOpenEnqueue,
  externalStatusFilter,
  onNotice,
}: JobTableProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [modeFilter, setModeFilter] = useState<"all" | "vm_remux" | "kaggle_gpu">("all");
  const [sortOrder, setSortOrder] = useState<"newest" | "episode" | "size">("newest");
  const [viewMode, setViewMode] = useState<"table" | "grid">("table");
  const [search, setSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  // Multi-select state
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [lastClickedIdx, setLastClickedIdx] = useState<number | null>(null);
  const [bulkLoading, setBulkLoading] = useState<string | null>(null);
  const [confirmBulkDelete, setConfirmBulkDelete] = useState(false);

  useEffect(() => {
    if (externalStatusFilter) {
      setStatusFilter(externalStatusFilter);
    }
  }, [externalStatusFilter]);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const url =
        statusFilter === "all"
          ? "/api/jobs?limit=100"
          : `/api/jobs?status=${statusFilter}&limit=100`;
      const res = await fetch(url);
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {
      // Ignore transient errors
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 6000);
    return () => clearInterval(interval);
  }, [statusFilter]);

  const handleRetry = async (jobId: number) => {
    try {
      await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      onNotice?.(`Job #${jobId} re-queued for pipeline discovery.`);
      fetchJobs();
    } catch {}
  };

  const handleDelete = async (jobId: number) => {
    try {
      await fetch(`/api/jobs/${jobId}/delete`, { method: "POST" });
      setConfirmDeleteId(null);
      setSelectedIds((prev) => {
        const next = new Set(prev);
        next.delete(jobId);
        return next;
      });
      onNotice?.(`Job #${jobId} deleted and local staged files cleaned.`);
      fetchJobs();
    } catch {}
  };

  const handleBulkAction = async (
    action: "retry" | "delete" | "force_remux" | "force_gpu" | "sync_callbacks",
  ) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    setBulkLoading(action);
    try {
      const res = await fetch("/api/jobs/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobIds: ids, action }),
      });
      const data = await res.json();
      onNotice?.(data.message || `Executed ${action} on ${ids.length} job(s).`);
      if (action === "delete") {
        setSelectedIds(new Set());
        setConfirmBulkDelete(false);
      }
      await fetchJobs();
    } catch {
      onNotice?.(`Failed to execute bulk ${action}.`);
    } finally {
      setBulkLoading(null);
    }
  };

  const handleRetryAllFailed = async () => {
    setBulkLoading("retry_all_failed");
    try {
      const res = await fetch("/api/jobs/retry-all-failed", { method: "POST" });
      const data = await res.json();
      onNotice?.(data.message || "Retried all failed jobs.");
      await fetchJobs();
    } catch {
      onNotice?.("Failed to retry failed jobs.");
    } finally {
      setBulkLoading(null);
    }
  };

  const handleClearCompleted = async () => {
    setBulkLoading("clear_completed");
    try {
      const res = await fetch("/api/jobs/clear-completed", { method: "POST" });
      const data = await res.json();
      onNotice?.(data.message || "Cleared completed jobs.");
      setSelectedIds(new Set());
      await fetchJobs();
    } catch {
      onNotice?.("Failed to clear completed jobs.");
    } finally {
      setBulkLoading(null);
    }
  };

  const handleRequeueAllSkipped = async () => {
    setBulkLoading("requeue_skipped");
    try {
      const res = await fetch("/api/jobs/requeue-skipped", { method: "POST" });
      const data = await res.json();
      onNotice?.(data.message || "Re-queued skipped jobs.");
      await fetchJobs();
    } catch {
      onNotice?.("Failed to re-queue skipped jobs.");
    } finally {
      setBulkLoading(null);
    }
  };

  const handleExportSelectedJson = () => {
    const selectedList = jobs.filter((j) => selectedIds.has(j.id));
    if (selectedList.length === 0) return;
    const blob = new Blob([JSON.stringify(selectedList, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `kira-pipeline-jobs-${selectedList.length}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    onNotice?.(`Exported ${selectedList.length} job manifest(s) to JSON.`);
  };

  const filteredJobs = useMemo(() => {
    const base = jobs.filter((j) => {
      if (modeFilter !== "all") {
        const jobMode = j.pipelineType || j.metadata?.processingMode;
        if (jobMode !== modeFilter) return false;
      }
      if (!search) return true;
      const s = search.toLowerCase().trim();
      return (
        (j.anilistId && String(j.anilistId).includes(s)) ||
        (j.anidbId && String(j.anidbId).includes(s)) ||
        (j.animeId && String(j.animeId).includes(s)) ||
        (j.metadata?.tsukihimeId && String(j.metadata.tsukihimeId).includes(s)) ||
        String(j.episodeNumber).includes(s) ||
        (j.metadata?.primaryTitle && j.metadata.primaryTitle.toLowerCase().includes(s)) ||
        (j.torrentTitle && j.torrentTitle.toLowerCase().includes(s)) ||
        (j.knownTitles && j.knownTitles.some((t: string) => t.toLowerCase().includes(s)))
      );
    });

    return [...base].sort((a, b) => {
      if (sortOrder === "episode") {
        if ((a.anilistId || 0) !== (b.anilistId || 0)) {
          return (b.anilistId || 0) - (a.anilistId || 0);
        }
        return a.episodeNumber - b.episodeNumber;
      }
      if (sortOrder === "size") {
        return (b.sizeBytes || 0) - (a.sizeBytes || 0);
      }
      return b.id - a.id;
    });
  }, [jobs, modeFilter, search, sortOrder]);

  const toggleSelectRow = (
    jobId: number,
    index: number,
    e: React.MouseEvent,
  ) => {
    e.stopPropagation();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (e.shiftKey && lastClickedIdx !== null && filteredJobs.length > 0) {
        const start = Math.min(lastClickedIdx, index);
        const end = Math.max(lastClickedIdx, index);
        const shouldAdd = !prev.has(jobId);
        for (let i = start; i <= end; i++) {
          const id = filteredJobs[i]?.id;
          if (id !== undefined) {
            if (shouldAdd) next.add(id);
            else next.delete(id);
          }
        }
      } else {
        if (next.has(jobId)) next.delete(jobId);
        else next.add(jobId);
      }
      return next;
    });
    setLastClickedIdx(index);
  };

  const allVisibleSelected =
    filteredJobs.length > 0 && filteredJobs.every((j) => selectedIds.has(j.id));

  const toggleSelectAllVisible = () => {
    if (allVisibleSelected) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const j of filteredJobs) next.delete(j.id);
        return next;
      });
    } else {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        for (const j of filteredJobs) next.add(j.id);
        return next;
      });
    }
  };

  const selectByPredicate = (pred: (j: Job) => boolean) => {
    const matching = filteredJobs.filter(pred).map((j) => j.id);
    setSelectedIds(new Set(matching));
  };

  const selectedTotalBytes = useMemo(() => {
    return jobs
      .filter((j) => selectedIds.has(j.id))
      .reduce((acc, j) => acc + (Number(j.sizeBytes) || 0), 0);
  }, [jobs, selectedIds]);

  const failedCount = useMemo(
    () => jobs.filter((j) => j.status === "failed").length,
    [jobs],
  );
  const skippedCount = useMemo(
    () => jobs.filter((j) => j.status === "skipped").length,
    [jobs],
  );
  const completedCount = useMemo(
    () => jobs.filter((j) => j.status === "completed").length,
    [jobs],
  );

  const renderStatus = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>Completed</span>
          </span>
        );
      case "encoding":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-violet-300">
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
            <span>Encoding</span>
          </span>
        );
      case "staged":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-indigo-300">
            <HardDrive className="w-3.5 h-3.5 shrink-0" />
            <span>Staged SSD</span>
          </span>
        );
      case "downloading":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-sky-400">
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
            <span>Downloading</span>
          </span>
        );
      case "download_paused":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-amber-300">
            <PauseCircle className="w-3.5 h-3.5 shrink-0" />
            <span>Paused (56GB Cap)</span>
          </span>
        );
      case "queued":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-amber-300">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>Queued</span>
          </span>
        );
      case "skipped":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-slate-300">
            <PauseCircle className="w-3.5 h-3.5 shrink-0 text-amber-300" />
            <span>Skipped (Policy)</span>
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-rose-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>Failed</span>
          </span>
        );
      default:
        return (
          <span className="text-xs font-mono text-[#949bb0] capitalize">
            {status}
          </span>
        );
    }
  };

  const filterTabs = [
    { id: "all", label: "All" },
    { id: "queued", label: "Queued" },
    { id: "downloading", label: "Downloading" },
    { id: "staged", label: "Staged" },
    { id: "encoding", label: "Encoding" },
    { id: "completed", label: "Completed" },
    { id: "skipped", label: "Skipped" },
    { id: "failed", label: "Failed" },
  ];

  return (
    <div className="surface-panel rounded-xl overflow-hidden">
      {/* Primary Control Header */}
      <div className="px-5 py-4 border-b border-[#1e2230] flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2.5">
          <h2 className="text-sm font-semibold text-[#f3f4f8]">
            Multimedia Pipeline Manager
          </h2>
          <span className="text-xs text-[#636b82] font-mono tabular-nums">
            · {filteredJobs.length} {filteredJobs.length === 1 ? "entry" : "entries"}
          </span>

          {/* Quick Selection & QoL Shortcuts */}
          <div className="hidden md:flex items-center gap-1.5 ml-2 text-[11px] font-mono">
            {skippedCount > 0 && (
              <button
                type="button"
                onClick={handleRequeueAllSkipped}
                disabled={bulkLoading !== null}
                className="btn-secondary px-2 py-1 rounded text-indigo-300 hover:text-white inline-flex items-center gap-1 cursor-pointer"
                title="Re-queue all skipped jobs for discovery"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Re-queue Skipped ({skippedCount})</span>
              </button>
            )}
            {failedCount > 0 && (
              <button
                type="button"
                onClick={handleRetryAllFailed}
                disabled={bulkLoading !== null}
                className="btn-secondary px-2 py-1 rounded text-amber-300 hover:text-white inline-flex items-center gap-1 cursor-pointer"
                title="Retry all failed jobs in the database"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Retry Failed ({failedCount})</span>
              </button>
            )}
            {completedCount > 0 && (
              <button
                type="button"
                onClick={handleClearCompleted}
                disabled={bulkLoading !== null}
                className="btn-secondary px-2 py-1 rounded text-[#949bb0] hover:text-white inline-flex items-center gap-1 cursor-pointer"
                title="Remove completed job records"
              >
                <Trash2 className="w-3 h-3" />
                <span>Clear Completed ({completedCount})</span>
              </button>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Interactive Segmented Status Filter Controls */}
          <div className="hidden xl:flex items-center bg-[#0c0e14] p-1 rounded-lg border border-[#1e2230] text-xs">
            {filterTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  statusFilter === tab.id
                    ? "bg-[#1c202e] text-white"
                    : "text-[#949bb0] hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Mobile/Tablet Status Select */}
          <select
            aria-label="Filter jobs by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="xl:hidden bg-[#0c0e14] border border-[#1e2230] rounded-lg px-2.5 py-1.5 text-xs text-[#f3f4f8] focus:outline-none focus:border-indigo-500"
          >
            {filterTabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                Status: {tab.label}
              </option>
            ))}
          </select>

          {/* Processing Mode Filter */}
          <select
            aria-label="Filter jobs by processing mode"
            value={modeFilter}
            onChange={(e) => setModeFilter(e.target.value as any)}
            className="bg-[#0c0e14] border border-[#1e2230] rounded-lg px-2.5 py-1.5 text-xs text-[#f3f4f8] focus:outline-none focus:border-indigo-500 font-mono"
          >
            <option value="all">Mode: All</option>
            <option value="vm_remux">VM Remux (-c:v copy)</option>
            <option value="kaggle_gpu">Kaggle GPU (HEVC/AV1)</option>
          </select>

          {/* Sort Order */}
          <select
            aria-label="Sort jobs"
            value={sortOrder}
            onChange={(e) => setSortOrder(e.target.value as any)}
            className="bg-[#0c0e14] border border-[#1e2230] rounded-lg px-2.5 py-1.5 text-xs text-[#f3f4f8] focus:outline-none focus:border-indigo-500 font-mono"
          >
            <option value="newest">Sort: Newest</option>
            <option value="episode">Sort: Episode</option>
            <option value="size">Sort: Size</option>
          </select>

          {/* Search Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[#636b82]" />
            <input
              type="text"
              aria-label="Search jobs by AniList ID, Tsukihime ID, or title"
              placeholder="Search ID, title, release..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-xs text-[#f3f4f8] placeholder-[#636b82] focus:outline-none focus:border-indigo-500/60 transition-colors w-44 sm:w-56"
            />
          </div>

          {/* Table vs Multimedia Grid Toggle */}
          <div className="flex items-center bg-[#0c0e14] p-1 rounded-lg border border-[#1e2230]">
            <button
              type="button"
              onClick={() => setViewMode("table")}
              aria-label="Table view"
              title="Table view"
              className={`p-1 rounded-md transition-colors cursor-pointer ${
                viewMode === "table"
                  ? "bg-[#1c202e] text-white"
                  : "text-[#636b82] hover:text-white"
              }`}
            >
              <List className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={() => setViewMode("grid")}
              aria-label="Multimedia grid view"
              title="Multimedia grid view"
              className={`p-1 rounded-md transition-colors cursor-pointer ${
                viewMode === "grid"
                  ? "bg-[#1c202e] text-white"
                  : "text-[#636b82] hover:text-white"
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
            </button>
          </div>

          <button
            type="button"
            onClick={fetchJobs}
            aria-label="Refresh jobs table"
            className="btn-secondary p-1.5 rounded-lg text-[#949bb0] hover:text-white cursor-pointer"
            title="Refresh jobs table"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Contextual Multi-Select Action Bar */}
      {selectedIds.size > 0 && (
        <div className="px-5 py-2.5 bg-indigo-500/10 border-b border-indigo-500/30 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 text-xs font-mono tabular-nums">
            <span className="font-semibold text-indigo-300">
              {selectedIds.size} selected
            </span>
            <span className="text-[#636b82]">·</span>
            <span className="text-[#d5d9e6]">
              {(selectedTotalBytes / (1024 * 1024)).toFixed(1)} MB total
            </span>
            <div className="flex items-center gap-2 ml-2 text-[11px]">
              <button
                type="button"
                onClick={() => selectByPredicate((j) => j.status === "failed")}
                className="text-[#949bb0] hover:text-white underline cursor-pointer"
              >
                Only Failed
              </button>
              <button
                type="button"
                onClick={() => selectByPredicate((j) => j.status === "staged")}
                className="text-[#949bb0] hover:text-white underline cursor-pointer"
              >
                Only Staged
              </button>
              <button
                type="button"
                onClick={() => {
                  setSelectedIds(new Set());
                  setConfirmBulkDelete(false);
                }}
                className="text-indigo-300 hover:text-white underline cursor-pointer"
              >
                Clear Selection
              </button>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => handleBulkAction("retry")}
              disabled={bulkLoading !== null}
              className="btn-secondary px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              {bulkLoading === "retry" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <RefreshCw className="w-3.5 h-3.5 text-amber-300" />
              )}
              <span>Retry Selected</span>
            </button>

            <button
              type="button"
              onClick={() => handleBulkAction("force_remux")}
              disabled={bulkLoading !== null}
              className="btn-secondary px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="Route selected staged jobs to local VM Direct-Remux (-c:v copy)"
            >
              {bulkLoading === "force_remux" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Zap className="w-3.5 h-3.5 text-emerald-400" />
              )}
              <span>VM Remux (-c:v copy)</span>
            </button>

            <button
              type="button"
              onClick={() => handleBulkAction("force_gpu")}
              disabled={bulkLoading !== null}
              className="btn-secondary px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="Route selected staged jobs to Kaggle Dual-T4 GPU batch"
            >
              {bulkLoading === "force_gpu" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Cpu className="w-3.5 h-3.5 text-violet-400" />
              )}
              <span>Kaggle GPU</span>
            </button>

            <button
              type="button"
              onClick={() => handleBulkAction("sync_callbacks")}
              disabled={bulkLoading !== null}
              className="btn-secondary px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="Re-dispatch completion webhook to Main Backend for completed jobs"
            >
              {bulkLoading === "sync_callbacks" ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Send className="w-3.5 h-3.5 text-sky-400" />
              )}
              <span>Sync Webhooks</span>
            </button>

            <button
              type="button"
              onClick={handleExportSelectedJson}
              className="btn-secondary px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5 text-[#949bb0]" />
              <span>Export JSON</span>
            </button>

            {confirmBulkDelete ? (
              <div className="inline-flex items-center gap-1">
                <button
                  type="button"
                  onClick={() => handleBulkAction("delete")}
                  disabled={bulkLoading !== null}
                  className="px-2.5 py-1 rounded-md bg-rose-500/20 text-rose-300 border border-rose-500/40 text-xs font-medium hover:bg-rose-500/30 cursor-pointer"
                >
                  Confirm Delete ({selectedIds.size})
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmBulkDelete(false)}
                  className="px-2 py-1 rounded-md bg-[#151822] text-[#949bb0] text-xs hover:text-white cursor-pointer"
                >
                  Cancel
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setConfirmBulkDelete(true)}
                className="btn-secondary px-2.5 py-1 rounded-md text-xs font-medium text-rose-300 hover:text-rose-200 inline-flex items-center gap-1.5 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>Delete</span>
              </button>
            )}
          </div>
        </div>
      )}

      {/* View Mode: Table vs Multimedia Grid */}
      {viewMode === "table" ? (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0c0e14] text-[#636b82] font-medium border-b border-[#1e2230]">
              <tr>
                <th className="py-2.5 px-4 w-9">
                  <button
                    type="button"
                    onClick={toggleSelectAllVisible}
                    aria-label="Select all visible jobs"
                    className="text-[#949bb0] hover:text-white flex items-center justify-center cursor-pointer"
                  >
                    {allVisibleSelected ? (
                      <CheckSquare className="w-4 h-4 text-indigo-400" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                </th>
                <th className="py-2.5 px-3 font-mono">Job</th>
                <th className="py-2.5 px-4">Anime & AniList ID</th>
                <th className="py-2.5 px-4 font-mono">Provider IDs</th>
                <th className="py-2.5 px-4">Episode</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Release & Processing Mode</th>
                <th className="py-2.5 px-4 text-right font-mono">Size</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e2230]">
              {filteredJobs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="py-12 px-6 text-center">
                    <p className="text-xs font-medium text-[#f3f4f8]">
                      No encoding jobs match the current filter
                    </p>
                    <p className="text-xs text-[#636b82] mt-1">
                      Enqueue an anime episode by AniList ID to initiate Tsukihime & AnimeTosho discovery.
                    </p>
                    {onOpenEnqueue && (
                      <button
                        type="button"
                        onClick={onOpenEnqueue}
                        className="btn-primary mt-3 px-3.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        <span>Enqueue First Episode</span>
                      </button>
                    )}
                  </td>
                </tr>
              ) : (
                filteredJobs.map((job, idx) => {
                  const animeTitle =
                    job.metadata?.primaryTitle ||
                    (job.knownTitles && job.knownTitles[0]) ||
                    `AniList #${job.anilistId || job.id}`;
                  const tsukihimeId = job.metadata?.tsukihimeId;
                  const isSelected = selectedIds.has(job.id);
                  const subtitleCount = Array.isArray(job.metadata?.subtitles)
                    ? job.metadata.subtitles.length
                    : 0;

                  return (
                    <tr
                      key={job.id}
                      className={`transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-indigo-500/10 hover:bg-indigo-500/15"
                          : "hover:bg-[#151822]/70"
                      }`}
                      onClick={() => setSelectedJob(job)}
                    >
                      <td
                        className="py-3 px-4"
                        onClick={(e) => toggleSelectRow(job.id, idx, e)}
                      >
                        <button
                          type="button"
                          aria-label={`Select Job #${job.id}`}
                          className="text-[#949bb0] hover:text-white flex items-center justify-center cursor-pointer"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-indigo-400" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>

                      <td className="py-3 px-3 font-mono tabular-nums text-[#949bb0] font-semibold">
                        #{job.id}
                      </td>

                      <td className="py-3 px-4">
                        <div className="flex flex-col">
                          <span className="text-xs font-medium text-[#f3f4f8] truncate max-w-xs">
                            {animeTitle}
                          </span>
                          <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono tabular-nums text-[#636b82]">
                            {job.anilistId ? (
                              <a
                                href={`https://anilist.co/anime/${job.anilistId}`}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                className="text-indigo-400 hover:underline inline-flex items-center gap-1"
                              >
                                <span>AniList #{job.anilistId}</span>
                                <ExternalLink className="w-2.5 h-2.5" />
                              </a>
                            ) : (
                              <span>AniList —</span>
                            )}
                            {subtitleCount > 0 && (
                              <span>· {subtitleCount} VTT R2</span>
                            )}
                          </div>
                        </div>
                      </td>

                      <td className="py-3 px-4 font-mono tabular-nums text-[11px] text-[#949bb0]">
                        <div className="flex flex-col">
                          <span>
                            AniDB:{" "}
                            <strong className="text-[#d5d9e6]">
                              {job.anidbId || "—"}
                            </strong>
                            {tsukihimeId ? ` · Tsuki: #${tsukihimeId}` : ""}
                          </span>
                          {job.animeId && (
                            <span className="text-[#636b82]">
                              Main DB: #{job.animeId}
                            </span>
                          )}
                        </div>
                      </td>

                      <td className="py-3 px-4 font-mono tabular-nums">
                        <span className="font-semibold text-[#f3f4f8]">
                          Ep {job.episodeNumber}
                        </span>
                        <span className="text-[#636b82] mx-1.5">·</span>
                        <span className="text-[11px] text-[#949bb0] uppercase">
                          {job.types?.join("/") || "SUB"}
                        </span>
                      </td>

                      <td className="py-3 px-4">{renderStatus(job.status)}</td>

                      <td
                        className="py-3 px-4 max-w-xs truncate"
                        title={job.torrentTitle || job.lastError || ""}
                      >
                        {job.torrentTitle ? (
                          <div className="flex flex-col">
                            <span className="text-[#d5d9e6] truncate block text-[11px] font-mono">
                              {job.torrentTitle}
                            </span>
                            <div className="flex items-center gap-1.5 mt-0.5 text-[10px] font-mono text-[#636b82]">
                              {(job.pipelineType || job.metadata?.processingMode) === "vm_remux" ? (
                                <span className="text-emerald-400">
                                  {(job.selectionTier || job.metadata?.selectionTier) === "h264_single_1080p"
                                    ? "Pipeline 1: VM Remux (1Q 1080p)"
                                    : "Pipeline 1: VM Remux (-c:v copy)"}
                                </span>
                              ) : (job.pipelineType || job.metadata?.processingMode) === "kaggle_gpu" ? (
                                <span className="text-violet-400">
                                  Pipeline 2: Kaggle GPU (HEVC/AV1)
                                </span>
                              ) : null}
                              {Array.isArray(job.metadata?.availableQualities) &&
                                job.metadata.availableQualities.length > 0 && (
                                  <span>
                                    · {job.metadata.availableQualities.join("/")}
                                  </span>
                                )}
                              {Boolean(job.isBatchTorrent ?? job.metadata?.isBatchTorrent) && (
                                <span className="text-amber-300">· 1-Ep Batch Extract</span>
                              )}
                            </div>
                          </div>
                        ) : job.lastError ? (
                          <span className="text-rose-400 text-[11px] truncate flex items-center gap-1 font-mono">
                            <AlertCircle className="w-3 h-3 shrink-0" />
                            <span className="truncate">{job.lastError}</span>
                          </span>
                        ) : (
                          <span className="text-[#636b82] text-[11px]">
                            Awaiting candidate selection
                          </span>
                        )}
                      </td>

                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#949bb0]">
                        {job.sizeBytes
                          ? `${(job.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                          : "—"}
                      </td>

                      <td
                        className="py-3 px-4 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {confirmDeleteId === job.id ? (
                          <div className="inline-flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => handleDelete(job.id)}
                              className="px-2 py-1 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[11px] font-medium hover:bg-rose-500/30 cursor-pointer"
                            >
                              Confirm
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(null)}
                              className="px-2 py-1 rounded bg-[#151822] text-[#949bb0] text-[11px] hover:text-white cursor-pointer"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <div className="inline-flex items-center gap-1">
                            {(job.status === "failed" ||
                              job.status === "skipped" ||
                              job.status === "download_paused") && (
                              <button
                                type="button"
                                onClick={() => handleRetry(job.id)}
                                className="btn-secondary p-1.5 rounded-md text-[#d5d9e6] hover:text-white cursor-pointer"
                                title={`Retry / Re-queue Job #${job.id}`}
                                aria-label={`Retry Job #${job.id}`}
                              >
                                <RefreshCw className="w-3.5 h-3.5" />
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => setSelectedJob(job)}
                              className="btn-secondary p-1.5 rounded-md text-[#949bb0] hover:text-white cursor-pointer"
                              title={`Inspect & Preview Job #${job.id}`}
                              aria-label={`Inspect Job #${job.id}`}
                            >
                              {job.status === "completed" ? (
                                <Play className="w-3.5 h-3.5 text-emerald-400" />
                              ) : (
                                <Info className="w-3.5 h-3.5" />
                              )}
                            </button>
                            <button
                              type="button"
                              onClick={() => setConfirmDeleteId(job.id)}
                              className="btn-secondary p-1.5 rounded-md text-[#949bb0] hover:text-rose-400 cursor-pointer"
                              title={`Delete Job #${job.id}`}
                              aria-label={`Delete Job #${job.id}`}
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : (
        /* Multimedia Grid View */
        <div className="p-5">
          {filteredJobs.length === 0 ? (
            <div className="py-10 text-center">
              <p className="text-xs font-medium text-[#f3f4f8]">
                No encoding jobs match the current filter
              </p>
              <p className="text-xs text-[#636b82] mt-1">
                Switch filters or enqueue an episode to populate the multimedia grid.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {filteredJobs.map((job, idx) => {
                const animeTitle =
                  job.metadata?.primaryTitle ||
                  (job.knownTitles && job.knownTitles[0]) ||
                  `AniList #${job.anilistId || job.id}`;
                const coverImage = job.metadata?.coverImage;
                const isSelected = selectedIds.has(job.id);
                const subtitleCount = Array.isArray(job.metadata?.subtitles)
                  ? job.metadata.subtitles.length
                  : 0;
                const availableQualities: string[] =
                  job.metadata?.availableQualities || [];

                return (
                  <div
                    key={job.id}
                    onClick={() => setSelectedJob(job)}
                    className={`rounded-xl p-4 border transition-colors cursor-pointer flex gap-3.5 ${
                      isSelected
                        ? "bg-indigo-500/10 border-indigo-500/40"
                        : "bg-[#0c0e14] border-[#1e2230] hover:border-[#2e344a]"
                    }`}
                  >
                    {/* Cover Art or Placeholder */}
                    <div className="relative w-16 h-24 rounded-lg bg-[#151822] border border-[#1e2230] shrink-0 overflow-hidden flex items-center justify-center">
                      {coverImage ? (
                        <img
                          src={coverImage}
                          alt={animeTitle}
                          referrerPolicy="no-referrer"
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <Film className="w-5 h-5 text-[#636b82]" />
                      )}
                      <button
                        type="button"
                        onClick={(e) => toggleSelectRow(job.id, idx, e)}
                        aria-label={`Select Job #${job.id}`}
                        className="absolute top-1.5 left-1.5 w-5 h-5 rounded bg-black/75 border border-white/20 flex items-center justify-center text-white cursor-pointer"
                      >
                        {isSelected ? (
                          <CheckSquare className="w-3.5 h-3.5 text-indigo-400" />
                        ) : (
                          <Square className="w-3.5 h-3.5 text-[#949bb0]" />
                        )}
                      </button>
                    </div>

                    {/* Multimedia Metadata */}
                    <div className="flex-1 min-w-0 flex flex-col justify-between">
                      <div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[11px] font-mono tabular-nums text-[#636b82]">
                            Job #{job.id} · Ep {job.episodeNumber} (
                            {job.types?.join("/").toUpperCase()})
                          </span>
                          {renderStatus(job.status)}
                        </div>
                        <h3 className="text-xs font-semibold text-[#f3f4f8] truncate mt-1">
                          {animeTitle}
                        </h3>
                        <p className="text-[11px] font-mono text-[#949bb0] truncate mt-0.5">
                          {job.torrentTitle ||
                            job.lastError ||
                            "Resolving torrent release..."}
                        </p>
                      </div>

                      <div className="pt-2 mt-2 border-t border-[#1e2230] flex items-center justify-between text-[11px] font-mono tabular-nums text-[#949bb0]">
                        <div className="flex items-center gap-2">
                          {job.metadata?.processingMode === "vm_remux" ? (
                            <span className="text-emerald-400">VM Remux</span>
                          ) : job.metadata?.processingMode === "kaggle_gpu" ? (
                            <span className="text-violet-400">Kaggle GPU</span>
                          ) : (
                            <span>Auto Route</span>
                          )}
                          {availableQualities.length > 0 && (
                            <span>· {availableQualities.join("/")}</span>
                          )}
                        </div>

                        <div className="flex items-center gap-2">
                          {subtitleCount > 0 && (
                            <span className="inline-flex items-center gap-1 text-indigo-300">
                              <Subtitles className="w-3 h-3" />
                              {subtitleCount}
                            </span>
                          )}
                          <span>
                            {job.sizeBytes
                              ? `${(job.sizeBytes / (1024 * 1024)).toFixed(0)} MB`
                              : "—"}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {selectedJob && (
        <JobDetailsModal
          job={selectedJob}
          onClose={() => setSelectedJob(null)}
          onUpdated={(msg) => {
            fetchJobs();
            onNotice?.(msg || `Updated Job #${selectedJob.id}`);
          }}
        />
      )}
    </div>
  );
}
