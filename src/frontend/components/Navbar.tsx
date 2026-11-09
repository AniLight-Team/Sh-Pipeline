import React from "react";
import { Zap, Sparkles, Flame, RotateCw, Plus } from "lucide-react";
import type { PipelineStats } from "../../backend/engine/types.js";

interface NavbarProps {
  connected: boolean;
  stats: PipelineStats | null;
  onOpenEnqueue: () => void;
  onForceFlush: () => void;
  onRunRecovery: () => void;
  sidebarCollapsed: boolean;
}

export function Navbar({
  connected,
  stats,
  onOpenEnqueue,
  onForceFlush,
  onRunRecovery,
  sidebarCollapsed,
}: NavbarProps) {
  const activeSlots = stats?.concurrency?.active ?? 0;
  const maxSlots = stats?.concurrency?.max ?? 2;
  const slotPct = Math.round((activeSlots / maxSlots) * 100);

  return (
    <header className="sticky top-0 z-20 border-b border-white/[0.07] bg-[#12131c]/90 backdrop-blur-xl px-4 sm:px-6 py-3">
      <div className="flex items-center justify-between">
        {/* Left Status Bar */}
        <div className="flex items-center gap-2.5">
          {/* Connection Status Indicator */}
          <div className="flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-[11px] font-mono">
            <span className="relative flex h-2 w-2">
              {connected && (
                <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
              )}
              <span
                className={`relative inline-flex rounded-full h-2 w-2 ${
                  connected ? "bg-emerald-400" : "bg-rose-400"
                }`}
              />
            </span>
            <span className={connected ? "text-neutral-300" : "text-rose-400"}>
              {connected ? "SSE Stream Active" : "Reconnecting..."}
            </span>
          </div>

          {/* 10 Files / 10 GB Limit Chip */}
          <div className="hidden sm:flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/[0.05] border border-white/10 text-[11px] font-mono text-white">
            <Sparkles className="w-3 h-3 text-neutral-300" />
            <span>Dual Trigger: 10 Files or 10 GB</span>
          </div>

          {/* GPU Cluster Capacity Meter */}
          <div className="hidden lg:flex items-center gap-2 px-3 py-1 rounded-full bg-white/[0.04] border border-white/[0.08] text-[11px] font-mono text-neutral-400">
            <Zap className={`w-3 h-3 ${activeSlots > 0 ? "text-white" : "text-neutral-500"}`} />
            <span>GPU Load:</span>
            <span className={`font-semibold ${activeSlots > 0 ? "text-white" : "text-neutral-400"}`}>
              {activeSlots}/{maxSlots} Slots
            </span>
            <span className="text-[10px] text-neutral-500 font-sans">({slotPct}%)</span>
          </div>
        </div>

        {/* Right Actions Bar */}
        <div className="flex items-center gap-2">
          <button
            onClick={onForceFlush}
            className="button-liquid-glass flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-neutral-300 hover:text-white transition-all cursor-pointer"
            title="Immediately package staged episodes into GPU batch"
          >
            <Flame className="w-3.5 h-3.5 text-neutral-300" />
            <span className="hidden sm:inline">Force Flush</span>
          </button>

          <button
            onClick={onRunRecovery}
            className="button-liquid-glass flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold text-neutral-300 hover:text-white transition-all cursor-pointer"
            title="Reconcile pipeline heartbeats and watchdog state"
          >
            <RotateCw className="w-3.5 h-3.5 text-neutral-400" />
            <span className="hidden sm:inline">Reconcile</span>
          </button>

          <button
            onClick={onOpenEnqueue}
            className="button-glow hidden sm:flex items-center gap-1.5 px-4 py-1.5 rounded-full text-xs font-bold shadow-md cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5 text-neutral-950" />
            <span>Enqueue Anime</span>
          </button>
        </div>
      </div>
    </header>
  );
}
