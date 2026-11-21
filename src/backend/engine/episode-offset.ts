import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { ReleaseFilter } from "./release-filter.js";
import type { AnimeToshoItem } from "./types.js";

export interface AnimeDiscoveryRule {
  id: number;
  anilistId: number | null;
  animeId: number | null;
  episodeOffset: number;
  sourceTsukihimeId: number | null;
  sourceAnidbId: number | null;
  searchTitles: string[];
  notes: string | null;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface LocalEpisodeScheduleInfo {
  episodeNumber: number;
  title?: string | null;
  /** Original (sub) broadcast air timestamp in Unix epoch seconds. */
  airedAtSec?: number | null;
}

export interface PrequelOffsetContext {
  /** Cumulative episode offsets derived strictly from verified PREQUEL chain(s), sorted ascending. */
  candidateOffsets: number[];
  /** Start dates (Unix epoch seconds) of immediate/chained prequels for premiere falsification. */
  prequelStartDates: number[];
  /** Local episodes with their original (sub) air dates and titles. */
  localEpisodes: LocalEpisodeScheduleInfo[];
}

export interface OffsetDetectionResult {
  offset: number;
  strict: boolean;
  reason: string;
  evidence?: {
    candidateOffset: number;
    exactAirDateMatches: number;
    zeroExactAirDateMatches: number;
    earlyViolations: number;
    zeroEarlyViolations: number;
    titleMatches: number;
    zeroTitleMatches: number;
    prequelDateMatches: number;
  };
}

const HOUR_SEC = 3600;
const DAY_SEC = 86_400;
const AIR_DATE_EARLY_TOLERANCE_SEC = 36 * HOUR_SEC; // Allow timezone/early web premiere up to 36h before airedAt
const AIR_DATE_LATE_EXACT_SEC = 60 * HOUR_SEC; // Allow up to 60h after airedAt for exact match
const AIR_DATE_VIOLATION_EARLY_SEC = 72 * HOUR_SEC; // > 72h before airedAt cannot be this episode
const AIR_DATE_DELAY_MAX_SEC = 21 * DAY_SEC; // Legal broadcast delay window (up to 3 weeks)

const GENERIC_EPISODE_TITLE =
  /^(?:episode|ep|ova|ona|special|recap|prologue|finale|interlude|part|stage|chapter|act)?\s*#?\d*(?:\.\d+)?$/i;

export function normalizeEpisodeSubTitle(raw: string | null | undefined): string {
  if (!raw) return "";
  let cleaned = raw
    .normalize("NFKC")
    .normalize("NFD")
    .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
    .normalize("NFC")
    .trim();
  if (!cleaned || GENERIC_EPISODE_TITLE.test(cleaned)) return "";
  cleaned = cleaned
    .replace(/^(?:episode|ep|act|chapter|stage|part)\s*#?\d+[\s.:—–-]+/i, "")
    .replace(/['’`]/g, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
    .trim();
  const significant = cleaned.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (significant < 6 || GENERIC_EPISODE_TITLE.test(cleaned)) return "";
  return cleaned;
}

function isBatchDropSchedule(episodes: LocalEpisodeScheduleInfo[]): boolean {
  const dated = episodes
    .map(ep => ep.airedAtSec)
    .filter((sec): sec is number => typeof sec === "number" && Number.isFinite(sec) && sec > 0)
    .sort((a, b) => a - b);
  if (dated.length < 3) return false;
  let sameDayPairs = 0;
  for (let i = 1; i < dated.length; i++) {
    if (dated[i] - dated[i - 1] <= DAY_SEC) sameDayPairs++;
  }
  // If half or more adjacent episodes dropped within 24h (e.g. Netflix full-cour batch drop),
  // air dates cannot distinguish offsets.
  return sameDayPairs >= Math.ceil((dated.length - 1) / 2);
}

/**
 * Pure, evidence-backed cumulative episode offset detector.
 *
 * Guarantees zero impact on normal anime:
 * - Never invents arbitrary offsets: only evaluates offsets `K > 0` present in `context.candidateOffsets`
 *   (derived from real PREQUEL relations).
 * - Uses earliest healthy torrent upload timestamps per episode against original (`sub`) air dates,
 *   making it resilient to late fansubs, archive re-encodes, and mid-season broadcast delays.
 * - Uses asymmetric early-violation detection so a delayed mid-season episode never tricks the
 *   detector into shifting a normal anime OR flipping a true offset back to 0.
 * - Also verifies episode titles (for Netflix/WEB-DL rips with episode titles in filenames) and
 *   prequel-matched Tsukihime `episode_no` mappings.
 */
export function detectVerifiedEpisodeOffset(params: {
  torrents: AnimeToshoItem[];
  knownTitles?: (string | null | undefined)[];
  targetEp: number;
  totalExpectedEps?: number | null;
  context: PrequelOffsetContext;
}): OffsetDetectionResult {
  const { torrents, knownTitles, targetEp, context } = params;
  const candidateOffsets = Array.from(
    new Set(
      (context.candidateOffsets || []).filter(
        off => typeof off === "number" && Number.isSafeInteger(off) && off > 0 && off <= 2000,
      ),
    ),
  ).sort((a, b) => a - b);

  if (candidateOffsets.length === 0 || !torrents.length) {
    return { offset: 0, strict: false, reason: "no_prequel_candidates" };
  }

  const firstReleaseSecByTorrentEp = new Map<number, number>();
  const titlesByTorrentEp = new Map<number, string[]>();
  const tsukihimeDeltaEps = new Map<number, Set<number>>();

  for (const item of torrents) {
    if (!item?.title?.trim() || ReleaseFilter.hasWatermarkedSource(item.title)) continue;
    if ((item.seeders ?? 1) <= 0) continue;
    const verified = item.provider === "tsukihime" || Number(item.anidb_aid) > 0;
    if (knownTitles?.length && !ReleaseFilter.matchesSeriesTitle(item.title, knownTitles, {
      allowUnmarkedSeason: verified,
      allowVerifiedSeason: verified,
    })) {
      continue;
    }
    const parsed = ReleaseFilter.parseTitle(item.title, knownTitles, item);
    if (
      parsed.isBatch ||
      parsed.isBonusOrExtra ||
      parsed.isWeirdOrPromo ||
      parsed.isUnsupportedContainer ||
      parsed.seasonNum === 0 ||
      parsed.singleEp === null ||
      parsed.singleEp <= 0
    ) {
      continue;
    }

    const ep = parsed.singleEp;
    const rawDate = Number(item.date);
    if (Number.isFinite(rawDate) && rawDate > 946_684_800) {
      // Normalize milliseconds -> seconds if needed
      const sec = rawDate > 10_000_000_000 ? Math.floor(rawDate / 1000) : Math.floor(rawDate);
      const prev = firstReleaseSecByTorrentEp.get(ep);
      if (prev === undefined || sec < prev) {
        firstReleaseSecByTorrentEp.set(ep, sec);
      }
    }

    const list = titlesByTorrentEp.get(ep) ?? [];
    list.push(item.title);
    titlesByTorrentEp.set(ep, list);

    const indexed =
      typeof item.tsukihime_episode_no === "number" &&
      Number.isSafeInteger(item.tsukihime_episode_no) &&
      item.tsukihime_episode_no > 0 &&
      (item.provider === "tsukihime" || item.tsukihime_id)
        ? item.tsukihime_episode_no
        : undefined;
    if (indexed !== undefined) {
      const delta = ep - indexed;
      if (delta >= 0) {
        const eps = tsukihimeDeltaEps.get(delta) ?? new Set<number>();
        eps.add(indexed);
        tsukihimeDeltaEps.set(delta, eps);
      }
    }
  }

  if (firstReleaseSecByTorrentEp.size === 0 && titlesByTorrentEp.size === 0 && tsukihimeDeltaEps.size === 0) {
    return { offset: 0, strict: false, reason: "no_usable_torrents" };
  }

  const localEpisodes = (context.localEpisodes || []).filter(
    ep => Number.isSafeInteger(ep.episodeNumber) && ep.episodeNumber > 0,
  );
  const prequelStarts = (context.prequelStartDates || []).filter(
    sec => typeof sec === "number" && Number.isFinite(sec) && sec > 946_684_800,
  );
  const batchDrop = isBatchDropSchedule(localEpisodes);

  const normalizedTorrentTitlesByEp = new Map<number, string[]>();
  for (const [ep, rawTitles] of titlesByTorrentEp.entries()) {
    normalizedTorrentTitlesByEp.set(
      ep,
      rawTitles.map(raw =>
        raw
          .normalize("NFKC")
          .normalize("NFD")
          .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
          .normalize("NFC")
          .replace(/['’`]/g, "")
          .toLowerCase()
          .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
          .trim(),
      ),
    );
  }

  interface CandidateScore {
    offset: number;
    exactAirDateMatches: number;
    delayedAirDateMatches: number;
    earlyViolations: number;
    titleMatches: number;
    prequelDateMatches: number;
  }

  const evaluate = (offset: number): CandidateScore => {
    let exactAirDateMatches = 0;
    let delayedAirDateMatches = 0;
    let earlyViolations = 0;
    let titleMatches = 0;
    let prequelDateMatches = 0;

    for (const local of localEpisodes) {
      const tEp = local.episodeNumber + offset;

      // 1. Episode title matching
      const normSub = normalizeEpisodeSubTitle(local.title);
      if (normSub) {
        const candidateTitles = normalizedTorrentTitlesByEp.get(tEp);
        if (candidateTitles?.some(t => t.includes(normSub))) {
          titleMatches++;
        }
      }

      // 2. Air-date alignment (skipped on same-day batch drops)
      if (!batchDrop && typeof local.airedAtSec === "number" && local.airedAtSec > 946_684_800) {
        const relSec = firstReleaseSecByTorrentEp.get(tEp);
        if (relSec !== undefined) {
          const delta = relSec - local.airedAtSec;
          if (delta >= -AIR_DATE_EARLY_TOLERANCE_SEC && delta <= AIR_DATE_LATE_EXACT_SEC) {
            exactAirDateMatches++;
          } else if (delta > AIR_DATE_LATE_EXACT_SEC && delta <= AIR_DATE_DELAY_MAX_SEC) {
            delayedAirDateMatches++;
          } else if (delta < -AIR_DATE_VIOLATION_EARLY_SEC) {
            earlyViolations++;
            if (
              offset === 0 &&
              delta < -14 * DAY_SEC &&
              prequelStarts.some(pSec => relSec >= pSec - 7 * DAY_SEC && relSec <= pSec + 14 * DAY_SEC)
            ) {
              prequelDateMatches++;
            }
          }
        }
      }
    }

    return {
      offset,
      exactAirDateMatches,
      delayedAirDateMatches,
      earlyViolations,
      titleMatches,
      prequelDateMatches,
    };
  };

  const zeroScore = evaluate(0);
  const candidateScores = candidateOffsets.map(evaluate);

  // Proof 1: Episode-title consensus (works even on same-day batch drops & heavy broadcast delays!)
  const titleWinners = candidateScores.filter(
    c => c.titleMatches >= 1 && c.titleMatches > zeroScore.titleMatches && c.earlyViolations === 0,
  );
  if (titleWinners.length > 0 && zeroScore.titleMatches === 0) {
    titleWinners.sort((a, b) => b.titleMatches - a.titleMatches);
    if (titleWinners.length === 1 || titleWinners[0].titleMatches > titleWinners[1].titleMatches) {
      const winner = titleWinners[0];
      return {
        offset: winner.offset,
        strict: true,
        reason: "episode_title_verified",
        evidence: {
          candidateOffset: winner.offset,
          exactAirDateMatches: winner.exactAirDateMatches,
          zeroExactAirDateMatches: zeroScore.exactAirDateMatches,
          earlyViolations: winner.earlyViolations,
          zeroEarlyViolations: zeroScore.earlyViolations,
          titleMatches: winner.titleMatches,
          zeroTitleMatches: zeroScore.titleMatches,
          prequelDateMatches: zeroScore.prequelDateMatches,
        },
      };
    }
  }

  // Proof 2: Air-date alignment with asymmetric early-violation checking (delay-safe!)
  if (!batchDrop) {
    const datedLocalCount = localEpisodes.filter(
      ep => typeof ep.airedAtSec === "number" && ep.airedAtSec > 946_684_800,
    ).length;

    const airWinners = candidateScores.filter(c => {
      if (c.earlyViolations > 0) return false;
      if (c.exactAirDateMatches === 0) return false;
      // If multiple local episodes have dates and we only got 1 exact match, also require
      // an explicit early violation on offset=0 so a single coincidental match never shifts a show.
      if (c.exactAirDateMatches === 1 && datedLocalCount >= 2 && zeroScore.earlyViolations === 0) {
        return false;
      }
      // Must strictly outperform offset=0: either offset=0 has 0 exact matches, OR offset=0
      // has early-upload violations (e.g. a mid-season 1-week delay created spurious late matches for 0
      // while pre-delay episodes falsified 0).
      if (zeroScore.exactAirDateMatches === 0) return true;
      return c.exactAirDateMatches > zeroScore.exactAirDateMatches && zeroScore.earlyViolations > 0;
    });

    if (airWinners.length > 0) {
      airWinners.sort(
        (a, b) =>
          b.exactAirDateMatches - a.exactAirDateMatches ||
          b.delayedAirDateMatches - a.delayedAirDateMatches,
      );
      if (airWinners.length === 1 || airWinners[0].exactAirDateMatches > airWinners[1].exactAirDateMatches) {
        const winner = airWinners[0];
        return {
          offset: winner.offset,
          strict: true,
          reason: "air_date_verified",
          evidence: {
            candidateOffset: winner.offset,
            exactAirDateMatches: winner.exactAirDateMatches,
            zeroExactAirDateMatches: zeroScore.exactAirDateMatches,
            earlyViolations: winner.earlyViolations,
            zeroEarlyViolations: zeroScore.earlyViolations,
            titleMatches: winner.titleMatches,
            zeroTitleMatches: zeroScore.titleMatches,
            prequelDateMatches: zeroScore.prequelDateMatches,
          },
        };
      }
    }

    // Proof 2b: Premiere-day falsification (e.g. Ep 1 of 2nd-3rd STAGE just aired before Torrent 02 drops,
    // while Torrent 01 was uploaded months earlier on 1st STAGE's start date).
    if (
      candidateOffsets.length === 1 &&
      targetEp === 1 &&
      zeroScore.exactAirDateMatches === 0 &&
      zeroScore.prequelDateMatches >= 1 &&
      zeroScore.titleMatches === 0
    ) {
      const only = candidateScores[0];
      return {
        offset: only.offset,
        strict: true,
        reason: "prequel_premiere_falsified_zero",
        evidence: {
          candidateOffset: only.offset,
          exactAirDateMatches: only.exactAirDateMatches,
          zeroExactAirDateMatches: zeroScore.exactAirDateMatches,
          earlyViolations: only.earlyViolations,
          zeroEarlyViolations: zeroScore.earlyViolations,
          titleMatches: only.titleMatches,
          zeroTitleMatches: zeroScore.titleMatches,
          prequelDateMatches: zeroScore.prequelDateMatches,
        },
      };
    }
  }

  // Proof 3: Prequel-verified Tsukihime episode_no mapping (unanimous across indexed torrents)
  if (tsukihimeDeltaEps.size === 1 && zeroScore.exactAirDateMatches === 0 && zeroScore.titleMatches === 0) {
    const [[delta, eps]] = [...tsukihimeDeltaEps.entries()];
    if (delta > 0 && candidateOffsets.includes(delta) && (eps.has(targetEp) || eps.size >= 2)) {
      const score = candidateScores.find(c => c.offset === delta)!;
      if (score.earlyViolations === 0) {
        return {
          offset: delta,
          strict: true,
          reason: "tsukihime_prequel_verified",
          evidence: {
            candidateOffset: delta,
            exactAirDateMatches: score.exactAirDateMatches,
            zeroExactAirDateMatches: zeroScore.exactAirDateMatches,
            earlyViolations: score.earlyViolations,
            zeroEarlyViolations: zeroScore.earlyViolations,
            titleMatches: score.titleMatches,
            zeroTitleMatches: zeroScore.titleMatches,
            prequelDateMatches: zeroScore.prequelDateMatches,
          },
        };
      }
    }
  }

  return { offset: 0, strict: false, reason: "default_zero" };
}

/**
 * Loads prequel chain offsets and original (`sub`) episode air dates/titles from the shared AniLight database.
 * Gracefully returns empty context when DATABASE_URL is absent or tables are unavailable.
 */
export async function loadPrequelOffsetContext(params: {
  animeId?: number | null;
  anilistId?: number | null;
}): Promise<PrequelOffsetContext> {
  const empty: PrequelOffsetContext = {
    candidateOffsets: [],
    prequelStartDates: [],
    localEpisodes: [],
  };
  if (!params.animeId && !params.anilistId) return empty;

  try {
    const animeRows = await db.execute(
      params.animeId
        ? sql`SELECT id, anilist_id, episode_count, start_date FROM anime WHERE id = ${params.animeId} LIMIT 1`
        : sql`SELECT id, anilist_id, episode_count, start_date FROM anime WHERE anilist_id = ${params.anilistId} LIMIT 1`,
    ).catch(() => null);
    const root = animeRows?.[0] as {
      id?: number;
      anilist_id?: number;
      episode_count?: number | null;
      start_date?: string | Date | null;
    } | undefined;
    if (!root?.id) return empty;

    const candidateOffsets: number[] = [];
    const prequelStartDates: number[] = [];
    const visitedAnilistIds = new Set<number>();
    if (root.anilist_id) visitedAnilistIds.add(Number(root.anilist_id));

    let currentAnimeId = Number(root.id);
    let cumulative = 0;

    // Walk up to 5 consecutive PREQUEL links (e.g. 1st STAGE -> 2nd-3rd STAGE, or Bleach Cour 1-3 -> Cour 4)
    for (let depth = 0; depth < 5; depth++) {
      const metaRows = await db.execute(sql`
        SELECT relations FROM anime_extra_meta WHERE anime_id = ${currentAnimeId} LIMIT 1
      `).catch(() => null);
      const relations = (metaRows?.[0] as { relations?: unknown } | undefined)?.relations;
      if (!Array.isArray(relations)) break;

      const prequelRel = relations.find(
        (r: any) => r && r.relationType === "PREQUEL" && Number.isSafeInteger(Number(r.animeId)) && Number(r.animeId) > 0,
      ) as { animeId: number } | undefined;
      if (!prequelRel) break;

      const prequelAnilistId = Number(prequelRel.animeId);
      if (visitedAnilistIds.has(prequelAnilistId)) break;
      visitedAnilistIds.add(prequelAnilistId);

      const prequelRows = await db.execute(sql`
        SELECT id, anilist_id, episode_count, start_date
        FROM anime
        WHERE anilist_id = ${prequelAnilistId}
        LIMIT 1
      `).catch(() => null);
      const prequel = prequelRows?.[0] as {
        id?: number;
        episode_count?: number | null;
        start_date?: string | Date | null;
      } | undefined;
      if (!prequel?.id) break;

      let prequelEpCount = Number(prequel.episode_count || 0);
      if (!Number.isSafeInteger(prequelEpCount) || prequelEpCount <= 0) {
        const maxEpRows = await db.execute(sql`
          SELECT max(episode_number)::int AS max_ep FROM episode WHERE anime_id = ${prequel.id}
        `).catch(() => null);
        prequelEpCount = Number((maxEpRows?.[0] as { max_ep?: number } | undefined)?.max_ep || 0);
      }
      if (!Number.isSafeInteger(prequelEpCount) || prequelEpCount <= 0) break;

      cumulative += prequelEpCount;
      candidateOffsets.push(cumulative);

      if (prequel.start_date) {
        const ms = new Date(prequel.start_date).getTime();
        if (Number.isFinite(ms) && ms > 946_684_800_000) {
          prequelStartDates.push(Math.floor(ms / 1000));
        }
      }
      currentAnimeId = Number(prequel.id);
    }

    if (candidateOffsets.length === 0) return empty;

    // Load local episodes + original (`sub`) air dates from episode & anime_schedule
    const [epRows, schedRows] = await Promise.all([
      db.execute(sql`
        SELECT episode_number, title, aired_at
        FROM episode
        WHERE anime_id = ${root.id}
        ORDER BY episode_number ASC
      `).catch(() => null),
      db.execute(sql`
        SELECT episode_number, airing_at
        FROM anime_schedule
        WHERE anime_id = ${root.id} AND air_type = 'sub'
        ORDER BY episode_number ASC
      `).catch(() => null),
    ]);

    const byEp = new Map<number, LocalEpisodeScheduleInfo>();
    if (Array.isArray(epRows)) {
      for (const row of epRows as any[]) {
        const epNum = Number(row.episode_number);
        if (!Number.isSafeInteger(epNum) || epNum <= 0) continue;
        const ms = row.aired_at ? new Date(row.aired_at).getTime() : NaN;
        byEp.set(epNum, {
          episodeNumber: epNum,
          title: typeof row.title === "string" ? row.title : null,
          airedAtSec: Number.isFinite(ms) && ms > 946_684_800_000 ? Math.floor(ms / 1000) : null,
        });
      }
    }
    if (Array.isArray(schedRows)) {
      for (const row of schedRows as any[]) {
        const epNum = Number(row.episode_number);
        if (!Number.isSafeInteger(epNum) || epNum <= 0) continue;
        const ms = row.airing_at ? new Date(row.airing_at).getTime() : NaN;
        const sec = Number.isFinite(ms) && ms > 946_684_800_000 ? Math.floor(ms / 1000) : null;
        const existing = byEp.get(epNum);
        if (existing) {
          if (sec !== null) existing.airedAtSec = sec;
        } else {
          byEp.set(epNum, { episodeNumber: epNum, airedAtSec: sec });
        }
      }
    }

    return {
      candidateOffsets,
      prequelStartDates,
      localEpisodes: [...byEp.values()].sort((a, b) => a.episodeNumber - b.episodeNumber),
    };
  } catch {
    return empty;
  }
}
