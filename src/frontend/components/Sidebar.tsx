import React from "react";
import {
  LayoutDashboard,
  Layers,
  Boxes,
  Cpu,
  Cloud,
  Terminal,
  ChevronLeft,
  ChevronRight,
  Plus,
  Activity,
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
    (stats?.queue?.queued ?? 0) +
    (stats?.queue?.downloading ?? 0) +
    (stats?.queue?.staged ?? 0) +
    (stats?.queue?.encoding ?? 0);
  const activeBatchCount = stats?.activeBatches?.length ?? 0;
  const stagedCount = stats?.storage?.stagedCount ?? 0;
  const maxBatchItems = stats?.storage?.maxBatchItems ?? 10;

  const navItems = [
    {
      id: "dashboard",
      label: "Overview",
      icon: LayoutDashboard,
      count: null as number | null,
    },
    {
      id: "jobs",
      label: "Encoding Queue",
      icon: Layers,
      count: queuedCount > 0 ? queuedCount : null,
    },
    {
      id: "batches",
      label: "GPU Batches",
      icon: Boxes,
      count: activeBatchCount > 0 ? activeBatchCount : null,
    },
    {
      id: "terminal",
      label: "Live Console",
      icon: Terminal,
      count: null as number | null,
    },
  ];

  return (
    <aside
      aria-label="Primary Sidebar Navigation"
      className={`fixed top-0 left-0 bottom-0 z-30 hidden md:flex flex-col bg-[#0c0e14] border-r border-[#1e2230] transition-all duration-200 select-none ${
        collapsed ? "w-16" : "w-60"
      }`}
    >
      {/* Brand Header */}
      <div
        className={`h-14 border-b border-[#1e2230] flex items-center shrink-0 ${
          collapsed ? "justify-center px-0" : "justify-between px-4"
        }`}
      >
        <div
          onClick={collapsed ? onToggleCollapse : undefined}
          className={`flex items-center gap-2.5 ${collapsed ? "cursor-pointer" : "min-w-0"}`}
          title={collapsed ? "Expand sidebar" : "AniLight Kira Pipeline"}
        >
          <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-indigo-400 font-bold text-sm shrink-0">
            <Activity className="w-4 h-4" />
          </div>

          {!collapsed && (
            <div className="flex items-baseline gap-1.5 min-w-0">
              <span className="text-sm font-bold text-[#f3f4f8] tracking-tight truncate">
                AniLight
              </span>
              <span className="text-xs font-medium text-[#636b82] truncate">
                · Kira Ops
              </span>
            </div>
          )}
        </div>

        {!collapsed && (
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Collapse sidebar"
            className="p-1.5 rounded-md text-[#636b82] hover:text-[#f3f4f8] hover:bg-[#151822] transition-colors cursor-pointer"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
        )}
      </div>

      {collapsed && (
        <div className="flex justify-center pt-2">
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label="Expand sidebar"
            className="w-8 h-8 flex items-center justify-center rounded-md text-[#636b82] hover:text-[#f3f4f8] hover:bg-[#151822] transition-colors cursor-pointer"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* Workspace Navigation */}
      <div className={`flex-1 overflow-y-auto py-4 space-y-6 ${collapsed ? "px-2" : "px-3"}`}>
        <div>
          {!collapsed && (
            <div className="px-2.5 mb-2 text-[11px] font-semibold text-[#636b82]">
              Workspace
            </div>
          )}
          <nav className="space-y-1">
            {navItems.map((item) => {
              const Icon = item.icon;
              const isActive = activeView === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onSelectView(item.id)}
                  title={item.label}
                  className={`w-full flex items-center transition-colors duration-150 cursor-pointer rounded-lg ${
                    collapsed
                      ? "h-10 justify-center px-0"
                      : "justify-between px-2.5 py-2 text-xs font-medium"
                  } ${
                    isActive
                      ? "bg-indigo-500/12 text-white border border-indigo-500/25"
                      : "text-[#949bb0] hover:text-[#f3f4f8] hover:bg-[#151822] border border-transparent"
                  }`}
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <Icon
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? "text-indigo-400" : "text-[#636b82]"
                      }`}
                    />
                    {!collapsed && (
                      <span className="truncate whitespace-nowrap">{item.label}</span>
                    )}
                  </div>
                  {!collapsed && item.count !== null && (
                    <span className="font-mono text-[11px] tabular-nums text-[#949bb0]">
                      {item.count}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </div>

        {/* Infrastructure & Storage */}
        <div>
          {!collapsed && (
            <div className="px-2.5 mb-2 text-[11px] font-semibold text-[#636b82]">
              Infrastructure
            </div>
          )}
          <div className="space-y-1">
            <button
              type="button"
              onClick={onOpenKaggleDetails}
              title="Kaggle GPU Cluster"
              className={`w-full flex items-center transition-colors duration-150 cursor-pointer rounded-lg text-[#949bb0] hover:text-[#f3f4f8] hover:bg-[#151822] ${
                collapsed
                  ? "h-10 justify-center px-0"
                  : "justify-between px-2.5 py-2 text-xs font-medium"
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Cpu className="w-4 h-4 shrink-0 text-[#636b82]" />
                {!collapsed && <span className="truncate whitespace-nowrap">Kaggle Cluster</span>}
              </div>
              {!collapsed && (
                <span className="font-mono text-[11px] tabular-nums text-[#949bb0]">
                  {activeSlots}/{maxSlots}
                </span>
              )}
            </button>

            <button
              type="button"
              onClick={onOpenHfDetails}
              title="Storage & CDN"
              className={`w-full flex items-center transition-colors duration-150 cursor-pointer rounded-lg text-[#949bb0] hover:text-[#f3f4f8] hover:bg-[#151822] ${
                collapsed
                  ? "h-10 justify-center px-0"
                  : "justify-between px-2.5 py-2 text-xs font-medium"
              }`}
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <Cloud className="w-4 h-4 shrink-0 text-[#636b82]" />
                {!collapsed && <span className="truncate whitespace-nowrap">Storage & CDN</span>}
              </div>
              {!collapsed && (
                <span className="font-mono text-[11px] tabular-nums text-[#636b82]">
                  HF · R2
                </span>
              )}
            </button>
          </div>
        </div>

        {/* Real-time Staging Progress Summary (Expanded Only) */}
        {!collapsed && (
          <div className="pt-4 border-t border-[#1e2230] px-2.5 space-y-2.5">
            <div className="flex items-center justify-between text-xs">
              <span className="text-[#949bb0] font-medium">Staging Buffer</span>
              <span className="font-mono text-[11px] tabular-nums text-[#f3f4f8]">
                {stagedCount} / {maxBatchItems} files
              </span>
            </div>
            <div className="w-full h-1.5 bg-[#151822] rounded-full overflow-hidden">
              <div
                className="h-full bg-indigo-500 transition-all duration-300"
                style={{
                  width: `${Math.min(100, Math.round((stagedCount / Math.max(1, maxBatchItems)) * 100))}%`,
                }}
              />
            </div>
            <p className="text-[11px] text-[#636b82] leading-relaxed">
              Batches auto-seal at {maxBatchItems} staged episodes or 10 GB volume.
            </p>
          </div>
        )}
      </div>

      {/* Primary Bottom CTA */}
      <div className="p-3 border-t border-[#1e2230]">
        <button
          type="button"
          onClick={onOpenEnqueue}
          title="Enqueue Episode (⌘K)"
          className={`btn-primary flex items-center justify-center font-semibold text-xs rounded-lg cursor-pointer whitespace-nowrap ${
            collapsed ? "w-10 h-10 p-0 mx-auto" : "w-full py-2 px-3 gap-2"
          }`}
        >
          <Plus className="w-4 h-4 shrink-0" />
          {!collapsed && (
            <>
              <span>Enqueue Episode</span>
              <kbd className="ml-auto text-[10px] font-mono text-indigo-200/80 bg-black/20 px-1.5 py-0.5 rounded">
                ⌘K
              </kbd>
            </>
          )}
        </button>
      </div>
    </aside>
  );
}
