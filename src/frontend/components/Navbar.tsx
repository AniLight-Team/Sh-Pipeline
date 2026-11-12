import React from "react";
import { RotateCw, Layers, Plus, Wifi, WifiOff, HardDrive, Activity } from "lucide-react";
import type { PipelineStats, PipelineExecutionPolicy } from "../../backend/engine/types.js";

interface NavbarProps {
  connected: boolean;
  stats: PipelineStats | null;
  activeView: string;
  onSelectView: (view: string) => void;
  onOpenEnqueue: () => void;
  onForceFlush: () => void;
  onRunRecovery: () => void;
  onSyncEncoding?: () => void;
  onOpenStagingExplorer?: () => void;
  onChangePolicy?: (policy: PipelineExecutionPolicy) => void;
}

const VIEW_LABELS: Record<string, string> = {
  dashboard: "Operations Overview",
  jobs: "Encoding Jobs Queue",
  batches: "GPU Batches & Cluster",
  terminal: "Live Telemetry Console",
};

function formatUptime(seconds?: number): string {
  if (!seconds || seconds <= 0) return "0m";
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  if (hrs > 0) return `${hrs}h ${mins}m`;
  return `${mins}m`;
}

export function Navbar({
  connected,
  stats,
  activeView,
  onSelectView,
  onOpenEnqueue,
  onForceFlush,
  onRunRecovery,
  onSyncEncoding,
  onOpenStagingExplorer,
  onChangePolicy,
}: NavbarProps) {
  const activeSlots = stats?.concurrency?.active ?? 0;
  const maxSlots = stats?.concurrency?.max ?? 2;
  const stagedCount = stats?.storage?.stagedCount ?? 0;
  const encodingCount = stats?.queue?.encoding ?? 0;
  const uptime = formatUptime(stats?.engine?.uptimeSeconds);
  const currentPolicy: PipelineExecutionPolicy = stats?.executionPolicy || "all";

  return (
    <header className="sticky top-0 z-20 h-14 border-b border-[#1e2230] bg-[#090a0f]/90 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between gap-4">
      {/* Zone 1: Contextual Breadcrumb & Live Telemetry Status */}
      <div className="flex items-center gap-3 min-w-0 shrink-0">
        <div className="flex items-center gap-2 text-xs font-medium">
          <button
            type="button"
            onClick={() => onSelectView("dashboard")}
            className="text-[#636b82] hover:text-[#f3f4f8] transition-colors cursor-pointer whitespace-nowrap"
          >
            Kira Pipeline
          </button>
          <span className="text-[#2a3042]" aria-hidden="true">
            /
          </span>
          <span className="text-[#f3f4f8] font-semibold whitespace-nowrap">
            {VIEW_LABELS[activeView] || "Overview"}
          </span>
        </div>

        <span className="hidden sm:inline text-[#2a3042]" aria-hidden="true">
          ·
        </span>

        {/* Real SSE Stream Connection State */}
        <div className="hidden sm:flex items-center gap-1.5 text-xs font-mono tabular-nums">
          {connected ? (
            <>
              <Wifi className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
              <span className="text-emerald-400">Live</span>
            </>
          ) : (
            <>
              <WifiOff className="w-3.5 h-3.5 text-rose-400 shrink-0" />
              <span className="text-rose-400">Reconnecting</span>
            </>
          )}
          <span className="text-[#2a3042] mx-1" aria-hidden="true">
            ·
          </span>
          <span className="text-[#636b82]">Uptime {uptime}</span>
          <span className="hidden xl:inline text-[#2a3042] mx-1" aria-hidden="true">
            ·
          </span>
          <span className="hidden xl:inline text-[#949bb0]">
            GPU {activeSlots}/{maxSlots}
          </span>
        </div>
      </div>

      {/* Zone 2: Operational Actions & Policy Selector */}
      <div className="flex items-center gap-2 shrink-0">
        {/* Global Pipeline Execution Policy Switcher */}
        {onChangePolicy && (
          <div
            className="hidden lg:flex items-center bg-[#0c0e14] p-0.5 rounded-lg border border-[#1e2230] text-[11px] font-mono"
            title="Pipeline Execution Policy: restrict processing to Pipeline 1 (VM H.264) or Pipeline 2 (Kaggle GPU) and mark incompatible anime as skipped"
          >
            <button
              type="button"
              onClick={() => onChangePolicy("all")}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                currentPolicy === "all"
                  ? "bg-indigo-500/25 text-indigo-200 border border-indigo-500/40 font-semibold"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              Both (Auto)
            </button>
            <button
              type="button"
              onClick={() => onChangePolicy("vm_remux_only")}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                currentPolicy === "vm_remux_only"
                  ? "bg-emerald-500/25 text-emerald-200 border border-emerald-500/40 font-semibold"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              Pipeline 1 Only
            </button>
            <button
              type="button"
              onClick={() => onChangePolicy("kaggle_gpu_only")}
              className={`px-2 py-1 rounded-md transition-colors cursor-pointer whitespace-nowrap ${
                currentPolicy === "kaggle_gpu_only"
                  ? "bg-violet-500/25 text-violet-200 border border-violet-500/40 font-semibold"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              Pipeline 2 Only
            </button>
          </div>
        )}

        {onOpenStagingExplorer && (
          <button
            type="button"
            onClick={onOpenStagingExplorer}
            className="btn-secondary hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Inspect local SSD staging directory (.kira-staging) and staged MKV files"
          >
            <HardDrive className="w-3.5 h-3.5 text-sky-400" />
            <span className="hidden xl:inline">Staged Files</span>
          </button>
        )}

        {onSyncEncoding && (
          <button
            type="button"
            onClick={onSyncEncoding}
            className="btn-secondary flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
            title="Live poll Kaggle GPU kernels and immediately reconcile any stuck encoding jobs"
          >
            <Activity className="w-3.5 h-3.5 text-violet-400" />
            <span className="hidden sm:inline">
              Sync Encoding{encodingCount > 0 ? ` (${encodingCount})` : ""}
            </span>
          </button>
        )}

        <button
          type="button"
          onClick={onRunRecovery}
          className="btn-secondary flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
          title="Reconcile stuck jobs, batch heartbeats, and pending webhooks"
        >
          <RotateCw className="w-3.5 h-3.5 text-[#949bb0]" />
          <span className="hidden xl:inline">Reconcile</span>
        </button>

        <button
          type="button"
          onClick={onForceFlush}
          className="btn-secondary flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
          title="Immediately drain VM Remux slots and seal/dispatch staged GPU batches"
        >
          <Layers className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden sm:inline">
            Flush{stagedCount > 0 ? ` (${stagedCount})` : ""}
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenEnqueue}
          className="btn-primary flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Enqueue Episode</span>
        </button>
      </div>
    </header>
  );
}
