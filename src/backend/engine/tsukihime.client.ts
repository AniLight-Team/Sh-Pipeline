import { setTimeout as delay } from "node:timers/promises";
import PQueue from "p-queue";
import type { AnimeToshoItem, ReleaseCandidateBundle, VideoResolutionQuality } from "./types.js";
import type { FetchTorrentsOptions } from "./animetosho.client.js";
import { canonicalDiscoveryTitles } from "./discovery-titles.js";
import { ReleaseFilter } from "./release-filter.js";
import { torrentInfoHash } from "./torrent-identity.js";
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
  name: string;
  btih: string;
  state?: string;
  has_nzb?: number;
  main_source?: number;
  nyaa_id?: number;
  sukebei_id?: number;
  nekobt_id?: number;
  tt_id?: number;
  is_adult?: number;
  totalsize?: number;
  filecount?: number;
  audiolangs?: string[];
  sublangs?: string[];
  episode_no?: number | null;
  source_date?: number;
  added_date?: number;
  anime?: Pick<TsukihimeAnime, "id" | "anilist" | "mal" | "anidb"> | null;
  group?: { id: number; name: string; is_fansub?: number } | null;
  trackers?: {
    tier?: number;
    lastupdate?: number;
    seeders?: number | null;
    leechers?: number | null;
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

export interface TsukihimeFetchOptions extends FetchTorrentsOptions {
  episodeAliases?: number[];
  quality?: VideoResolutionQuality;
  groupName?: string;
}

interface TorrentPage {
  results: TsukihimeTorrentEntry[];
  total?: number;
  start?: number;
  limit?: number;
  error?: boolean;
  anime?: TsukihimeAnime;
}

type Query = Record<string, string | number>;
const baseUrl = "https://api.tsukihime.org/v1";
const pageLimit = 50;
const trackers = [
  "http://nyaa.tracker.wf:7777/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "http://tracker.anirena.com:80/announce",
  "udp://open.demonii.com:1337/announce",
];
const queue = new PQueue({ concurrency: 8, interval: 10_000, intervalCap: 22 });
const animeCache = new Map<string, { anime: TsukihimeAnime; expiresAt: number }>();
let rateLimitedUntil = 0;

function pathWithQuery(path: string, query: Query) {
  return path + "?" + new URLSearchParams(Object.entries(query).map(([key, value]) => [key, String(value)]));
}

function isId(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function retryAfterMs(value: string | null) {
  if (!value?.trim()) return 3000;
  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - Date.now();
  return Number.isFinite(ms) ? Math.max(0, ms) : 3000;
}

function languageFilters(langType?: string): Query {
  const language = langType?.toLowerCase();
  if (language === "dub") return { audiolang: "en" };
  if (language === "sub") return { audiolang: "ja", sublang: "en" };
  return {};
}

function titleQuery(titles: (string | null | undefined)[], quality?: VideoResolutionQuality) {
  return [...new Set(titles.flatMap(title => {
    const words = title?.normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim().slice(0, 100);
    return words && words.length >= 2 ? [words + (quality ? " " + quality : "")] : [];
  }))].slice(0, 3).join(" | ");
}

export class TsukihimeClient {
  private static async requestJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    let failure: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted();
      const cooldown = rateLimitedUntil - Date.now();
      if (cooldown > 15_000) throw new Error("Tsukihime rate limit is still active");
      if (cooldown > 0) await delay(cooldown, undefined, { signal });
      let response: Response | undefined;
      try {
        response = await queue.add(async () => {
          if (Date.now() < rateLimitedUntil) throw new Error("Tsukihime rate limit is still active");
          const timeout = AbortSignal.timeout(15_000);
          const result = await fetch(baseUrl + path, {
            headers: { Accept: "application/json", "User-Agent": "AniLight-Pipeline/2.0" },
            signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
            redirect: "error",
          });
          if (result.status === 429) {
            rateLimitedUntil = Math.max(rateLimitedUntil, Date.now() + retryAfterMs(result.headers.get("Retry-After")));
          }
          return result;
        }, { signal });
        if (response?.ok) return await response.json() as T;
      } catch (error) {
        failure = error;
      }
      await response?.body?.cancel().catch(() => {});
      if (response?.status === 404) return null;
      if (response && !response.ok) {
        failure = new Error(`Tsukihime ${path} returned HTTP ${response.status}`);
        if (response.status < 500 && response.status !== 408 && response.status !== 429) throw failure;
      }
      if (attempt < 2) await delay(1000 * (attempt + 1), undefined, { signal });
    }
    throw failure ?? new Error(`Tsukihime ${path} did not return a response`);
  }

  public static async resolveAnime(
    lookup: TsukihimeAnimeLookup,
    reportErrors = false,
    signal = AbortSignal.timeout(30_000),
  ): Promise<TsukihimeAnime | null> {
    const { tsukihimeId, anilistId, malId, anidbId } = lookup;
    const external = [["anilist", anilistId], ["mal", malId], ["anidb", anidbId]] as const;
    const failures: unknown[] = [];
    for (const [field, id] of [...external, ["id", tsukihimeId] as const]) {
      if (signal.aborted) break;
      if (!isId(id)) continue;
      const cached = animeCache.get(`${field}:${id}`);
      try {
        const anime = cached && cached.expiresAt > Date.now() ? cached.anime : field === "id"
          ? (await this.requestJson<TorrentPage>(pathWithQuery(`/animes/${id}`, { limit: 1, offset: 0 }), signal))?.anime
          : await this.requestJson<TsukihimeAnime>(`/animes/${field}/${id}`, signal);
        if (!anime || !isId(anime.id) || typeof anime.title !== "string") continue;

        const conflicting = (isId(anime[field]) && anime[field] !== id) ||
          (isId(anilistId) && isId(anime.anilist) && anime.anilist !== anilistId);
        const unconfirmedInternalId = field === "id" && external.some(([, expected]) => isId(expected)) &&
          !external.some(([key, expected]) => isId(expected) && anime[key] === expected);
        if (conflicting || unconfirmedInternalId) {
          log.warn("Tsukihime", `Ignoring conflicting mapping for ${field} #${id} (Tsukihime #${anime.id}).`);
          continue;
        }

        if (cached?.anime !== anime || cached.expiresAt <= Date.now()) {
          const entry = { anime, expiresAt: Date.now() + 3_600_000 };
          animeCache.set(`id:${anime.id}`, entry);
          for (const [key] of external) if (isId(anime[key])) animeCache.set(`${key}:${anime[key]}`, entry);
          log.info("Tsukihime", `Resolved ${field} #${id} to #${anime.id} ("${anime.title}").`);
        }
        return anime;
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length) {
      if (reportErrors) throw new AggregateError(failures, "Tsukihime anime lookup failed");
      log.warn("Tsukihime", `Anime lookup failed: ${String(failures[0])}`);
    }
    return null;
  }

  public static buildMagnetUri(btih: string, title: string, extraTrackers: string[] = []): string {
    const uri = new URLSearchParams({ dn: title });
    for (const tracker of new Set([...extraTrackers, ...trackers])) uri.append("tr", tracker);
    return `magnet:?xt=urn:btih:${btih.trim().toLowerCase()}&${uri}`;
  }

  public static toAnimeToshoItem(entry: TsukihimeTorrentEntry): AnimeToshoItem {
    const usableTrackers = (Array.isArray(entry.trackers) ? entry.trackers : []).filter(tracker => tracker && !Number(tracker.error));
    const seedCounts = usableTrackers.map(tracker => tracker.seeders).filter((count): count is number =>
      typeof count === "number" && Number.isFinite(count) && count >= 0);
    // List rows omit tracker data. Keep unknown swarms eligible until hydration.
    const seeders = seedCounts.length ? Math.max(...seedCounts) : 1;
    const hash = torrentInfoHash({ title: entry.name, info_hash: entry.btih }) ?? entry.btih;
    return {
      id: entry.id,
      title: entry.name,
      info_hash: hash,
      magnet_uri: this.buildMagnetUri(hash, entry.name, usableTrackers.flatMap(tracker =>
        typeof tracker.url === "string" && /^(https?|udp):\/\//i.test(tracker.url) ? [tracker.url] : [])),
      size: entry.totalsize,
      num_files: entry.filecount,
      date: entry.source_date || entry.added_date,
      seeders,
      leechers: Math.max(0, ...usableTrackers.map(tracker => Number(tracker.leechers) || 0)),
      provider: "tsukihime",
      tsukihime_id: entry.id,
      tsukihime_episode_no: isId(entry.episode_no) ? entry.episode_no : null,
      tsukihime_seeders_known: seedCounts.length > 0,
      audiolangs: Array.isArray(entry.audiolangs) ? entry.audiolangs : undefined,
      sublangs: Array.isArray(entry.sublangs) ? entry.sublangs : undefined,
      group_name: entry.group?.name || undefined,
    };
  }

  private static async fetchPages(path: string, query: Query, maxPages: number, signal: AbortSignal, animeId?: number) {
    const results: TsukihimeTorrentEntry[] = [];
    let offset = 0;
    for (let page = 0; page < maxPages; page++) {
      try {
        const response = await this.requestJson<TorrentPage>(pathWithQuery(path, { ...query, limit: pageLimit, offset }), signal);
        if (!response) break;
        if (response.error || !Array.isArray(response.results)) throw new Error(`Invalid Tsukihime page for ${path}`);
        if (animeId && response.anime && response.anime.id !== animeId) {
          throw new Error(`Unexpected anime #${response.anime.id} in Tsukihime ${path}`);
        }
        if (!response.results.length) break;
        results.push(...response.results);
        const limit = isId(response.limit) ? response.limit : pageLimit;
        const nextOffset = (response.start ?? offset) + limit;
        if (nextOffset <= offset || (typeof response.total === "number"
          ? nextOffset >= response.total : response.results.length < limit)) break;
        offset = nextOffset;
      } catch (error) {
        if (!results.length) throw error;
        log.warn("Tsukihime", `Keeping earlier pages from ${path}: ${String(error)}`);
        break;
      }
    }
    return results;
  }

  public static async fetchTorrents(
    lookup: TsukihimeAnimeLookup,
    options: TsukihimeFetchOptions = {},
  ): Promise<{ anime: TsukihimeAnime | null; torrents: AnimeToshoItem[] }> {
    const deadline = AbortSignal.timeout(45_000);
    const errors: unknown[] = [];
    const attempt = async <T>(work: Promise<T>): Promise<T | null> => {
      try { return await work; }
      catch (error) { errors.push(error); return null; }
    };
    const anime = await attempt(this.resolveAnime(lookup, true, AbortSignal.any([deadline, AbortSignal.timeout(20_000)])));
    const titles = options.knownTitles?.some(title => title?.trim()) ? options.knownTitles
      : canonicalDiscoveryTitles({ titleRomaji: anime?.title, titleEnglish: anime?.english_title });
    const episode = isId(options.targetEp) ? options.targetEp : null;
    const episodeCount = options.episodeCount ?? anime?.total_episodes;
    const maxPages = Math.max(1, Math.min(options.maxPages ?? 4, 8));
    const filters = languageFilters(options.langType);
    const preferredGroup = options.groupName?.trim().toLowerCase();
    const torrents = new Map<string, AnimeToshoItem>();
    let groupId: number | undefined;
    let searched = false;
    let ranked: ReleaseCandidateBundle[] | undefined;

    const merge = (entries: TsukihimeTorrentEntry[] | null, scopedAnimeId?: number) => {
      if (!entries) return;
      searched = true;
      if (entries.length) ranked = undefined;
      for (const entry of entries) {
        if (!entry || !isId(entry.id) || typeof entry.name !== "string" || !entry.name.trim() ||
            typeof entry.btih !== "string" || Number(entry.is_adult) > 0 ||
            (scopedAnimeId && isId(entry.anime?.id) && entry.anime.id !== scopedAnimeId) ||
            (!scopedAnimeId && isId(lookup.anilistId) && isId(entry.anime?.anilist) && entry.anime.anilist !== lookup.anilistId) ||
            !ReleaseFilter.matchesSeriesTitle(entry.name, titles, { allowUnmarkedSeason: true })) continue;
        const item = this.toAnimeToshoItem(entry);
        const hash = torrentInfoHash(item);
        if (!hash) continue;
        if (preferredGroup && isId(entry.group?.id) && typeof entry.group.name === "string" &&
            entry.group.name.trim().toLowerCase() === preferredGroup) {
          groupId ??= entry.group.id;
        }
        const previous = torrents.get(hash);
        if (!previous || ReleaseFilter.hasWatermarkedSource(item.title)) torrents.set(hash, item);
        else if (!ReleaseFilter.hasWatermarkedSource(previous.title)) {
          previous.tsukihime_episode_no ??= item.tsukihime_episode_no;
          if (!previous.audiolangs?.length) previous.audiolangs = item.audiolangs;
          if (!previous.sublangs?.length) previous.sublangs = item.sublangs;
          previous.group_name ??= item.group_name;
        }
      }
    };
    const bundles = () => ranked ??= episode ? ReleaseFilter.selectTopCandidateBundles([...torrents.values()], episode, options.langType ?? "all", {
      knownTitles: titles, totalExpectedEps: episodeCount, maxBundles: 8,
    }) : [];
    const hasCoverage = () => {
      if (options.exhaustive || !episode) return false;
      return bundles().some(bundle => bundle.isSolo && bundle.isH264 &&
        bundle.qualities["1080p"] && bundle.qualities["720p"] && bundle.qualities["480p"]);
    };
    const hasEpisodeQuality = () => bundles().some(bundle =>
      (!preferredGroup || bundle.groupLower === preferredGroup) && bundle.qualities[options.quality ?? "1080p"]);
    const preferredFilters = (): Query => groupId ? { ...filters, group_id: groupId } : filters;
    const read = async (path: string, params: Query, pages: number, scope?: number) => {
      const entries = await attempt(this.fetchPages(path, params, pages, deadline, scope));
      merge(entries, scope);
      return entries?.length ?? 0;
    };

    if (anime && titles.length) {
      const { id } = anime;
      const episodePath = `/animes/${id}/episodes`;
      const knownEpisodes = new Set([episode, ...(options.episodeAliases ?? [])].filter(isId));
      await Promise.all([...knownEpisodes].slice(0, 3).map(ep => read(`${episodePath}/${ep}`, {}, maxPages, id)));
      if (episode) {
        const offsets = ReleaseFilter.inferCumulativeOffsets([...torrents.values()], episode, titles, episodeCount);
        const aliases = offsets.map(offset => episode + offset).filter(ep => isId(ep) && !knownEpisodes.has(ep)).slice(0, 2);
        await Promise.all(aliases.map(ep => read(`${episodePath}/${ep}`, {}, maxPages, id)));
      }

      if (!hasCoverage()) {
        const query = { anime_id: id, is_adult: 0, sort_by: "source_date", order: "desc" };
        const preferred = preferredFilters();
        if (Object.keys(preferred).length) await read("/torrents", { ...query, ...preferred }, 1, id);
        if (!hasCoverage() && !await read("/torrents", query, maxPages, id)) {
          await read(`/animes/${id}`, {}, maxPages, id);
        }
      }
      if (episode && (options.exhaustive || !hasEpisodeQuality())) {
        await read(`${episodePath}/null`, {}, Math.min(2, maxPages), id);
      }
    }

    if (titles.length && (!anime || !hasEpisodeQuality() || options.exhaustive)) {
      const q = titleQuery(titles, options.quality);
      if (q) {
        const animeId = anime?.id;
        const scope: Query = animeId ? { anime_id: animeId } : {};
        const preferred = preferredFilters();
        const filteredCount = Object.keys(preferred).length
          ? await read("/search/torrents", { q, ...scope, ...preferred }, 1, animeId) : 0;
        if (!filteredCount || !hasEpisodeQuality() || options.exhaustive) {
          const scopedCount = await read("/search/torrents", { q, ...scope }, Math.min(2, maxPages), animeId);
          if (animeId && (!scopedCount || !hasEpisodeQuality())) {
            await read("/search/torrents", { q }, Math.min(2, maxPages));
          }
        }
      }
    }

    if (errors.length) {
      if (!searched && options.reportErrors) throw new AggregateError(errors, "Tsukihime discovery failed");
      log.warn("Tsukihime", `Some discovery lookups failed: ${String(errors[0])}`);
    }
    return { anime, torrents: [...torrents.values()] };
  }

  private static async hydrateCandidate(item: AnimeToshoItem): Promise<AnimeToshoItem> {
    const hash = torrentInfoHash(item);
    if (!isId(item.tsukihime_id) || !hash) return item;
    const deadline = AbortSignal.timeout(25_000);
    let detail = await this.requestJson<TsukihimeTorrentEntry>(`/torrents/${item.tsukihime_id}`, deadline).catch(() => null);
    const sameHash = (entry: TsukihimeTorrentEntry | null) => entry && typeof entry.btih === "string" &&
      torrentInfoHash({ title: item.title, info_hash: entry.btih }) === hash;
    if (detail?.id !== item.tsukihime_id || !sameHash(detail)) {
      detail = await this.requestJson<TsukihimeTorrentEntry>(`/torrents/btih/${hash}`, deadline).catch(() => null);
    }
    if (!detail || !sameHash(detail) || Number(detail.is_adult) > 0) return item;
    const title = typeof detail.name === "string" && ReleaseFilter.hasWatermarkedSource(detail.name) ? detail.name : item.title;
    const enriched = this.toAnimeToshoItem({ ...detail, name: title });
    const seeders = enriched.tsukihime_seeders_known
      ? item.provider === "tsukihime" ? enriched.seeders : Math.max(item.seeders ?? 0, enriched.seeders ?? 0)
      : item.seeders ?? enriched.seeders;
    return {
      ...item,
      title,
      magnet_uri: enriched.magnet_uri,
      seeders,
      leechers: Math.max(enriched.leechers ?? 0, item.leechers ?? 0),
      tsukihime_seeders_known: enriched.tsukihime_seeders_known || item.tsukihime_seeders_known,
      audiolangs: enriched.audiolangs?.length ? enriched.audiolangs : item.audiolangs,
      sublangs: enriched.sublangs?.length ? enriched.sublangs : item.sublangs,
      group_name: item.group_name ?? enriched.group_name,
      tsukihime_episode_no: item.tsukihime_episode_no ?? enriched.tsukihime_episode_no,
    };
  }

  public static async hydrateCandidates(candidates: [AnimeToshoItem, number | string][]): Promise<[AnimeToshoItem, number | string][]> {
    return Promise.all(candidates.map(async ([item, episode]): Promise<[AnimeToshoItem, number | string]> =>
      [await this.hydrateCandidate(item), episode]));
  }
}
