import React, { useState, useEffect } from "react";
import {
  X,
  Plus,
  AlertCircle,
  Sparkles,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Image,
} from "lucide-react";

interface EnqueueModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

interface ResolvedPreview {
  anilistId: number;
  animeId?: number;
  anidbId?: number;
  primaryTitle: string;
  titleEnglish?: string;
  titleRomaji?: string;
  totalEpisodes?: number;
  coverImage?: string;
  synonyms: string[];
  source: string;
}

export function EnqueueModal({ isOpen, onClose, onSuccess }: EnqueueModalProps) {
  const [anilistInput, setAnilistInput] = useState("");
  const [episodes, setEpisodes] = useState("1");
  const [isSub, setIsSub] = useState(true);
  const [isDub, setIsDub] = useState(false);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [preview, setPreview] = useState<ResolvedPreview | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Advanced fields
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrideAnidbId, setOverrideAnidbId] = useState("");
  const [overrideAnimeId, setOverrideAnimeId] = useState("");
  const [knownTitles, setKnownTitles] = useState("");
  const [callbackUrl, setCallbackUrl] = useState("");

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setPreview(null);
      setResolving(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  // Extract clean AniList ID if a full URL was pasted
  const extractAnilistId = (raw: string): number | null => {
    const trimmed = raw.trim();
    const urlMatch = trimmed.match(/anilist\.co\/anime\/(\d+)/i);
    if (urlMatch) return parseInt(urlMatch[1], 10);
    const num = parseInt(trimmed, 10);
    return !isNaN(num) && num > 0 ? num : null;
  };

  // Fetch anime metadata preview when user inputs AniList ID
  const handleResolve = async (idNum: number) => {
    setResolving(true);
    setError(null);
    try {
      const res = await fetch(`/api/anime/resolve?anilistId=${idNum}`);
      if (res.ok) {
        const json = await res.json();
        if (json.metadata) {
          setPreview(json.metadata);
          if (json.metadata.anidbId && !overrideAnidbId) {
            setOverrideAnidbId(String(json.metadata.anidbId));
          }
          if (json.metadata.animeId && !overrideAnimeId) {
            setOverrideAnimeId(String(json.metadata.animeId));
          }
          if (json.metadata.synonyms?.length > 0 && !knownTitles) {
            setKnownTitles(json.metadata.synonyms.join(", "));
          }
        }
      }
    } catch {} finally {
      setResolving(false);
    }
  };

  const handleAnilistChange = (val: string) => {
    setAnilistInput(val);
    const parsed = extractAnilistId(val);
    if (parsed) {
      handleResolve(parsed);
    } else {
      setPreview(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsedAnilist = extractAnilistId(anilistInput);
    const parsedAnidb = overrideAnidbId ? parseInt(overrideAnidbId.trim(), 10) : preview?.anidbId;
    const parsedAnime = overrideAnimeId ? parseInt(overrideAnimeId.trim(), 10) : preview?.animeId;

    if (!parsedAnilist && !parsedAnidb) {
      setError("Please provide a valid AniList ID (or AniDB ID)");
      return;
    }

    // Parse episode numbers (supports "1", "1-12", "1, 2, 3")
    const epNums: number[] = [];
    for (const part of episodes.split(",")) {
      const trimmed = part.trim();
      if (trimmed.includes("-")) {
        const [start, end] = trimmed.split("-").map((x) => parseInt(x.trim(), 10));
        if (!isNaN(start) && !isNaN(end) && start <= end) {
          for (let n = start; n <= end; n++) epNums.push(n);
        }
      } else {
        const n = parseInt(trimmed, 10);
        if (!isNaN(n) && n > 0) epNums.push(n);
      }
    }

    if (epNums.length === 0) {
      setError("Please specify at least one episode number (e.g. 1 or 1-12)");
      return;
    }

    const types: ("sub" | "dub")[] = [];
    if (isSub) types.push("sub");
    if (isDub) types.push("dub");
    if (types.length === 0) {
      setError("Please select at least one release audio type (Sub or Dub)");
      return;
    }

    setLoading(true);
    try {
      const payload: any = {
        anilistId: parsedAnilist || undefined,
        anidbId: parsedAnidb || undefined,
        animeId: parsedAnime || undefined,
        episodeNumbers: epNums,
        types,
        knownTitles: knownTitles.split(",").map((t) => t.trim()).filter(Boolean),
        callbackUrl: callbackUrl.trim() || undefined,
      };

      const res = await fetch("/api/pipeline/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to enqueue jobs");
      }

      onSuccess();
      onClose();
    } catch (err: any) {
      setError(err?.message || "Failed to enqueue jobs");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#161724] border border-white/[0.1] rounded-3xl max-w-lg w-full p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        {/* AniLight Liquid Glass Close Button */}
        <button
          onClick={onClose}
          className="button-liquid-glass absolute right-4 top-4 text-neutral-400 hover:text-white transition-colors w-8 h-8 rounded-full flex items-center justify-center cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="mb-5">
          <div className="flex items-center gap-2.5">
            <h3 className="text-base font-bold text-white tracking-tight">
              Enqueue Anime Episode(s)
            </h3>
            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-white/[0.08] text-white border border-white/10">
              AniList Trigger
            </span>
          </div>
          <p className="text-xs text-neutral-400 mt-1">
            Trigger automated torrent discovery, audio extraction, and Kaggle GPU batch encoding.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-2xl bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Hero Input: AniList ID */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-neutral-200 font-semibold flex items-center gap-1.5">
                AniList ID or URL <span className="text-white">*</span>
              </label>
              {preview?.anilistId && (
                <a
                  href={`https://anilist.co/anime/${preview.anilistId}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] font-mono text-neutral-300 hover:text-white hover:underline inline-flex items-center gap-1"
                >
                  View on AniList <ExternalLink className="w-2.5 h-2.5" />
                </a>
              )}
            </div>
            <div className="relative">
              <input
                type="text"
                placeholder="e.g. 16498 or https://anilist.co/anime/16498"
                value={anilistInput}
                onChange={(e) => handleAnilistChange(e.target.value)}
                className="w-full px-3.5 py-2.5 rounded-2xl bg-[#10111a] border border-white/[0.1] text-white placeholder-neutral-500 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 font-mono transition-all text-sm"
                required
              />
              {resolving && (
                <div className="absolute right-3.5 top-3 text-neutral-400 flex items-center gap-1 text-[11px] animate-pulse">
                  <Sparkles className="w-3.5 h-3.5 text-white animate-spin" />
                  Resolving...
                </div>
              )}
            </div>
          </div>

          {/* Metadata Preview Card */}
          {preview && (
            <div className="p-3.5 rounded-2xl bg-[#10111a] border border-white/[0.08] flex items-center gap-3.5">
              {preview.coverImage ? (
                <img
                  src={preview.coverImage}
                  alt={preview.primaryTitle}
                  className="w-12 h-16 object-cover rounded-xl shrink-0 border border-white/[0.08]"
                />
              ) : (
                <div className="w-12 h-16 rounded-xl bg-neutral-800 flex items-center justify-center shrink-0">
                  <Image className="w-5 h-5 text-neutral-500" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-bold text-white truncate">
                  {preview.primaryTitle}
                </h4>
                <div className="flex flex-wrap items-center gap-1.5 mt-1.5 text-[10px] font-mono">
                  {preview.anidbId && (
                    <span className="px-2 py-0.5 rounded-full bg-white/[0.05] text-neutral-300 border border-white/[0.06]">
                      AniDB #{preview.anidbId}
                    </span>
                  )}
                  {preview.animeId && (
                    <span className="px-2 py-0.5 rounded-full bg-white/[0.05] text-neutral-300 border border-white/[0.06]">
                      AnimeId #{preview.animeId}
                    </span>
                  )}
                  {preview.totalEpisodes && (
                    <span className="px-2 py-0.5 rounded-full bg-white/[0.08] text-white border border-white/10">
                      {preview.totalEpisodes} Episodes Total
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Episode Range with Quick Presets */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-neutral-200 font-semibold">
                Episodes to Encode <span className="text-white">*</span>
              </label>
              {/* Presets */}
              <div className="flex items-center gap-1.5 text-[11px] font-mono">
                <button
                  type="button"
                  onClick={() => setEpisodes("1")}
                  className="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-neutral-300 hover:text-white hover:bg-white/[0.12] border border-white/[0.08] transition-colors"
                >
                  Ep 1
                </button>
                <button
                  type="button"
                  onClick={() => setEpisodes("1-12")}
                  className="px-2.5 py-0.5 rounded-full bg-white/[0.06] text-neutral-300 hover:text-white hover:bg-white/[0.12] border border-white/[0.08] transition-colors"
                >
                  1-12
                </button>
                {preview?.totalEpisodes && (
                  <button
                    type="button"
                    onClick={() => setEpisodes(`1-${preview.totalEpisodes}`)}
                    className="px-2.5 py-0.5 rounded-full bg-white/[0.1] text-white hover:bg-white/[0.18] border border-white/15 transition-colors font-bold"
                  >
                    All ({preview.totalEpisodes})
                  </button>
                )}
              </div>
            </div>
            <input
              type="text"
              placeholder="e.g. 1 or 1-12 or 1, 2, 3"
              value={episodes}
              onChange={(e) => setEpisodes(e.target.value)}
              className="w-full px-3.5 py-2.5 rounded-2xl bg-[#10111a] border border-white/[0.1] text-white placeholder-neutral-500 focus:outline-none focus:border-white/40 focus:ring-1 focus:ring-white/20 font-mono transition-all"
              required
            />
          </div>

          {/* Audio Types */}
          <div>
            <label className="block text-neutral-200 font-semibold mb-1.5">
              Audio / Release Formats
            </label>
            <div className="grid grid-cols-2 gap-2">
              <label
                className={`flex items-center gap-2.5 p-3 rounded-2xl border cursor-pointer transition-all ${
                  isSub
                    ? "bg-white/[0.08] border-white/20 text-white"
                    : "bg-[#10111a] border-white/[0.06] text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSub}
                  onChange={(e) => setIsSub(e.target.checked)}
                  className="rounded border-neutral-700 text-white focus:ring-0"
                />
                <div>
                  <div className="font-semibold text-xs">Sub (Japanese)</div>
                  <div className="text-[10px] text-neutral-500">Includes English subtitles</div>
                </div>
              </label>

              <label
                className={`flex items-center gap-2.5 p-3 rounded-2xl border cursor-pointer transition-all ${
                  isDub
                    ? "bg-white/[0.08] border-white/20 text-white"
                    : "bg-[#10111a] border-white/[0.06] text-neutral-400 hover:text-neutral-200"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isDub}
                  onChange={(e) => setIsDub(e.target.checked)}
                  className="rounded border-neutral-700 text-white focus:ring-0"
                />
                <div>
                  <div className="font-semibold text-xs">Dub (Dual Audio)</div>
                  <div className="text-[10px] text-neutral-500">English audio track</div>
                </div>
              </label>
            </div>
          </div>

          {/* Advanced Accordion Toggle */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-neutral-400 hover:text-white text-xs font-medium cursor-pointer"
            >
              {showAdvanced ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
              <span>{showAdvanced ? "Hide Advanced Settings" : "Show Advanced Options"}</span>
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-3 pt-2 border-t border-white/[0.06]">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-neutral-400 text-[11px] mb-1">
                    AniDB ID (Internal Override)
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 18131"
                    value={overrideAnidbId}
                    onChange={(e) => setOverrideAnidbId(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-[#10111a] border border-white/[0.08] text-white font-mono text-xs focus:border-white/30"
                  />
                </div>
                <div>
                  <label className="block text-neutral-400 text-[11px] mb-1">
                    Main Anime ID (Optional)
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 502"
                    value={overrideAnimeId}
                    onChange={(e) => setOverrideAnimeId(e.target.value)}
                    className="w-full px-3 py-2 rounded-xl bg-[#10111a] border border-white/[0.08] text-white font-mono text-xs focus:border-white/30"
                  />
                </div>
              </div>

              <div>
                <label className="block text-neutral-400 text-[11px] mb-1">
                  Known Search Titles (Comma-separated)
                </label>
                <input
                  type="text"
                  placeholder="e.g. Bleach: Thousand-Year Blood War, Sennen Kessen-hen"
                  value={knownTitles}
                  onChange={(e) => setKnownTitles(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#10111a] border border-white/[0.08] text-white text-xs focus:border-white/30"
                />
              </div>

              <div>
                <label className="block text-neutral-400 text-[11px] mb-1">
                  Webhook Callback URL
                </label>
                <input
                  type="url"
                  placeholder="http://127.0.0.1:4000/internal/pipeline/completed"
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  className="w-full px-3 py-2 rounded-xl bg-[#10111a] border border-white/[0.08] text-white font-mono text-xs focus:border-white/30"
                />
              </div>
            </div>
          )}

          {/* Action Buttons */}
          <div className="pt-3 border-t border-white/[0.08] flex items-center justify-end gap-2.5">
            <button
              type="button"
              onClick={onClose}
              className="button-liquid-glass px-4 py-2 rounded-full text-neutral-300 hover:text-white transition-colors cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="button-glow px-6 py-2.5 rounded-full font-bold shadow-md transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-4 h-4 text-neutral-950" />
              <span>{loading ? "Enqueuing..." : "Enqueue Jobs"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
