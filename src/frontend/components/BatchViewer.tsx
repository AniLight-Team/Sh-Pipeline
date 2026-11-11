import React, { useState, useEffect } from "react";
import {
  Boxes,
  Play,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Clock,
  RefreshCw,
  Layers,
  Trash2,
  ChevronDown,
  ChevronUp,
  CheckSquare,
  Square,
} from "lucide-react";

interface Batch {
  id: number;
  status: string;
  pipelineType?: "vm_remux" | "kaggle_gpu" | string | null;
  triggerReason: string;
  kaggleUsername?: string | null;
  datasetSlug?: string | null;
  kernelSlug?: string | null;
  totalBytes: number;
  jobCount: number;
  lastError?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

interface BatchViewerProps {
  onForceFlush?: () => void;
  stagedCount?: number;
  onNotice?: (msg: string) => void;
}

export function BatchViewer({
  onForceFlush,
  stagedCount = 0,
  onNotice,
}: BatchViewerProps) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(false);
  const [executingId, setExecutingId] = useState<number | null>(null);
  const [modeFilter, setModeFilter] = useState<"all" | "vm_remux" | "kaggle_gpu">("all");
  const [selectedBatchIds, setSelectedBatchIds] = useState<Set<number>>(new Set());
  const [bulkLoading, setBulkLoading] = useState(false);

  // Expandable batch manifest state
  const [expandedBatchId, setExpandedBatchId] = useState<number | null>(null);
  const [batchJobsMap, setBatchJobsMap] = useState<Record<number, any[]>>({});
  const [loadingBatchJobsId, setLoadingBatchJobsId] = useState<number | null>(null);

  const fetchBatches = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/batches");
      const data = await res.json();
      setBatches(data.batches || []);
    } catch {
      // Ignore transient network errors
    } finally {
      setLoading(false);
    }
  };

  const handleExecuteBatch = async (batchId: number) => {
    setExecutingId(batchId);
    try {
      await fetch(`/api/batches/${batchId}/execute`, { method: "POST" });
      onNotice?.(`Batch #${batchId} execution dispatched.`);
      await fetchBatches();
    } catch {
      onNotice?.(`Failed to dispatch Batch #${batchId}.`);
    } finally {
      setExecutingId(null);
    }
  };

  const handleBulkBatchAction = async (action: "execute" | "delete") => {
    const ids = Array.from(selectedBatchIds);
    if (ids.length === 0) return;
    setBulkLoading(true);
    try {
      const res = await fetch("/api/batches/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ batchIds: ids, action }),
      });
      const data = await res.json();
      onNotice?.(data.message || `Batch ${action} completed.`);
      if (action === "delete") {
        setSelectedBatchIds(new Set());
      }
      await fetchBatches();
    } catch {
      onNotice?.(`Failed to run bulk ${action} on selected batches.`);
    } finally {
      setBulkLoading(false);
    }
  };

  const toggleExpandBatch = async (batchId: number) => {
    if (expandedBatchId === batchId) {
      setExpandedBatchId(null);
      return;
    }
    setExpandedBatchId(batchId);
    if (!batchJobsMap[batchId]) {
      setLoadingBatchJobsId(batchId);
      try {
        const res = await fetch(`/api/batches/${batchId}/jobs`);
        const data = await res.json();
        setBatchJobsMap((prev) => ({ ...prev, [batchId]: data.jobs || [] }));
      } catch {
        // Ignore
      } finally {
        setLoadingBatchJobsId(null);
      }
    }
  };

  useEffect(() => {
    fetchBatches();
    const interval = setInterval(fetchBatches, 10000);
    return () => clearInterval(interval);
  }, []);

  const filteredBatches = batches.filter((b) => {
    if (modeFilter === "all") return true;
    const isVmRemux =
      b.pipelineType === "vm_remux" ||
      b.kaggleUsername === "local-vm" ||
      b.triggerReason.startsWith("vm_remux");
    return modeFilter === "vm_remux" ? isVmRemux : !isVmRemux;
  });

  const visibleBatches = filteredBatches.slice(0, 15);
  const allVisibleSelected =
    visibleBatches.length > 0 &&
    visibleBatches.every((b) => selectedBatchIds.has(b.id));

  const toggleSelectAll = () => {
    if (allVisibleSelected) {
      setSelectedBatchIds(new Set());
    } else {
      setSelectedBatchIds(new Set(visibleBatches.map((b) => b.id)));
    }
  };

  const toggleSelectBatch = (id: number, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedBatchIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const renderStatus = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>Completed</span>
          </span>
        );
      case "kernel_running":
      case "uploading":
      case "waiting_dataset":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-sky-400">
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
            <span>{status.replace("_", " ")}</span>
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-rose-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
            <span>Failed</span>
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-amber-400">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>{status === "created" ? "Sealed / Ready" : status}</span>
          </span>
        );
    }
  };

  return (
    <div className="surface-panel rounded-xl overflow-hidden">
      <div className="px-5 py-4 border-b border-[#1e2230] flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-[#f3f4f8]">
              Pipeline 2 GPU Batch Executions (Kaggle Dual-T4 GPU · 429 Rate-Limit Protected)
            </h2>
            <span className="text-xs font-mono tabular-nums text-[#636b82]">
              · {filteredBatches.length} {filteredBatches.length === 1 ? "batch" : "batches"}
            </span>
          </div>
          <p className="text-xs text-[#636b82] mt-0.5">
            Pipeline 1 (H.264) streams 2 jobs at a time directly on the VM (-c:v copy, no batching) · Pipeline 2 (HEVC/AV1) batches up to 10 episodes on Kaggle GPU
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Mode Filter */}
          <div className="flex items-center bg-[#0c0e14] p-1 rounded-lg border border-[#1e2230] text-xs font-mono">
            <button
              type="button"
              onClick={() => setModeFilter("all")}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition-colors ${
                modeFilter === "all"
                  ? "bg-[#1c202e] text-white"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              All
            </button>
            <button
              type="button"
              onClick={() => setModeFilter("vm_remux")}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition-colors ${
                modeFilter === "vm_remux"
                  ? "bg-[#1c202e] text-emerald-300"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              VM Remux
            </button>
            <button
              type="button"
              onClick={() => setModeFilter("kaggle_gpu")}
              className={`px-2.5 py-1 rounded-md cursor-pointer transition-colors ${
                modeFilter === "kaggle_gpu"
                  ? "bg-[#1c202e] text-violet-300"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              Kaggle GPU
            </button>
          </div>

          {stagedCount > 0 && onForceFlush && (
            <button
              type="button"
              onClick={onForceFlush}
              className="btn-secondary px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
              <span>Drain VM Slots & Seal GPU ({stagedCount})</span>
            </button>
          )}
          <button
            type="button"
            onClick={fetchBatches}
            aria-label="Refresh batches"
            className="btn-secondary p-1.5 rounded-lg text-[#949bb0] hover:text-white cursor-pointer"
            title="Refresh batches"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Multi-Select Batch Action Toolbar */}
      {selectedBatchIds.size > 0 && (
        <div className="px-5 py-2.5 bg-indigo-500/10 border-b border-indigo-500/30 flex flex-wrap items-center justify-between gap-3 text-xs">
          <div className="flex items-center gap-3 font-mono tabular-nums">
            <span className="font-semibold text-indigo-300">
              {selectedBatchIds.size} batch(es) selected
            </span>
            <button
              type="button"
              onClick={() => setSelectedBatchIds(new Set())}
              className="text-[#949bb0] hover:text-white underline cursor-pointer"
            >
              Clear
            </button>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => handleBulkBatchAction("execute")}
              disabled={bulkLoading}
              className="btn-secondary px-2.5 py-1 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Play className="w-3 h-3 text-indigo-400" />
              <span>Dispatch Selected</span>
            </button>
            <button
              type="button"
              onClick={() => handleBulkBatchAction("delete")}
              disabled={bulkLoading}
              className="btn-secondary px-2.5 py-1 rounded-md text-xs font-medium text-rose-300 hover:text-rose-200 inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Trash2 className="w-3 h-3" />
              <span>Delete Selected</span>
            </button>
          </div>
        </div>
      )}

      {visibleBatches.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <Boxes className="w-6 h-6 text-[#636b82] mx-auto mb-2" />
          <p className="text-xs font-medium text-[#f3f4f8]">
            No Kaggle GPU batches match the current filter
          </p>
          <p className="text-xs text-[#636b82] mt-1 max-w-md mx-auto">
            Pipeline 1 (H.264) processes 2 episodes concurrently on the VM with zero batch wait — as soon as one finishes, the next enters immediately. Pipeline 2 (HEVC/AV1) seals into a Kaggle GPU batch (10 eps / 10 GB / 90s idle settle).
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0c0e14] text-[#636b82] font-medium border-b border-[#1e2230]">
              <tr>
                <th className="py-2.5 px-4 w-9">
                  <button
                    type="button"
                    onClick={toggleSelectAll}
                    aria-label="Select all visible batches"
                    className="text-[#949bb0] hover:text-white flex items-center justify-center cursor-pointer"
                  >
                    {allVisibleSelected ? (
                      <CheckSquare className="w-4 h-4 text-indigo-400" />
                    ) : (
                      <Square className="w-4 h-4" />
                    )}
                  </button>
                </th>
                <th className="py-2.5 px-3 font-mono">Batch</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Mode / Trigger</th>
                <th className="py-2.5 px-4">Execution Target</th>
                <th className="py-2.5 px-4">Worker / Kernel</th>
                <th className="py-2.5 px-4 text-right font-mono">Payload</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e2230]">
              {visibleBatches.map((b) => {
                const isVmRemux =
                  b.kaggleUsername === "local-vm" || b.triggerReason.startsWith("vm_remux");
                const isSelected = selectedBatchIds.has(b.id);
                const isExpanded = expandedBatchId === b.id;
                const manifestJobs = batchJobsMap[b.id] || [];

                return (
                  <React.Fragment key={b.id}>
                    <tr
                      onClick={() => toggleExpandBatch(b.id)}
                      className={`transition-colors cursor-pointer ${
                        isSelected
                          ? "bg-indigo-500/10 hover:bg-indigo-500/15"
                          : "hover:bg-[#151822]/60"
                      }`}
                    >
                      <td
                        className="py-3 px-4"
                        onClick={(e) => toggleSelectBatch(b.id, e)}
                      >
                        <button
                          type="button"
                          aria-label={`Select Batch #${b.id}`}
                          className="text-[#949bb0] hover:text-white flex items-center justify-center cursor-pointer"
                        >
                          {isSelected ? (
                            <CheckSquare className="w-4 h-4 text-indigo-400" />
                          ) : (
                            <Square className="w-4 h-4" />
                          )}
                        </button>
                      </td>
                      <td className="py-3 px-3 font-mono tabular-nums font-semibold text-[#f3f4f8]">
                        <div className="inline-flex items-center gap-1.5">
                          <span>#{b.id}</span>
                          {isExpanded ? (
                            <ChevronUp className="w-3.5 h-3.5 text-[#636b82]" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-[#636b82]" />
                          )}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        {renderStatus(b.status)}
                        {b.lastError && b.status === "failed" && (
                          <div
                            className="text-[11px] text-rose-400 font-mono truncate max-w-xs mt-0.5"
                            title={b.lastError}
                          >
                            {b.lastError}
                          </div>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-[#949bb0]">
                        {isVmRemux ? (
                          <span className="text-emerald-400">VM Direct Remux</span>
                        ) : (
                          <span>{b.triggerReason.replace(/_/g, " ")}</span>
                        )}
                      </td>
                      <td className="py-3 px-4 font-mono text-[#d5d9e6]">
                        {isVmRemux
                          ? "Local VM (-c:v copy)"
                          : b.kaggleUsername
                            ? `@${b.kaggleUsername}`
                            : "auto-assign"}
                      </td>
                      <td className="py-3 px-4 font-mono text-[#949bb0] max-w-xs truncate">
                        {b.kernelSlug || "awaiting dispatch"}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#d5d9e6]">
                        {b.jobCount} {b.jobCount === 1 ? "ep" : "eps"} ·{" "}
                        {(b.totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB
                      </td>
                      <td
                        className="py-3 px-4 text-right whitespace-nowrap"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <div className="inline-flex items-center gap-1.5">
                          {(b.status === "created" || b.status === "failed") && (
                            <button
                              type="button"
                              onClick={() => handleExecuteBatch(b.id)}
                              disabled={executingId === b.id}
                              className="btn-secondary px-2.5 py-1 rounded-md text-[11px] font-medium inline-flex items-center gap-1 cursor-pointer disabled:opacity-50"
                            >
                              {executingId === b.id ? (
                                <Loader2 className="w-3 h-3 animate-spin" />
                              ) : (
                                <Play className="w-3 h-3 text-indigo-400" />
                              )}
                              <span>{b.status === "failed" ? "Retry" : "Dispatch"}</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => toggleExpandBatch(b.id)}
                            className="btn-secondary px-2 py-1 rounded-md text-[11px] font-mono text-[#949bb0] hover:text-white cursor-pointer"
                          >
                            {isExpanded ? "Hide" : "Episodes"}
                          </button>
                        </div>
                      </td>
                    </tr>

                    {/* Expanded Batch Episode Manifest */}
                    {isExpanded && (
                      <tr className="bg-[#0c0e14]">
                        <td colSpan={8} className="px-6 py-3.5 border-t border-[#1e2230]">
                          <div className="text-[11px] font-mono text-[#949bb0] mb-2 flex items-center justify-between">
                            <span>
                              Batch #{b.id} Episode Manifest ({b.jobCount} episodes)
                            </span>
                            <span>
                              Dataset: {b.datasetSlug || "local-vm-staging"}
                            </span>
                          </div>
                          {loadingBatchJobsId === b.id ? (
                            <div className="py-3 text-xs text-[#636b82] flex items-center gap-2 font-mono">
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-indigo-400" />
                              <span>Loading batch episodes...</span>
                            </div>
                          ) : manifestJobs.length === 0 ? (
                            <div className="py-2 text-xs text-[#636b82] font-mono">
                              No linked episode records found for this batch.
                            </div>
                          ) : (
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-2">
                              {manifestJobs.map((j: any) => (
                                <div
                                  key={j.id}
                                  className="p-2.5 rounded-lg bg-[#12141c] border border-[#1e2230] flex items-center justify-between text-xs font-mono tabular-nums"
                                >
                                  <div className="min-w-0 pr-2">
                                    <div className="text-[#f3f4f8] font-medium truncate">
                                      Job #{j.id} · Ep {j.episodeNumber} (
                                      {j.types?.join("/").toUpperCase()})
                                    </div>
                                    <div className="text-[10px] text-[#636b82] truncate">
                                      {j.metadata?.primaryTitle ||
                                        j.torrentTitle ||
                                        `AniList #${j.anilistId || "—"}`}
                                    </div>
                                  </div>
                                  <span className="text-[11px] text-indigo-300 shrink-0">
                                    {j.status}
                                  </span>
                                </div>
                              ))}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
