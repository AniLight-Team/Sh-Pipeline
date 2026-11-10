import React from "react";
import { RotateCw, Layers, Plus, Wifi, WifiOff } from "lucide-react";
import type { PipelineStats } from "../../backend/engine/types.js";

interface NavbarProps {
  connected: boolean;
  stats: PipelineStats | null;
  activeView: string;
  onSelectView: (view: string) => void;
  onOpenEnqueue: () => void;
  onForceFlush: () => void;
  onRunRecovery: () => void;
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
}: NavbarProps) {
  const activeSlots = stats?.concurrency?.active ?? 0;
  const maxSlots = stats?.concurrency?.max ?? 2;
  const stagedCount = stats?.storage?.stagedCount ?? 0;
  const uptime = formatUptime(stats?.engine?.uptimeSeconds);

  return (
    <header className="sticky top-0 z-20 h-14 border-b border-[#1e2230] bg-[#090a0f]/90 backdrop-blur-md px-4 sm:px-6 flex items-center justify-between gap-8">
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
          <span className="hidden lg:inline text-[#2a3042] mx-1" aria-hidden="true">
            ·
          </span>
          <span className="hidden lg:inline text-[#949bb0]">
            GPU {activeSlots}/{maxSlots} slots
          </span>
        </div>
      </div>

      {/* Zone 2: Operational Actions */}
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={onRunRecovery}
          className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
          title="Reconcile stuck jobs, batch heartbeats, and pending webhooks"
        >
          <RotateCw className="w-3.5 h-3.5 text-[#949bb0]" />
          <span className="hidden sm:inline">Reconcile</span>
        </button>

        <button
          type="button"
          onClick={onForceFlush}
          className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium cursor-pointer whitespace-nowrap shrink-0"
          title="Immediately seal and dispatch staged episodes to Kaggle GPU"
        >
          <Layers className="w-3.5 h-3.5 text-indigo-400" />
          <span className="hidden sm:inline">
            Flush Batch{stagedCount > 0 ? ` (${stagedCount})` : ""}
          </span>
        </button>

        <button
          type="button"
          onClick={onOpenEnqueue}
          className="btn-primary flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-3.5 h-3.5" />
          <span>Enqueue Episode</span>
        </button>
      </div>
    </header>
  );
}
