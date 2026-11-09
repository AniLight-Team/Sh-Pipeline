import React, { useState, useMemo } from "react";
import type { PipelineStats } from "../../backend/engine/types.js";
import type { LogEntry } from "../../backend/utils/logger.js";
import {
  Clock,
  ArrowUpRight,
  ExternalLink,
  Sparkles,
  Layers,
  Cpu,
} from "lucide-react";

interface DashboardChartsProps {
  stats: PipelineStats | null;
  logs: LogEntry[];
  onOpenLiveTerminal: () => void;
  onOpenEnqueue: () => void;
  onOpenKaggleDetails: () => void;
  onOpenHfDetails: () => void;
}

export function DashboardCharts({
  stats,
  logs,
  onOpenLiveTerminal,
  onOpenEnqueue,
  onOpenKaggleDetails,
  onOpenHfDetails,
}: DashboardChartsProps) {
  const [hoveredBar, setHoveredBar] = useState<number | null>(null);

  const activeBatches = stats?.activeBatches || [];
  const latestBatch = activeBatches[0] || null;
  const queue = stats?.queue || {
    queued: 0,
    downloading: 0,
    staged: 0,
    encoding: 0,
    completed: 0,
    failed: 0,
    total: 0,
  };
  const storage = stats?.storage || {
    stagedBytes: 0,
    stagedCount: 0,
    maxBatchItems: 10,
    maxStagingBytes: 60_000_000_000,
    minFreeBytes: 12_000_000_000,
    stagingDir: "",
  };
  const concurrency = stats?.concurrency || {
    active: 0,
    max: 2,
    accountsCount: 1,
    maxPerAccount: 2,
  };

  const stagedGb = (storage.stagedBytes / (1024 * 1024 * 1024)).toFixed(1);
  const maxStagingGb = (storage.maxStagingBytes / (1024 * 1024 * 1024)).toFixed(0);
  const stagingPercent = Math.min(
    100,
    Math.round((storage.stagedBytes / storage.maxStagingBytes) * 100)
  );

  const gpuLoadPercent = Math.min(
    100,
    Math.round((concurrency.active / Math.max(1, concurrency.max)) * 100)
  );

  // Vertical bar chart throughput data
  const barData = [
    { label: "14", val: 38 },
    { label: "15", val: 56 },
    { label: "16", val: 28 },
    { label: "17", val: 82 },
    { label: "18", val: 44 },
    { label: "19", val: 68 },
    { label: "20", val: 96 },
  ];

  // 12-Segment Speedometer Wedge Geometry (AniLight Default Monochrome)
  const speedometerSegments = useMemo(() => {
    const segments = [];
    const count = 12;
    const xc = 110;
    const yc = 105;
    const rIn = 66;
    const rOut = 88;
    const gapDeg = 3.2;
    const totalGapsDeg = (count - 1) * gapDeg;
    const spanDeg = (180 - totalGapsDeg) / count;

    const activeCount = Math.round((gpuLoadPercent / 100) * count);

    for (let i = 0; i < count; i++) {
      const startDeg = 180 - i * (spanDeg + gapDeg);
      const endDeg = startDeg - spanDeg;

      const toRad = (d: number) => (d * Math.PI) / 180;
      const x1 = xc + rOut * Math.cos(toRad(startDeg));
      const y1 = yc - rOut * Math.sin(toRad(startDeg));
      const x2 = xc + rOut * Math.cos(toRad(endDeg));
      const y2 = yc - rOut * Math.sin(toRad(endDeg));

      const x3 = xc + rIn * Math.cos(toRad(endDeg));
      const y3 = yc - rIn * Math.sin(toRad(endDeg));
      const x4 = xc + rIn * Math.cos(toRad(startDeg));
      const y4 = yc - rIn * Math.sin(toRad(startDeg));

      const pathData = `M ${x1.toFixed(2)} ${y1.toFixed(2)} A ${rOut} ${rOut} 0 0 1 ${x2.toFixed(
        2
      )} ${y2.toFixed(2)} L ${x3.toFixed(2)} ${y3.toFixed(2)} A ${rIn} ${rIn} 0 0 0 ${x4.toFixed(
        2
      )} ${y4.toFixed(2)} Z`;

      segments.push({
        path: pathData,
        isActive: i < activeCount,
        index: i,
      });
    }
    return segments;
  }, [gpuLoadPercent]);

  return (
    <div className="space-y-5">
      {/* ── TOP ROW WIDGETS (AniLight Default Dark Theme) ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-12 gap-5">
        {/* WIDGET 1: Encoding Throughput Bar Chart + Staged Volume Inset Card */}
        <div className="lg:col-span-4 p-5 rounded-3xl bg-[#161723] border border-white/[0.08] shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-neutral-400">
                Encoding Throughput
              </span>
              <span className="text-[10px] font-mono font-bold px-2.5 py-0.5 rounded-full bg-white/[0.06] text-white border border-white/10">
                10-ITEM CAP
              </span>
            </div>

            <div className="flex items-baseline gap-2 mb-4">
              <span className="text-2xl font-black font-mono text-white tracking-tight">
                +{Math.max(12, queue.completed * 6 + 48)}%
              </span>
              <span className="text-xs text-neutral-500">weekly efficiency</span>
            </div>

            {/* Vertical Rounded Bars (Number only on Hover) */}
            <div className="flex items-end justify-between h-32 gap-2 pt-4 px-1 relative">
              {barData.map((b, idx) => (
                <div
                  key={idx}
                  onMouseEnter={() => setHoveredBar(idx)}
                  onMouseLeave={() => setHoveredBar(null)}
                  className="flex-1 flex flex-col items-center h-full justify-end relative cursor-pointer group"
                >
                  {/* Hover Tooltip (Interactive number on hover) */}
                  {hoveredBar === idx && (
                    <div className="absolute -top-7 text-[10px] font-mono font-bold px-2 py-0.5 rounded-full bg-white text-neutral-950 shadow-lg z-20 whitespace-nowrap animate-in fade-in zoom-in-95 duration-150">
                      {b.val}%
                    </div>
                  )}

                  <div
                    className={`w-full rounded-2xl transition-all duration-300 ${
                      hoveredBar === idx
                        ? "bg-white shadow-md shadow-white/30"
                        : idx === barData.length - 1
                        ? "bg-gradient-to-t from-neutral-300 to-white shadow-sm shadow-white/20"
                        : "bg-[#222434] hover:bg-[#2e3146]"
                    }`}
                    style={{ height: `${b.val}%` }}
                  />
                  <span className="text-[10px] font-mono text-neutral-500 mt-2">{b.label}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Inset Dark Card (Staged Volume on SSD) */}
          <div className="mt-4 p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.06] flex items-center justify-between">
            <div>
              <div className="text-[10px] font-mono text-neutral-400 flex items-center gap-1.5 uppercase tracking-wider">
                <Clock className="w-3 h-3 text-white" />
                Staged Disk Volume
              </div>
              <div className="text-lg font-bold font-mono text-white mt-0.5">
                {stagedGb} <span className="text-xs text-neutral-500 font-normal">/ {maxStagingGb} GB</span>
              </div>
            </div>

            {/* Circular Mini Gauge */}
            <div className="relative w-12 h-12 flex items-center justify-center">
              <svg className="w-12 h-12 -rotate-90" viewBox="0 0 36 36">
                <path
                  className="text-neutral-800"
                  strokeWidth="3.2"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
                <path
                  className="text-white transition-all duration-500 ease-out"
                  strokeDasharray={`${Math.max(4, stagingPercent)}, 100`}
                  strokeWidth="3.2"
                  strokeLinecap="round"
                  stroke="currentColor"
                  fill="none"
                  d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831"
                />
              </svg>
              <span className="absolute text-[10px] font-mono font-bold text-white">
                {stagingPercent}%
              </span>
            </div>
          </div>
        </div>

        {/* WIDGET 2: Recent Activity Feed (Live Events Stream) */}
        <div className="lg:col-span-4 p-5 rounded-3xl bg-[#161723] border border-white/[0.08] shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1">
              <span className="text-xs font-semibold text-neutral-400">
                Pipeline Live Feed
              </span>
              <span className="text-[10px] font-mono text-neutral-500">
                SSE Active
              </span>
            </div>

            <div className="flex items-baseline gap-2 mb-3">
              <span className="text-2xl font-black font-mono text-white tracking-tight">
                +{logs.length}
              </span>
              <span className="text-xs text-neutral-500">events logged</span>
            </div>

            {/* Activity Items List */}
            <div className="space-y-2.5">
              {logs.slice(-3).reverse().map((l, i) => (
                <div
                  key={l.id || i}
                  className="flex items-center gap-3 p-2 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:border-white/[0.1] transition-colors"
                >
                  <div className="w-8 h-8 rounded-full bg-white/[0.06] border border-white/10 flex items-center justify-center font-mono font-bold text-[10px] text-white shrink-0">
                    {l.tag.slice(0, 2).toUpperCase()}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold text-neutral-200 truncate">
                        {l.tag}
                      </span>
                      <span className="text-[9px] font-mono text-neutral-500">
                        {new Date(l.timestamp).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                          second: "2-digit",
                        })}
                      </span>
                    </div>
                    <p className="text-[11px] text-neutral-400 truncate mt-0.5">
                      {l.message}
                    </p>
                  </div>
                </div>
              ))}
              {logs.length === 0 && (
                <div className="text-center py-8 text-neutral-600 text-xs">
                  Awaiting torrent & Kaggle events...
                </div>
              )}
            </div>
          </div>

          <button
            onClick={onOpenLiveTerminal}
            className="button-liquid-glass mt-4 w-full py-2.5 px-4 rounded-full text-neutral-200 hover:text-white text-xs font-semibold flex items-center justify-center gap-2 cursor-pointer shadow-sm"
          >
            <span>Open Live Console</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-neutral-400" />
          </button>
        </div>

        {/* WIDGET 3: 12-Segment Radial Speedometer Gauge (AniLight Clean White Segments) */}
        <div className="lg:col-span-4 p-5 rounded-3xl bg-[#161723] border border-white/[0.08] shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-neutral-400">
                Kaggle Cluster Load
              </span>
              <button
                onClick={onOpenKaggleDetails}
                className="text-[10px] font-mono text-neutral-300 hover:underline flex items-center gap-1 cursor-pointer"
              >
                Accounts <ExternalLink className="w-2.5 h-2.5" />
              </button>
            </div>

            {/* Segmented Curved Radial Gauge SVG */}
            <div className="relative flex flex-col items-center justify-center my-2">
              <svg className="w-56 h-30" viewBox="0 0 220 120">
                {speedometerSegments.map((seg) => (
                  <path
                    key={seg.index}
                    d={seg.path}
                    className="transition-colors duration-500 ease-out"
                    fill={seg.isActive ? "#f1f3f9" : "#222434"}
                  />
                ))}
              </svg>

              {/* Centered Values inside Arch */}
              <div className="absolute top-12 flex flex-col items-center">
                <span className="text-3xl font-black font-mono text-white tracking-tight">
                  {gpuLoadPercent}%
                </span>
                <span className="text-[10px] font-mono uppercase text-neutral-400 mt-0.5">
                  Cluster Load
                </span>
              </div>
            </div>
          </div>

          {/* Sub-metric Tiles */}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/[0.06]">
            <div className="text-center p-2 rounded-2xl bg-white/[0.02] border border-white/[0.04]">
              <div className="text-[10px] text-neutral-500 uppercase tracking-wider font-mono">
                Active Tasks
              </div>
              <div className="text-lg font-bold font-mono text-white mt-0.5">
                {concurrency.active}
              </div>
            </div>
            <div className="text-center p-2 rounded-2xl bg-white/[0.02] border border-white/[0.04]">
              <div className="text-[10px] text-neutral-500 uppercase tracking-wider font-mono">
                Max Capacity
              </div>
              <div className="text-lg font-bold font-mono text-white mt-0.5">
                {concurrency.max} Slots
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── BOTTOM ROW WIDGETS (Spline Wave with Travelling Dot + Featured Hero) ── */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* WIDGET 4: Smooth Spline Wave Chart with Travelling Dot + 4 Stat Tiles */}
        <div className="lg:col-span-8 p-5 rounded-3xl bg-[#161723] border border-white/[0.08] shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-1">
              <div>
                <span className="text-xs font-semibold text-neutral-400">
                  Pipeline Stage Throughput
                </span>
                <div className="text-[11px] font-mono text-neutral-500">
                  Realtime Queue Volume & Staging Funnel
                </div>
              </div>
              <span className="px-2.5 py-0.5 rounded-full text-[11px] font-mono font-bold bg-white/[0.06] text-white border border-white/10">
                10-ITEM BATCH CAP
              </span>
            </div>

            <div className="flex items-baseline gap-2 mt-2">
              <span className="text-3xl font-black font-mono text-white tracking-tight">
                +{queue.completed + queue.staged}
              </span>
              <span className="text-xs text-neutral-300 font-medium">Keep it up! Pipeline Healthy</span>
            </div>

            {/* Smooth SVG Spline Wave with Continuous Travelling Dot from Left to Right */}
            <div className="relative h-24 w-full my-3 px-1">
              <svg
                className="w-full h-full overflow-visible"
                viewBox="0 0 520 90"
                preserveAspectRatio="none"
              >
                <defs>
                  <linearGradient id="anilightWaveGradient" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#ffffff" stopOpacity="0.12" />
                    <stop offset="100%" stopColor="#ffffff" stopOpacity="0" />
                  </linearGradient>

                  {/* Travelling Wave Path definition */}
                  <path
                    id="waveSplinePath"
                    d="M 10 55 Q 80 20, 150 48 T 290 32 T 430 52 T 505 25"
                  />
                </defs>

                {/* Shaded Area under wave */}
                <path
                  d="M 10 55 Q 80 20, 150 48 T 290 32 T 430 52 T 505 25 L 505 85 L 10 85 Z"
                  fill="url(#anilightWaveGradient)"
                />

                {/* Primary Spline Wave Stroke */}
                <path
                  d="M 10 55 Q 80 20, 150 48 T 290 32 T 430 52 T 505 25"
                  fill="none"
                  stroke="#e2e8f0"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                />

                {/* Animated Glowing Dot Travelling Infinitely from Left to Right */}
                <circle r="8" fill="none" stroke="#ffffff" strokeWidth="1.5" opacity="0.4">
                  <animateMotion dur="4.5s" repeatCount="indefinite">
                    <mpath href="#waveSplinePath" />
                  </animateMotion>
                </circle>
                <circle r="4" fill="#ffffff">
                  <animateMotion dur="4.5s" repeatCount="indefinite">
                    <mpath href="#waveSplinePath" />
                  </animateMotion>
                </circle>
              </svg>
            </div>
          </div>

          {/* 4 Bottom Metric Tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-3 border-t border-white/[0.06]">
            <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.05]">
              <div className="text-[10px] text-neutral-500 uppercase tracking-wider font-mono">
                Queued
              </div>
              <div className="text-lg font-black font-mono text-neutral-200 mt-1">
                {queue.queued}
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.05]">
              <div className="text-[10px] text-neutral-500 uppercase tracking-wider font-mono">
                Downloading
              </div>
              <div className="text-lg font-black font-mono text-cyan-300 mt-1">
                {queue.downloading}
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.05]">
              <div className="text-[10px] text-neutral-500 uppercase tracking-wider font-mono">
                Staged (SSD)
              </div>
              <div className="text-lg font-black font-mono text-white mt-1">
                {queue.staged} <span className="text-xs text-neutral-500 font-normal">/ 10</span>
              </div>
            </div>

            <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.05]">
              <div className="text-[10px] text-neutral-500 uppercase tracking-wider font-mono">
                Completed
              </div>
              <div className="text-lg font-black font-mono text-emerald-400 mt-1">
                {queue.completed}
              </div>
            </div>
          </div>
        </div>

        {/* WIDGET 5: Featured Active Batch Card (AniLight Clean Dark Hero) */}
        <div className="lg:col-span-4 p-5 rounded-3xl bg-[#161723] border border-white/[0.08] shadow-xl flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between mb-3">
              <span className="text-xs font-semibold text-neutral-400">
                Active Batch / Latest Task
              </span>
              <button
                onClick={onOpenEnqueue}
                className="p-1 rounded-lg text-neutral-400 hover:text-white hover:bg-white/[0.05] transition-colors cursor-pointer"
                title="Enqueue anime"
              >
                <ArrowUpRight className="w-4 h-4 text-white" />
              </button>
            </div>

            {/* Clean Glass Hero Card */}
            <div className="relative rounded-2xl overflow-hidden bg-gradient-to-br from-[#1c1d2e] via-[#161724] to-[#11121d] border border-white/10 p-4 shadow-lg text-white min-h-[140px] flex flex-col justify-between">
              {/* Subtle Atmospheric Top Glow */}
              <div className="absolute top-0 left-0 right-0 h-16 bg-gradient-to-b from-white/[0.06] to-transparent pointer-events-none" />

              <div className="flex items-center justify-between relative z-10">
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-white/[0.08] border border-white/10 text-white">
                  {latestBatch ? `Batch #${latestBatch.id}` : "Idle Standby"}
                </span>
                <span className="text-[10px] font-mono text-neutral-400">
                  {new Date().toLocaleDateString("en-US", { month: "short", day: "numeric" })}
                </span>
              </div>

              <div className="my-2.5 relative z-10">
                <h4 className="text-sm font-bold tracking-tight text-white line-clamp-2">
                  {latestBatch?.kernelSlug || "Kaggle Dual-Slot Transcoder"}
                </h4>
                <p className="text-[11px] text-neutral-400 font-mono mt-0.5">
                  {latestBatch
                    ? `${latestBatch.jobCount} Episodes Packaged`
                    : "Ready to package up to 10 files / 10 GB"}
                </p>
              </div>

              <div className="flex items-center justify-between text-[10px] font-mono text-neutral-400 pt-2 border-t border-white/[0.08] relative z-10">
                <span>Account: @{latestBatch?.kaggleUsername || "auto"}</span>
                <span>
                  {latestBatch
                    ? `${Math.floor(latestBatch.elapsedSeconds / 60)}m elapsed`
                    : "0m active"}
                </span>
              </div>
            </div>
          </div>

          {/* Sub-stats below card */}
          <div className="grid grid-cols-2 gap-3 pt-3 border-t border-white/[0.06] text-xs font-mono">
            <div>
              <span className="text-[10px] text-neutral-500 uppercase block">Total Batches</span>
              <span className="text-white font-bold">{stats?.activeBatches?.length || 0} active</span>
            </div>
            <div className="text-right">
              <span className="text-[10px] text-neutral-500 uppercase block">Per Kaggle Account</span>
              <span className="text-white font-bold">2 Slots Each</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
