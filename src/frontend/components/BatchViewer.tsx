import React, { useState, useEffect } from "react";
import { Zap, CheckCircle2, AlertCircle, Clock, ExternalLink } from "lucide-react";

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

  const fetchBatches = async () => {
    try {
      const res = await fetch("/api/batches");
      const data = await res.json();
      setBatches(data.batches || []);
    } catch {}
  };

  useEffect(() => {
    fetchBatches();
    const interval = setInterval(fetchBatches, 10000);
    return () => clearInterval(interval);
  }, []);

  if (batches.length === 0) return null;

  return (
    <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 p-4">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-sm font-bold text-white tracking-wide uppercase flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5 text-indigo-400" />
          Recent Kaggle GPU Batches
        </h2>
        <span className="text-xs text-zinc-500 font-mono">10GB Auto-Sealed Batches</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {batches.slice(0, 6).map((b) => (
          <div
            key={b.id}
            className="p-3 rounded-lg bg-zinc-950/60 border border-zinc-800/80 hover:border-zinc-700/80 transition-colors"
          >
            <div className="flex items-center justify-between mb-1.5">
              <span className="font-mono font-bold text-xs text-white">Batch #{b.id}</span>
              <span
                className={`text-[10px] font-bold px-2 py-0.5 rounded ${
                  b.status === "completed"
                    ? "bg-emerald-500/10 text-emerald-400"
                    : b.status === "kernel_running"
                    ? "bg-indigo-500/20 text-indigo-300 animate-pulse"
                    : b.status === "failed"
                    ? "bg-rose-500/10 text-rose-400"
                    : "bg-amber-500/10 text-amber-300"
                }`}
              >
                {b.status.toUpperCase()}
              </span>
            </div>

            <div className="text-xs text-zinc-400 truncate mb-1">
              Kernel: <span className="font-mono text-zinc-300">{b.kernelSlug || "-"}</span>
            </div>

            <div className="flex items-center justify-between text-[11px] text-zinc-500 font-mono mt-2 pt-2 border-t border-zinc-800/60">
              <span>{b.jobCount} Eps ({(b.totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB)</span>
              <span>Account: {b.kaggleUsername || "-"}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

