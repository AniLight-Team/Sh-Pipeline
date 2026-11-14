import { useDialog } from "../hooks/useDialog.js";
import React, { useState } from "react";
import {
  X,
  ExternalLink,
  Copy,
  Check,
  Download,
  AlertTriangle,
  Play,
  RefreshCw,
  Cpu,
  HardDrive,
  Film,
  Subtitles,
} from "lucide-react";

interface JobDetailsModalProps {
  job: any | null;
  onClose: () => void;
  onUpdated?: (message?: string) => void;
}

export function JobDetailsModal({ job, onClose, onUpdated }: JobDetailsModalProps) {
  useDialog(Boolean(job), onClose);
  const [copied, setCopied] = useState(false);
  const [copiedUrls, setCopiedUrls] = useState(false);
  const [actionBusy, setActionBusy] = useState<string | null>(null);

  const allTrackPayloads = Array.isArray(job?.resultPayload?.allTrackPayloads)
    ? job.resultPayload.allTrackPayloads
    : job?.resultPayload
    ? [job.resultPayload]
    : [];

  const availableAudioTracks: string[] =
    allTrackPayloads.length > 0
      ? allTrackPayloads.map((p: any) => p.type || "sub")
      : Array.isArray(job?.types) && job.types.length > 0
      ? job.types
      : ["sub"];

  const [selectedAudioType, setSelectedAudioType] = useState<string>(
    availableAudioTracks[0] || "sub",
  );
  const [selectedQuality, setSelectedQuality] = useState<string>("1080p");

  if (!job) return null;

  const activeTrackPayload =
    allTrackPayloads.find((p: any) => p.type === selectedAudioType) ||
    allTrackPayloads[0] ||
    job.resultPayload;

  const sources: any[] = activeTrackPayload?.sources || job.resultPayload?.sources || [];
  const subtitles: any[] =
    activeTrackPayload?.subtitles ||
    job.subtitlesPayload ||
    job.resultPayload?.subtitles ||
    [];

  const activeStreamSource =
    sources.find((s: any) => s.quality === selectedQuality) || sources[0] || null;
  const activeStreamUrl = activeStreamSource?.downloadUrl || activeStreamSource?.url || "";

  const cannotReprocess = ["downloading", "encoding", "completed"].includes(job.status) || Boolean(job.batchId && job.status !== "failed");
  const tsukihimeId = job.metadata?.tsukihimeId;
  const processingMode = job.pipelineType || job.metadata?.processingMode;
  const selectionTier = job.selectionTier || job.metadata?.selectionTier;
  const releaseGroup = job.releaseGroup || job.metadata?.releaseGroup;
  const videoCodec = job.videoCodec || job.metadata?.videoCodec;
  const isBatchTorrent = Boolean(job.isBatchTorrent ?? job.metadata?.isBatchTorrent);
  const stagedQualities = (job.stagedQualities ||
    job.metadata?.stagedQualities ||
    {}) as Record<string, string>;
  const stagedQualityKeys = Object.keys(stagedQualities);

  const handleCopyJson = () => {
    navigator.clipboard.writeText(JSON.stringify(job, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleCopyStreamUrls = () => {
    const urls = sources
      .map((s: any) => `${s.quality}: ${s.downloadUrl || s.url}`)
      .join("\n");
    navigator.clipboard.writeText(urls || job.torrentMagnet || "");
    setCopiedUrls(true);
    setTimeout(() => setCopiedUrls(false), 2000);
  };

  const runJobAction = async (
    action: "retry" | "force_remux" | "force_gpu" | "sync_callbacks",
  ) => {
    setActionBusy(action);
    try {
      const res = await fetch("/api/jobs/bulk", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jobIds: [job.id],
          action,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || data.message || "Job update failed");
      if (onUpdated) {
        onUpdated(data.message || `Executed ${action} for Job #${job.id}`);
      }
      onClose();
    } catch (error) {
      onUpdated?.(error instanceof Error ? error.message : "Job update failed");
    } finally {
      setActionBusy(null);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="job-details-title"
      className="fixed inset-0 z-50 bg-[#302e2a]/35 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="surface-panel rounded-xl max-w-3xl w-full p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-[#e6e3db]">
          <div className="pr-8 min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-mono tabular-nums text-[#716c63]">
              <span>Job #{job.id}</span>
              <span>·</span>
              <span className="uppercase text-[#9a563b] font-semibold">{job.status}</span>
              <span>·</span>
              <span>Episode {job.episodeNumber}</span>
              <span>·</span>
              <span>{job.types?.join(" + ").toUpperCase() || "SUB"}</span>
              {processingMode && (
                <>
                  <span>·</span>
                  <span
                    className={
                      processingMode === "vm_remux" ? "text-[#52734c]" : "text-[#9a563b]"
                    }
                  >
                    {processingMode === "vm_remux"
                      ? "VM Direct Remux (-c:v copy)"
                      : "Kaggle GPU Encode"}
                  </span>
                </>
              )}
            </div>
            <h3 id="job-details-title" className="text-base font-bold text-[#302e2a] mt-1 truncate">
              {job.metadata?.primaryTitle || job.torrentTitle || `Anime Job #${job.id}`}
            </h3>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close job details"
            className="btn-secondary w-8 h-8 rounded-lg flex items-center justify-center text-[#716c63] hover:text-[#302e2a] cursor-pointer shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Direct Job Action Toolbar */}
        <div className="my-4 p-3 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] flex flex-wrap items-center justify-between gap-2">
          <span className="text-xs font-medium text-[#716c63]">
            Pipeline Controls
          </span>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={actionBusy !== null || cannotReprocess}
              onClick={() => runJobAction("retry")}
              className="btn-secondary px-2.5 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className="w-3.5 h-3.5 text-[#9a563b]" />
              <span>Retry Job</span>
            </button>
            <button
              type="button"
              disabled={actionBusy !== null || cannotReprocess}
              onClick={() => runJobAction("force_remux")}
              className="btn-secondary px-2.5 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="Force direct container & audio conversion on VM (-c:v copy)"
            >
              <HardDrive className="w-3.5 h-3.5 text-[#52734c]" />
              <span>Route to VM Remux</span>
            </button>
            <button
              type="button"
              disabled={actionBusy !== null || cannotReprocess}
              onClick={() => runJobAction("force_gpu")}
              className="btn-secondary px-2.5 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              title="Route job to Kaggle Dual-T4 GPU batch transcoding"
            >
              <Cpu className="w-3.5 h-3.5 text-[#9a563b]" />
              <span>Route to GPU</span>
            </button>
            {job.status === "completed" && (
              <button
                type="button"
                disabled={actionBusy !== null}
                onClick={() => runJobAction("sync_callbacks")}
                className="btn-secondary px-2.5 py-1.5 rounded-md text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
              >
                <Play className="w-3.5 h-3.5 text-[#9a563b]" />
                <span>Sync Webhook</span>
              </button>
            )}
          </div>
        </div>

        {/* Identifiers & Codec Metadata Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
          <div className="p-3 rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
            <span className="text-[11px] text-[#817a70] block mb-0.5">AniList ID</span>
            {job.anilistId ? (
              <a
                href={`https://anilist.co/anime/${job.anilistId}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono tabular-nums font-semibold text-xs text-[#9a563b] hover:underline inline-flex items-center gap-1"
              >
                <span>#{job.anilistId}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span className="text-xs font-mono text-[#817a70]">—</span>
            )}
          </div>

          <div className="p-3 rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
            <span className="text-[11px] text-[#817a70] block mb-0.5">Tsukihime / AniDB</span>
            <span className="font-mono tabular-nums font-semibold text-xs text-[#302e2a]">
              {tsukihimeId ? `Tsuki #${tsukihimeId}` : "—"} ·{" "}
              {job.anidbId ? `AniDB #${job.anidbId}` : "—"}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
            <span className="text-[11px] text-[#817a70] block mb-0.5">Release Group & Tier</span>
            <span className="font-mono text-xs font-semibold text-[#5b554a] truncate block">
              {releaseGroup || "auto"} · {(videoCodec || "h264").toUpperCase()}
              {selectionTier ? ` (${selectionTier})` : ""}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
            <span className="text-[11px] text-[#817a70] block mb-0.5">Staged Payload</span>
            <span className="font-mono tabular-nums font-semibold text-xs text-[#5b554a]">
              {job.sizeBytes
                ? `${(job.sizeBytes / (1024 * 1024)).toFixed(1)} MB`
                : "—"}{" "}
              · {isBatchTorrent ? "1-Ep Batch Extract" : "Solo Release"}
            </span>
          </div>
        </div>

        {/* Selected Release Title & Multi-Quality Staged Files */}
        {(job.torrentTitle || job.stagedFilePath || stagedQualityKeys.length > 0) && (
          <div className="mb-4 p-3 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] space-y-2">
            {job.torrentTitle && (
              <div>
                <span className="text-[11px] text-[#817a70] block mb-1">
                  Selected Primary Release (1080p Subtitle Source)
                </span>
                <div className="font-mono text-xs text-[#302e2a] break-all">
                  {job.torrentTitle}
                </div>
              </div>
            )}

            {job.stagedFilePath && (
              <div className="pt-2 border-t border-[#e6e3db]">
                <span className="text-[11px] text-[#817a70] block mb-1">
                  Primary Staged File Path on Local SSD
                </span>
                <div className="font-mono text-[11px] text-[#52734c] break-all bg-[#12151f] px-2.5 py-1.5 rounded border border-[#e6e3db]">
                  {job.stagedFilePath}
                </div>
              </div>
            )}

            {stagedQualityKeys.length > 0 && (
              <div className="pt-2 border-t border-[#e6e3db]">
                <span className="text-[11px] text-[#817a70] block mb-1">
                  Same-Group Staged Quality Files ({stagedQualityKeys.join(" · ")})
                </span>
                <div className="space-y-1">
                  {stagedQualityKeys.map((qKey) => (
                    <div
                      key={qKey}
                      className="flex items-center justify-between text-[11px] font-mono text-[#716c63]"
                    >
                      <span className="text-[#9a563b] font-semibold">{qKey}</span>
                      <span className="truncate max-w-md">{stagedQualities[qKey]}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Error Trace if Failed */}
        {job.lastError && (
          <div className="mb-4 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-[#ad4a3e] text-xs">
            <div className="font-semibold flex items-center gap-1.5 mb-1 text-rose-200">
              <AlertTriangle className="w-4 h-4" />
              <span>Diagnostic Trace</span>
            </div>
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-all text-[#ad4a3e]">
              {job.lastError}
            </pre>
          </div>
        )}

        {/* Multimedia Video Stream Preview Player (When Completed / Sources Available) */}
        {sources.length > 0 && (
          <div className="mb-4 p-3.5 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex items-center gap-2">
                <Film className="w-4 h-4 text-[#9a563b]" />
                <h4 className="text-xs font-semibold text-[#302e2a]">
                  Multimedia Stream Inspector ({sources.length} qualities)
                </h4>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                {/* Audio Track Switcher */}
                {availableAudioTracks.length > 1 && (
                  <div className="flex items-center bg-[#f0eee8] p-0.5 rounded-md border border-[#ded8cd] text-[11px] font-mono">
                    {availableAudioTracks.map((aType) => (
                      <button
                        key={aType}
                        type="button"
                        onClick={() => setSelectedAudioType(aType)}
                        className={`px-2 py-0.5 rounded uppercase cursor-pointer ${
                          selectedAudioType === aType
                            ? "bg-indigo-500 text-[#302e2a] font-semibold"
                            : "text-[#716c63] hover:text-[#302e2a]"
                        }`}
                      >
                        {aType}
                      </button>
                    ))}
                  </div>
                )}

                {/* Quality Switcher */}
                <div className="flex items-center bg-[#f0eee8] p-0.5 rounded-md border border-[#ded8cd] text-[11px] font-mono">
                  {sources.map((s: any) => (
                    <button
                      key={s.quality}
                      type="button"
                      onClick={() => setSelectedQuality(s.quality)}
                      className={`px-2 py-0.5 rounded cursor-pointer ${
                        (activeStreamSource?.quality || "") === s.quality
                          ? "bg-[#ded8cd] text-[#302e2a] font-semibold"
                          : "text-[#716c63] hover:text-[#302e2a]"
                      }`}
                    >
                      {s.quality}
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={handleCopyStreamUrls}
                  className="btn-secondary px-2.5 py-1 rounded-md text-[11px] font-mono inline-flex items-center gap-1 cursor-pointer"
                >
                  {copiedUrls ? (
                    <Check className="w-3 h-3 text-[#52734c]" />
                  ) : (
                    <Copy className="w-3 h-3" />
                  )}
                  <span>{copiedUrls ? "Copied URLs" : "Copy URLs"}</span>
                </button>
              </div>
            </div>

            {activeStreamUrl && (
              <div className="rounded-lg overflow-hidden bg-black border border-[#e6e3db]">
                <video
                  key={activeStreamUrl}
                  src={activeStreamUrl}
                  controls
                  preload="metadata"
                  crossOrigin="anonymous"
                  className="w-full max-h-64 bg-black"
                >
                  {subtitles.map((sub: any, idx: number) =>
                    sub.url ? (
                      <track
                        key={idx}
                        kind="subtitles"
                        src={sub.url}
                        srcLang={sub.language || "en"}
                        label={sub.label || sub.language || `Track ${idx + 1}`}
                        default={Boolean(sub.isDefault || sub.default_sub || idx === 0)}
                      />
                    ) : null,
                  )}
                </video>
              </div>
            )}

            <div className="space-y-1.5">
              {sources.map((s: any, idx: number) => (
                <div
                  key={idx}
                  className="p-2 rounded-md bg-[#131620] border border-[#e6e3db] flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-[#9a563b] font-semibold">{s.quality}</span>
                    {s.sizeBytes && (
                      <span className="text-[#817a70] text-[11px]">
                        {(s.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                      </span>
                    )}
                    <span className="text-[#716c63] text-[11px] truncate max-w-md">
                      {s.downloadUrl || s.url}
                    </span>
                  </div>
                  {(s.downloadUrl || s.url) && (
                    <a
                      href={s.downloadUrl || s.url}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-secondary p-1.5 rounded-md text-[#716c63] hover:text-[#302e2a] shrink-0"
                      title={`Open ${s.quality} MP4 stream`}
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Extracted 1080p Subtitles */}
        {subtitles.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-[#716c63] mb-2 flex items-center gap-1.5">
              <Subtitles className="w-3.5 h-3.5 text-[#9a563b]" />
              <span>Cloudflare R2 Subtitles — Extracted from 1080p ({subtitles.length} tracks)</span>
            </h4>
            <div className="space-y-1.5">
              {subtitles.map((sub: any, idx: number) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-[#9a563b] font-semibold uppercase">
                      {sub.language || "UND"}
                    </span>
                    <span className="text-[#5b554a] text-[11px] truncate">
                      {sub.label || sub.path}
                    </span>
                    {sub.role && (
                      <span className="text-[#817a70] text-[10px]">· {sub.role}</span>
                    )}
                  </div>
                  {sub.url && (
                    <a
                      href={sub.url}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-secondary p-1.5 rounded-md text-[#716c63] hover:text-[#302e2a] shrink-0"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Footer */}
        <div className="pt-3 border-t border-[#e6e3db] flex items-center justify-between text-xs text-[#817a70] font-mono tabular-nums">
          <div>Created {new Date(job.createdAt).toLocaleString()}</div>
          <button
            type="button"
            onClick={handleCopyJson}
            className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs cursor-pointer"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-[#52734c]" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
            <span>{copied ? "Copied JSON" : "Copy Raw JSON"}</span>
          </button>
        </div>
      </div>
    </div>
  );
}
