import React, { useState, useEffect } from "react";
import { Zap, Play, Loader2 } from "lucide-react";

interface Batch {
  id: number;
  status: string;
  triggerReason: string;
  kaggleUsername?: string | null;
  datasetSlug?: string | null;
  kernelSlug?: string | null;
  totalBytes: number;
  jobCount: number;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
}

export function BatchViewer() {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [executingId, setExecutingId] = useState<number | null>(null);

  const fetchBatches = async () => {
    try {
      const res = await fetch("/api/batches");
      const data = await res.json();
      setBatches(data.batches || []);
    } catch {}
  };

  const handleExecuteBatch = async (batchId: number) => {
    setExecutingId(batchId);
    try {
      await fetch(`/api/batches/${batchId}/execute`, { method: "POST" });
      await fetchBatches();
    } catch {} finally {
      setExecutingId(null);
    }
  };

  useEffect(() => {
    fetchBatches();
    const interval = setInterval(fetchBatches, 10000);
    return () => clearInterval(interval);
  }, []);

  if (batches.length === 0) return null;

  return (
    <div className="rounded-3xl bg-[#161723] border border-white/[0.08] p-5 shadow-2xl">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <div className="w-7 h-7 rounded-lg bg-white/[0.08] border border-white/10 flex items-center justify-center text-white">
            <Zap className="w-3.5 h-3.5" />
          </div>
          <h2 className="text-xs font-bold text-white tracking-wider uppercase font-sans">
            Kaggle GPU Batch History
          </h2>
        </div>
        <span className="text-[11px] text-neutral-500 font-mono">
          Safe 10-Item / 10GB Auto-Sealed Batches
        </span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3.5">
        {batches.slice(0, 6).map((b) => {
          const isActive = [
            "created",
            "uploading",
            "waiting_dataset",
            "kernel_running",
          ].includes(b.status);

          return (
            <div
              key={b.id}
              className={`p-4 rounded-2xl border transition-all duration-200 ${
                isActive
                  ? "bg-[#10111a] border-white/20 shadow-lg shadow-black/40"
                  : "bg-white/[0.02] border-white/[0.05] hover:border-white/[0.12]"
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <div className="flex items-center gap-1.5">
                  <span className="font-mono font-bold text-xs text-white">Batch #{b.id}</span>
                  <span className="text-[10px] text-neutral-500 font-mono capitalize">
                    • {b.triggerReason.replace("_", " ")}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span
                    className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                      b.status === "completed"
                        ? "bg-emerald-500/10 text-emerald-300 border-emerald-500/20"
                        : b.status === "kernel_running"
                        ? "bg-sky-500/20 text-sky-300 border-sky-500/30 animate-pulse"
                        : b.status === "created"
                        ? "bg-amber-500/10 text-amber-300 border-amber-500/20"
                        : b.status === "failed"
                        ? "bg-rose-500/10 text-rose-300 border-rose-500/20"
                        : "bg-white/[0.08] text-white border-white/10"
                    }`}
                  >
                    {b.status === "created" ? "PREPARING" : b.status.toUpperCase()}
                  </span>
                  {b.status === "created" && (
                    <button
                      onClick={() => handleExecuteBatch(b.id)}
                      disabled={executingId === b.id}
                      title="Dispatch to Kaggle GPU"
                      className="px-2 py-0.5 text-[10px] font-mono font-bold rounded-full bg-white text-black hover:bg-neutral-200 flex items-center gap-1 transition-all active:scale-95 disabled:opacity-50"
                    >
                      {executingId === b.id ? (
                        <Loader2 className="w-2.5 h-2.5 animate-spin" />
                      ) : (
                        <Play className="w-2.5 h-2.5 fill-black" />
                      )}
                      <span>Run</span>
                    </button>
                  )}
                </div>
              </div>

              <div className="text-[11px] text-neutral-400 font-mono truncate mb-1">
                Kernel: <span className="text-neutral-200">{b.kernelSlug || "provisioning"}</span>
              </div>

              <div className="flex items-center justify-between text-[11px] text-neutral-400 font-mono mt-3 pt-2.5 border-t border-white/[0.05]">
                <span>
                  {b.jobCount} {b.jobCount === 1 ? "Ep" : "Eps"} •{" "}
                  {(b.totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB
                </span>
                <span
                  className="text-white font-medium truncate max-w-[110px]"
                  title={b.kaggleUsername || ""}
                >
                  @{b.kaggleUsername || "-"}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
