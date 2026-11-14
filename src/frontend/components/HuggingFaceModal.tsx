import { useDialog } from "../hooks/useDialog.js";
import React from "react";
import { X, Cloud, HardDrive, CheckCircle2, Film } from "lucide-react";
import type { PipelineStats } from "../../backend/engine/types.js";

interface HuggingFaceModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: PipelineStats | null;
}

export function HuggingFaceModal({ isOpen, onClose, stats }: HuggingFaceModalProps) {
  useDialog(isOpen, onClose);
  if (!isOpen) return null;

  const hfAccounts = stats?.accounts?.huggingFace || [];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="hf-modal-title"
      className="fixed inset-0 z-50 bg-[#302e2a]/35 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="surface-panel rounded-xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between pb-4 border-b border-[#e6e3db]">
          <div className="flex items-center gap-3 pr-8">
            <div className="w-9 h-9 rounded-lg bg-sky-500/15 border border-sky-500/30 flex items-center justify-center text-[#9a563b] shrink-0">
              <Cloud className="w-4 h-4" />
            </div>
            <div>
              <h3 id="hf-modal-title" className="text-base font-bold text-[#302e2a]">
                Video Storage & Subtitle CDN
              </h3>
              <p className="text-xs text-[#817a70] mt-0.5">
                Multi-bitrate MP4 stream distribution on Hugging Face + VTT subtitle delivery on Cloudflare R2
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close storage modal"
            className="btn-secondary w-8 h-8 rounded-lg flex items-center justify-center text-[#716c63] hover:text-[#302e2a] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Architecture Overview */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 my-4">
          <div className="p-3.5 rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#302e2a] mb-1">
              <Film className="w-4 h-4 text-[#9a563b]" />
              <span>Hugging Face Video Streams</span>
            </div>
            <p className="text-[11px] text-[#716c63] leading-relaxed">
              Kaggle GPU batches transcode 1080p, 720p, and 480p H.264/MP4 streams with burned AniLight watermark and upload directly to Hugging Face buckets.
            </p>
          </div>

          <div className="p-3.5 rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
            <div className="flex items-center gap-2 text-xs font-semibold text-[#302e2a] mb-1">
              <HardDrive className="w-4 h-4 text-[#9a563b]" />
              <span>Cloudflare R2 Subtitles</span>
            </div>
            <p className="text-[11px] text-[#716c63] leading-relaxed">
              Full dialogue (default for Sub) and signs/songs (default for Dub) tracks are extracted during local SSD staging and synced to Cloudflare R2.
            </p>
          </div>
        </div>

        {/* Configured Buckets */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-[#716c63]">
            Configured Hugging Face Targets ({hfAccounts.length})
          </h4>

          {hfAccounts.length === 0 ? (
            <div className="p-6 text-center text-[#817a70] text-xs rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
              No Hugging Face accounts configured in environment (HF_ACCOUNTS).
            </div>
          ) : (
            hfAccounts.map((h, idx) => (
              <div
                key={idx}
                className="p-4 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] flex flex-wrap items-center justify-between gap-3"
              >
                <div>
                  <div className="flex items-center gap-2 font-mono text-xs">
                    <CheckCircle2 className="w-3.5 h-3.5 text-[#52734c]" />
                    <span className="font-semibold text-[#302e2a]">
                      {h.owner || "Primary Account"}
                    </span>
                    <span className="text-[#817a70]">· Connected</span>
                  </div>
                  <div className="text-[11px] font-mono text-[#817a70] mt-1">
                    Dataset path: <span className="text-[#716c63]">datasets/{h.owner || "kira"}/{h.bucket || "capthumb"}</span>
                  </div>
                </div>

                <div className="text-xs font-mono text-[#716c63]">
                  Bucket: <strong className="text-[#302e2a]">{h.bucket || "capthumb"}</strong>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-[#e6e3db] flex justify-end">
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
