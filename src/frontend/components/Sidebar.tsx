import React from "react";
import {
  LayoutDashboard,
  Layers,
  Cpu,
  Cloud,
  Terminal,
  ChevronLeft,
  ChevronRight,
  Plus,
  Sparkles,
  Zap,
} from "lucide-react";
import type { PipelineStats } from "../../backend/engine/types.js";

interface SidebarProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  activeView: string;
  onSelectView: (view: string) => void;
  stats: PipelineStats | null;
  onOpenEnqueue: () => void;
  onOpenKaggleDetails: () => void;
  onOpenHfDetails: () => void;
}

export function Sidebar({
  collapsed,
  onToggleCollapse,
  activeView,
  onSelectView,
  stats,
  onOpenEnqueue,
  onOpenKaggleDetails,
  onOpenHfDetails,
}: SidebarProps) {
  const activeSlots = stats?.concurrency?.active ?? 0;
  const maxSlots = stats?.concurrency?.max ?? 2;
  const queuedCount =
    (stats?.queue?.queued ?? 0) + (stats?.queue?.downloading ?? 0) + (stats?.queue?.staged ?? 0);

  return (
    <aside
      className={`fixed top-0 left-0 bottom-0 z-30 hidden md:flex flex-col bg-[#12131c] border-r border-white/[0.08] transition-all duration-300 ease-in-out select-none ${
        collapsed ? "w-16" : "w-64"
      }`}
    >
      {/* ── Brand Header (Clean Stylized "A" and "AniLight Pipeline") ── */}
      <div
        className={`h-16 border-b border-white/[0.07] flex items-center shrink-0 ${
          collapsed ? "justify-center px-0" : "justify-between px-4"
        }`}
      >
        <div
          onClick={collapsed ? onToggleCollapse : undefined}
          className={`flex items-center gap-3 ${collapsed ? "cursor-pointer" : "min-w-0"}`}
          title={collapsed ? "Click to expand AniLight Pipeline" : "AniLight Pipeline"}
        >
          {/* Stylized A Icon Badge - Dead Centered in Collapsed Mode */}
          <div className="w-9 h-9 rounded-xl bg-gradient-to-b from-white/20 via-white/10 to-transparent border border-white/15 flex items-center justify-center text-white font-black text-base shadow-sm shrink-0 transition-transform duration-200 hover:scale-105">
            <span className="text-gradient">A</span>
          </div>

          {/* When expanded: "AniLight" with subscript "Pipeline" */}
          {!collapsed && (
            <div className="flex items-baseline gap-1.5 leading-none min-w-0">
              <span className="text-[15px] font-extrabold text-white tracking-tight truncate">
                AniLight
              </span>
              <span className="text-[9px] font-mono font-bold uppercase tracking-wider text-neutral-300 bg-white/[0.08] px-1.5 py-0.5 rounded border border-white/10 align-sub shrink-0">
                Pipeline
              </span>
            </div>
          )}
        </div>

        {/* Toggle Collapse Button (Shown when expanded) */}
        {!collapsed && (
          <button
            onClick={onToggleCollapse}
            className="p-1.5 rounded-lg text-neutral-400 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="Collapse sidebar"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* When collapsed: Centered toggle arrow */}
      {collapsed && (
        <div className="flex justify-center pt-2">
          <button
            onClick={onToggleCollapse}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-neutral-500 hover:text-white hover:bg-white/[0.06] transition-colors cursor-pointer"
            title="Expand sidebar"
          >
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {/* ── Navigation Links (Uniform, Perfectly Centered Icons When Collapsed) ── */}
      <div className={`flex-1 overflow-y-auto py-3 space-y-4 ${collapsed ? "px-0" : "px-2"}`}>
        <div>
          {!collapsed && (
            <div className="px-3 mb-2 text-[10px] font-mono uppercase tracking-widest text-neutral-500">
              EXPLORE
            </div>
          )}
          <nav className="space-y-1.5 flex flex-col items-center w-full">
            {/* Dashboard Link */}
            <button
              onClick={() => onSelectView("dashboard")}
              className={`transition-all duration-200 cursor-pointer flex items-center ${
                collapsed
                  ? `w-10 h-10 justify-center rounded-xl mx-auto p-0 ${
                      activeView === "dashboard"
                        ? "bg-white/[0.12] text-white border border-white/15 shadow-sm"
                        : "text-neutral-400 hover:text-white hover:bg-white/[0.05]"
                    }`
                  : `w-full gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold ${
                      activeView === "dashboard"
                        ? "bg-white/[0.1] text-white border border-white/15 shadow-sm"
                        : "text-neutral-400 hover:text-white hover:bg-white/[0.04]"
                    }`
              }`}
              title="Dashboard"
            >
              <LayoutDashboard
                className={`w-4 h-4 shrink-0 ${
                  activeView === "dashboard" ? "text-white" : "text-neutral-400"
                }`}
              />
              {!collapsed && <span>Dashboard</span>}
            </button>

            {/* Jobs Queue Link */}
            <button
              onClick={() => onSelectView("jobs")}
              className={`transition-all duration-200 cursor-pointer flex items-center ${
                collapsed
                  ? `w-10 h-10 justify-center rounded-xl mx-auto p-0 relative ${
                      activeView === "jobs"
                        ? "bg-white/[0.12] text-white border border-white/15 shadow-sm"
                        : "text-neutral-400 hover:text-white hover:bg-white/[0.05]"
                    }`
                  : `w-full justify-between px-3 py-2.5 rounded-xl text-xs font-semibold ${
                      activeView === "jobs"
                        ? "bg-white/[0.1] text-white border border-white/15 shadow-sm"
                        : "text-neutral-400 hover:text-white hover:bg-white/[0.04]"
                    }`
              }`}
              title="Jobs Queue"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Layers
                  className={`w-4 h-4 shrink-0 ${
                    activeView === "jobs" ? "text-white" : "text-neutral-400"
                  }`}
                />
                {!collapsed && <span className="truncate">Jobs Queue</span>}
              </div>
              {!collapsed && queuedCount > 0 && (
                <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold bg-white/[0.08] text-neutral-300 border border-white/[0.06]">
                  {queuedCount}
                </span>
              )}
              {collapsed && queuedCount > 0 && (
                <span className="absolute top-1 right-1 w-2 h-2 rounded-full bg-cyan-400" />
              )}
            </button>

            {/* Kaggle Accounts (Detailed Modal Trigger) */}
            <button
              onClick={onOpenKaggleDetails}
              className={`transition-all duration-200 cursor-pointer flex items-center group ${
                collapsed
                  ? "w-10 h-10 justify-center rounded-xl mx-auto p-0 text-neutral-400 hover:text-white hover:bg-white/[0.05]"
                  : "w-full justify-between px-3 py-2.5 rounded-xl text-xs font-semibold text-neutral-400 hover:text-white hover:bg-white/[0.04]"
              }`}
              title="Kaggle GPU Cluster"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Cpu className="w-4 h-4 shrink-0 text-purple-400 group-hover:text-purple-300" />
                {!collapsed && <span className="truncate">Kaggle GPU</span>}
              </div>
              {!collapsed && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-purple-500/10 text-purple-300 border border-purple-500/20">
                  {activeSlots}/{maxSlots}
                </span>
              )}
            </button>

            {/* Hugging Face Accounts (Detailed Modal Trigger) */}
            <button
              onClick={onOpenHfDetails}
              className={`transition-all duration-200 cursor-pointer flex items-center group ${
                collapsed
                  ? "w-10 h-10 justify-center rounded-xl mx-auto p-0 text-neutral-400 hover:text-white hover:bg-white/[0.05]"
                  : "w-full justify-between px-3 py-2.5 rounded-xl text-xs font-semibold text-neutral-400 hover:text-white hover:bg-white/[0.04]"
              }`}
              title="Hugging Face Storage"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Cloud className="w-4 h-4 shrink-0 text-sky-400 group-hover:text-sky-300" />
                {!collapsed && <span className="truncate">Hugging Face</span>}
              </div>
              {!collapsed && (
                <span className="px-1.5 py-0.5 rounded text-[10px] font-mono bg-sky-500/10 text-sky-300 border border-sky-500/20">
                  Streams
                </span>
              )}
            </button>

            {/* Live Terminal Console Link */}
            <button
              onClick={() => onSelectView("terminal")}
              className={`transition-all duration-200 cursor-pointer flex items-center ${
                collapsed
                  ? `w-10 h-10 justify-center rounded-xl mx-auto p-0 ${
                      activeView === "terminal"
                        ? "bg-white/[0.12] text-white border border-white/15 shadow-sm"
                        : "text-neutral-400 hover:text-white hover:bg-white/[0.05]"
                    }`
                  : `w-full gap-3 px-3 py-2.5 rounded-xl text-xs font-semibold ${
                      activeView === "terminal"
                        ? "bg-white/[0.1] text-white border border-white/15 shadow-sm"
                        : "text-neutral-400 hover:text-white hover:bg-white/[0.04]"
                    }`
              }`}
              title="Live Terminal"
            >
              <Terminal
                className={`w-4 h-4 shrink-0 ${
                  activeView === "terminal" ? "text-emerald-400" : "text-neutral-400"
                }`}
              />
              {!collapsed && (
                <div className="flex items-center justify-between flex-1">
                  <span>Live Console</span>
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                </div>
              )}
            </button>
          </nav>
        </div>

        {/* Dynamic Capacity Card (Shown when expanded) */}
        {!collapsed && (
          <div className="p-3 rounded-2xl bg-[#161723] border border-white/[0.06] space-y-2 mx-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] font-mono text-neutral-400 uppercase tracking-wider flex items-center gap-1.5">
                <Sparkles className="w-3 h-3 text-neutral-300" />
                Batch Limits
              </span>
              <span className="text-[10px] font-mono font-bold text-white">10 Cap</span>
            </div>
            <div className="text-[11px] text-neutral-400 leading-snug">
              Auto-flushes at <strong className="text-white font-mono">10 files</strong> or{" "}
              <strong className="text-white font-mono">10 GB</strong> limit.
            </div>
            <div className="flex items-center justify-between text-[10px] font-mono text-neutral-500 pt-1 border-t border-white/[0.05]">
              <span>Kaggle Dual-Slot:</span>
              <span className="text-neutral-200 font-bold">{maxSlots} Max Tasks</span>
            </div>
          </div>
        )}
      </div>

      {/* ── Bottom Enqueue Action ─────────────────────────────────── */}
      <div className={`p-3 border-t border-white/[0.07] ${collapsed ? "flex justify-center" : ""}`}>
        <button
          onClick={onOpenEnqueue}
          className={`button-glow flex items-center justify-center font-bold text-xs shadow-md transition-all cursor-pointer ${
            collapsed ? "w-10 h-10 rounded-xl p-0 mx-auto" : "w-full py-2.5 px-4 rounded-full gap-2"
          }`}
          title="Enqueue Anime"
        >
          <Plus className="w-4 h-4 text-neutral-950" />
          {!collapsed && <span>Enqueue Anime</span>}
        </button>
      </div>
    </aside>
  );
}
