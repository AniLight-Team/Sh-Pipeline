import React, { useEffect, useState } from "react";
import { Loader2, Plus, RefreshCw, Search, SlidersHorizontal, Trash2 } from "lucide-react";
import { api } from "../api.js";

interface AnimeDiscoveryRule {
  id: number;
  anilistId: number | null;
  animeId: number | null;
  episodeOffset: number;
  sourceTsukihimeId: number | null;
  sourceAnidbId: number | null;
  searchTitles: string[];
  notes: string | null;
  updatedAt?: string;
}

interface Props {
  onNotice?: (message: string) => void;
}

export function AnimeRulesPanel({ onNotice }: Props) {
  const [rules, setRules] = useState<AnimeDiscoveryRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [lookingUp, setLookingUp] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [anilistIdInput, setAnilistIdInput] = useState("");
  const [episodeOffsetInput, setEpisodeOffsetInput] = useState("1");
  const [tsukihimeIdInput, setTsukihimeIdInput] = useState("");
  const [anidbIdInput, setAnidbIdInput] = useState("");
  const [searchTitlesInput, setSearchTitlesInput] = useState("");
  const [notesInput, setNotesInput] = useState("");
  const [resolvedPreview, setResolvedPreview] = useState<{
    primaryTitle?: string;
    tsukihimeId?: number | null;
    anidbId?: number | null;
    animeId?: number | null;
  } | null>(null);

  const loadRules = async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ ok: boolean; rules: AnimeDiscoveryRule[] }>("/api/anime/rules");
      setRules(Array.isArray(data.rules) ? data.rules : []);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not load anime discovery rules.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void loadRules();
  }, []);

  const lookupAnilist = async () => {
    const id = Number.parseInt(anilistIdInput.trim(), 10);
    if (!Number.isSafeInteger(id) || id <= 0) {
      setError("Enter a valid numeric AniList ID first (e.g. 210482).");
      return;
    }
    setLookingUp(true);
    setError(null);
    try {
      const data = await api<{ ok: boolean; metadata: any }>(`/api/anime/resolve?anilistId=${id}`);
      const meta = data?.metadata;
      setResolvedPreview({
        primaryTitle: meta?.primaryTitle || meta?.knownTitles?.[0],
        tsukihimeId: meta?.tsukihimeId ?? null,
        anidbId: meta?.anidbId ?? null,
        animeId: meta?.animeId ?? null,
      });
      if (!tsukihimeIdInput.trim() && meta?.tsukihimeId) {
        setTsukihimeIdInput(String(meta.tsukihimeId));
      }
      if (!anidbIdInput.trim() && meta?.anidbId) {
        setAnidbIdInput(String(meta.anidbId));
      }
    } catch (e) {
      setResolvedPreview(null);
      setError(e instanceof Error ? e.message : "Could not resolve AniList metadata.");
    } finally {
      setLookingUp(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    const anilistId = Number.parseInt(anilistIdInput.trim(), 10);
    if (!Number.isSafeInteger(anilistId) || anilistId <= 0) {
      setError("Valid AniList ID is required.");
      return;
    }
    const episodeOffset = Number.parseInt(episodeOffsetInput.trim() || "0", 10);
    if (!Number.isSafeInteger(episodeOffset) || episodeOffset < 0 || episodeOffset > 5000) {
      setError("Episode offset must be an integer between 0 and 5000.");
      return;
    }
    const sourceTsukihimeId = tsukihimeIdInput.trim()
      ? Number.parseInt(tsukihimeIdInput.trim(), 10)
      : null;
    if (tsukihimeIdInput.trim() && (!Number.isSafeInteger(sourceTsukihimeId) || (sourceTsukihimeId ?? 0) <= 0)) {
      setError("Source Tsukihime ID must be a positive integer.");
      return;
    }
    const sourceAnidbId = anidbIdInput.trim()
      ? Number.parseInt(anidbIdInput.trim(), 10)
      : null;
    if (anidbIdInput.trim() && (!Number.isSafeInteger(sourceAnidbId) || (sourceAnidbId ?? 0) <= 0)) {
      setError("Source AniDB ID must be a positive integer.");
      return;
    }

    const searchTitles = searchTitlesInput
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    setSaving(true);
    setError(null);
    try {
      const data = await api<{ ok: boolean; rule: AnimeDiscoveryRule; message?: string }>("/api/anime/rules", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          anilistId,
          animeId: resolvedPreview?.animeId ?? null,
          episodeOffset,
          sourceTsukihimeId,
          sourceAnidbId,
          searchTitles,
          notes: notesInput.trim() || null,
        }),
      });
      onNotice?.(data.message || `Saved discovery rule for AniList #${anilistId}.`);
      setAnilistIdInput("");
      setEpisodeOffsetInput("1");
      setTsukihimeIdInput("");
      setAnidbIdInput("");
      setSearchTitlesInput("");
      setNotesInput("");
      setResolvedPreview(null);
      await loadRules();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save discovery rule.");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (rule: AnimeDiscoveryRule) => {
    setAnilistIdInput(rule.anilistId ? String(rule.anilistId) : "");
    setEpisodeOffsetInput(String(rule.episodeOffset ?? 0));
    setTsukihimeIdInput(rule.sourceTsukihimeId ? String(rule.sourceTsukihimeId) : "");
    setAnidbIdInput(rule.sourceAnidbId ? String(rule.sourceAnidbId) : "");
    setSearchTitlesInput((rule.searchTitles || []).join(", "));
    setNotesInput(rule.notes || "");
    setResolvedPreview(null);
    setError(null);
  };

  const handleDelete = async (rule: AnimeDiscoveryRule) => {
    setDeletingId(rule.id);
    setError(null);
    try {
      const data = await api<{ ok: boolean; message?: string }>(`/api/anime/rules/${rule.id}`, {
        method: "DELETE",
      });
      onNotice?.(data.message || `Deleted rule #${rule.id}.`);
      setRules((prev) => prev.filter((item) => item.id !== rule.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete rule.");
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <section className="panel" style={{ gridColumn: "1 / -1" }}>
      <div className="section-heading">
        <div>
          <span className="eyebrow">DISCOVERY OVERRIDES</span>
          <h2 className="flex items-center gap-2">
            <SlidersHorizontal size={15} className="text-[#9a563b]" />
            <span>Per-Anime Discovery Rules &amp; Episode Offsets</span>
          </h2>
        </div>
        <button
          type="button"
          className="icon-button"
          title="Refresh rules"
          aria-label="Refresh discovery rules"
          onClick={() => void loadRules()}
          disabled={loading}
        >
          <RefreshCw size={15} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <p className="empty-description" style={{ marginTop: 0 }}>
        Pin strict cumulative episode offsets (e.g. offset <code>+1</code> when torrent Ep 10 corresponds to local Ep 9),
        explicit Tsukihime/AniDB source IDs, or extra release search titles for split-stage or merged-numbering anime.
        Rules only apply to the configured AniList ID and never affect other series.
      </p>

      <form onSubmit={handleSave} className="p-4 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] space-y-3 mb-5">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          <div>
            <label className="text-[11px] text-[#716c63] block mb-1" htmlFor="rule-anilist-id">
              AniList ID *
            </label>
            <div className="flex gap-1.5">
              <input
                id="rule-anilist-id"
                type="number"
                min={1}
                placeholder="e.g. 210482"
                value={anilistIdInput}
                onChange={(e) => { setAnilistIdInput(e.target.value); setResolvedPreview(null); }}
                className="w-full px-2.5 py-2 rounded-md bg-white border border-[#d5d0c6] text-xs font-mono text-[#302e2a]"
                required
              />
              <button
                type="button"
                className="btn-secondary px-2.5 py-1.5"
                onClick={() => void lookupAnilist()}
                disabled={lookingUp || !anilistIdInput.trim()}
                title="Preview AniList metadata"
              >
                {lookingUp ? <Loader2 size={13} className="animate-spin" /> : <Search size={13} />}
              </button>
            </div>
          </div>

          <div>
            <label className="text-[11px] text-[#716c63] block mb-1" htmlFor="rule-offset">
              Episode Offset (+N) *
            </label>
            <input
              id="rule-offset"
              type="number"
              min={0}
              max={5000}
              value={episodeOffsetInput}
              onChange={(e) => setEpisodeOffsetInput(e.target.value)}
              className="w-full px-2.5 py-2 rounded-md bg-white border border-[#d5d0c6] text-xs font-mono text-[#302e2a]"
              required
            />
          </div>

          <div>
            <label className="text-[11px] text-[#716c63] block mb-1" htmlFor="rule-tsuki-id">
              Source Tsukihime ID (optional)
            </label>
            <input
              id="rule-tsuki-id"
              type="number"
              min={1}
              placeholder="e.g. 9388"
              value={tsukihimeIdInput}
              onChange={(e) => setTsukihimeIdInput(e.target.value)}
              className="w-full px-2.5 py-2 rounded-md bg-white border border-[#d5d0c6] text-xs font-mono text-[#302e2a]"
            />
          </div>

          <div>
            <label className="text-[11px] text-[#716c63] block mb-1" htmlFor="rule-anidb-id">
              Source AniDB ID (optional)
            </label>
            <input
              id="rule-anidb-id"
              type="number"
              min={1}
              placeholder="e.g. 19234"
              value={anidbIdInput}
              onChange={(e) => setAnidbIdInput(e.target.value)}
              className="w-full px-2.5 py-2 rounded-md bg-white border border-[#d5d0c6] text-xs font-mono text-[#302e2a]"
            />
          </div>
        </div>

        {resolvedPreview && (
          <div className="px-3 py-2 rounded-md bg-white border border-[#e6e3db] text-[11px] font-mono text-[#5b554a] flex flex-wrap gap-x-3 gap-y-1">
            <span className="font-semibold text-[#302e2a]">{resolvedPreview.primaryTitle || "Resolved"}</span>
            {resolvedPreview.tsukihimeId ? <span>Tsuki #{resolvedPreview.tsukihimeId}</span> : null}
            {resolvedPreview.anidbId ? <span>AniDB #{resolvedPreview.anidbId}</span> : null}
          </div>
        )}

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <div>
            <label className="text-[11px] text-[#716c63] block mb-1" htmlFor="rule-search-titles">
              Extra Search / Release Titles (comma or newline separated)
            </label>
            <input
              id="rule-search-titles"
              type="text"
              placeholder="e.g. JoJo no Kimyou na Bouken: Steel Ball Run, Steel Ball Run"
              value={searchTitlesInput}
              onChange={(e) => setSearchTitlesInput(e.target.value)}
              className="w-full px-2.5 py-2 rounded-md bg-white border border-[#d5d0c6] text-xs text-[#302e2a]"
            />
          </div>

          <div>
            <label className="text-[11px] text-[#716c63] block mb-1" htmlFor="rule-notes">
              Notes (optional)
            </label>
            <input
              id="rule-notes"
              type="text"
              placeholder="e.g. 2nd-3rd STAGE torrents include 1st STAGE as Ep 1"
              value={notesInput}
              onChange={(e) => setNotesInput(e.target.value)}
              className="w-full px-2.5 py-2 rounded-md bg-white border border-[#d5d0c6] text-xs text-[#302e2a]"
            />
          </div>
        </div>

        {error && (
          <div className="text-xs font-mono text-[#ad4a3e]" role="alert">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button type="submit" className="btn-primary" disabled={saving}>
            {saving ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
            <span>Save rule</span>
          </button>
        </div>
      </form>

      {loading && rules.length === 0 ? (
        <div className="text-xs text-[#817a70] flex items-center gap-2 py-3">
          <Loader2 size={14} className="animate-spin" /> Loading saved rules…
        </div>
      ) : rules.length === 0 ? (
        <p className="text-xs text-[#817a70] m-0">
          No per-anime discovery rules configured yet. Auto-detection still checks verified prequel chains safely.
        </p>
      ) : (
        <div className="space-y-2">
          {rules.map((rule) => (
            <div
              key={rule.id}
              className="p-3 rounded-lg bg-[#fffefa] border border-[#e6e3db] flex flex-wrap items-center justify-between gap-3"
            >
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                  <span className="font-semibold text-[#302e2a]">
                    {rule.anilistId ? `AniList #${rule.anilistId}` : `Anime #${rule.animeId}`}
                  </span>
                  <span className="px-2 py-0.5 rounded bg-[#fbf1e9] text-[#9a563b] font-semibold">
                    Offset +{rule.episodeOffset}
                  </span>
                  {rule.sourceTsukihimeId && (
                    <span className="text-[#5b554a]">Tsuki #{rule.sourceTsukihimeId}</span>
                  )}
                  {rule.sourceAnidbId && (
                    <span className="text-[#5b554a]">AniDB #{rule.sourceAnidbId}</span>
                  )}
                </div>
                {rule.searchTitles?.length > 0 && (
                  <div className="text-[11px] font-mono text-[#716c63] break-words">
                    Titles: {rule.searchTitles.join(" · ")}
                  </div>
                )}
                {rule.notes && <div className="text-[11px] text-[#817a70]">{rule.notes}</div>}
              </div>

              <div className="flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  className="btn-secondary px-2.5 py-1.5 text-[11px]"
                  onClick={() => handleEdit(rule)}
                >
                  Edit
                </button>
                <button
                  type="button"
                  className="btn-secondary px-2.5 py-1.5 text-[11px] text-[#ad4a3e]"
                  disabled={deletingId === rule.id}
                  onClick={() => void handleDelete(rule)}
                  aria-label={`Delete rule ${rule.id}`}
                >
                  {deletingId === rule.id ? (
                    <Loader2 size={13} className="animate-spin" />
                  ) : (
                    <Trash2 size={13} />
                  )}
                  <span>Delete</span>
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
