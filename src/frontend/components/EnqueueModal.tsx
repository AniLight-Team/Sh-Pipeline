import React, { useState, useEffect } from "react";
import {
  X,
  Plus,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Film,
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
  malId?: number;
  tsukihimeId?: number;
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
  const [isDub, setIsDub] = useState(true);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [preview, setPreview] = useState<ResolvedPreview | null>(null);
  const [imgError, setImgError] = useState(false);
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
      setImgError(false);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const extractAnilistId = (raw: string): number | null => {
    const trimmed = raw.trim();
    const urlMatch = trimmed.match(/anilist\.co\/anime\/(\d+)/i);
    if (urlMatch) return parseInt(urlMatch[1], 10);
    const num = parseInt(trimmed, 10);
    return !isNaN(num) && num > 0 ? num : null;
  };

  const handleResolve = async (idNum: number) => {
    setResolving(true);
    setError(null);
    setImgError(false);
    try {
      const res = await fetch(`/api/anime/resolve?anilistId=${idNum}`);
      if (res.ok) {
        const json = await res.json();
        if (json.metadata) {
          setPreview(json.metadata);
          if (json.metadata.anidbId) {
            setOverrideAnidbId(String(json.metadata.anidbId));
          }
          if (json.metadata.animeId) {
            setOverrideAnimeId(String(json.metadata.animeId));
          }
          if (json.metadata.synonyms?.length > 0) {
            setKnownTitles(json.metadata.synonyms.join(", "));
          }
        }
      }
    } catch {
      // Ignore preview lookup errors
    } finally {
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
      setError("Please specify at least one episode number (e.g. 1 or 1-10)");
      return;
    }

    const types: ("sub" | "dub")[] = [];
    if (isSub) types.push("sub");
    if (isDub) types.push("dub");
    if (types.length === 0) {
      setError("Please select at least one audio track (Sub or Dub)");
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
        knownTitles: knownTitles
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
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
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="enqueue-modal-title"
      className="fixed inset-0 z-50 bg-black/75 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="surface-panel rounded-xl max-w-lg w-full p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close modal"
          className="btn-secondary absolute right-4 top-4 w-8 h-8 rounded-lg flex items-center justify-center text-[#949bb0] hover:text-white cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="mb-5 pr-8">
          <h3 id="enqueue-modal-title" className="text-base font-bold text-[#f3f4f8]">
            Enqueue Anime Episodes
          </h3>
          <p className="text-xs text-[#636b82] mt-1">
            Resolves Tsukihime & AnimeTosho releases, extracts subtitles to R2, and stages MKVs for Kaggle GPU encoding.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/25 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* AniList ID Input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="anilist-id-input" className="text-[#f3f4f8] font-medium">
                AniList ID or URL
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleAnilistChange("185874")}
                  className="text-[11px] font-mono text-indigo-400 hover:underline cursor-pointer"
                >
                  Try #185874 (Bleach Cour 4)
                </button>
                {preview?.anilistId && (
                  <a
                    href={`https://anilist.co/anime/${preview.anilistId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-mono text-[#949bb0] hover:text-white inline-flex items-center gap-1"
                  >
                    <span>AniList</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}
              </div>
            </div>
            <div className="relative">
              <input
                id="anilist-id-input"
                type="text"
                placeholder="e.g. 185874 or https://anilist.co/anime/185874"
                value={anilistInput}
                onChange={(e) => handleAnilistChange(e.target.value)}
                className="w-full px-3.5 py-2 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-[#f3f4f8] placeholder-[#636b82] focus:outline-none focus:border-indigo-500 font-mono text-xs transition-colors"
                required
              />
              {resolving && (
                <div className="absolute right-3 top-2.5 text-[#949bb0] flex items-center gap-1.5 text-[11px] font-mono">
                  <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />
                  <span>Resolving...</span>
                </div>
              )}
            </div>
          </div>

          {/* Resolved Metadata Preview */}
          {preview && (
            <div className="p-3.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] flex items-center gap-3.5">
              {preview.coverImage && !imgError ? (
                <img
                  src={preview.coverImage}
                  alt={preview.primaryTitle}
                  referrerPolicy="no-referrer"
                  onError={() => setImgError(true)}
                  className="w-11 h-16 object-cover rounded-md shrink-0 border border-[#1e2230]"
                />
              ) : (
                <div className="w-11 h-16 rounded-md bg-[#151822] border border-[#1e2230] flex items-center justify-center shrink-0">
                  <Film className="w-4 h-4 text-[#636b82]" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-semibold text-[#f3f4f8] truncate">
                  {preview.primaryTitle}
                </h4>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] font-mono tabular-nums text-[#949bb0]">
                  {preview.tsukihimeId && (
                    <span className="text-indigo-400">Tsukihime #{preview.tsukihimeId}</span>
                  )}
                  {preview.anidbId && <span>· AniDB #{preview.anidbId}</span>}
                  {preview.malId && <span>· MAL #{preview.malId}</span>}
                  {preview.totalEpisodes && (
                    <span className="text-[#f3f4f8]">· {preview.totalEpisodes} eps</span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Episode Range */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="episodes-input" className="text-[#f3f4f8] font-medium">
                Episode Numbers
              </label>
              <div className="flex items-center gap-1.5 text-[11px] font-mono">
                <button
                  type="button"
                  onClick={() => setEpisodes("1")}
                  className="px-2 py-0.5 rounded bg-[#151822] text-[#949bb0] hover:text-white border border-[#232838] cursor-pointer"
                >
                  Ep 1
                </button>
                <button
                  type="button"
                  onClick={() => setEpisodes("1-10")}
                  className="px-2 py-0.5 rounded bg-[#151822] text-[#949bb0] hover:text-white border border-[#232838] cursor-pointer"
                >
                  1-10
                </button>
                {preview?.totalEpisodes && (
                  <button
                    type="button"
                    onClick={() => setEpisodes(`1-${preview.totalEpisodes}`)}
                    className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/25 cursor-pointer"
                  >
                    All ({preview.totalEpisodes})
                  </button>
                )}
              </div>
            </div>
            <input
              id="episodes-input"
              type="text"
              placeholder="e.g. 1 or 1-10 or 1, 2, 5"
              value={episodes}
              onChange={(e) => setEpisodes(e.target.value)}
              className="w-full px-3.5 py-2 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-[#f3f4f8] placeholder-[#636b82] focus:outline-none focus:border-indigo-500 font-mono text-xs transition-colors"
              required
            />
          </div>

          {/* Audio Track Selection */}
          <div>
            <span className="block text-[#f3f4f8] font-medium mb-1.5">
              Target Audio Tracks
            </span>
            <div className="grid grid-cols-2 gap-2.5">
              <label
                className={`flex items-center gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                  isSub
                    ? "bg-indigo-500/10 border-indigo-500/30 text-[#f3f4f8]"
                    : "bg-[#0c0e14] border-[#1e2230] text-[#949bb0]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSub}
                  onChange={(e) => setIsSub(e.target.checked)}
                  className="rounded border-[#2a3042]"
                />
                <div>
                  <div className="font-semibold text-xs">Sub (Japanese)</div>
                  <div className="text-[11px] text-[#636b82]">Full dialogue VTT subtitles</div>
                </div>
              </label>

              <label
                className={`flex items-center gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                  isDub
                    ? "bg-indigo-500/10 border-indigo-500/30 text-[#f3f4f8]"
                    : "bg-[#0c0e14] border-[#1e2230] text-[#949bb0]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isDub}
                  onChange={(e) => setIsDub(e.target.checked)}
                  className="rounded border-[#2a3042]"
                />
                <div>
                  <div className="font-semibold text-xs">Dub (English)</div>
                  <div className="text-[11px] text-[#636b82]">Dual-audio + signs track</div>
                </div>
              </label>
            </div>
          </div>

          {/* Advanced Overrides */}
          <div className="pt-1">
            <button
              type="button"
              onClick={() => setShowAdvanced(!showAdvanced)}
              className="flex items-center gap-1.5 text-[#949bb0] hover:text-white text-xs font-medium cursor-pointer"
            >
              {showAdvanced ? (
                <ChevronUp className="w-3.5 h-3.5" />
              ) : (
                <ChevronDown className="w-3.5 h-3.5" />
              )}
              <span>{showAdvanced ? "Hide Advanced Overrides" : "Show Advanced Overrides"}</span>
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-3 pt-3 border-t border-[#1e2230]">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[#949bb0] text-[11px] mb-1">
                    AniDB ID Override
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 19079"
                    value={overrideAnidbId}
                    onChange={(e) => setOverrideAnidbId(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-[#f3f4f8] font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-[#949bb0] text-[11px] mb-1">
                    Main DB Anime ID
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 502"
                    value={overrideAnimeId}
                    onChange={(e) => setOverrideAnimeId(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-[#f3f4f8] font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[#949bb0] text-[11px] mb-1">
                  Known Search Titles (Comma-separated)
                </label>
                <input
                  type="text"
                  placeholder="e.g. BLEACH: Thousand-Year Blood War - The Calamity"
                  value={knownTitles}
                  onChange={(e) => setKnownTitles(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-[#f3f4f8] text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>

              <div>
                <label className="block text-[#949bb0] text-[11px] mb-1">
                  Webhook Callback URL
                </label>
                <input
                  type="url"
                  placeholder="http://127.0.0.1:4000/api/internal/pipeline/completed"
                  value={callbackUrl}
                  onChange={(e) => setCallbackUrl(e.target.value)}
                  className="w-full px-3 py-1.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-[#f3f4f8] font-mono text-xs focus:outline-none focus:border-indigo-500"
                />
              </div>
            </div>
          )}

          {/* Submit Footer */}
          <div className="pt-4 border-t border-[#1e2230] flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-secondary px-4 py-2 rounded-lg text-xs font-medium cursor-pointer"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="btn-primary px-5 py-2 rounded-lg text-xs font-semibold flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{loading ? "Dispatching..." : "Enqueue Episodes"}</span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
