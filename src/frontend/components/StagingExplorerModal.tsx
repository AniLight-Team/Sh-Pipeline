import React, { useState, useEffect } from "react";
import {
  X,
  HardDrive,
  RefreshCw,
  Trash2,
  FolderOpen,
  CheckCircle2,
  AlertTriangle,
  Copy,
  Check,
  FileVideo,
} from "lucide-react";
import type { StorageInspectionReport } from "../../backend/engine/types.js";

interface StagingExplorerModalProps {
  isOpen: boolean;
  onClose: () => void;
  onNotice?: (msg: string) => void;
}

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 MB";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function StagingExplorerModal({
  isOpen,
  onClose,
  onNotice,
}: StagingExplorerModalProps) {
  const [report, setReport] = useState<StorageInspectionReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [cleaning, setCleaning] = useState(false);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  const fetchStorageReport = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/storage/staged-files");
      if (res.ok) {
        const data = await res.json();
        setReport(data.report || data);
      }
    } catch {
      // Ignore transient errors
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (isOpen) {
      fetchStorageReport();
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleCleanupOrphans = async () => {
    setCleaning(true);
    try {
      const res = await fetch("/api/storage/cleanup-orphans", {
        method: "POST",
      });
      const data = await res.json();
      if (data.report) setReport(data.report);
      onNotice?.(data.message || "Cleaned orphaned staged files.");
    } catch {
      onNotice?.("Failed to clean orphaned staged files.");
    } finally {
      setCleaning(false);
    }
  };

  const handleCopyPath = (text: string, id: string) => {
    navigator.clipboard.writeText(text);
    setCopiedPath(id);
    setTimeout(() => setCopiedPath(null), 2000);
  };

  const filesList = Array.isArray(report?.files) ? report.files : [];
  const orphanFiles = filesList.filter((f) => f.isOrphan);
  const usedPct = report
    ? Math.min(
        100,
        Math.round(
          ((report.totalDiskBytes || 0) /
            Math.max(1, report.maxStagingBytes || 56 * 1024 * 1024 * 1024)) *
            100,
        ),
      )
    : 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="staging-explorer-title"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="surface-panel rounded-xl max-w-4xl w-full p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-[#1e2230]">
          <div className="pr-8">
            <div className="flex items-center gap-2 text-xs font-mono text-indigo-400">
              <HardDrive className="w-4 h-4" />
              <span>LOCAL SSD STAGING BUFFER & FILE EXPLORER</span>
            </div>
            <h3
              id="staging-explorer-title"
              className="text-base font-bold text-[#f3f4f8] mt-1"
            >
              Where Staged Files Are Stored & Managed
            </h3>
            <p className="text-xs text-[#636b82] mt-0.5">
              Downloaded episode MKVs are moved out of Transmission into the isolated local SSD staging buffer before Pipeline 1 (VM Direct Remux) or Pipeline 2 (Kaggle GPU Batch) execution.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close staging explorer"
            className="btn-secondary w-8 h-8 rounded-lg flex items-center justify-center text-[#949bb0] hover:text-white cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Directory Architecture Breakdown */}
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="p-3.5 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <div className="flex items-center justify-between text-xs text-[#949bb0] mb-1">
              <span className="font-semibold text-[#f3f4f8] flex items-center gap-1.5">
                <FolderOpen className="w-3.5 h-3.5 text-indigo-400" />
                <span>Active Staging Directory (KIRA_STAGING_DIR)</span>
              </span>
              {report?.stagingDir && (
                <button
                  type="button"
                  onClick={() => handleCopyPath(report.stagingDir, "staging")}
                  className="text-[11px] font-mono text-indigo-400 hover:text-indigo-300 inline-flex items-center gap-1 cursor-pointer"
                >
                  {copiedPath === "staging" ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copiedPath === "staging" ? "Copied" : "Copy Path"}</span>
                </button>
              )}
            </div>
            <div className="font-mono text-xs text-emerald-300 break-all bg-[#12151f] px-2.5 py-1.5 rounded border border-[#1e2230]">
              {report?.stagingDir || "/srv/torrents/complete/.kira-staging"}
            </div>
            <p className="text-[11px] text-[#636b82] mt-1.5 font-mono">
              Pattern: job_&lt;id&gt;_ep&lt;ep&gt;_&lt;1080p|720p|480p&gt;_&lt;uuid&gt;.mkv
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <div className="flex items-center justify-between text-xs text-[#949bb0] mb-1">
              <span className="font-semibold text-[#f3f4f8] flex items-center gap-1.5">
                <HardDrive className="w-3.5 h-3.5 text-sky-400" />
                <span>Transmission Download Dir (DOWNLOAD_DIR)</span>
              </span>
              {report?.downloadDir && (
                <button
                  type="button"
                  onClick={() => handleCopyPath(report.downloadDir, "download")}
                  className="text-[11px] font-mono text-sky-400 hover:text-sky-300 inline-flex items-center gap-1 cursor-pointer"
                >
                  {copiedPath === "download" ? (
                    <Check className="w-3 h-3 text-emerald-400" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copiedPath === "download" ? "Copied" : "Copy Path"}</span>
                </button>
              )}
            </div>
            <div className="font-mono text-xs text-sky-300 break-all bg-[#12151f] px-2.5 py-1.5 rounded border border-[#1e2230]">
              {report?.downloadDir || "/srv/torrents/complete"}
            </div>
            <p className="text-[11px] text-[#636b82] mt-1.5 font-mono">
              Torrents are removed immediately after episode MKVs are staged.
            </p>
          </div>
        </div>

        {/* Capacity & Cleanup Controls */}
        <div className="mt-4 p-3.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] flex flex-wrap items-center justify-between gap-4">
          <div className="flex flex-wrap items-center gap-6 text-xs font-mono tabular-nums">
            <div>
              <span className="text-[#636b82] block text-[11px]">Disk Staged Volume</span>
              <span className="text-sm font-bold text-[#f3f4f8]">
                {formatBytes(report?.totalDiskBytes || 0)}{" "}
                <span className="text-[#636b82] font-normal">
                  / {formatBytes(report?.maxStagingBytes || 56 * 1024 * 1024 * 1024)} ({usedPct}%)
                </span>
              </span>
            </div>
            <div>
              <span className="text-[#636b82] block text-[11px]">SSD Free Space</span>
              <span className="text-sm font-bold text-emerald-400">
                {report?.freeDiskBytes !== null && report?.freeDiskBytes !== undefined
                  ? formatBytes(report.freeDiskBytes)
                  : "Available"}
              </span>
            </div>
            <div>
              <span className="text-[#636b82] block text-[11px]">Files on Disk</span>
              <span className="text-sm font-bold text-[#f3f4f8]">
                {report?.fileCount ?? 0} files{" "}
                {orphanFiles.length > 0 && (
                  <span className="text-amber-300 text-xs">
                    ({orphanFiles.length} orphaned)
                  </span>
                )}
              </span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {orphanFiles.length > 0 && (
              <button
                type="button"
                onClick={handleCleanupOrphans}
                disabled={cleaning}
                className="btn-secondary px-3 py-1.5 rounded-lg text-xs font-medium text-amber-300 hover:text-white inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Trash2 className="w-3.5 h-3.5" />
                <span>
                  {cleaning
                    ? "Cleaning..."
                    : `Clean Orphans (${orphanFiles.length})`}
                </span>
              </button>
            )}
            <button
              type="button"
              onClick={fetchStorageReport}
              disabled={loading}
              className="btn-secondary px-3 py-1.5 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
              <span>Refresh Disk</span>
            </button>
          </div>
        </div>

        {/* File Table */}
        <div className="mt-4 rounded-lg border border-[#1e2230] overflow-hidden">
          <div className="bg-[#0c0e14] px-4 py-2.5 border-b border-[#1e2230] flex items-center justify-between text-xs">
            <span className="font-semibold text-[#f3f4f8]">
              Staged Video Files in {report?.stagingDir || ".kira-staging"}
            </span>
            <span className="font-mono text-[11px] text-[#636b82] tabular-nums">
              Auto-cleaned upon job completion, skip, or deletion
            </span>
          </div>

          {filesList.length === 0 ? (
            <div className="py-10 px-4 text-center text-xs text-[#636b82] font-mono">
              <FileVideo className="w-6 h-6 text-[#636b82] mx-auto mb-2" />
              <p className="text-[#f3f4f8] font-sans font-medium">
                Staging directory is currently empty (0 bytes on disk)
              </p>
              <p className="mt-1">
                When episodes finish downloading in Transmission, their 1080p/720p/480p MKV files are staged here until VM Remux or Kaggle GPU upload completes.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto max-h-80">
              <table className="w-full text-left text-xs">
                <thead className="bg-[#0c0e14] text-[#636b82] font-mono border-b border-[#1e2230]">
                  <tr>
                    <th className="py-2 px-3">File Name & Path</th>
                    <th className="py-2 px-3">Quality</th>
                    <th className="py-2 px-3">Linked Job</th>
                    <th className="py-2 px-3">Pipeline</th>
                    <th className="py-2 px-3 text-right">Size</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#1e2230] font-mono">
                  {filesList.map((file) => (
                    <tr key={file.fullPath} className="hover:bg-[#151822]/60">
                      <td className="py-2.5 px-3">
                        <div className="text-[#f3f4f8] font-medium truncate max-w-xs">
                          {file.filename}
                        </div>
                        <div className="text-[10px] text-[#636b82] truncate max-w-xs">
                          {file.fullPath}
                        </div>
                      </td>
                      <td className="py-2.5 px-3">
                        <span className="text-indigo-400 font-semibold">
                          {file.quality}
                        </span>
                      </td>
                      <td className="py-2.5 px-3 tabular-nums">
                        {file.isOrphan ? (
                          <span className="inline-flex items-center gap-1 text-amber-300">
                            <AlertTriangle className="w-3 h-3" />
                            <span>Orphaned ({file.jobStatus || "unlinked"})</span>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-emerald-400">
                            <CheckCircle2 className="w-3 h-3" />
                            <span>
                              Job #{file.jobId} · Ep {file.episodeNumber} ({file.jobStatus})
                            </span>
                          </span>
                        )}
                      </td>
                      <td className="py-2.5 px-3">
                        {file.pipelineType === "vm_remux" ? (
                          <span className="text-emerald-400">Pipeline 1 (VM)</span>
                        ) : file.pipelineType === "kaggle_gpu" ? (
                          <span className="text-violet-400">Pipeline 2 (GPU)</span>
                        ) : (
                          <span className="text-[#636b82]">—</span>
                        )}
                      </td>
                      <td className="py-2.5 px-3 text-right tabular-nums text-[#d5d9e6]">
                        {formatBytes(file.sizeBytes)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
