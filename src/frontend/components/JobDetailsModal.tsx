import React from "react";
import { X, ExternalLink, Copy, Check, Download, AlertTriangle } from "lucide-react";

interface JobDetailsModalProps {
  job: any | null;
  onClose: () => void;
}

export function JobDetailsModal({ job, onClose }: JobDetailsModalProps) {
  const [copied, setCopied] = React.useState(false);

  if (!job) return null;

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const sources = job.resultPayload?.sources || [];
  const subtitles = job.subtitlesPayload || job.resultPayload?.subtitles || [];
  const tsukihimeId = job.metadata?.tsukihimeId;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="job-details-title"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="surface-panel rounded-xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-[#1e2230]">
          <div className="pr-8">
            <div className="flex items-center gap-2 text-xs font-mono tabular-nums text-[#949bb0]">
              <span>Job #{job.id}</span>
              <span>·</span>
              <span className="uppercase text-indigo-400 font-semibold">{job.status}</span>
              <span>·</span>
              <span>Episode {job.episodeNumber}</span>
              <span>·</span>
              <span>{job.types?.join(" + ").toUpperCase() || "SUB"}</span>
            </div>
            <h3 id="job-details-title" className="text-base font-bold text-[#f3f4f8] mt-1">
              {job.metadata?.primaryTitle || job.torrentTitle || `Anime Job #${job.id}`}
            </h3>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close job details"
            className="btn-secondary w-8 h-8 rounded-lg flex items-center justify-center text-[#949bb0] hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Identifiers Row */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 my-4">
          <div className="p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <span className="text-[11px] text-[#636b82] block mb-0.5">AniList ID</span>
            {job.anilistId ? (
              <a
                href={`https://anilist.co/anime/${job.anilistId}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono tabular-nums font-semibold text-xs text-indigo-400 hover:underline inline-flex items-center gap-1"
              >
                <span>#{job.anilistId}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span className="text-xs font-mono text-[#636b82]">—</span>
            )}
          </div>

          <div className="p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <span className="text-[11px] text-[#636b82] block mb-0.5">Tsukihime ID</span>
            <span className="font-mono tabular-nums font-semibold text-xs text-[#f3f4f8]">
              {tsukihimeId ? `#${tsukihimeId}` : "—"}
            </span>
          </div>

          <div className="p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <span className="text-[11px] text-[#636b82] block mb-0.5">AniDB ID</span>
            {job.anidbId ? (
              <a
                href={`https://anidb.net/anime/${job.anidbId}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono tabular-nums font-semibold text-xs text-[#d5d9e6] hover:text-white inline-flex items-center gap-1"
              >
                <span>#{job.anidbId}</span>
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span className="text-xs font-mono text-[#636b82]">—</span>
            )}
          </div>

          <div className="p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <span className="text-[11px] text-[#636b82] block mb-0.5">Main Anime ID</span>
            <span className="font-mono tabular-nums font-semibold text-xs text-[#d5d9e6]">
              {job.animeId ? `#${job.animeId}` : "—"}
            </span>
          </div>
        </div>

        {/* Selected Release Title */}
        {job.torrentTitle && (
          <div className="mb-4 p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <span className="text-[11px] text-[#636b82] block mb-1">Selected Release</span>
            <div className="font-mono text-xs text-[#f3f4f8] break-all">{job.torrentTitle}</div>
          </div>
        )}

        {/* Error Trace if Failed */}
        {job.lastError && (
          <div className="mb-4 p-3.5 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs">
            <div className="font-semibold flex items-center gap-1.5 mb-1 text-rose-200">
              <AlertTriangle className="w-4 h-4" />
              <span>Diagnostic Trace</span>
            </div>
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-all text-rose-300">
              {job.lastError}
            </pre>
          </div>
        )}

        {/* Encoded Video Streams */}
        {sources.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-[#949bb0] mb-2">
              Encoded Video Streams ({sources.length} qualities)
            </h4>
            <div className="space-y-1.5">
              {sources.map((s: any, idx: number) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2.5 min-w-0">
                    <span className="text-indigo-400 font-semibold">{s.quality}</span>
                    <span className="text-[#949bb0] text-[11px] truncate max-w-md">
                      {s.downloadUrl || s.url}
                    </span>
                  </div>
                  {s.downloadUrl && (
                    <a
                      href={s.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-secondary p-1.5 rounded-md text-[#949bb0] hover:text-white shrink-0"
                      title="Download encoded video"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Extracted Subtitles */}
        {subtitles.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-[#949bb0] mb-2">
              Extracted Subtitles ({subtitles.length} tracks)
            </h4>
            <div className="space-y-1.5">
              {subtitles.map((sub: any, idx: number) => (
                <div
                  key={idx}
                  className="p-2.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2.5">
                    <span className="text-sky-400 font-semibold uppercase">
                      {sub.language || "UND"}
                    </span>
                    <span className="text-[#d5d9e6] text-[11px]">{sub.label || sub.path}</span>
                  </div>
                  {sub.url && (
                    <a
                      href={sub.url}
                      target="_blank"
                      rel="noreferrer"
                      className="btn-secondary p-1.5 rounded-md text-[#949bb0] hover:text-white"
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
        <div className="pt-3 border-t border-[#1e2230] flex items-center justify-between text-xs text-[#636b82] font-mono tabular-nums">
          <div>Created {new Date(job.createdAt).toLocaleString()}</div>
          <button
            type="button"
            onClick={() => handleCopy(JSON.stringify(job, null, 2))}
            className="btn-secondary flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs cursor-pointer"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
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
