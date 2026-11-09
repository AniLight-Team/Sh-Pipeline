import React from "react";
import type { PipelineStats } from "../../backend/engine/types.js";
import { HardDrive, Server, Layers, Zap, Clock, CheckCircle2, AlertCircle } from "lucide-react";

interface StatsOverviewProps {
  stats: PipelineStats | null;
}

export function StatsOverview({ stats }: StatsOverviewProps) {
  if (!stats) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-32 rounded-2xl glass-panel animate-pulse" />
        ))}
      </div>
    );
  }

  const { activeBatches = [], queue, storage, accounts, concurrency } = stats;
  const stagedGb = (storage.stagedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const maxStagingGb = (storage.maxStagingBytes / (1024 * 1024 * 1024)).toFixed(0);
  const stagingPercent = Math.min(100, Math.round((storage.stagedBytes / storage.maxStagingBytes) * 100));

  const totalCapacity = concurrency?.max || Math.max(2, (accounts.kaggle.length || 1) * 2);
  const activeCount = concurrency?.active || activeBatches.length;

  return (
    <div className="space-y-4">
      {/* Top 4 Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* Card 1: Kaggle GPU Concurrency Cluster */}
        <div className="p-4 rounded-2xl glass-panel-interactive relative overflow-hidden flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-sans">
                <Zap className="w-3.5 h-3.5 text-indigo-400" />
                GPU Concurrency
              </span>
              <span
                className={`text-[10px] font-mono font-bold px-2 py-0.5 rounded-full border ${
                  activeCount > 0
                    ? "bg-indigo-500/10 text-indigo-300 border-indigo-500/30"
                    : "bg-white/[0.04] text-zinc-500 border-white/[0.06]"
                }`}
              >
                {activeCount > 0 ? `${activeCount} ACTIVE` : "IDLE"}
              </span>
            </div>

            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold font-mono text-white tracking-tight">
                {activeCount}
              </span>
              <span className="text-xs font-mono text-zinc-500">
                / {totalCapacity} slots limit
              </span>
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-400">
            <span>Limit Formula:</span>
            <span className="font-mono text-zinc-300">
              {accounts.kaggle.length} accts × 2 = {totalCapacity} max
            </span>
          </div>
        </div>

        {/* Card 2: Queue Lifecycle Funnel */}
        <div className="p-4 rounded-2xl glass-panel-interactive flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-sans">
                <Layers className="w-3.5 h-3.5 text-cyan-400" />
                Pipeline Queue
              </span>
              <span className="text-xs font-mono text-zinc-400">{queue.total} total</span>
            </div>

            <div className="grid grid-cols-3 gap-2 mt-2">
              <div className="p-2 rounded-xl bg-white/[0.02] border border-white/[0.05] text-center">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Queue</div>
                <div className="text-sm font-bold font-mono text-amber-300 mt-0.5">
                  {queue.queued + queue.downloading}
                </div>
              </div>
              <div className="p-2 rounded-xl bg-white/[0.02] border border-white/[0.05] text-center">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Staged</div>
                <div className="text-sm font-bold font-mono text-cyan-300 mt-0.5">{queue.staged}</div>
              </div>
              <div className="p-2 rounded-xl bg-white/[0.02] border border-white/[0.05] text-center">
                <div className="text-[10px] text-zinc-500 uppercase tracking-wider">Done</div>
                <div className="text-sm font-bold font-mono text-emerald-300 mt-0.5">{queue.completed}</div>
              </div>
            </div>
          </div>

          <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-500">
            <span>Encoding: <strong className="text-indigo-400 font-mono">{queue.encoding}</strong></span>
            <span>Failed: <strong className="text-rose-400 font-mono">{queue.failed}</strong></span>
          </div>
        </div>

        {/* Card 3: Storage & Staging Guardrail */}
        <div className="p-4 rounded-2xl glass-panel-interactive flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-sans">
                <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
                Staging SSD Volume
              </span>
              <span className="text-xs font-mono text-zinc-300 font-semibold">
                {stagedGb} / {maxStagingGb} GB
              </span>
            </div>

            {/* Custom Sleek Gauge */}
            <div className="w-full bg-white/[0.04] rounded-full h-1.5 border border-white/[0.06] mt-3.5 overflow-hidden">
              <div
                className={`h-full transition-all duration-300 rounded-full ${
                  stagingPercent > 80
                    ? "bg-rose-500"
                    : stagingPercent > 50
                    ? "bg-amber-400"
                    : "bg-emerald-400"
                }`}
                style={{ width: `${Math.max(3, stagingPercent)}%` }}
              />
            </div>
          </div>

          <div className="mt-3 pt-2.5 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-400">
            <span>{storage.stagedCount} files staged</span>
            <span className="font-mono text-zinc-300">{stagingPercent}% used</span>
          </div>
        </div>

        {/* Card 4: Kaggle Accounts Dual-Slot Status */}
        <div className="p-4 rounded-2xl glass-panel-interactive flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5 font-sans">
                <Server className="w-3.5 h-3.5 text-purple-400" />
                Kaggle Accounts Pool
              </span>
              <span className="text-xs font-mono text-zinc-400">
                {accounts.kaggle.length} accts
              </span>
            </div>

            <div className="space-y-1.5 mt-2">
              {accounts.kaggle.slice(0, 2).map((acc) => (
                <div
                  key={acc.username}
                  className="flex items-center justify-between text-xs p-1.5 rounded-xl bg-white/[0.02] border border-white/[0.05]"
                >
                  <span className="font-mono text-zinc-300 truncate max-w-[110px]" title={acc.username}>
                    {acc.username}
                  </span>

                  {/* Dual-Slot Indicators */}
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] text-zinc-500 font-mono">
                      {acc.activeTasks ?? 0}/2
                    </span>
                    <div className="flex items-center gap-1">
                      <span
                        className={`w-2 h-2 rounded-full ${
                          acc.slots?.[0] || (acc.activeTasks ?? 0) >= 1
                            ? "bg-indigo-400 animate-pulse"
                            : "bg-zinc-700"
                        }`}
                        title="Slot 1"
                      />
                      <span
                        className={`w-2 h-2 rounded-full ${
                          acc.slots?.[1] || (acc.activeTasks ?? 0) >= 2
                            ? "bg-indigo-400 animate-pulse"
                            : "bg-zinc-700"
                        }`}
                        title="Slot 2"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-2.5 pt-2 border-t border-white/[0.06] flex items-center justify-between text-[11px] text-zinc-400">
            <span>HF Target:</span>
            <span className="font-mono text-zinc-300">
              {accounts.huggingFace[0]?.bucket || "capthumb"}
            </span>
          </div>
        </div>
      </div>

      {/* Active Running Batches Strip (when 1 or more batches are running) */}
      {activeBatches.length > 0 && (
        <div className="p-4 rounded-2xl glass-panel border border-indigo-500/20 shadow-xl shadow-indigo-950/20">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <span className="relative flex h-2 w-2">
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-indigo-400 opacity-75" />
                <span className="relative inline-flex rounded-full h-2 w-2 bg-indigo-500" />
              </span>
              <h3 className="text-xs font-bold text-white tracking-wider uppercase font-sans">
                Active Concurrent Batches ({activeBatches.length} running)
              </h3>
            </div>
            <span className="text-[11px] font-mono text-zinc-400">
              Kaggle GPU Acceleration
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {activeBatches.map((b) => (
              <div
                key={b.id}
                className="p-3 rounded-xl bg-zinc-950/70 border border-white/[0.08] relative overflow-hidden"
              >
                <div className="flex items-center justify-between mb-1.5">
                  <div className="flex items-center gap-1.5">
                    <span className="font-mono font-bold text-xs text-white">Batch #{b.id}</span>
                    <span className="text-[10px] font-mono font-medium px-1.5 py-0.2 rounded bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
                      {b.status}
                    </span>
                  </div>
                  <span className="text-xs font-mono text-zinc-300 flex items-center gap-1">
                    <Clock className="w-3 h-3 text-zinc-500" />
                    {Math.floor(b.elapsedSeconds / 60)}m {b.elapsedSeconds % 60}s
                  </span>
                </div>

                <div className="text-[11px] font-mono text-zinc-400 truncate mb-1">
                  Kernel: <span className="text-zinc-200">{b.kernelSlug || "provisioning..."}</span>
                </div>

                <div className="flex items-center justify-between text-[11px] text-zinc-500 font-mono mt-2 pt-2 border-t border-white/[0.06]">
                  <span>{b.jobCount} Eps ({(b.totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB)</span>
                  <span className="text-indigo-400 font-medium">@{b.kaggleUsername || "auto"}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
