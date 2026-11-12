import React from "react";
import type { PipelineStats, PipelineExecutionPolicy } from "../../backend/engine/types.js";
import type { LogEntry } from "../../backend/utils/logger.js";
import {
  ArrowUpRight,
  Cpu,
  HardDrive,
  Layers,
  Terminal,
  CheckCircle2,
  Clock,
  Plus,
  ArrowRight,
  FolderOpen,
  RefreshCw,
  Sliders,
} from "lucide-react";

interface DashboardChartsProps {
  stats: PipelineStats | null;
  logs: LogEntry[];
  onOpenLiveTerminal: () => void;
  onOpenEnqueue: () => void;
  onOpenKaggleDetails: () => void;
  onOpenHfDetails: () => void;
  onOpenStagingExplorer?: () => void;
  onForceFlush?: () => void;
  onSyncEncoding?: () => void;
  onChangePolicy?: (policy: PipelineExecutionPolicy) => void;
  onRequeueSkipped?: () => void;
  onSelectStatusFilter?: (status: string) => void;
}

export function DashboardCharts({
  stats,
  logs,
  onOpenLiveTerminal,
  onOpenEnqueue,
  onOpenKaggleDetails,
  onOpenHfDetails,
  onOpenStagingExplorer,
  onForceFlush,
  onSyncEncoding,
  onChangePolicy,
  onRequeueSkipped,
  onSelectStatusFilter,
}: DashboardChartsProps) {
  const activeBatches = stats?.activeBatches || [];
  const latestBatch = activeBatches[0] || null;
  const currentPolicy: PipelineExecutionPolicy = stats?.executionPolicy || "all";
  const queue = stats?.queue || {
    queued: 0,
    downloading: 0,
    staged: 0,
    stagedRemux: 0,
    stagedGpu: 0,
    encoding: 0,
    completed: 0,
    failed: 0,
    skipped: 0,
    paused: 0,
    total: 0,
  };
  const storage = stats?.storage || {
    stagedBytes: 0,
    stagedCount: 0,
    maxBatchItems: 10,
    maxStagingBytes: 56 * 1024 * 1024 * 1024,
    minFreeBytes: 12_000_000_000,
    stagingDir: "/srv/torrents/complete/.kira-staging",
    isAtCapacity: false,
  };
  const concurrency = stats?.concurrency || {
    active: 0,
    max: 2,
    accountsCount: 1,
    maxPerAccount: 2,
    vmActive: 0,
    vmMax: 2,
  };

  const stagedGb = (storage.stagedBytes / (1024 * 1024 * 1024)).toFixed(2);
  const maxStagingGb = Math.round(storage.maxStagingBytes / (1024 * 1024 * 1024));
  const stagingPercent = Math.min(
    100,
    Math.round((storage.stagedBytes / Math.max(1, storage.maxStagingBytes)) * 100),
  );

  const batchSafeMaxBytes = 10 * 1024 * 1024 * 1024;
  const batchCountPct = Math.min(
    100,
    Math.round((storage.stagedCount / Math.max(1, storage.maxBatchItems)) * 100),
  );
  const batchBytesPct = Math.min(
    100,
    Math.round((storage.stagedBytes / batchSafeMaxBytes) * 100),
  );

  const gpuLoadPercent = Math.min(
    100,
    Math.round((concurrency.active / Math.max(1, concurrency.max)) * 100),
  );

  const inFlightCount = queue.queued + queue.downloading + queue.staged + queue.encoding;
  const completionRate =
    queue.total > 0 ? Math.round((queue.completed / queue.total) * 100) : 0;

  const stageRows = [
    {
      key: "queued",
      label: "Queued for Discovery",
      sublabel: "Tsukihime & AnimeTosho H.264-priority resolution",
      count: queue.queued,
      barColor: "bg-amber-400",
      textColor: "text-amber-300",
    },
    {
      key: "downloading",
      label: "Downloading via Transmission",
      sublabel: "Same-group 1080p/720p/480p · 56 GB hard cap enforced",
      count: queue.downloading,
      barColor: "bg-sky-400",
      textColor: "text-sky-300",
    },
    {
      key: "staged",
      label: "Staged on Local SSD",
      sublabel: `${storage.stagingDir} · ${queue.stagedRemux ?? 0} VM Remux / ${queue.stagedGpu ?? 0} GPU`,
      count: queue.staged,
      barColor: "bg-indigo-400",
      textColor: "text-indigo-300",
    },
    {
      key: "encoding",
      label: "VM Direct Remux / Kaggle GPU",
      sublabel: "H.264 direct MP4 remux (-c:v copy, 2 slots) · HEVC/AV1 GPU encode",
      count: queue.encoding,
      barColor: "bg-violet-400",
      textColor: "text-violet-300",
    },
    {
      key: "completed",
      label: "Completed & Published",
      sublabel: "Uploaded to Hugging Face CDN + webhook delivered",
      count: queue.completed,
      barColor: "bg-emerald-400",
      textColor: "text-emerald-300",
    },
    {
      key: "skipped",
      label: "Skipped by Pipeline Policy",
      sublabel:
        currentPolicy === "vm_remux_only"
          ? "Pipeline 1 Only active — non-H.264 (HEVC/AV1) anime skipped"
          : currentPolicy === "kaggle_gpu_only"
            ? "Pipeline 2 Only active — H.264 anime skipped"
            : "Skipped due to active pipeline execution filter",
      count: queue.skipped ?? 0,
      barColor: "bg-slate-400",
      textColor: "text-slate-300",
    },
    {
      key: "failed",
      label: "Failed / Retry Eligible",
      sublabel: "Exhausted candidate fallback or kernel error",
      count: queue.failed,
      barColor: "bg-rose-400",
      textColor: "text-rose-300",
    },
  ];

  const pipelineFlowSteps = [
    {
      index: "01",
      title: "Torrent Discovery",
      detail: "Tsukihime + AnimeTosho · H.264 priority",
      metric: `${queue.queued} queued · ${queue.skipped ?? 0} skipped`,
      filterKey: "queued",
    },
    {
      index: "02",
      title: "Same-Group Download",
      detail: "1080p + 720p + 480p · 56 GB hard cap",
      metric: `${queue.downloading} active`,
      filterKey: "downloading",
    },
    {
      index: "03",
      title: "1080p R2 Subtitles & SSD",
      detail: `Staged in ${storage.stagingDir}`,
      metric: `${queue.staged} staged (${stagedGb} GB)`,
      filterKey: "staged",
    },
    {
      index: "04",
      title: "VM Remux / Kaggle GPU",
      detail: "H.264 -> VM 2-slot · HEVC -> GPU",
      metric: `VM ${concurrency.vmActive || 0}/${concurrency.vmMax || 2} · GPU ${concurrency.active}/${concurrency.max}`,
      filterKey: "encoding",
    },
    {
      index: "05",
      title: "HF Bucket & Callback",
      detail: "Batch upload MP4s + Main DB webhook",
      metric: `${queue.completed} published`,
      filterKey: "completed",
    },
  ];

  const recentLogs = logs.slice(-5).reverse();

  return (
    <div className="space-y-6">
      {/* 0. Pipeline Execution Mode & Staged SSD Control Banner */}
      <div className="surface-panel rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="flex items-start sm:items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center shrink-0">
            <Sliders className="w-4 h-4 text-indigo-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="text-xs font-semibold text-[#f3f4f8]">
                Pipeline Execution Trigger Policy
              </h2>
              <span className="text-[11px] font-mono px-2 py-0.5 rounded bg-[#151822] border border-[#232838] text-indigo-300">
                {currentPolicy === "vm_remux_only"
                  ? "Pipeline 1 Only (Skip HEVC/AV1)"
                  : currentPolicy === "kaggle_gpu_only"
                    ? "Pipeline 2 Only (Skip H.264)"
                    : "Both Pipelines (Auto Waterfall)"}
              </span>
            </div>
            <p className="text-[11px] text-[#636b82] mt-0.5">
              {currentPolicy === "vm_remux_only"
                ? "Strictly runs Pipeline 1 (8-bit H.264 VM Direct Remux, 2 at a time). Non-compatible HEVC/AV1 anime episodes are automatically marked as Skipped."
                : currentPolicy === "kaggle_gpu_only"
                  ? "Strictly runs Pipeline 2 (Kaggle Dual-T4 GPU NVENC). Pipeline 1 (H.264) anime episodes are automatically marked as Skipped."
                  : "Runs Pipeline 1 (VM Direct Remux, 2 slots) for H.264 releases and falls back to Pipeline 2 (Kaggle GPU) only when HEVC/AV1 is required."}
            </p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center bg-[#0c0e14] p-1 rounded-lg border border-[#1e2230] text-xs font-mono">
            <button
              type="button"
              onClick={() => onChangePolicy?.("all")}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                currentPolicy === "all"
                  ? "bg-indigo-500/25 text-indigo-200 border border-indigo-500/40 font-semibold"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              Both Pipelines
            </button>
            <button
              type="button"
              onClick={() => onChangePolicy?.("vm_remux_only")}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                currentPolicy === "vm_remux_only"
                  ? "bg-emerald-500/25 text-emerald-200 border border-emerald-500/40 font-semibold"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              Pipeline 1 Only (VM)
            </button>
            <button
              type="button"
              onClick={() => onChangePolicy?.("kaggle_gpu_only")}
              className={`px-2.5 py-1 rounded-md transition-colors cursor-pointer ${
                currentPolicy === "kaggle_gpu_only"
                  ? "bg-violet-500/25 text-violet-200 border border-violet-500/40 font-semibold"
                  : "text-[#949bb0] hover:text-white"
              }`}
            >
              Pipeline 2 Only (GPU)
            </button>
          </div>

          {(queue.skipped ?? 0) > 0 && onRequeueSkipped && (
            <button
              type="button"
              onClick={onRequeueSkipped}
              className="btn-secondary px-2.5 py-1.5 rounded-lg text-xs font-mono text-amber-300 hover:text-white inline-flex items-center gap-1.5 cursor-pointer"
              title="Re-queue all skipped jobs for discovery under the current policy"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              <span>Re-queue Skipped ({queue.skipped})</span>
            </button>
          )}
        </div>
      </div>

      {/* 1. Top 4-Column Real Telemetry KPI Strip */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {/* KPI 1: Pipeline Queue Overview */}
        <div className="surface-panel rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-[#949bb0]">
              <span className="font-medium">Total Pipeline Jobs</span>
              <Layers className="w-4 h-4 text-[#636b82]" />
            </div>
            <div className="mt-2 flex items-baseline gap-2.5">
              <span className="text-2xl font-bold font-mono tabular-nums text-[#f3f4f8]">
                {queue.total}
              </span>
              <span className="text-xs font-mono tabular-nums text-[#949bb0]">
                {inFlightCount} active · {completionRate}% done
              </span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-[#1e2230] flex items-center justify-between text-xs text-[#636b82] font-mono tabular-nums">
            <span>Done: {queue.completed}</span>
            <span>Skipped: {queue.skipped ?? 0}</span>
            <span className={queue.failed > 0 ? "text-rose-400" : "text-[#636b82]"}>
              Failed: {queue.failed}
            </span>
          </div>
        </div>

        {/* KPI 2: Local SSD Staging Buffer (56 GB Guardrail + Exact Path) */}
        <div className="surface-panel rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-[#949bb0]">
              <span className="font-medium">SSD Staging Buffer</span>
              {onOpenStagingExplorer ? (
                <button
                  type="button"
                  onClick={onOpenStagingExplorer}
                  className="text-xs text-sky-400 hover:text-sky-300 inline-flex items-center gap-1 cursor-pointer font-mono"
                >
                  <FolderOpen className="w-3.5 h-3.5" />
                  <span>Inspect Files</span>
                </button>
              ) : (
                <HardDrive className="w-4 h-4 text-[#636b82]" />
              )}
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold font-mono tabular-nums text-[#f3f4f8]">
                {stagedGb} GB
              </span>
              <span className="text-xs font-mono tabular-nums text-[#636b82]">
                / {maxStagingGb} GB hard cap
              </span>
            </div>
            <div className="mt-2 text-[11px] font-mono text-[#949bb0] truncate" title={storage.stagingDir}>
              Path: <span className="text-emerald-300">{storage.stagingDir}</span>
            </div>
          </div>
          <div className="mt-3 pt-2.5 border-t border-[#1e2230] flex items-center justify-between text-xs font-mono tabular-nums">
            <span className={storage.isAtCapacity ? "text-amber-400" : "text-[#949bb0]"}>
              {storage.isAtCapacity
                ? "56 GB limit active (paused)"
                : `${storage.stagedCount} jobs staged`}
            </span>
            <span className="text-[#636b82]">{stagingPercent}% cap</span>
          </div>
        </div>

        {/* KPI 3: Kaggle GPU & VM Remux Cluster Load */}
        <div className="surface-panel rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-[#949bb0]">
              <span className="font-medium">Compute & Remux Pool</span>
              <button
                type="button"
                onClick={onOpenKaggleDetails}
                className="text-xs text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1 cursor-pointer"
              >
                <span>{concurrency.accountsCount} accts</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="mt-2 flex items-baseline gap-2.5">
              <span className="text-2xl font-bold font-mono tabular-nums text-[#f3f4f8]">
                {concurrency.active} / {concurrency.max}
              </span>
              <span className="text-xs font-mono tabular-nums text-[#949bb0]">
                GPU · VM {concurrency.vmActive || 0}/{concurrency.vmMax || 2}
              </span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-[#1e2230] flex items-center justify-between gap-3 text-xs font-mono tabular-nums text-[#636b82]">
            <span className="truncate">VM 2-Slot + T4 NVENC ({gpuLoadPercent}%)</span>
            {onSyncEncoding ? (
              <button
                type="button"
                onClick={onSyncEncoding}
                className="text-violet-400 hover:text-violet-300 transition-colors cursor-pointer shrink-0 font-semibold"
              >
                Verify Live →
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenHfDetails}
                className="text-[#949bb0] hover:text-white transition-colors cursor-pointer shrink-0"
              >
                Storage & CDN →
              </button>
            )}
          </div>
        </div>

        {/* KPI 4: Auto-Batch Packaging Trigger */}
        <div className="surface-panel rounded-xl p-4 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between text-xs text-[#949bb0]">
              <span className="font-medium">Next Batch Seal</span>
              <Cpu className="w-4 h-4 text-[#636b82]" />
            </div>
            <div className="mt-2 flex items-baseline gap-2">
              <span className="text-2xl font-bold font-mono tabular-nums text-[#f3f4f8]">
                {storage.stagedCount} / {storage.maxBatchItems}
              </span>
              <span className="text-xs font-mono tabular-nums text-[#949bb0]">
                episodes staged
              </span>
            </div>
          </div>
          <div className="mt-4 pt-3 border-t border-[#1e2230] flex items-center justify-between gap-3 text-xs">
            <span className="text-[#636b82] font-mono tabular-nums truncate">
              {queue.stagedRemux ?? 0} H.264 VM · {queue.stagedGpu ?? 0} HEVC GPU
            </span>
            {storage.stagedCount > 0 && onForceFlush ? (
              <button
                type="button"
                onClick={onForceFlush}
                className="text-indigo-400 hover:text-indigo-300 font-semibold cursor-pointer shrink-0"
              >
                Flush Now →
              </button>
            ) : (
              <button
                type="button"
                onClick={onOpenEnqueue}
                className="text-indigo-400 hover:text-indigo-300 font-semibold cursor-pointer shrink-0"
              >
                Enqueue +
              </button>
            )}
          </div>
        </div>
      </div>

      {/* 2. Interactive End-to-End Pipeline Architecture Flow Bar */}
      <div className="surface-panel rounded-xl p-4">
        <div className="flex flex-wrap items-center justify-between gap-2 pb-3 mb-3 border-b border-[#1e2230]">
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-semibold text-[#f3f4f8]">
              Autonomous Pipeline Execution Flow
            </h2>
            <span className="text-xs text-[#636b82]">
              · Minimal Re-Encoding Architecture (H.264 Same-Group Direct Remux + HEVC/AV1 GPU Fallback)
            </span>
          </div>
          <span className="text-[11px] font-mono tabular-nums text-[#949bb0]">
            Click any stage to filter queue
          </span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
          {pipelineFlowSteps.map((step, idx) => (
            <button
              key={step.index}
              type="button"
              onClick={() => onSelectStatusFilter?.(step.filterKey)}
              className="text-left p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230] hover:border-indigo-500/50 transition-colors cursor-pointer flex flex-col justify-between group"
            >
              <div>
                <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-[#636b82]">
                  <span className="text-indigo-400 font-semibold">{step.index}. Stage</span>
                  {idx < pipelineFlowSteps.length - 1 && (
                    <ArrowRight className="w-3 h-3 text-[#636b82] group-hover:text-indigo-400 transition-colors hidden lg:inline" />
                  )}
                </div>
                <div className="text-xs font-semibold text-[#f3f4f8] mt-1 truncate">
                  {step.title}
                </div>
                <div className="text-[11px] text-[#636b82] mt-0.5 truncate">
                  {step.detail}
                </div>
              </div>
              <div className="mt-2.5 pt-2 border-t border-[#1e2230] text-[11px] font-mono tabular-nums text-[#d5d9e6]">
                {step.metric}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* 3. Main Operational Split: Pipeline Stage Funnel (7 cols) + Live Activity & Batch Status (5 cols) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-stretch">
        {/* Left Column: Real 6-Stage Pipeline Distribution & Batch Packaging Thresholds */}
        <div className="lg:col-span-7 surface-panel rounded-xl p-5 flex flex-col justify-between">
          <div>
            <div className="flex items-center justify-between gap-4 pb-4 border-b border-[#1e2230]">
              <div>
                <h2 className="text-sm font-semibold text-[#f3f4f8]">
                  Pipeline Stage Distribution
                </h2>
                <p className="text-xs text-[#636b82] mt-0.5">
                  Real-time job allocation across torrent discovery, 56 GB SSD staging, VM Direct Remux, and Kaggle GPU
                </p>
              </div>
              <span className="font-mono text-xs tabular-nums text-[#949bb0] shrink-0">
                {queue.total} total {queue.total === 1 ? "job" : "jobs"}
              </span>
            </div>

            {/* Proportional Multi-Segment Bar */}
            <div className="mt-4">
              <div className="h-2.5 w-full rounded-md bg-[#151822] overflow-hidden flex gap-0.5">
                {queue.total > 0 ? (
                  stageRows.map((st) => {
                    if (st.count <= 0) return null;
                    const widthPct = Math.max(3, (st.count / queue.total) * 100);
                    return (
                      <div
                        key={st.key}
                        style={{ width: `${widthPct}%` }}
                        className={`${st.barColor} h-full transition-all duration-300`}
                        title={`${st.label}: ${st.count}`}
                      />
                    );
                  })
                ) : (
                  <div className="w-full h-full bg-[#1a1e2b]" />
                )}
              </div>
            </div>

            {/* Stage Breakdown Rows */}
            <div className="mt-4 divide-y divide-[#1e2230]">
              {stageRows.map((row) => {
                const pct =
                  queue.total > 0 ? Math.round((row.count / queue.total) * 100) : 0;
                return (
                  <button
                    key={row.key}
                    type="button"
                    onClick={() => onSelectStatusFilter?.(row.key)}
                    className="w-full py-2.5 flex items-center justify-between gap-4 text-xs text-left hover:bg-[#151822]/50 px-2 -mx-2 rounded-md transition-colors cursor-pointer"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <span className={`w-2 h-2 rounded-xs shrink-0 ${row.barColor}`} />
                      <div className="min-w-0">
                        <div className="font-medium text-[#f3f4f8] truncate">
                          {row.label}
                        </div>
                        <div className="text-[11px] text-[#636b82] truncate">
                          {row.sublabel}
                        </div>
                      </div>
                    </div>

                    <div className="flex items-center gap-4 font-mono tabular-nums shrink-0">
                      <span className="text-[11px] text-[#636b82] w-10 text-right">
                        {pct}%
                      </span>
                      <span
                        className={`text-xs font-semibold w-8 text-right ${
                          row.count > 0 ? row.textColor : "text-[#636b82]"
                        }`}
                      >
                        {row.count}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dual Batch Packaging Threshold Meters */}
          <div className="mt-5 pt-4 border-t border-[#1e2230] grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#949bb0] font-medium">Episode Count Trigger</span>
                <span className="font-mono tabular-nums text-[#f3f4f8]">
                  {storage.stagedCount} / {storage.maxBatchItems} files ({batchCountPct}%)
                </span>
              </div>
              <div className="h-1.5 w-full bg-[#151822] rounded-full overflow-hidden">
                <div
                  className="h-full bg-indigo-500 transition-all duration-300"
                  style={{ width: `${batchCountPct}%` }}
                />
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between text-xs mb-1.5">
                <span className="text-[#949bb0] font-medium">Batch Volume Trigger</span>
                <span className="font-mono tabular-nums text-[#f3f4f8]">
                  {stagedGb} / 10.00 GB ({batchBytesPct}%)
                </span>
              </div>
              <div className="h-1.5 w-full bg-[#151822] rounded-full overflow-hidden">
                <div
                  className="h-full bg-sky-400 transition-all duration-300"
                  style={{ width: `${batchBytesPct}%` }}
                />
              </div>
            </div>
          </div>
        </div>

        {/* Right Column: Active Batch Status + Live Telemetry Event Stream */}
        <div className="lg:col-span-5 surface-panel rounded-xl p-5 flex flex-col justify-between">
          <div>
            {/* Active Batch Section */}
            <div className="flex items-center justify-between pb-3 border-b border-[#1e2230]">
              <div>
                <h2 className="text-sm font-semibold text-[#f3f4f8]">
                  Active Batch Execution
                </h2>
                <p className="text-xs text-[#636b82] mt-0.5">
                  VM Direct Remux (-c:v copy) & Kaggle Dual-T4 GPU
                </p>
              </div>
              <button
                type="button"
                onClick={onOpenKaggleDetails}
                className="text-xs text-[#949bb0] hover:text-white inline-flex items-center gap-1 cursor-pointer"
              >
                <span>Cluster Pool</span>
                <ArrowUpRight className="w-3.5 h-3.5" />
              </button>
            </div>

            <div className="mt-3">
              {latestBatch ? (
                <div className="p-3.5 rounded-lg bg-[#151822] border border-[#232838] space-y-2">
                  <div className="flex items-center justify-between text-xs font-mono tabular-nums">
                    <span className="font-semibold text-[#f3f4f8]">
                      Batch #{latestBatch.id} ·{" "}
                      {latestBatch.mode === "vm_remux" ? "VM DIRECT REMUX" : latestBatch.status.toUpperCase()}
                    </span>
                    <span className="text-[#949bb0] flex items-center gap-1">
                      <Clock className="w-3.5 h-3.5 text-indigo-400" />
                      {Math.floor(latestBatch.elapsedSeconds / 60)}m {latestBatch.elapsedSeconds % 60}s
                    </span>
                  </div>
                  <div className="text-xs font-mono text-[#949bb0] truncate">
                    Worker:{" "}
                    <span className="text-[#f3f4f8]">
                      {latestBatch.mode === "vm_remux"
                        ? "ffmpeg -c:v copy (2 threads)"
                        : latestBatch.kernelSlug || "provisioning..."}
                    </span>
                  </div>
                  <div className="flex items-center justify-between text-[11px] font-mono tabular-nums text-[#636b82] pt-2 border-t border-[#1e2230]">
                    <span>
                      {latestBatch.jobCount} episodes ·{" "}
                      {(latestBatch.totalBytes / (1024 * 1024 * 1024)).toFixed(2)} GB
                    </span>
                    <span className="text-indigo-400">
                      @{latestBatch.kaggleUsername || "auto"}
                    </span>
                  </div>
                </div>
              ) : (
                <div className="p-3.5 rounded-lg bg-[#151822]/60 border border-[#1e2230] flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#f3f4f8] flex items-center gap-1.5">
                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
                      <span>
                        VM Remux & {concurrency.max} GPU Slots Ready
                      </span>
                    </div>
                    <p className="text-[11px] text-[#636b82] mt-0.5">
                      H.264 releases remux immediately on VM; HEVC/AV1 releases dispatch to Kaggle GPU.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={onOpenEnqueue}
                    className="btn-secondary px-2.5 py-1.5 rounded-md text-xs font-medium shrink-0 flex items-center gap-1 cursor-pointer"
                  >
                    <Plus className="w-3.5 h-3.5" />
                    <span>Enqueue</span>
                  </button>
                </div>
              )}
            </div>

            {/* Live Event Stream */}
            <div className="mt-5 pt-4 border-t border-[#1e2230]">
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-xs font-semibold text-[#f3f4f8] flex items-center gap-1.5">
                  <Terminal className="w-3.5 h-3.5 text-indigo-400" />
                  <span>Recent Telemetry Events</span>
                </span>
                <span className="text-[11px] font-mono tabular-nums text-[#636b82]">
                  {logs.length} buffered
                </span>
              </div>

              <div className="space-y-1.5">
                {recentLogs.length > 0 ? (
                  recentLogs.map((l, idx) => (
                    <div
                      key={l.id || idx}
                      className="px-2.5 py-2 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-xs font-mono"
                    >
                      <div className="flex items-center justify-between text-[10px] text-[#636b82] tabular-nums">
                        <span className="font-semibold text-[#949bb0]">[{l.tag}]</span>
                        <span>
                          {new Date(l.timestamp).toLocaleTimeString([], {
                            hour: "2-digit",
                            minute: "2-digit",
                            second: "2-digit",
                          })}
                        </span>
                      </div>
                      <p
                        className={`text-[11px] truncate mt-0.5 ${
                          l.level === "error"
                            ? "text-rose-400"
                            : l.level === "success"
                            ? "text-emerald-400"
                            : "text-[#d5d9e6]"
                        }`}
                      >
                        {l.message}
                      </p>
                    </div>
                  ))
                ) : (
                  <div className="py-6 text-center text-xs text-[#636b82] bg-[#0c0e14] rounded-lg border border-[#1e2230]">
                    No pipeline events recorded in current session yet.
                  </div>
                )}
              </div>
            </div>
          </div>

          <button
            type="button"
            onClick={onOpenLiveTerminal}
            className="btn-secondary mt-4 w-full py-2 px-3 rounded-lg text-xs font-medium flex items-center justify-center gap-1.5 cursor-pointer"
          >
            <span>Open Full Live Console</span>
            <ArrowUpRight className="w-3.5 h-3.5 text-[#949bb0]" />
          </button>
        </div>
      </div>
    </div>
  );
}
