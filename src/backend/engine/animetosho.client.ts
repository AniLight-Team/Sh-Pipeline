import { gotScraping } from "got-scraping";
import type { AnimeToshoItem } from "./types.js";
import { ReleaseFilter } from "./release-filter.js";
import { log } from "../utils/logger.js";

export interface FetchTorrentsOptions {
  targetEp?: number;
  langType?: string;
  knownTitles?: (string | null | undefined)[];
  episodeCount?: number | null;
  maxPages?: number;
}

export class AnimeToshoClient {
  private static async fetchPage(
    url: string,
    retries = 3,
  ): Promise<AnimeToshoItem[]> {
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        const res = await gotScraping({
          url,
          method: "GET",
          responseType: "json",
          timeout: { request: 20000 },
          headers: {
            "Accept": "application/json, text/plain, */*",
            "User-Agent":
              "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
          },
        });

        if (res.statusCode === 200 && Array.isArray(res.body)) {
          return res.body as AnimeToshoItem[];
        }
        return [];
      } catch (err: any) {
        if (attempt === retries) {
          log.error("AnimeTosho", `Error fetching ${url}: ${err?.message || err}`);
          return [];
        }
        await new Promise((resolve) => setTimeout(resolve, 1500 * attempt));
      }
    }
    return [];
  }

  private static async fetchWithPagination(
    baseUrl: string,
    logContext: string,
    options: FetchTorrentsOptions = {},
  ): Promise<AnimeToshoItem[]> {
    const {
      targetEp,
      langType = "all",
      knownTitles = [],
      episodeCount = null,
      maxPages = 6,
    } = options;

    const allItems: AnimeToshoItem[] = [];
    const seenIds = new Set<string | number>();

    const targetEpNum =
      typeof targetEp === "number" && !isNaN(targetEp) && targetEp > 0
        ? targetEp
        : null;
    const effectiveMaxPages =
      targetEpNum !== null ? Math.max(1, Math.min(maxPages, 10)) : 1;

    for (let page = 1; page <= effectiveMaxPages; page++) {
      const pageParam = page > 1 ? `&page=${page}` : "";
      const pageUrl = `${baseUrl}${pageParam}`;
      log.info("AnimeTosho", `Querying feed (page ${page}/${effectiveMaxPages}) for ${logContext}`);

      const pageItems = await this.fetchPage(pageUrl);
      if (!pageItems || pageItems.length === 0) {
        break;
      }

      let newItemsCount = 0;
      const pageUniqueItems: AnimeToshoItem[] = [];
      for (const item of pageItems) {
        const itemKey = item.id || item.info_hash || item.title;
        if (!seenIds.has(itemKey)) {
          seenIds.add(itemKey);
          allItems.push(item);
          pageUniqueItems.push(item);
          newItemsCount++;
        }
      }

      if (newItemsCount === 0) {
        break;
      }

      if (targetEpNum === null) {
        break;
      }

      const matchingCandidates = ReleaseFilter.selectTopCandidates(
        allItems,
        targetEpNum,
        langType,
        {
          knownTitles,
          totalExpectedEps: episodeCount,
          maxCandidates: 3,
        },
      );

      const hasTopQuality = matchingCandidates.some(([item]) =>
        ReleaseFilter.isHighQualityCandidate(item, targetEpNum, langType, knownTitles),
      );

      const isDubSearch = String(langType).toLowerCase() === "dub";
      const candidateStopThreshold = isDubSearch ? 4 : 3;
      if (hasTopQuality || (page >= candidateStopThreshold && matchingCandidates.length >= 2)) {
        log.success(
          "AnimeTosho",
          `Found ${matchingCandidates.length} candidate(s) (hasTopQuality=${hasTopQuality}) for Ep ${targetEpNum} on page ${page}.`,
        );
        break;
      }

      let maxPageEp: number | null = null;
      let hasCoveringBatch = false;

      for (const item of pageUniqueItems) {
        const parsed = ReleaseFilter.parseTitle(item.title || "", knownTitles);
        if (parsed.isBonusOrExtra || parsed.seasonNum === 0 || parsed.isWeirdOrPromo || parsed.isUnsupportedContainer) continue;

        if (parsed.singleEp !== null && parsed.singleEp > 0) {
          if (maxPageEp === null || parsed.singleEp > maxPageEp) maxPageEp = parsed.singleEp;
        }

        if (parsed.epRange) {
          const [rStart, rEnd] = parsed.epRange;
          if (maxPageEp === null || rEnd > maxPageEp) maxPageEp = rEnd;
          if (rStart <= targetEpNum && targetEpNum <= rEnd) hasCoveringBatch = true;
        } else if (parsed.isBatch && parsed.singleEp === null) {
          const nFiles = item.num_files || 0;
          if (nFiles >= targetEpNum || (episodeCount && targetEpNum <= episodeCount)) {
            hasCoveringBatch = true;
          }
        }
      }

      const minPagesBeforeEpCutoff = isDubSearch ? 6 : 3;
      if (!hasCoveringBatch && maxPageEp !== null && maxPageEp < targetEpNum && page >= minPagesBeforeEpCutoff) {
        log.info(
          "AnimeTosho",
          `Max ep on page ${page} (${maxPageEp}) < target Ep ${targetEpNum}. Target episode passed; stopping.`,
        );
        break;
      }

      if (pageItems.length < 20) {
        break;
      }

      if (page < effectiveMaxPages) {
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }

    return allItems;
  }

  public static async fetchTorrents(
    anidbId: number,
    query = "1080p",
    options: FetchTorrentsOptions = {},
  ): Promise<AnimeToshoItem[]> {
    const qParam = query ? `&q=${encodeURIComponent(query)}` : "";
    const baseUrl = `https://feed.animetosho.net/json?qx=1${qParam}&aids=${anidbId}`;
    return await this.fetchWithPagination(
      baseUrl,
      `AniDB ID ${anidbId} (query: "${query || "all"}")`,
      options,
    );
  }

  public static async fetchTorrentsByTitle(
    title: string,
    query = "1080p",
    options: FetchTorrentsOptions = {},
  ): Promise<AnimeToshoItem[]> {
    const cleanTitle = title.replace(/[^\w\s-]/g, " ").replace(/\s+/g, " ").trim();
    const fullQuery = query ? `${cleanTitle} ${query}` : cleanTitle;
    const baseUrl = `https://feed.animetosho.net/json?qx=1&q=${encodeURIComponent(fullQuery)}`;
    return await this.fetchWithPagination(
      baseUrl,
      `title "${fullQuery}"`,
      {
        ...options,
        knownTitles: options.knownTitles || [title, cleanTitle],
      },
    );
  }
}

