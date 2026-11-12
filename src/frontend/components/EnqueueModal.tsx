import React, { useState, useEffect, useMemo } from "react";
import {
  X,
  Plus,
  AlertCircle,
  Loader2,
  ChevronDown,
  ChevronUp,
  ExternalLink,
  Film,
  Grid,
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

function parseEpisodeString(input: string): number[] {
  const result = new Set<number>();
  for (const part of input.split(",")) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    if (trimmed.includes("-")) {
      const [start, end] = trimmed.split("-").map((x) => parseInt(x.trim(), 10));
      if (!isNaN(start) && !isNaN(end) && start > 0 && start <= end) {
        const cappedEnd = Math.min(end, start + 200);
        for (let n = start; n <= cappedEnd; n++) result.add(n);
      }
    } else {
      const n = parseInt(trimmed, 10);
      if (!isNaN(n) && n > 0) result.add(n);
    }
  }
  return Array.from(result).sort((a, b) => a - b);
}

function formatEpisodeArray(nums: number[]): string {
  const sorted = Array.from(new Set(nums))
    .filter((n) => n > 0)
    .sort((a, b) => a - b);
  if (sorted.length === 0) return "";
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
    } else {
      ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
      start = cur;
      prev = cur;
    }
  }
  ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
  return ranges.join(", ");
}

export function EnqueueModal({ isOpen, onClose, onSuccess }: EnqueueModalProps) {
  const [anilistInput, setAnilistInput] = useState("");
  const [episodes, setEpisodes] = useState("1");
  const [showEpisodeGrid, setShowEpisodeGrid] = useState(true);
  const [isSub, setIsSub] = useState(true);
  const [isDub, setIsDub] = useState(true);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [preview, setPreview] = useState<ResolvedPreview | null>(null);
  const [imgError, setImgError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Advanced fields
  const [executionPolicy, setExecutionPolicy] = useState<
    "default" | "all" | "vm_remux_only" | "kaggle_gpu_only"
  >("default");
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

  const selectedEpisodeSet = useMemo(
    () => new Set(parseEpisodeString(episodes)),
    [episodes],
  );

  const gridCount = useMemo(() => {
    const total = preview?.totalEpisodes || 12;
    return Math.min(Math.max(total, 10), 36);
  }, [preview?.totalEpisodes]);

  if (!isOpen) return null;

  const toggleEpisodeNumber = (ep: number) => {
    const next = new Set(selectedEpisodeSet);
    if (next.has(ep)) {
      next.delete(ep);
    } else {
      next.add(ep);
    }
    setEpisodes(formatEpisodeArray(Array.from(next)));
  };

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
    const parsedAnidb = overrideAnidbId
      ? parseInt(overrideAnidbId.trim(), 10)
      : preview?.anidbId;
    const parsedAnime = overrideAnimeId
      ? parseInt(overrideAnimeId.trim(), 10)
      : preview?.animeId;

    if (!parsedAnilist && !parsedAnidb) {
      setError("Please provide a valid AniList ID (or AniDB ID)");
      return;
    }

    const epNums = parseEpisodeString(episodes);

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
        executionPolicy:
          executionPolicy === "default" ? undefined : executionPolicy,
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
            Resolves Tsukihime & AnimeTosho releases, downloads same-group H.264 qualities, extracts 1080p subtitles to R2, and routes to VM Remux or Kaggle GPU.
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
                    <span className="text-indigo-400">
                      Tsukihime #{preview.tsukihimeId}
                    </span>
                  )}
                  {preview.anidbId && <span>· AniDB #{preview.anidbId}</span>}
                  {preview.malId && <span>· MAL #{preview.malId}</span>}
                  {preview.totalEpisodes && (
                    <span className="text-[#f3f4f8]">
                      · {preview.totalEpisodes} eps
                    </span>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Episode Range + Interactive Multi-Select Grid */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <div className="flex items-center gap-2">
                <label htmlFor="episodes-input" className="text-[#f3f4f8] font-medium">
                  Episode Numbers
                </label>
                <span className="text-[11px] font-mono tabular-nums text-indigo-300">
                  ({selectedEpisodeSet.size} selected)
                </span>
              </div>
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
                <button
                  type="button"
                  onClick={() =>
                    setEpisodes(
                      `1-${preview?.totalEpisodes || gridCount}`,
                    )
                  }
                  className="px-2 py-0.5 rounded bg-indigo-500/15 text-indigo-300 border border-indigo-500/30 hover:bg-indigo-500/25 cursor-pointer"
                >
                  All ({preview?.totalEpisodes || gridCount})
                </button>
                <button
                  type="button"
                  onClick={() => setShowEpisodeGrid(!showEpisodeGrid)}
                  className="px-2 py-0.5 rounded bg-[#151822] text-[#949bb0] hover:text-white border border-[#232838] inline-flex items-center gap-1 cursor-pointer"
                  title="Toggle interactive multi-select episode picker"
                >
                  <Grid className="w-3 h-3" />
                  <span>{showEpisodeGrid ? "Hide Grid" : "Grid"}</span>
                </button>
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

            {/* Interactive Visual Multi-Select Episode Grid */}
            {showEpisodeGrid && (
              <div className="mt-2.5 p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230]">
                <div className="flex items-center justify-between text-[11px] font-mono text-[#636b82] mb-2">
                  <span>Click episodes to toggle multi-selection:</span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        const inverted: number[] = [];
                        for (let i = 1; i <= gridCount; i++) {
                          if (!selectedEpisodeSet.has(i)) inverted.push(i);
                        }
                        setEpisodes(formatEpisodeArray(inverted));
                      }}
                      className="text-[#949bb0] hover:text-white underline cursor-pointer"
                    >
                      Invert
                    </button>
                    <button
                      type="button"
                      onClick={() => setEpisodes("")}
                      className="text-[#949bb0] hover:text-white underline cursor-pointer"
                    >
                      Clear
                    </button>
                  </div>
                </div>
                <div className="grid grid-cols-6 sm:grid-cols-10 gap-1.5">
                  {Array.from({ length: gridCount }, (_, i) => i + 1).map(
                    (epNum) => {
                      const active = selectedEpisodeSet.has(epNum);
                      return (
                        <button
                          key={epNum}
                          type="button"
                          onClick={() => toggleEpisodeNumber(epNum)}
                          className={`py-1.5 rounded text-[11px] font-mono tabular-nums font-medium border transition-colors cursor-pointer ${
                            active
                              ? "bg-indigo-500/25 border-indigo-500/60 text-white"
                              : "bg-[#12141c] border-[#1e2230] text-[#949bb0] hover:text-white hover:border-[#2e344a]"
                          }`}
                        >
                          {epNum}
                        </button>
                      );
                    },
                  )}
                </div>
              </div>
            )}
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
                  <div className="text-[11px] text-[#636b82]">
                    1080p VTT subtitles to R2
                  </div>
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
                  <div className="text-[11px] text-[#636b82]">
                    Dual-audio + signs track
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Pipeline Execution Policy Override */}
          <div>
            <span className="block text-[#f3f4f8] font-medium mb-1.5">
              Pipeline Execution Trigger Policy
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setExecutionPolicy("default")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  executionPolicy === "default"
                    ? "bg-indigo-500/15 border-indigo-500/40 text-[#f3f4f8]"
                    : "bg-[#0c0e14] border-[#1e2230] text-[#949bb0] hover:text-white"
                }`}
              >
                <div className="font-semibold text-xs">Follow Global Policy</div>
                <div className="text-[11px] text-[#636b82]">
                  Uses active dashboard trigger mode
                </div>
              </button>

              <button
                type="button"
                onClick={() => setExecutionPolicy("all")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  executionPolicy === "all"
                    ? "bg-indigo-500/15 border-indigo-500/40 text-[#f3f4f8]"
                    : "bg-[#0c0e14] border-[#1e2230] text-[#949bb0] hover:text-white"
                }`}
              >
                <div className="font-semibold text-xs">Both Pipelines (Auto)</div>
                <div className="text-[11px] text-[#636b82]">
                  H.264 -&gt; VM Remux · HEVC -&gt; GPU
                </div>
              </button>

              <button
                type="button"
                onClick={() => setExecutionPolicy("vm_remux_only")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  executionPolicy === "vm_remux_only"
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                    : "bg-[#0c0e14] border-[#1e2230] text-[#949bb0] hover:text-white"
                }`}
              >
                <div className="font-semibold text-xs">
                  Pipeline 1 Only (VM H.264)
                </div>
                <div className="text-[11px] text-[#636b82]">
                  Marks non-H.264 anime as Skipped
                </div>
              </button>

              <button
                type="button"
                onClick={() => setExecutionPolicy("kaggle_gpu_only")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  executionPolicy === "kaggle_gpu_only"
                    ? "bg-violet-500/15 border-violet-500/40 text-violet-200"
                    : "bg-[#0c0e14] border-[#1e2230] text-[#949bb0] hover:text-white"
                }`}
              >
                <div className="font-semibold text-xs">
                  Pipeline 2 Only (Kaggle GPU)
                </div>
                <div className="text-[11px] text-[#636b82]">
                  Marks H.264 anime as Skipped
                </div>
              </button>
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
              <span>
                {showAdvanced
                  ? "Hide Advanced Overrides"
                  : "Show Advanced Overrides"}
              </span>
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
              <span>
                {loading
                  ? "Dispatching..."
                  : `Enqueue ${selectedEpisodeSet.size || 1} Episode${selectedEpisodeSet.size === 1 ? "" : "s"}`}
              </span>
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
