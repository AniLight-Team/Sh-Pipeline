import { useDialog } from "../hooks/useDialog.js";
import React, { useState, useEffect, useMemo, useRef } from "react";
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
  Link2,
  Search,
  Sparkles,
} from "lucide-react";

interface EnqueueModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: (message?: string) => void;
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
  source: string;
}

interface ManualTorrentPreview {
  id: number;
  name: string;
  btih: string;
  state?: string;
  totalsize?: number | null;
  filecount: number;
  episode_no?: number | null;
  audiolangs: string[];
  sublangs: string[];
  group?: { id: number; name: string } | null;
  anime?: {
    id?: number;
    title?: string;
    english_title?: string | null;
    anilist?: number | null;
    anidb?: number | null;
    mal?: number | null;
    total_episodes?: number | null;
    thumbnail?: string | null;
  } | null;
  seeders: number;
  leechers: number;
  resolution: string;
  videoCodec: string;
  expectedPipeline: "vm_remux" | "kaggle_gpu";
  isDualAudio: boolean;
  isEnglishDub: boolean;
}

function extractTsukihimeTorrentId(raw: string): number | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const urlMatch = trimmed.match(/\/torrents\/(\d+)(?:[/?#]|$)/i);
  if (urlMatch) {
    const num = Number.parseInt(urlMatch[1], 10);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  }
  if (/^\d+$/.test(trimmed)) {
    const num = Number.parseInt(trimmed, 10);
    return Number.isSafeInteger(num) && num > 0 ? num : null;
  }
  return null;
}

function formatBytesMb(bytes?: number | null): string {
  if (!bytes || bytes <= 0) return "—";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
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
  const [discoveryMode, setDiscoveryMode] = useState<"auto" | "manual">("auto");
  const [anilistInput, setAnilistInput] = useState("");
  const [episodes, setEpisodes] = useState("1");
  const [episodesTouched, setEpisodesTouched] = useState(false);
  const [showEpisodeGrid, setShowEpisodeGrid] = useState(true);
  const [isSub, setIsSub] = useState(true);
  const [isDub, setIsDub] = useState(true);
  const [loading, setLoading] = useState(false);
  const [resolving, setResolving] = useState(false);
  const [preview, setPreview] = useState<ResolvedPreview | null>(null);
  const [imgError, setImgError] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Manual Tsukihime torrent fields
  const [manualTorrentInput, setManualTorrentInput] = useState("");
  const [lookingUpTorrent, setLookingUpTorrent] = useState(false);
  const [manualTorrentPreview, setManualTorrentPreview] = useState<ManualTorrentPreview | null>(null);
  const [manualTorrentError, setManualTorrentError] = useState<string | null>(null);
  const torrentLookupSeq = useRef(0);

  // Advanced fields
  const [executionPolicy, setExecutionPolicy] = useState<
    "default" | "all" | "vm_remux_only" | "kaggle_gpu_only"
  >("default");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [overrideAnidbId, setOverrideAnidbId] = useState("");
  const [overrideAnimeId, setOverrideAnimeId] = useState("");

  useEffect(() => {
    if (!isOpen) {
      setError(null);
      setPreview(null);
      setResolving(false);
      setImgError(false);
      setManualTorrentPreview(null);
      setManualTorrentError(null);
      setLookingUpTorrent(false);
      setEpisodesTouched(false);
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

  useDialog(isOpen, onClose);
  if (!isOpen) return null;

  const toggleEpisodeNumber = (ep: number) => {
    setEpisodesTouched(true);
    const next = new Set(selectedEpisodeSet);
    if (next.has(ep)) {
      next.delete(ep);
    } else {
      next.add(ep);
    }
    setEpisodes(formatEpisodeArray(Array.from(next)));
  };

  const handleLookupManualTorrent = async (rawValue = manualTorrentInput) => {
    const parsedId = extractTsukihimeTorrentId(rawValue);
    if (!parsedId) {
      setManualTorrentPreview(null);
      setManualTorrentError(rawValue.trim() ? "Enter a numeric Tsukihime torrent ID (e.g. 41031) or URL." : null);
      return;
    }
    const seq = ++torrentLookupSeq.current;
    setLookingUpTorrent(true);
    setManualTorrentError(null);
    try {
      const res = await fetch(`/api/tsukihime/torrents/${parsedId}`);
      const json = await res.json().catch(() => null);
      if (seq !== torrentLookupSeq.current) return;
      if (!res.ok || !json?.torrent) {
        setManualTorrentPreview(null);
        setManualTorrentError(json?.error || `Tsukihime torrent #${parsedId} was not found.`);
        return;
      }
      const torrent: ManualTorrentPreview = json.torrent;
      setManualTorrentPreview(torrent);
      if (!anilistInput.trim() && torrent.anime?.anilist) {
        const autoAnilist = String(torrent.anime.anilist);
        setAnilistInput(autoAnilist);
        void handleResolve(torrent.anime.anilist);
      }
      if (!episodesTouched && torrent.episode_no && torrent.episode_no > 0) {
        setEpisodes(String(torrent.episode_no));
      }
    } catch {
      if (seq !== torrentLookupSeq.current) return;
      setManualTorrentPreview(null);
      setManualTorrentError("Could not reach Tsukihime torrent lookup endpoint.");
    } finally {
      if (seq === torrentLookupSeq.current) setLookingUpTorrent(false);
    }
  };

  const handleManualTorrentInputChange = (val: string) => {
    setManualTorrentInput(val);
    setManualTorrentError(null);
    const parsedId = extractTsukihimeTorrentId(val);
    if (parsedId) {
      void handleLookupManualTorrent(val);
    } else {
      torrentLookupSeq.current++;
      setLookingUpTorrent(false);
      setManualTorrentPreview(null);
    }
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

    const parsedManualTorrentId =
      discoveryMode === "manual"
        ? extractTsukihimeTorrentId(manualTorrentInput)
        : null;
    if (discoveryMode === "manual" && !parsedManualTorrentId) {
      setError("Please enter a valid numeric Tsukihime torrent ID (e.g. 41031)");
      return;
    }

    const parsedAnilist =
      extractAnilistId(anilistInput) ||
      (discoveryMode === "manual" ? manualTorrentPreview?.anime?.anilist || null : null);
    const parsedAnidb = overrideAnidbId
      ? parseInt(overrideAnidbId.trim(), 10)
      : preview?.anidbId || (discoveryMode === "manual" ? manualTorrentPreview?.anime?.anidb || undefined : undefined);
    const parsedAnime = overrideAnimeId
      ? parseInt(overrideAnimeId.trim(), 10)
      : preview?.animeId;

    if (!parsedAnilist && !parsedAnidb && !parsedManualTorrentId) {
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
        manualTsukihimeTorrentId: parsedManualTorrentId || undefined,
      };

      const res = await fetch("/api/pipeline/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(data?.error || "Failed to enqueue jobs");
      }

      if (parsedManualTorrentId) {
        const queuedCount = Array.isArray(data?.queuedJobs) ? data.queuedJobs.length : 0;
        if (queuedCount === 0 && Number(data?.skippedExisting ?? 0) > 0) {
          throw new Error("A matching job is already actively downloading or encoding. Wait for it to finish or retry it from Job Details.");
        }
        onSuccess(`Queued ${queuedCount} episode job(s) using Tsukihime torrent #${parsedManualTorrentId}.`);
      } else {
        onSuccess();
      }
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
      className="fixed inset-0 z-50 bg-[#302e2a]/35 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="surface-panel rounded-xl max-w-lg w-full p-6 shadow-2xl relative max-h-[92vh] overflow-y-auto">
        <button
          type="button"
          onClick={onClose}
          aria-label="Close modal"
          className="btn-secondary absolute right-4 top-4 w-8 h-8 rounded-lg flex items-center justify-center text-[#716c63] hover:text-[#302e2a] cursor-pointer"
        >
          <X className="w-4 h-4" />
        </button>

        <div className="mb-5 pr-8">
          <h3 id="enqueue-modal-title" className="text-base font-bold text-[#302e2a]">
            Enqueue Anime Episodes
          </h3>
          <p className="text-xs text-[#817a70] mt-1">
            Resolves Tsukihime & AnimeTosho releases, downloads same-group H.264 qualities, extracts 1080p subtitles to R2, and routes to VM Remux or Kaggle GPU.
          </p>
        </div>

        {error && (
          <div className="mb-4 p-3 rounded-lg bg-rose-500/10 border border-rose-500/25 text-[#ad4a3e] text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          {/* Discovery Mode Switcher */}
          <div>
            <span className="block text-[#302e2a] font-medium mb-1.5">
              Discovery Mode
            </span>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setDiscoveryMode("auto")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer flex items-start gap-2 ${
                  discoveryMode === "auto"
                    ? "bg-indigo-500/15 border-indigo-500/40 text-[#302e2a]"
                    : "bg-[#f5f3ed] border-[#e6e3db] text-[#716c63] hover:text-[#302e2a]"
                }`}
              >
                <Sparkles className="w-3.5 h-3.5 mt-0.5 text-[#9a563b] shrink-0" />
                <div>
                  <div className="font-semibold text-xs">Auto Discovery</div>
                  <div className="text-[11px] text-[#817a70]">
                    Search Tsukihime & AnimeTosho
                  </div>
                </div>
              </button>
              <button
                type="button"
                onClick={() => setDiscoveryMode("manual")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer flex items-start gap-2 ${
                  discoveryMode === "manual"
                    ? "bg-indigo-500/15 border-indigo-500/40 text-[#302e2a]"
                    : "bg-[#f5f3ed] border-[#e6e3db] text-[#716c63] hover:text-[#302e2a]"
                }`}
              >
                <Link2 className="w-3.5 h-3.5 mt-0.5 text-[#9a563b] shrink-0" />
                <div>
                  <div className="font-semibold text-xs">Manual Tsukihime ID</div>
                  <div className="text-[11px] text-[#817a70]">
                    Use a direct torrent ID (e.g. 41031)
                  </div>
                </div>
              </button>
            </div>
          </div>

          {/* Manual Tsukihime Torrent ID Input & Preview */}
          {discoveryMode === "manual" && (
            <div className="p-3.5 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] space-y-2.5">
              <div className="flex items-center justify-between">
                <label htmlFor="manual-torrent-id-input" className="text-[#302e2a] font-medium">
                  Tsukihime Torrent ID or URL
                </label>
                {manualTorrentPreview && (
                  <a
                    href={`https://api.tsukihime.org/v1/torrents/${manualTorrentPreview.id}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-mono text-[#9a563b] hover:underline inline-flex items-center gap-1"
                  >
                    <span>API #{manualTorrentPreview.id}</span>
                    <ExternalLink className="w-2.5 h-2.5" />
                  </a>
                )}
              </div>
              <div className="flex items-center gap-2">
                <input
                  id="manual-torrent-id-input"
                  type="text"
                  placeholder="e.g. 41031 or https://api.tsukihime.org/v1/torrents/41031"
                  value={manualTorrentInput}
                  onChange={(e) => handleManualTorrentInputChange(e.target.value)}
                  className="flex-1 px-3 py-2 rounded-lg bg-white border border-[#e6e3db] text-[#302e2a] placeholder-[#817a70] focus:outline-none focus:border-indigo-500 font-mono text-xs"
                  required={discoveryMode === "manual"}
                />
                <button
                  type="button"
                  disabled={lookingUpTorrent}
                  onClick={() => void handleLookupManualTorrent()}
                  className="btn-secondary px-3 py-2 rounded-lg text-xs font-medium inline-flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {lookingUpTorrent ? (
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  ) : (
                    <Search className="w-3.5 h-3.5" />
                  )}
                  <span>Lookup</span>
                </button>
              </div>
              {manualTorrentError && (
                <div className="text-[11px] text-[#ad4a3e] flex items-center gap-1.5">
                  <AlertCircle className="w-3.5 h-3.5 shrink-0" />
                  <span>{manualTorrentError}</span>
                </div>
              )}
              {manualTorrentPreview && (
                <div className="p-2.5 rounded-md bg-white border border-[#e6e3db] space-y-1.5">
                  <div className="font-mono text-[11px] text-[#302e2a] font-semibold break-all">
                    {manualTorrentPreview.name}
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-[#716c63]">
                    {manualTorrentPreview.group?.name && (
                      <span className="text-[#9a563b] font-semibold">
                        [{manualTorrentPreview.group.name}]
                      </span>
                    )}
                    <span>{manualTorrentPreview.resolution}</span>
                    <span>· {manualTorrentPreview.videoCodec.toUpperCase()}</span>
                    <span className={manualTorrentPreview.expectedPipeline === "vm_remux" ? "text-[#52734c]" : "text-[#9a563b]"}>
                      → {manualTorrentPreview.expectedPipeline === "vm_remux" ? "VM Remux" : "GPU Encode"}
                    </span>
                    <span>· {formatBytesMb(manualTorrentPreview.totalsize)}</span>
                    <span>· {manualTorrentPreview.filecount} file{manualTorrentPreview.filecount === 1 ? "" : "s"}</span>
                    <span>· {manualTorrentPreview.seeders} seed{manualTorrentPreview.seeders === 1 ? "" : "s"}</span>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px] font-mono text-[#817a70]">
                    <span>
                      Audio: {manualTorrentPreview.audiolangs.length ? manualTorrentPreview.audiolangs.join(", ") : "untagged"}
                    </span>
                    <span>
                      · Subs: {manualTorrentPreview.sublangs.length
                        ? `${manualTorrentPreview.sublangs.includes("en") ? "en" : manualTorrentPreview.sublangs[0]}${manualTorrentPreview.sublangs.length > 1 ? ` (+${manualTorrentPreview.sublangs.length - 1})` : ""}`
                        : "none"}
                    </span>
                    {manualTorrentPreview.episode_no ? <span>· Ep {manualTorrentPreview.episode_no}</span> : null}
                    {manualTorrentPreview.anime?.anilist ? <span>· AniList #{manualTorrentPreview.anime.anilist}</span> : null}
                  </div>
                  {manualTorrentPreview.anime?.anilist &&
                    extractAnilistId(anilistInput) &&
                    extractAnilistId(anilistInput) !== manualTorrentPreview.anime.anilist && (
                      <div className="text-[11px] text-amber-700 bg-amber-500/10 border border-amber-500/25 rounded px-2 py-1">
                        Note: Torrent links to AniList #{manualTorrentPreview.anime.anilist}, while you selected #{extractAnilistId(anilistInput)}. Your selected anime will be used.
                      </div>
                    )}
                </div>
              )}
            </div>
          )}

          {/* AniList ID Input */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label htmlFor="anilist-id-input" className="text-[#302e2a] font-medium">
                AniList ID or URL
              </label>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleAnilistChange("185874")}
                  className="text-[11px] font-mono text-[#9a563b] hover:underline cursor-pointer"
                >
                  Try #185874 (Bleach Cour 4)
                </button>
                {preview?.anilistId && (
                  <a
                    href={`https://anilist.co/anime/${preview.anilistId}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-[11px] font-mono text-[#716c63] hover:text-[#302e2a] inline-flex items-center gap-1"
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
                className="w-full px-3.5 py-2 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] text-[#302e2a] placeholder-[#817a70] focus:outline-none focus:border-indigo-500 font-mono text-xs transition-colors"
                required={discoveryMode === "auto"}
              />
              {resolving && (
                <div className="absolute right-3 top-2.5 text-[#716c63] flex items-center gap-1.5 text-[11px] font-mono">
                  <Loader2 className="w-3.5 h-3.5 text-[#9a563b] animate-spin" />
                  <span>Resolving...</span>
                </div>
              )}
            </div>
          </div>

          {/* Resolved Metadata Preview */}
          {preview && (
            <div className="p-3.5 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] flex items-center gap-3.5">
              {preview.coverImage && !imgError ? (
                <img
                  src={preview.coverImage}
                  alt={preview.primaryTitle}
                  referrerPolicy="no-referrer"
                  onError={() => setImgError(true)}
                  className="w-11 h-16 object-cover rounded-md shrink-0 border border-[#e6e3db]"
                />
              ) : (
                <div className="w-11 h-16 rounded-md bg-[#f0eee8] border border-[#e6e3db] flex items-center justify-center shrink-0">
                  <Film className="w-4 h-4 text-[#817a70]" />
                </div>
              )}
              <div className="flex-1 min-w-0">
                <h4 className="text-xs font-semibold text-[#302e2a] truncate">
                  {preview.primaryTitle}
                </h4>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1 mt-1 text-[11px] font-mono tabular-nums text-[#716c63]">
                  {preview.tsukihimeId && (
                    <span className="text-[#9a563b]">
                      Tsukihime #{preview.tsukihimeId}
                    </span>
                  )}
                  {preview.anidbId && <span>· AniDB #{preview.anidbId}</span>}
                  {preview.malId && <span>· MAL #{preview.malId}</span>}
                  {preview.totalEpisodes && (
                    <span className="text-[#302e2a]">
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
                <label htmlFor="episodes-input" className="text-[#302e2a] font-medium">
                  Episode Numbers
                </label>
                <span className="text-[11px] font-mono tabular-nums text-[#9a563b]">
                  ({selectedEpisodeSet.size} selected)
                </span>
              </div>
              <div className="flex items-center gap-1.5 text-[11px] font-mono">
                <button
                  type="button"
                  onClick={() => { setEpisodesTouched(true); setEpisodes("1"); }}
                  className="px-2 py-0.5 rounded bg-[#f0eee8] text-[#716c63] hover:text-[#302e2a] border border-[#ded8cd] cursor-pointer"
                >
                  Ep 1
                </button>
                <button
                  type="button"
                  onClick={() => { setEpisodesTouched(true); setEpisodes("1-10"); }}
                  className="px-2 py-0.5 rounded bg-[#f0eee8] text-[#716c63] hover:text-[#302e2a] border border-[#ded8cd] cursor-pointer"
                >
                  1-10
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEpisodesTouched(true);
                    setEpisodes(
                      `1-${preview?.totalEpisodes || gridCount}`,
                    );
                  }}
                  className="px-2 py-0.5 rounded bg-indigo-500/15 text-[#9a563b] border border-indigo-500/30 hover:bg-indigo-500/25 cursor-pointer"
                >
                  All ({preview?.totalEpisodes || gridCount})
                </button>
                <button
                  type="button"
                  onClick={() => setShowEpisodeGrid(!showEpisodeGrid)}
                  className="px-2 py-0.5 rounded bg-[#f0eee8] text-[#716c63] hover:text-[#302e2a] border border-[#ded8cd] inline-flex items-center gap-1 cursor-pointer"
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
              onChange={(e) => { setEpisodesTouched(true); setEpisodes(e.target.value); }}
              className="w-full px-3.5 py-2 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] text-[#302e2a] placeholder-[#817a70] focus:outline-none focus:border-indigo-500 font-mono text-xs transition-colors"
              required
            />

            {/* Interactive Visual Multi-Select Episode Grid */}
            {showEpisodeGrid && (
              <div className="mt-2.5 p-3 rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
                <div className="flex items-center justify-between text-[11px] font-mono text-[#817a70] mb-2">
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
                      className="text-[#716c63] hover:text-[#302e2a] underline cursor-pointer"
                    >
                      Invert
                    </button>
                    <button
                      type="button"
                      onClick={() => setEpisodes("")}
                      className="text-[#716c63] hover:text-[#302e2a] underline cursor-pointer"
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
                              ? "bg-indigo-500/25 border-indigo-500/60 text-[#302e2a]"
                              : "bg-[#12141c] border-[#e6e3db] text-[#716c63] hover:text-[#302e2a] hover:border-[#2e344a]"
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
            <span className="block text-[#302e2a] font-medium mb-1.5">
              Target Audio Tracks
            </span>
            <div className="grid grid-cols-2 gap-2.5">
              <label
                className={`flex items-center gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                  isSub
                    ? "bg-indigo-500/10 border-indigo-500/30 text-[#302e2a]"
                    : "bg-[#f5f3ed] border-[#e6e3db] text-[#716c63]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isSub}
                  onChange={(e) => setIsSub(e.target.checked)}
                  className="rounded border-[#d5d0c6]"
                />
                <div>
                  <div className="font-semibold text-xs">Sub (Japanese)</div>
                  <div className="text-[11px] text-[#817a70]">
                    1080p VTT subtitles to R2
                  </div>
                </div>
              </label>

              <label
                className={`flex items-center gap-2.5 p-3 rounded-lg border cursor-pointer transition-colors ${
                  isDub
                    ? "bg-indigo-500/10 border-indigo-500/30 text-[#302e2a]"
                    : "bg-[#f5f3ed] border-[#e6e3db] text-[#716c63]"
                }`}
              >
                <input
                  type="checkbox"
                  checked={isDub}
                  onChange={(e) => setIsDub(e.target.checked)}
                  className="rounded border-[#d5d0c6]"
                />
                <div>
                  <div className="font-semibold text-xs">Dub (English)</div>
                  <div className="text-[11px] text-[#817a70]">
                    Dual-audio + signs track
                  </div>
                </div>
              </label>
            </div>
          </div>

          {/* Pipeline Execution Policy Override */}
          <div>
            <span className="block text-[#302e2a] font-medium mb-1.5">
              Pipeline Execution Trigger Policy
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setExecutionPolicy("default")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  executionPolicy === "default"
                    ? "bg-indigo-500/15 border-indigo-500/40 text-[#302e2a]"
                    : "bg-[#f5f3ed] border-[#e6e3db] text-[#716c63] hover:text-[#302e2a]"
                }`}
              >
                <div className="font-semibold text-xs">Follow Global Policy</div>
                <div className="text-[11px] text-[#817a70]">
                  Uses active dashboard trigger mode
                </div>
              </button>

              <button
                type="button"
                onClick={() => setExecutionPolicy("all")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  executionPolicy === "all"
                    ? "bg-indigo-500/15 border-indigo-500/40 text-[#302e2a]"
                    : "bg-[#f5f3ed] border-[#e6e3db] text-[#716c63] hover:text-[#302e2a]"
                }`}
              >
                <div className="font-semibold text-xs">Both Pipelines (Auto)</div>
                <div className="text-[11px] text-[#817a70]">
                  H.264 -&gt; VM Remux · HEVC -&gt; GPU
                </div>
              </button>

              <button
                type="button"
                onClick={() => setExecutionPolicy("vm_remux_only")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  executionPolicy === "vm_remux_only"
                    ? "bg-emerald-500/15 border-emerald-500/40 text-emerald-200"
                    : "bg-[#f5f3ed] border-[#e6e3db] text-[#716c63] hover:text-[#302e2a]"
                }`}
              >
                <div className="font-semibold text-xs">
                  Pipeline 1 Only (VM H.264)
                </div>
                <div className="text-[11px] text-[#817a70]">
                  Marks non-H.264 anime as Skipped
                </div>
              </button>

              <button
                type="button"
                onClick={() => setExecutionPolicy("kaggle_gpu_only")}
                className={`p-2.5 rounded-lg border text-left transition-colors cursor-pointer ${
                  executionPolicy === "kaggle_gpu_only"
                    ? "bg-violet-500/15 border-violet-500/40 text-violet-200"
                    : "bg-[#f5f3ed] border-[#e6e3db] text-[#716c63] hover:text-[#302e2a]"
                }`}
              >
                <div className="font-semibold text-xs">
                  Pipeline 2 Only (Kaggle GPU)
                </div>
                <div className="text-[11px] text-[#817a70]">
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
              className="flex items-center gap-1.5 text-[#716c63] hover:text-[#302e2a] text-xs font-medium cursor-pointer"
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
            <div className="space-y-3 pt-3 border-t border-[#e6e3db]">
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block text-[#716c63] text-[11px] mb-1">
                    AniDB ID Override
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 19079"
                    value={overrideAnidbId}
                    onChange={(e) => setOverrideAnidbId(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] text-[#302e2a] font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-[#716c63] text-[11px] mb-1">
                    Main DB Anime ID
                  </label>
                  <input
                    type="number"
                    placeholder="e.g. 502"
                    value={overrideAnimeId}
                    onChange={(e) => setOverrideAnimeId(e.target.value)}
                    className="w-full px-3 py-1.5 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] text-[#302e2a] font-mono text-xs focus:outline-none focus:border-indigo-500"
                  />
                </div>
              </div>

            </div>
          )}

          {/* Submit Footer */}
          <div className="pt-4 border-t border-[#e6e3db] flex items-center justify-end gap-2">
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
