import { gotScraping } from "got-scraping";
import PQueue from "p-queue";
import type {
  AnimeToshoItem,
  ReleaseCandidateBundle,
  VideoResolutionQuality,
} from "./types.js";
import type { FetchTorrentsOptions } from "./animetosho.client.js";
import { ReleaseFilter } from "./release-filter.js";
import { log } from "../utils/logger.js";

export interface TsukihimeAnime {
  id: number;
  title: string;
  english_title?: string | null;
  thumbnail?: string | null;
  synopsis?: string | null;
  genres?: string[];
  studios?: string[];
  release_year?: number | null;
  anilist?: number | null;
  mal?: number | null;
  anidb?: number | null;
  is_movie?: number;
  total_episodes?: number | null;
  air_status?: number;
}

export interface TsukihimeTorrentEntry {
  id: number;
  state?: string;
  has_nzb?: number;
  main_source?: number;
  nyaa_id?: number;
  sukebei_id?: number;
  nekobt_id?: number;
  tt_id?: number;
  name: string;
  btih: string;
  is_adult?: number;
  totalsize?: number;
  filecount?: number;
  audiolangs?: string[];
  sublangs?: string[];
  episode_no?: number | null;
  source_date?: number;
  added_date?: number;
  group?: {
    id: number;
    name: string;
    is_fansub?: number;
  } | null;
  trackers?: {
    tier?: number;
    lastupdate?: number;
    seeders?: number;
    leechers?: number;
    complete?: number;
    error?: number;
    url?: string;
  }[];
}

export interface TsukihimeAnimeLookup {
  tsukihimeId?: number | null;
  anilistId?: number | null;
  malId?: number | null;
  anidbId?: number | null;
}

const TSUKIHIME_BASE_URL = "https://api.tsukihime.org/v1";

const DEFAULT_ANIME_TRACKERS = [
  "http://nyaa.tracker.wf:7777/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "http://tracker.anirena.com:80/announce",
  "udp://open.demonii.com:1337/announce",
];

// Rate limit: 100 req/min, 60 req/30s, 25 req/10s -> cap at 15 req/10s with concurrency 4
const tsukihimeQueue = new PQueue({
  concurrency: 4,
  interval: 10_000,
  intervalCap: 15,
});

// Cache resolved Tsukihime anime metadata (1 hour TTL)
const animeLookupCache = new Map<string, { data: TsukihimeAnime; expiresAt: number }>();

export class TsukihimeClient {
  private static cacheAnime(anime: TsukihimeAnime): void {
    const entry = { data: anime, expiresAt: Date.now() + 3600_000 };
    animeLookupCache.set(`id:${anime.id}`, entry);
    if (anime.anilist) animeLookupCache.set(`anilist:${anime.anilist}`, entry);
    if (anime.mal) animeLookupCache.set(`mal:${anime.mal}`, entry);
    if (anime.anidb) animeLookupCache.set(`anidb:${anime.anidb}`, entry);
  }

  private static async requestJson<T = any>(path: string, retries = 3): Promise<T | null> {
    const url = `${TSUKIHIME_BASE_URL}${path.startsWith("/") ? path : `/${path}`}`;
    return tsukihimeQueue.add(async () => {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          const res = await gotScraping({
            url,
            method: "GET",
            responseType: "json",
            timeout: { request: 15_000 },
            throwHttpErrors: false,
            headers: {
              Accept: "application/json",
              "User-Agent": "AniLight-Pipeline/2.0",
            },
          });

          if (res.statusCode === 200 && res.body) {
            return res.body as T;
          }

          if (res.statusCode === 404) {
            return null;
          }

          if (res.statusCode === 429) {
            const retryAfterSec = Number(res.headers["retry-after"] || 3);
            const waitMs = Math.max(1500, (isNaN(retryAfterSec) ? 3 : retryAfterSec) * 1000);
            log.warn("Tsukihime", `Rate limited (429) on ${path}, retrying in ${waitMs}ms...`);
            await new Promise((r) => setTimeout(r, waitMs));
            continue;
          }

          if (attempt === retries) {
            return null;
          }
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        } catch (err: any) {
          if (attempt === retries) {
            log.warn("Tsukihime", `Request failed for ${path}: ${err?.message || err}`);
            return null;
          }
          await new Promise((r) => setTimeout(r, 1000 * attempt));
        }
      }
      return null;
    }) as Promise<T | null>;
  }

  /**
   * Resolves Tsukihime internal anime metadata using the priority cascade:
   * 1. /animes/anilist/{anilistId}
   * 2. /animes/mal/{malId}
   * 3. /animes/anidb/{anidbId}
   */
  public static async resolveAnime(lookup: TsukihimeAnimeLookup): Promise<TsukihimeAnime | null> {
    const { tsukihimeId, anilistId, malId, anidbId } = lookup;
    const now = Date.now();

    if (tsukihimeId && tsukihimeId > 0) {
      const cached = animeLookupCache.get(`id:${tsukihimeId}`);
      if (cached && cached.expiresAt > now) return cached.data;
    }
    if (anilistId && anilistId > 0) {
      const cached = animeLookupCache.get(`anilist:${anilistId}`);
      if (cached && cached.expiresAt > now) return cached.data;
    }
    if (malId && malId > 0) {
      const cached = animeLookupCache.get(`mal:${malId}`);
      if (cached && cached.expiresAt > now) return cached.data;
    }
    if (anidbId && anidbId > 0) {
      const cached = animeLookupCache.get(`anidb:${anidbId}`);
      if (cached && cached.expiresAt > now) return cached.data;
    }

    // 1. Try AniList ID first
    if (anilistId && anilistId > 0) {
      const data = await this.requestJson<TsukihimeAnime>(`/animes/anilist/${anilistId}`);
      if (data && typeof data.id === "number" && data.id > 0) {
        this.cacheAnime(data);
        log.info(
          "Tsukihime",
          `Resolved AniList #${anilistId} -> Tsukihime #${data.id} ("${data.title}", eps=${data.total_episodes ?? "?"})`,
        );
        return data;
      }
    }

    // 2. Fallback to MAL ID
    if (malId && malId > 0) {
      const data = await this.requestJson<TsukihimeAnime>(`/animes/mal/${malId}`);
      if (data && typeof data.id === "number" && data.id > 0) {
        this.cacheAnime(data);
        log.info(
          "Tsukihime",
          `Resolved MAL #${malId} -> Tsukihime #${data.id} ("${data.title}", eps=${data.total_episodes ?? "?"})`,
        );
        return data;
      }
    }

    // 3. Fallback to AniDB ID
    if (anidbId && anidbId > 0) {
      const data = await this.requestJson<TsukihimeAnime>(`/animes/anidb/${anidbId}`);
      if (data && typeof data.id === "number" && data.id > 0) {
        this.cacheAnime(data);
        log.info(
          "Tsukihime",
          `Resolved AniDB #${anidbId} -> Tsukihime #${data.id} ("${data.title}", eps=${data.total_episodes ?? "?"})`,
        );
        return data;
      }
    }

    return null;
  }

  public static buildMagnetUri(
    btih: string,
    title: string,
    extraTrackers: string[] = [],
  ): string {
    const cleanHash = btih.trim().toLowerCase();
    const dn = encodeURIComponent(title);
    const trackers = Array.from(new Set([...extraTrackers, ...DEFAULT_ANIME_TRACKERS])).filter(Boolean);
    const trParams = trackers.map((tr) => `&tr=${encodeURIComponent(tr)}`).join("");
    return `magnet:?xt=urn:btih:${cleanHash}&dn=${dn}${trParams}`;
  }

  public static toAnimeToshoItem(entry: TsukihimeTorrentEntry): AnimeToshoItem {
    const extraTrackers = Array.isArray(entry.trackers)
      ? entry.trackers
          .filter((t) => t && t.url && !t.error)
          .map((t) => t.url!)
      : [];

    let seeders = 15; // Default baseline for completed Tsukihime entries before tracker hydration
    let leechers = 0;

    if (Array.isArray(entry.trackers) && entry.trackers.length > 0) {
      const maxSeed = entry.trackers.reduce((m, t) => Math.max(m, t.seeders || 0), 0);
      const maxLeech = entry.trackers.reduce((m, t) => Math.max(m, t.leechers || 0), 0);
      seeders = maxSeed > 0 ? maxSeed : entry.state === "completed" ? 2 : 0;
      leechers = maxLeech;
    }

    return {
      id: entry.id,
      title: entry.name,
      info_hash: entry.btih,
      magnet_uri: this.buildMagnetUri(entry.btih, entry.name, extraTrackers),
      size: entry.totalsize || 0,
      num_files: entry.filecount || 1,
      date: entry.source_date || entry.added_date || 0,
      seeders,
      leechers,
      provider: "tsukihime",
      tsukihime_id: entry.id,
      tsukihime_episode_no:
        typeof entry.episode_no === "number" && !isNaN(entry.episode_no)
          ? entry.episode_no
          : null,
      audiolangs: Array.isArray(entry.audiolangs) ? entry.audiolangs : undefined,
      sublangs: Array.isArray(entry.sublangs) ? entry.sublangs : undefined,
      group_name: entry.group?.name || undefined,
    };
  }

  /**
   * Queries /v1/animes/{internalId}/episodes/{episodeNumber} for torrents mapped to a specific relative episode.
   */
  public static async fetchEpisodeTorrents(
    tsukihimeId: number,
    episodeNum: number,
  ): Promise<AnimeToshoItem[]> {
    log.info("Tsukihime", `Querying /animes/${tsukihimeId}/episodes/${episodeNum}...`);
    const body = await this.requestJson<{
      total?: number;
      results?: TsukihimeTorrentEntry[];
      error?: boolean;
    }>(`/animes/${tsukihimeId}/episodes/${episodeNum}`);

    if (!body || body.error || !Array.isArray(body.results)) {
      return [];
    }

    return body.results
      .filter((r) => r && r.btih && r.name && !r.is_adult)
      .map((r) => this.toAnimeToshoItem(r));
  }

  /**
   * Paginates /v1/animes/{internalId}?limit=50&offset=... for all torrents belonging to the anime.
   */
  public static async fetchAllAnimeTorrents(
    tsukihimeId: number,
    options: FetchTorrentsOptions = {},
  ): Promise<AnimeToshoItem[]> {
    const {
      targetEp,
      langType = "all",
      knownTitles = [],
      episodeCount = null,
      maxPages = 6,
    } = options;

    const limit = 50;
    const allItems: AnimeToshoItem[] = [];
    const seenHashes = new Set<string>();
    const targetEpNum =
      typeof targetEp === "number" && !isNaN(targetEp) && targetEp > 0
        ? targetEp
        : null;

    for (let page = 1; page <= maxPages; page++) {
      const offset = (page - 1) * limit;
      log.info(
        "Tsukihime",
        `Querying /animes/${tsukihimeId}?limit=${limit}&offset=${offset} (page ${page}/${maxPages})...`,
      );

      const body = await this.requestJson<{
        total?: number;
        start?: number;
        limit?: number;
        error?: boolean;
        results?: TsukihimeTorrentEntry[];
      }>(`/animes/${tsukihimeId}?limit=${limit}&offset=${offset}`);

      if (!body || body.error || !Array.isArray(body.results) || body.results.length === 0) {
        break;
      }

      let added = 0;
      for (const entry of body.results) {
        if (!entry || !entry.btih || !entry.name || entry.is_adult) continue;
        const hashKey = entry.btih.toLowerCase();
        if (!seenHashes.has(hashKey)) {
          seenHashes.add(hashKey);
          allItems.push(this.toAnimeToshoItem(entry));
          added++;
        }
      }

      if (added === 0) break;

      if (targetEpNum !== null) {
        const candidates = ReleaseFilter.selectTopCandidates(
          allItems,
          targetEpNum,
          langType,
          {
            knownTitles,
            totalExpectedEps: episodeCount,
            maxCandidates: 4,
          },
        );
        const hasTopQuality = candidates.some(([item, effectiveEp]) =>
          ReleaseFilter.isHighQualityCandidate(item, effectiveEp, langType, knownTitles),
        );
        if (hasTopQuality && candidates.length >= 2) {
          log.success(
            "Tsukihime",
            `Found ${candidates.length} candidate(s) for Ep ${targetEpNum} on page ${page} of Tsukihime #${tsukihimeId}.`,
          );
          break;
        }
      }

      const total = typeof body.total === "number" ? body.total : 0;
      if (body.results.length < limit || (total > 0 && offset + body.results.length >= total)) {
        break;
      }
    }

    return allItems;
  }

  /**
   * High-level fetch that resolves Tsukihime internal ID (anilist -> mal -> anidb),
   * queries /animes/{id}/episodes/{targetEp} first, and paginates /animes/{id} if needed.
   */
  public static async fetchTorrents(
    lookup: TsukihimeAnimeLookup,
    options: FetchTorrentsOptions = {},
  ): Promise<{ anime: TsukihimeAnime | null; torrents: AnimeToshoItem[] }> {
    const anime = await this.resolveAnime(lookup);
    if (!anime) {
      return { anime: null, torrents: [] };
    }

    const {
      targetEp,
      langType = "all",
      knownTitles = [],
      episodeCount = anime.total_episodes || null,
    } = options;

    const mergedKnownTitles = Array.from(
      new Set(
        [
          ...(knownTitles || []),
          anime.title,
          anime.english_title,
        ].filter(Boolean) as string[],
      ),
    );

    const allItems: AnimeToshoItem[] = [];
    const seenHashes = new Set<string>();
    const addItems = (items: AnimeToshoItem[]) => {
      for (const item of items) {
        const key = (item.info_hash || item.title).toLowerCase();
        if (!seenHashes.has(key)) {
          seenHashes.add(key);
          allItems.push(item);
        }
      }
    };

    const targetEpNum =
      typeof targetEp === "number" && !isNaN(targetEp) && targetEp > 0
        ? targetEp
        : null;

    // 1. Query the episode-specific endpoint /animes/{id}/episodes/{episodeNum} first
    if (targetEpNum !== null) {
      const epItems = await this.fetchEpisodeTorrents(anime.id, targetEpNum);
      addItems(epItems);

      const epCandidates = ReleaseFilter.selectTopCandidates(
        allItems,
        targetEpNum,
        langType,
        {
          knownTitles: mergedKnownTitles,
          totalExpectedEps: episodeCount,
          maxCandidates: 4,
        },
      );

      const hasTopQuality = epCandidates.some(([item, effectiveEp]) =>
        ReleaseFilter.isHighQualityCandidate(item, effectiveEp, langType, mergedKnownTitles),
      );

      // If episode endpoint already yielded strong candidates, return immediately without full pagination
      if (hasTopQuality && epCandidates.length >= 2) {
        log.success(
          "Tsukihime",
          `Episode endpoint /animes/${anime.id}/episodes/${targetEpNum} yielded ${epItems.length} torrents (${epCandidates.length} top candidates).`,
        );
        return { anime, torrents: allItems };
      }
    }

    // 2. Also paginate /animes/{id}?limit=50&offset=... to catch batches or unindexed episode_no entries
    const paginatedItems = await this.fetchAllAnimeTorrents(anime.id, {
      ...options,
      knownTitles: mergedKnownTitles,
      episodeCount,
    });
    addItems(paginatedItems);

    return { anime, torrents: allItems };
  }

  /**
   * Enriches selected Tsukihime candidates via GET /v1/torrents/{id} to attach live tracker
   * seeders/leechers and full tracker announce URLs onto magnet_uri.
   */
  public static async hydrateCandidates(
    candidates: [AnimeToshoItem, number | string][],
  ): Promise<[AnimeToshoItem, number | string][]> {
    const hydrated: [AnimeToshoItem, number | string][] = [];
    for (const [item, effectiveEp] of candidates) {
      if (item.provider === "tsukihime" && item.tsukihime_id) {
        const detail = await this.requestJson<TsukihimeTorrentEntry>(
          `/torrents/${item.tsukihime_id}`,
        );
        if (detail) {
          const enriched = this.toAnimeToshoItem(detail);
          hydrated.push([
            {
              ...item,
              ...enriched,
              tsukihime_episode_no: item.tsukihime_episode_no ?? enriched.tsukihime_episode_no,
            },
            effectiveEp,
          ]);
          continue;
        }
      }
      hydrated.push([item, effectiveEp]);
    }
    return hydrated;
  }

  /**
   * Hydrates all quality entries (1080p, 720p, 480p) inside each ReleaseCandidateBundle
   * when sourced from Tsukihime.
   */
  public static async hydrateCandidateBundles(
    bundles: ReleaseCandidateBundle[],
  ): Promise<ReleaseCandidateBundle[]> {
    const out: ReleaseCandidateBundle[] = [];
    for (const bundle of bundles) {
      const nextQualities: ReleaseCandidateBundle["qualities"] = {};
      for (const qKey of ["1080p", "720p", "480p"] as VideoResolutionQuality[]) {
        const entry = bundle.qualities[qKey];
        if (!entry) continue;
        const item = entry.item;
        if (item.provider === "tsukihime" && item.tsukihime_id) {
          const detail = await this.requestJson<TsukihimeTorrentEntry>(
            `/torrents/${item.tsukihime_id}`,
          );
          if (detail) {
            const enriched = this.toAnimeToshoItem(detail);
            nextQualities[qKey] = {
              ...entry,
              item: {
                ...item,
                ...enriched,
                tsukihime_episode_no:
                  item.tsukihime_episode_no ?? enriched.tsukihime_episode_no,
              },
            };
            continue;
          }
        }
        nextQualities[qKey] = entry;
      }
      const primaryEntry =
        nextQualities["1080p"] ||
        nextQualities["720p"] ||
        nextQualities["480p"] ||
        bundle.primaryEntry;
      out.push({
        ...bundle,
        primaryEntry,
        qualities: nextQualities,
      });
    }
    return out;
  }
}
