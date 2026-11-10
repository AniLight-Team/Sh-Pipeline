import React from "react";
import { X, Cloud, HardDrive, CheckCircle2, Film } from "lucide-react";
import type { PipelineStats } from "../../backend/engine/types.js";

interface HuggingFaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: PipelineStats | null;
}

export function HuggingFaceModal({ isOpen, onClose, stats }: HuggingFaceModalProps) {
  if (!isOpen) return null;

  const hfAccounts = stats?.accounts?.huggingFace || [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hf-modal-title"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="surface-panel rounded-xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between pb-4 border-b border-[#1e2230]">
          <div className="flex items-center gap-3 pr-8">
            <div className="w-9 h-9 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-sky-400 shrink-0">
              <Cloud className="w-4 h-4" />
            </div>
            <div>
              <h3 id="hf-modal-title" className="text-base font-bold text-[#f3f4f8]">
                Video Storage & Subtitle CDN
              </h3>
              <p className="text-xs text-[#636b82] mt-0.5">
                Multi-bitrate MP4 stream distribution on Hugging Face + VTT subtitle delivery on Cloudflare R2
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close storage modal"
            className="btn-secondary w-8 h-8 rounded-lg flex items-center justify-center text-[#949bb0] hover:text-white cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Architecture Overview */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-4">
          <div className="p-3.5 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#f3f4f8] mb-1">
              <Film className="w-4 h-4 text-indigo-400" />
              <span>Hugging Face Video Streams</span>
            </div>
            <p className="text-[11px] text-[#949bb0] leading-relaxed">
              Kaggle GPU batches transcode 1080p, 720p, and 480p H.264/MP4 streams with burned AniLight watermark and upload directly to Hugging Face buckets.
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#f3f4f8] mb-1">
              <HardDrive className="w-4 h-4 text-sky-400" />
              <span>Cloudflare R2 Subtitles</span>
            </div>
            <p className="text-[11px] text-[#949bb0] leading-relaxed">
              Full dialogue (default for Sub) and signs/songs (default for Dub) tracks are extracted during local SSD staging and synced to Cloudflare R2.
            </p>
          </div>
        </div>

        {/* Configured Buckets */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-[#949bb0]">
            Configured Hugging Face Targets ({hfAccounts.length})
          </h4>

          {hfAccounts.length === 0 ? (
            <div className="p-6 text-center text-[#636b82] text-xs rounded-lg bg-[#0c0e14] border border-[#1e2230]">
              No Hugging Face accounts configured in environment (HF_ACCOUNTS).
            </div>
          ) : (
            hfAccounts.map((h, idx) => (
              <div
                key={idx}
                className="p-4 rounded-lg bg-[#0c0e14] border border-[#1e2230] flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                    <span className="font-semibold text-[#f3f4f8]">
                      {h.owner || "Primary Account"}
                    </span>
                    <span className="text-[#636b82]">· Connected</span>
                  </div>
                  <div className="text-[11px] font-mono text-[#636b82] mt-1">
                    Dataset path: <span className="text-[#949bb0]">datasets/{h.owner || "kira"}/{h.bucket || "capthumb"}</span>
                  </div>
                </div>

                <div className="text-xs font-mono text-[#949bb0]">
                  Bucket: <strong className="text-[#f3f4f8]">{h.bucket || "capthumb"}</strong>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-[#1e2230] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary px-4 py-2 rounded-lg text-xs font-medium cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
