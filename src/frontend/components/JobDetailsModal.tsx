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

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#161724] border border-white/[0.1] rounded-3xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-start justify-between pb-4 border-b border-white/[0.08]">
          <div>
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs font-bold text-neutral-400">Job #{job.id}</span>
              <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono uppercase bg-white/[0.08] text-white border border-white/10">
                {job.status}
              </span>
            </div>
            <h3 className="text-base font-bold text-white mt-1">
              {job.metadata?.primaryTitle || job.torrentTitle || `Anime Job #${job.id}`}
            </h3>
            <p className="text-xs text-neutral-400 mt-0.5 font-mono">
              Episode {job.episodeNumber} • {job.types?.join(" & ").toUpperCase() || "SUB"}
            </p>
          </div>

          <button
            onClick={onClose}
            className="button-liquid-glass w-8 h-8 rounded-full flex items-center justify-center text-neutral-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Identifiers Grid */}
        <div className="grid grid-cols-3 gap-3 my-4">
          {/* AniList ID */}
          <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.06]">
            <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 block mb-1">
              AniList ID
            </span>
            {job.anilistId ? (
              <a
                href={`https://anilist.co/anime/${job.anilistId}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono font-bold text-sm text-white hover:underline flex items-center gap-1"
              >
                #{job.anilistId}
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span className="text-xs font-mono text-neutral-500">Not set</span>
            )}
          </div>

          {/* AniDB ID */}
          <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.06]">
            <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 block mb-1">
              AniDB ID (Internal)
            </span>
            {job.anidbId ? (
              <a
                href={`https://anidb.net/anime/${job.anidbId}`}
                target="_blank"
                rel="noreferrer"
                className="font-mono font-bold text-sm text-neutral-300 hover:text-white flex items-center gap-1"
              >
                #{job.anidbId}
                <ExternalLink className="w-3 h-3" />
              </a>
            ) : (
              <span className="text-xs font-mono text-neutral-500">Not set</span>
            )}
          </div>

          {/* Anime ID */}
          <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.06]">
            <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-400 block mb-1">
              Main Anime ID
            </span>
            <span className="font-mono font-bold text-sm text-neutral-300">
              {job.animeId ? `#${job.animeId}` : "Not set"}
            </span>
          </div>
        </div>

        {/* Error Trace if Failed */}
        {job.lastError && (
          <div className="mb-4 p-3.5 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs">
            <div className="font-semibold flex items-center gap-1.5 mb-1 text-rose-200">
              <AlertTriangle className="w-4 h-4" />
              Error Details:
            </div>
            <pre className="font-mono text-[11px] whitespace-pre-wrap break-all text-rose-300">
              {job.lastError}
            </pre>
          </div>
        )}

        {/* Encoded Video Streams */}
        {sources.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-neutral-300 uppercase tracking-wider mb-2">
              Encoded Video Streams ({sources.length} qualities)
            </h4>
            <div className="space-y-1.5">
              {sources.map((s: any, idx: number) => (
                <div
                  key={idx}
                  className="p-3 rounded-2xl bg-[#10111a] border border-white/[0.06] flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full bg-white/[0.08] text-white font-bold text-[10px]">
                      {s.quality}
                    </span>
                    <span className="text-neutral-400 text-[11px] truncate max-w-sm">
                      {s.downloadUrl || s.url}
                    </span>
                  </div>
                  {s.downloadUrl && (
                    <a
                      href={s.downloadUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="button-liquid-glass p-1.5 rounded-full text-neutral-400 hover:text-white"
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

        {/* Subtitles (Cloudflare R2) */}
        {subtitles.length > 0 && (
          <div className="mb-4">
            <h4 className="text-xs font-semibold text-neutral-300 uppercase tracking-wider mb-2">
              Extracted Subtitles ({subtitles.length} tracks)
            </h4>
            <div className="space-y-1.5">
              {subtitles.map((sub: any, idx: number) => (
                <div
                  key={idx}
                  className="p-3 rounded-2xl bg-[#10111a] border border-white/[0.06] flex items-center justify-between text-xs font-mono"
                >
                  <div className="flex items-center gap-2">
                    <span className="px-2 py-0.5 rounded-full bg-cyan-500/15 text-cyan-300 font-bold text-[10px] uppercase">
                      {sub.language || "UND"}
                    </span>
                    <span className="text-neutral-300 text-[11px]">{sub.label || sub.path}</span>
                  </div>
                  {sub.url && (
                    <a
                      href={sub.url}
                      target="_blank"
                      rel="noreferrer"
                      className="button-liquid-glass p-1.5 rounded-full text-neutral-400 hover:text-white"
                    >
                      <Download className="w-3.5 h-3.5" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Timestamps & Actions */}
        <div className="pt-3 border-t border-white/[0.08] flex items-center justify-between text-xs text-neutral-500 font-mono">
          <div>Created: {new Date(job.createdAt).toLocaleString()}</div>
          <button
            onClick={() => handleCopy(JSON.stringify(job, null, 2))}
            className="button-liquid-glass flex items-center gap-1.5 px-3.5 py-1.5 rounded-full text-neutral-300 hover:text-white transition-colors cursor-pointer"
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
