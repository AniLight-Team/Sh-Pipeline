import { gotScraping } from "got-scraping";
import PQueue from "p-queue";
import { db } from "../db/index.js";
import { sql } from "drizzle-orm";
import { log } from "../utils/logger.js";
import { TsukihimeClient } from "./tsukihime.client.js";
import type { AnimeResolvedMetadata } from "./types.js";

// Cache resolved anime in memory (1 hour TTL)
const metadataCache = new Map<number, { data: AnimeResolvedMetadata; expiresAt: number }>();

const requestQueue = new PQueue({
  concurrency: 4,
  interval: 100,
  intervalCap: 4,
});

export class AnimeMetadataResolver {
  /**
   * Resolves AniList ID to AniDB ID, MAL ID, Tsukihime internal ID, internal anime ID, title variations, and cover art.
   */
  public static async resolve(anilistId: number): Promise<AnimeResolvedMetadata> {
    if (!anilistId || isNaN(anilistId) || anilistId <= 0) {
      throw new Error(`Invalid AniList ID: ${anilistId}`);
    }

    const cached = metadataCache.get(anilistId);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.data;
    }

    let resolved: AnimeResolvedMetadata = {
      anilistId,
      primaryTitle: `AniList #${anilistId}`,
      synonyms: [],
      source: "unresolved",
    };

    // 1. Try resolving from local/connected AniLight DB
    try {
      const dbResult = await this.resolveFromDatabase(anilistId);
      if (dbResult) {
        resolved = { ...resolved, ...dbResult, source: "database" };
      }
    } catch {
      // Database might be unreachable or tables differ, continue to APIs
    }

    // 2. Enrich / resolve from Tsukihime API (/animes/anilist/{id} -> /animes/mal/{id} -> /animes/anidb/{id})
    try {
      const tsukihimeAnime = await TsukihimeClient.resolveAnime({
        anilistId,
        malId: resolved.malId,
        anidbId: resolved.anidbId,
      });
      if (tsukihimeAnime && tsukihimeAnime.id) {
        const tsukiSynonyms = [
          tsukihimeAnime.title,
          tsukihimeAnime.english_title,
        ].filter(Boolean) as string[];
        resolved = {
          ...resolved,
          tsukihimeId: tsukihimeAnime.id,
          anidbId: resolved.anidbId || tsukihimeAnime.anidb || undefined,
          malId: resolved.malId || tsukihimeAnime.mal || undefined,
          titleRomaji: resolved.titleRomaji || tsukihimeAnime.title || undefined,
          titleEnglish: resolved.titleEnglish || tsukihimeAnime.english_title || undefined,
          primaryTitle:
            resolved.primaryTitle !== `AniList #${anilistId}`
              ? resolved.primaryTitle
              : tsukihimeAnime.english_title || tsukihimeAnime.title || resolved.primaryTitle,
          synonyms: Array.from(new Set([...(resolved.synonyms || []), ...tsukiSynonyms])),
          totalEpisodes: resolved.totalEpisodes || tsukihimeAnime.total_episodes || undefined,
          coverImage: resolved.coverImage || tsukihimeAnime.thumbnail || undefined,
          source: resolved.source === "unresolved" ? "tsukihime" : `${resolved.source}+tsukihime`,
        };
        if (resolved.anidbId && resolved.tsukihimeId) {
          metadataCache.set(anilistId, { data: resolved, expiresAt: Date.now() + 3600_000 });
          return resolved;
        }
      }
    } catch (e: any) {
      log.warn("MetadataResolver", `Tsukihime resolution failed for AniList ${anilistId}: ${e?.message || e}`);
    }

    // 3. Try resolving from Animap API
    try {
      const animapResult = await this.resolveFromAnimap(anilistId);
      if (animapResult) {
        resolved = {
          ...resolved,
          ...animapResult,
          animeId: resolved.animeId || animapResult.animeId,
          tsukihimeId: resolved.tsukihimeId,
          malId: resolved.malId || animapResult.malId,
          synonyms: Array.from(new Set([...(resolved.synonyms || []), ...(animapResult.synonyms || [])])),
          source: resolved.animeId ? "database+animap" : "animap",
        };
      }
    } catch (e: any) {
      log.warn("MetadataResolver", `Animap resolution failed for AniList ${anilistId}: ${e?.message || e}`);
    }

    // 4. Fallback to AniList GraphQL + MAL Animap lookup if still missing anidbId or primaryTitle
    if (!resolved.anidbId || resolved.primaryTitle === `AniList #${anilistId}`) {
      try {
        const anilistData = await this.resolveFromAnilistGraphql(anilistId);
        if (anilistData) {
          resolved = {
            ...resolved,
            ...anilistData,
            animeId: resolved.animeId || anilistData.animeId,
            anidbId: resolved.anidbId || anilistData.anidbId,
            malId: resolved.malId || anilistData.malId,
            tsukihimeId: resolved.tsukihimeId,
            synonyms: Array.from(new Set([...(resolved.synonyms || []), ...(anilistData.synonyms || [])])),
            source: resolved.source === "unresolved" ? "anilist_api" : `${resolved.source}+anilist_api`,
          };
        }
      } catch (e: any) {
        log.warn("MetadataResolver", `AniList GraphQL failed for AniList ${anilistId}: ${e?.message || e}`);
      }
    }

    // 5. If Tsukihime wasn't resolved via AniList ID earlier, try resolving via newly discovered MAL or AniDB ID
    if (!resolved.tsukihimeId && (resolved.malId || resolved.anidbId)) {
      try {
        const tsukiFallback = await TsukihimeClient.resolveAnime({
          malId: resolved.malId,
          anidbId: resolved.anidbId,
        });
        if (tsukiFallback?.id) {
          resolved.tsukihimeId = tsukiFallback.id;
          if (!resolved.anidbId && tsukiFallback.anidb) resolved.anidbId = tsukiFallback.anidb;
          if (!resolved.malId && tsukiFallback.mal) resolved.malId = tsukiFallback.mal;
        }
      } catch {}
    }

    metadataCache.set(anilistId, { data: resolved, expiresAt: Date.now() + 3600_000 });
    return resolved;
  }

  /**
   * Resolves the canonical AniDB ID directly from Tsukihime/Animap/AniList for a given AniList ID,
   * useful when a local DB external_id mapping points to a parent/adjacent season.
   */
  public static async resolveAnimapAnidbId(anilistId: number): Promise<number | null> {
    if (!anilistId || isNaN(anilistId) || anilistId <= 0) return null;
    try {
      const tsuki = await TsukihimeClient.resolveAnime({ anilistId });
      if (tsuki?.anidb && tsuki.anidb > 0) return tsuki.anidb;
    } catch {}
    try {
      const animap = await this.resolveFromAnimap(anilistId);
      if (animap?.anidbId) return animap.anidbId;
    } catch {}
    try {
      const gql = await this.resolveFromAnilistGraphql(anilistId);
      if (gql?.anidbId) return gql.anidbId;
    } catch {}
    return null;
  }

  private static async resolveFromDatabase(anilistId: number): Promise<Partial<AnimeResolvedMetadata> | null> {
    const animeRows = await db.execute(sql`
      SELECT id, mal_id, title_romaji, title_english, title_native, synonyms, poster_url, episode_count
      FROM anime
      WHERE anilist_id = ${anilistId}
      LIMIT 1
    `).catch(() => null);

    if (!animeRows || animeRows.length === 0) return null;
    const anime = animeRows[0] as any;

    let anidbId: number | undefined;
    let malId: number | undefined = anime.mal_id ? Number(anime.mal_id) : undefined;
    const extRows = await db.execute(sql`
      SELECT source, external_id
      FROM anime_external_id
      WHERE anime_id = ${anime.id} AND source IN ('anidb', 'mal', 'myanimelist')
    `).catch(() => null);

    if (extRows && extRows.length > 0) {
      for (const row of extRows as any[]) {
        const parsed = parseInt(row.external_id, 10);
        if (isNaN(parsed) || parsed <= 0) continue;
        if (row.source === "anidb" && !anidbId) anidbId = parsed;
        if ((row.source === "mal" || row.source === "myanimelist") && !malId) malId = parsed;
      }
    }

    const titleEnglish = anime.title_english || undefined;
    const titleRomaji = anime.title_romaji || undefined;
    const titleNative = anime.title_native || undefined;
    const primaryTitle = titleRomaji || titleEnglish || `AniList #${anilistId}`;

    const rawSynonyms = Array.isArray(anime.synonyms) ? anime.synonyms : [];
    const synonyms = Array.from(new Set([
      ...(titleRomaji ? [titleRomaji] : []),
      ...(titleEnglish ? [titleEnglish] : []),
      ...(titleNative ? [titleNative] : []),
      ...rawSynonyms,
    ])).filter(Boolean);

    return {
      animeId: Number(anime.id),
      anidbId,
      malId,
      titleRomaji,
      titleEnglish,
      titleNative,
      primaryTitle,
      synonyms,
      coverImage: anime.poster_url || undefined,
      totalEpisodes: anime.episode_count ? Number(anime.episode_count) : undefined,
    };
  }

  private static async resolveFromAnimap(anilistId: number): Promise<Partial<AnimeResolvedMetadata> | null> {
    return requestQueue.add(async () => {
      const url = `https://animap.id/api/v1/map/anilist/${anilistId}`;
      const res = await gotScraping({
        url,
        method: "GET",
        responseType: "json",
        timeout: { request: 8000 },
        headers: {
          "Accept": "application/json",
          "User-Agent": "AniLight/2.0",
        },
        throwHttpErrors: false,
      });

      if (res.statusCode !== 200 || !res.body) return null;
      const data = res.body as any;

      let anidbId: number | undefined;
      let malId: number | undefined;

      if (Array.isArray(data.sources)) {
        for (const src of data.sources) {
          if (typeof src !== "string") continue;
          const anidbMatch = src.match(/anidb\.net\/anime\/(\d+)/i);
          if (anidbMatch && !anidbId) {
            anidbId = parseInt(anidbMatch[1], 10);
          }
          const malMatch = src.match(/myanimelist\.net\/anime\/(\d+)/i);
          if (malMatch && !malId) {
            malId = parseInt(malMatch[1], 10);
          }
        }
      }

      const primaryTitle = data.title || `AniList #${anilistId}`;
      const rawSynonyms = Array.isArray(data.synonyms) ? data.synonyms : [];
      const synonyms = Array.from(new Set([primaryTitle, ...rawSynonyms])).filter(Boolean);

      return {
        anidbId,
        malId,
        primaryTitle,
        synonyms,
        totalEpisodes: typeof data.episodes === "number" ? data.episodes : undefined,
        coverImage: data.picture || data.thumbnail || undefined,
        status: data.status || undefined,
      };
    });
  }

  private static async resolveFromAnilistGraphql(anilistId: number): Promise<Partial<AnimeResolvedMetadata> | null> {
    return requestQueue.add(async () => {
      const query = `
        query ($id: Int) {
          Media(id: $id, type: ANIME) {
            id
            idMal
            title {
              romaji
              english
              native
            }
            synonyms
            episodes
            coverImage {
              large
              medium
            }
            status
          }
        }
      `;

      const res = await gotScraping({
        url: "https://graphql.anilist.co",
        method: "POST",
        json: { query, variables: { id: anilistId } },
        responseType: "json",
        timeout: { request: 8000 },
        headers: {
          "Content-Type": "application/json",
          "Accept": "application/json",
          "User-Agent": "AniLight/2.0",
        },
        throwHttpErrors: false,
      });

      if (res.statusCode !== 200 || !res.body) return null;
      const media = (res.body as any)?.data?.Media;
      if (!media) return null;

      const titleRomaji = media.title?.romaji || undefined;
      const titleEnglish = media.title?.english || undefined;
      const titleNative = media.title?.native || undefined;
      const primaryTitle = titleEnglish || titleRomaji || `AniList #${anilistId}`;

      const rawSynonyms = Array.isArray(media.synonyms) ? media.synonyms : [];
      const synonyms = Array.from(new Set([
        ...(titleRomaji ? [titleRomaji] : []),
        ...(titleEnglish ? [titleEnglish] : []),
        ...(titleNative ? [titleNative] : []),
        ...rawSynonyms,
      ])).filter(Boolean);

      let anidbId: number | undefined;

      // If AniList gave us an idMal, check Animap MAL mapping to get AniDB ID
      if (media.idMal) {
        try {
          const malRes = await gotScraping({
            url: `https://animap.id/api/v1/map/mal/${media.idMal}`,
            method: "GET",
            responseType: "json",
            timeout: { request: 6000 },
            throwHttpErrors: false,
          });
          if (malRes.statusCode === 200 && malRes.body) {
            const malData = malRes.body as any;
            if (Array.isArray(malData.sources)) {
              for (const src of malData.sources) {
                const match = typeof src === "string" && src.match(/anidb\.net\/anime\/(\d+)/i);
                if (match) {
                  anidbId = parseInt(match[1], 10);
                  break;
                }
              }
            }
          }
        } catch {}
      }

      return {
        anidbId,
        malId: media.idMal ? Number(media.idMal) : undefined,
        titleRomaji,
        titleEnglish,
        titleNative,
        primaryTitle,
        synonyms,
        totalEpisodes: media.episodes || undefined,
        coverImage: media.coverImage?.large || media.coverImage?.medium || undefined,
        status: media.status || undefined,
      };
    });
  }
}

