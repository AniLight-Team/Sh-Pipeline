import React, { useState } from "react";
import { X, Plus, AlertCircle } from "lucide-react";

interface EnqueueModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function EnqueueModal({ isOpen, onClose, onSuccess }: EnqueueModalProps) {
  const [anidbId, setAnidbId] = useState("");
  const [episodes, setEpisodes] = useState("");
  const [isSub, setIsSub] = useState(true);
  const [isDub, setIsDub] = useState(false);
  const [knownTitles, setKnownTitles] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isOpen) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const parsedAnidb = parseInt(anidbId.trim(), 10);
    if (isNaN(parsedAnidb) || parsedAnidb <= 0) {
      setError("Please provide a valid AniDB ID (number)");
      return;
    }

    // Parse episodes list e.g. "1, 2, 3" or "1-4"
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
      setError("Please specify at least one episode number (e.g. 1 or 1-4)");
      return;
    }

    const types: ("sub" | "dub")[] = [];
    if (isSub) types.push("sub");
    if (isDub) types.push("dub");
    if (types.length === 0) {
      setError("Please select at least Sub or Dub");
      return;
    }

    setLoading(true);
    try {
      const res = await fetch("/api/pipeline/enqueue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anidbId: parsedAnidb,
          episodeNumbers: epNums,
          types,
          knownTitles: knownTitles.split(",").map((t) => t.trim()).filter(Boolean),
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error || "Failed to enqueue");
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
    <div className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl max-w-md w-full p-6 shadow-2xl relative">
        <button
          onClick={onClose}
          className="absolute right-4 top-4 text-zinc-400 hover:text-white transition"
        >
          <X className="w-5 h-5" />
        </button>

        <h3 className="text-base font-bold text-white mb-1">Enqueue AniDB Episode(s)</h3>
        <p className="text-xs text-zinc-400 mb-4">
          Manually dispatch episode downloads, MKV staging, and Kaggle GPU batch encoding.
        </p>

        {error && (
          <div className="mb-4 p-2.5 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-300 text-xs flex items-center gap-2">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4 text-xs">
          <div>
            <label className="block text-zinc-300 font-semibold mb-1">AniDB ID</label>
            <input
              type="number"
              placeholder="e.g. 18456"
              value={anidbId}
              onChange={(e) => setAnidbId(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono"
              required
            />
          </div>

          <div>
            <label className="block text-zinc-300 font-semibold mb-1">Episode(s)</label>
            <input
              type="text"
              placeholder="e.g. 1 or 1-4 or 1, 2, 3"
              value={episodes}
              onChange={(e) => setEpisodes(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500 font-mono"
              required
            />
          </div>

          <div>
            <label className="block text-zinc-300 font-semibold mb-1">Release Types</label>
            <div className="flex items-center gap-4 mt-1">
              <label className="flex items-center gap-2 text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isSub}
                  onChange={(e) => setIsSub(e.target.checked)}
                  className="rounded border-zinc-700 text-indigo-600 focus:ring-0"
                />
                <span>Sub (Japanese + Subs)</span>
              </label>
              <label className="flex items-center gap-2 text-zinc-300 cursor-pointer">
                <input
                  type="checkbox"
                  checked={isDub}
                  onChange={(e) => setIsDub(e.target.checked)}
                  className="rounded border-zinc-700 text-indigo-600 focus:ring-0"
                />
                <span>Dub (Dual Audio / Dub)</span>
              </label>
            </div>
          </div>

          <div>
            <label className="block text-zinc-300 font-semibold mb-1">Known Titles (Optional)</label>
            <input
              type="text"
              placeholder="e.g. Bleach, Sennen Kessen-hen (comma-separated)"
              value={knownTitles}
              onChange={(e) => setKnownTitles(e.target.value)}
              className="w-full px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 text-white placeholder-zinc-500 focus:outline-none focus:border-indigo-500"
            />
          </div>

          <div className="pt-2 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={loading}
              className="px-4 py-2 rounded-lg bg-indigo-600 text-white hover:bg-indigo-500 font-semibold shadow-md shadow-indigo-600/30 transition flex items-center gap-1.5"
            >
              {loading ? "Enqueuing..." : "Enqueue Jobs"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

