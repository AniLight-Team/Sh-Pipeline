import React from "react";
import type { PipelineStats } from "../../backend/engine/types.js";
import { HardDrive, Server, Layers, Clock, Zap, CheckCircle2, AlertCircle } from "lucide-react";

interface StatsOverviewProps {
  stats: PipelineStats | null;
}

export function StatsOverview({ stats }: StatsOverviewProps) {
  if (!stats) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4 animate-pulse">
        {[1, 2, 3, 4].map((i) => (
          <div key={i} className="h-28 rounded-xl bg-zinc-900 border border-zinc-800" />
        ))}
      </div>
    );
  }

  const { activeBatch, queue, storage, accounts } = stats;
  const stagedGb = (storage.stagedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const maxStagingGb = (storage.maxStagingBytes / (1024 * 1024 * 1024)).toFixed(0);
  const stagingPercent = Math.min(100, Math.round((storage.stagedBytes / storage.maxStagingBytes) * 100));

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
      {/* Active Kaggle GPU Batch Card */}
      <div className="p-4 rounded-xl bg-zinc-900/70 border border-zinc-800/80 relative overflow-hidden">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
            <Zap className="w-3.5 h-3.5 text-indigo-400" />
            Active GPU Batch
          </span>
          {activeBatch ? (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30">
              <span className="w-1.5 h-1.5 rounded-full bg-indigo-400 animate-ping" />
              RUNNING
            </span>
          ) : (
            <span className="text-[10px] font-semibold text-zinc-500 px-2 py-0.5 rounded-full bg-zinc-800">
              IDLE
            </span>
          )}
        </div>

        {activeBatch ? (
          <div>
            <div className="text-lg font-bold text-white truncate mb-1">
              {activeBatch.kernelSlug || `Batch #${activeBatch.id}`}
            </div>
            <div className="text-xs text-zinc-400 flex items-center justify-between">
              <span>{activeBatch.jobCount} Episodes ({(activeBatch.totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB)</span>
              <span className="font-mono text-zinc-300">
                {Math.floor(activeBatch.elapsedSeconds / 60)}m {activeBatch.elapsedSeconds % 60}s
              </span>
            </div>
            <div className="text-[11px] text-zinc-500 mt-1 truncate">
              Account: <span className="text-indigo-400 font-mono font-medium">{activeBatch.kaggleUsername}</span>
            </div>
          </div>
        ) : (
          <div className="py-2">
            <div className="text-sm font-medium text-zinc-300">No active Kaggle job</div>
            <div className="text-xs text-zinc-500 mt-0.5">Waiting for 10 GB cap or 30m window</div>
          </div>
        )}
      </div>

      {/* Queue Breakdown Card */}
      <div className="p-4 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
            <Layers className="w-3.5 h-3.5 text-cyan-400" />
            Queue Status
          </span>
          <span className="text-xs font-mono font-bold text-zinc-300">
            {queue.total} total
          </span>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center mt-2">
          <div className="p-1.5 rounded-lg bg-zinc-950/60 border border-zinc-800/60">
            <div className="text-xs text-zinc-400">Queued</div>
            <div className="text-sm font-bold text-amber-300">{queue.queued + queue.downloading}</div>
          </div>
          <div className="p-1.5 rounded-lg bg-zinc-950/60 border border-zinc-800/60">
            <div className="text-xs text-zinc-400">Staged</div>
            <div className="text-sm font-bold text-cyan-300">{queue.staged}</div>
          </div>
          <div className="p-1.5 rounded-lg bg-zinc-950/60 border border-zinc-800/60">
            <div className="text-xs text-zinc-400">Done</div>
            <div className="text-sm font-bold text-emerald-300">{queue.completed}</div>
          </div>
        </div>
      </div>

      {/* Storage & Staging Limit */}
      <div className="p-4 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
            <HardDrive className="w-3.5 h-3.5 text-emerald-400" />
            SSD Staging Storage
          </span>
          <span className="text-xs font-mono font-bold text-zinc-300">
            {stagedGb} / {maxStagingGb} GB
          </span>
        </div>

        <div className="w-full bg-zinc-950 rounded-full h-2 border border-zinc-800 mt-3 overflow-hidden">
          <div
            className={`h-full transition-all duration-500 rounded-full ${
              stagingPercent > 80 ? "bg-rose-500" : stagingPercent > 50 ? "bg-amber-500" : "bg-emerald-500"
            }`}
            style={{ width: `${Math.max(4, stagingPercent)}%` }}
          />
        </div>

        <div className="flex items-center justify-between text-xs text-zinc-500 mt-2">
          <span>{storage.stagedCount} files staged</span>
          <span>{stagingPercent}% capacity</span>
        </div>
      </div>

      {/* Cloud Transcoder Accounts Health */}
      <div className="p-4 rounded-xl bg-zinc-900/70 border border-zinc-800/80">
        <div className="flex items-center justify-between mb-2">
          <span className="text-xs font-semibold text-zinc-400 uppercase tracking-wider flex items-center gap-1.5">
            <Server className="w-3.5 h-3.5 text-violet-400" />
            GPU Accounts Pool
          </span>
          <span className="text-xs font-mono text-zinc-400">
            {accounts.kaggle.length} Kaggle / {accounts.huggingFace.length} HF
          </span>
        </div>

        <div className="space-y-1.5 mt-2">
          {accounts.kaggle.slice(0, 2).map((acc) => (
            <div
              key={acc.username}
              className="flex items-center justify-between text-xs p-1.5 rounded-lg bg-zinc-950/60 border border-zinc-800/60"
            >
              <span className="font-mono text-zinc-300 truncate max-w-[130px]">{acc.username}</span>
              <span
                className={`text-[10px] font-semibold px-2 py-0.5 rounded ${
                  acc.isBusy
                    ? "bg-indigo-500/20 text-indigo-300"
                    : "bg-emerald-500/10 text-emerald-400"
                }`}
              >
                {acc.isBusy ? "Active GPU" : "Available"}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

