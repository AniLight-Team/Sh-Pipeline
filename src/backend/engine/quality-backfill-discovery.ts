import { AnimeToshoClient, type FetchTorrentsOptions } from "./animetosho.client.js";
import { canonicalDiscoveryTitles } from "./discovery-titles.js";
import { AnimeMetadataResolver } from "./metadata-resolver.js";
import { ReleaseFilter } from "./release-filter.js";
import { torrentIdentityKey, torrentInfoHash } from "./torrent-identity.js";
import { TsukihimeClient } from "./tsukihime.client.js";
import type { AnimeToshoItem, ReleaseQualityEntry, StreamType, VideoResolutionQuality } from "./types.js";

interface BackfillSearch {
  anilistId?: number | null;
  animeId?: number | null;
  anidbId?: number | null;
  episodeNumber: number;
  knownTitles?: string[] | null;
  metadata?: Record<string, unknown> | null;
  releaseGroup?: string | null;
  torrentTitle?: string | null;
  sourceEffectiveEp?: number | string;
  type: StreamType;
  quality: Exclude<VideoResolutionQuality, "1080p">;
}

const qualityMarkers = {
  "720p": /\b(?:720p|1280x720)\b/i,
  "480p": /\b(?:480p|(?:848|854)x480)\b/i,
};

function releaseEdition(title: string): string {
  // Retain the episode, revision, source and audio labels so existing captions can be reused.
  return title.normalize("NFKC").toLowerCase()
    .replace(/^\s*\[[^\]]+\]\s*/, "")
    .replace(/\.(?:mkv|mp4|avi|webm)\s*$/, "")
    .replace(/\[[0-9a-f]{8}\]|\([0-9a-f]{8}\)/g, " ")
    .replace(/\b(?:1080p|1920x1080|720p|1280x720|480p|(?:848|854)x480)\b/g, " ")
    .replace(/\b(?:x264|h[._-]?264|avc1?)\b/g, "avc")
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
}

export async function findBackfillTorrents(job: BackfillSearch): Promise<ReleaseQualityEntry[]> {
  const { quality, type, episodeNumber, torrentTitle } = job;
  if (!torrentTitle) return [];

  const groupName = job.releaseGroup?.trim() || ReleaseFilter.parseTitle(torrentTitle).group;
  const group = groupName.toLowerCase();
  const edition = releaseEdition(torrentTitle);
  if (!group || group === "unknown" || !edition) return [];

  let knownTitles = job.knownTitles ?? [];
  if (!knownTitles.length && job.anilistId) {
    knownTitles = await AnimeMetadataResolver.resolveDiscoveryTitles(job.anilistId);
  } else if (!knownTitles.length && job.animeId) {
    knownTitles = await AnimeMetadataResolver.resolveLocalDiscoveryTitles(job.animeId);
  }
  const original = ReleaseFilter.parseTitle(torrentTitle, knownTitles);
  const storedEpisode = Number(job.sourceEffectiveEp);
  const effectiveEp = original.singleEp ?? (Number.isInteger(storedEpisode) && storedEpisode > 0 ? storedEpisode : episodeNumber);
  const expectedEpisodes = Number(job.metadata?.totalEpisodes) || null;
  const options: FetchTorrentsOptions = {
    targetEp: episodeNumber,
    langType: type,
    knownTitles,
    episodeCount: expectedEpisodes,
    maxPages: 4,
    exhaustive: true,
    reportErrors: true,
  };
  const candidates = new Map<string, ReleaseQualityEntry>();
  const blockedKeys = new Set<string>();
  const errors: unknown[] = [];
  let searched = false;

  const search = async <T>(query: Promise<T>): Promise<T | null> => {
    try {
      return await query;
    } catch (error) {
      errors.push(error);
      return null;
    }
  };

  const addCandidates = (items: AnimeToshoItem[] | null) => {
    if (!items) return;
    searched = true;
    if (!knownTitles.length) return;
    for (const item of items) {
      if (!torrentInfoHash(item)) continue;
      const declaredAnidb = Number(item.anidb_aid);
      if (options.expectedAnidbId && declaredAnidb > 0 && declaredAnidb !== options.expectedAnidbId) continue;
      const key = torrentIdentityKey(item);
      if (ReleaseFilter.hasWatermarkedSource(item.title)) {
        blockedKeys.add(key);
        candidates.delete(key);
        continue;
      }
      if (blockedKeys.has(key)) continue;
      const parsed = ReleaseFilter.parseTitle(item.title, knownTitles, item);
      const torrentKey = item.info_hash || item.magnet_uri || item.torrent_url;
      if (parsed.groupLower !== group || !parsed.isH264 || !qualityMarkers[quality].test(item.title) ||
          parsed.resolution !== quality || releaseEdition(item.title) !== edition || !torrentKey) continue;
      if (item.tsukihime_episode_no != null && item.tsukihime_episode_no !== episodeNumber &&
          item.tsukihime_episode_no !== effectiveEp) continue;

      const score = ReleaseFilter.scoreTorrent(item, effectiveEp, type, knownTitles, expectedEpisodes);
      if (score <= 0) continue;
      const current = candidates.get(key);
      if (!current || current.score < score) candidates.set(key, { quality, item, effectiveEp, score });
    }
  };

  const [tsukihime, aniDbItems] = await Promise.all([
    search(TsukihimeClient.fetchTorrents({
      anilistId: job.anilistId,
      anidbId: job.anidbId,
      tsukihimeId: Number(job.metadata?.tsukihimeId) || null,
      malId: Number(job.metadata?.malId) || null,
    }, {
      ...options,
      episodeAliases: effectiveEp === episodeNumber ? [] : [effectiveEp],
      quality,
      groupName,
    })),
    job.anidbId ? search(AnimeToshoClient.fetchTorrents(job.anidbId, quality, options)) : null,
  ]);

  options.expectedAnidbId = tsukihime?.anime?.anidb || job.anidbId;
  if (tsukihime?.anime) {
    if (!knownTitles.length) {
      knownTitles = canonicalDiscoveryTitles({
        titleRomaji: tsukihime.anime.title,
        titleEnglish: tsukihime.anime.english_title,
      });
      options.knownTitles = knownTitles;
    }
  }
  if (tsukihime?.releaseSearchFailed) errors.push(new Error("Tsukihime release search unavailable"));
  else addCandidates(tsukihime?.torrents ?? null);
  if (options.expectedAnidbId === job.anidbId) addCandidates(aniDbItems);

  if (!candidates.size) {
    const canonicalId = tsukihime?.anime?.anidb || (job.anilistId
      ? await search(AnimeMetadataResolver.resolveAnimapAnidbId(job.anilistId))
      : null);
    if (canonicalId) options.expectedAnidbId = canonicalId;
    if (canonicalId && canonicalId !== job.anidbId) {
      addCandidates(await search(AnimeToshoClient.fetchTorrents(canonicalId, quality, options)));
    }
  }

  for (const title of knownTitles) {
    if (candidates.size) break;
    addCandidates(await search(AnimeToshoClient.fetchTorrentsByTitle(title, quality, options)));
  }

  if (!searched && errors.length) throw new AggregateError(errors, `Torrent providers unavailable for ${quality} discovery`);

  const ranked = [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, 4);
  const hydrated = await TsukihimeClient.hydrateCandidates(ranked.map(({ item, effectiveEp }) => [item, effectiveEp]));
  return ranked.map((entry, index) => ({ ...entry, item: hydrated[index][0] }))
    .filter(({ item }) => !ReleaseFilter.hasWatermarkedSource(item.title) && item.seeders !== 0);
}
