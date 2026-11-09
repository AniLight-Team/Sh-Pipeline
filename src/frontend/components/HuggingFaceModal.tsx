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
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#161724] border border-white/[0.1] rounded-3xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between pb-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-sky-500/10 border border-sky-500/20 flex items-center justify-center text-sky-300">
              <Cloud className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">
                  Hugging Face Video Storage & Distribution
                </h3>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-white/[0.08] text-white border border-white/10">
                  CDN & Streams
                </span>
              </div>
              <p className="text-xs text-neutral-400 mt-0.5">
                Multi-bitrate video stream hosting (1080p, 720p, 480p, 360p) with SHA-256 validation.
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="button-liquid-glass w-8 h-8 rounded-full flex items-center justify-center text-neutral-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Storage Architecture Overview */}
        <div className="grid grid-cols-2 gap-3 my-4">
          <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.06]">
            <div className="flex items-center gap-2 text-xs font-bold text-white mb-1">
              <Film className="w-4 h-4 text-sky-400" />
              <span>Video Streams Hosting</span>
            </div>
            <p className="text-[11px] text-neutral-400 leading-relaxed">
              Kaggle GPU batches transcode raw MKV to H.264/MP4 and stream uploads directly to Hugging Face datasets with permanent direct download URLs.
            </p>
          </div>

          <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.06]">
            <div className="flex items-center gap-2 text-xs font-bold text-white mb-1">
              <HardDrive className="w-4 h-4 text-cyan-400" />
              <span>Cloudflare R2 Subtitles</span>
            </div>
            <p className="text-[11px] text-neutral-400 leading-relaxed">
              Dialogue, signs, and SDH subtitle tracks are extracted locally during VM staging and synced directly to Cloudflare R2 (capthumb).
            </p>
          </div>
        </div>

        {/* Configured Accounts */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
            Configured Hugging Face Accounts ({hfAccounts.length})
          </h4>

          {hfAccounts.length === 0 ? (
            <div className="p-6 text-center text-neutral-500 text-xs rounded-2xl bg-[#10111a] border border-white/[0.05]">
              No Hugging Face accounts configured in environment (HF_ACCOUNTS).
            </div>
          ) : (
            hfAccounts.map((h, idx) => (
              <div
                key={idx}
                className="p-4 rounded-2xl bg-[#10111a] border border-white/[0.06] hover:border-white/[0.12] transition-colors"
              >
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm font-bold text-white">
                      {h.owner || "Primary HF Account"}
                    </span>
                    <span className="text-[10px] font-mono px-2.5 py-0.5 rounded-full bg-emerald-500/10 text-emerald-300 border border-emerald-500/20 flex items-center gap-1">
                      <CheckCircle2 className="w-2.5 h-2.5" />
                      Connected
                    </span>
                  </div>

                  <span className="text-xs font-mono text-neutral-400">
                    Bucket: <strong className="text-white">{h.bucket || "capthumb"}</strong>
                  </span>
                </div>

                <div className="text-[11px] font-mono text-neutral-400 flex items-center justify-between pt-2 border-t border-white/[0.04]">
                  <span>Distribution Prefix:</span>
                  <span className="text-neutral-300 font-bold">
                    datasets/{h.owner || "kira"}/{h.bucket || "capthumb"}
                  </span>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-white/[0.08] flex justify-end">
          <button
            onClick={onClose}
            className="button-liquid-glass px-5 py-2 rounded-full text-xs font-semibold text-neutral-300 hover:text-white transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
