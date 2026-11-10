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
} from "lucide-react";

interface Batch {
  id: number;
  status: string;
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
}

export function BatchViewer({ onForceFlush, stagedCount = 0 }: BatchViewerProps) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(false);
  const [executingId, setExecutingId] = useState<number | null>(null);

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
      await fetchBatches();
    } catch {
      // Ignore
    } finally {
      setExecutingId(null);
    }
  };

  useEffect(() => {
    fetchBatches();
    const interval = setInterval(fetchBatches, 10000);
    return () => clearInterval(interval);
  }, []);

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
              Kaggle GPU Batch Executions
            </h2>
            <span className="text-xs font-mono tabular-nums text-[#636b82]">
              · {batches.length} {batches.length === 1 ? "batch" : "batches"}
            </span>
          </div>
          <p className="text-xs text-[#636b82] mt-0.5">
            Auto-sealed at 10 staged episodes, 10 GB payload volume, or 30m idle window
          </p>
        </div>

        <div className="flex items-center gap-2">
          {stagedCount > 0 && onForceFlush && (
            <button
              type="button"
              onClick={onForceFlush}
              className="btn-secondary px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer"
            >
              <Layers className="w-3.5 h-3.5 text-indigo-400" />
              <span>Seal & Flush ({stagedCount})</span>
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

      {batches.length === 0 ? (
        <div className="px-6 py-10 text-center">
          <Boxes className="w-6 h-6 text-[#636b82] mx-auto mb-2" />
          <p className="text-xs font-medium text-[#f3f4f8]">
            No GPU batches have been sealed yet
          </p>
          <p className="text-xs text-[#636b82] mt-1 max-w-md mx-auto">
            Episodes move from torrent discovery into local SSD staging first. Once 10 episodes are staged (or you trigger a manual flush), a Kaggle GPU batch will appear here.
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="bg-[#0c0e14] text-[#636b82] font-medium border-b border-[#1e2230]">
              <tr>
                <th className="py-2.5 px-4 font-mono">Batch</th>
                <th className="py-2.5 px-4">Status</th>
                <th className="py-2.5 px-4">Trigger</th>
                <th className="py-2.5 px-4">Kaggle Account</th>
                <th className="py-2.5 px-4">Kernel Slug</th>
                <th className="py-2.5 px-4 text-right font-mono">Payload</th>
                <th className="py-2.5 px-4 text-right">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#1e2230]">
              {batches.slice(0, 12).map((b) => (
                <tr key={b.id} className="hover:bg-[#151822]/60 transition-colors">
                  <td className="py-3 px-4 font-mono tabular-nums font-semibold text-[#f3f4f8]">
                    #{b.id}
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
                    {b.triggerReason.replace(/_/g, " ")}
                  </td>
                  <td className="py-3 px-4 font-mono text-[#d5d9e6]">
                    {b.kaggleUsername ? `@${b.kaggleUsername}` : "auto-assign"}
                  </td>
                  <td className="py-3 px-4 font-mono text-[#949bb0] max-w-xs truncate">
                    {b.kernelSlug || "awaiting dispatch"}
                  </td>
                  <td className="py-3 px-4 text-right font-mono tabular-nums text-[#d5d9e6]">
                    {b.jobCount} {b.jobCount === 1 ? "ep" : "eps"} ·{" "}
                    {(b.totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB
                  </td>
                  <td className="py-3 px-4 text-right">
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
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
