import { and, eq, isNull, lte, or } from "drizzle-orm";
import { schema } from "../db/index.js";

export function queuedDiscoveryCondition() {
  return and(
    eq(schema.pipelineJob.status, "queued"),
    or(isNull(schema.pipelineJob.discoverAfter), lte(schema.pipelineJob.discoverAfter, new Date())),
  );
}

// Sub releases usually appear within hours, while slower fansubbed shows (e.g. donghua) can take 1–2 days (~45.7h total).
export const SUB_DISCOVERY_DELAYS_MS = [5, 15, 30, 60, 120, 240, 360, 480, 720, 720].map(minutes => minutes * 60_000);
// Dub releases frequently drop 12–96h after AnimeSchedule's scheduled broadcast time (~94h / ~4 days total).
export const DUB_DISCOVERY_DELAYS_MS = [10, 20, 30, 60, 120, 240, 360, 480, 720, 720, 1440, 1440].map(minutes => minutes * 60_000);
export const RELEASE_DISCOVERY_DELAYS_MS = SUB_DISCOVERY_DELAYS_MS;
// Keep lower-quality torrent backfill searches within ~7.5h before falling back to GPU downscale.
export const QUALITY_BACKFILL_SEARCH_DELAYS_MS = [5, 15, 30, 60, 120, 240].map(minutes => minutes * 60_000);
export const CALLBACK_DELAYS_MS = [1, 5, 15, 60, 240, 720].map(minutes => minutes * 60_000);
// Minimum cooldown before an automated release dispatch re-opens an already-failed release job.
export const FAILED_RELEASE_REOPEN_COOLDOWN_MS = 30 * 60_000;

export function discoveryRetryDelaysForJob(
  types: readonly string[] | null | undefined,
  kind?: string | null,
): readonly number[] {
  if (kind !== "release") return [];
  const wantsDub = Array.isArray(types) && types.some(type => String(type).toLowerCase() === "dub");
  return wantsDub ? DUB_DISCOVERY_DELAYS_MS : SUB_DISCOVERY_DELAYS_MS;
}

export function resetRetryMetadata(
  metadata?: Record<string, any> | null,
  extra?: Record<string, any>,
): Record<string, any> {
  const next: Record<string, any> = { ...(metadata || {}), ...(extra || {}) };
  next.discoveryRetries = 0;
  if (next.kind === "quality_backfill") {
    next.qualitySearchAttempts = 0;
  }
  return next;
}

type AnimeIdentifiers = { animeId?: number | null; anilistId?: number | null; anidbId?: number | null };
type DiscoveryJob = AnimeIdentifiers & { id: number };

export function jobAnimeCondition({ animeId, anilistId, anidbId }: AnimeIdentifiers) {
  const row = schema.pipelineJob;
  const anidbMatch = anidbId ? eq(row.anidbId, anidbId) : undefined;
  const anilistMatch = anilistId
    ? or(eq(row.anilistId, anilistId), anidbMatch && and(isNull(row.anilistId), anidbMatch))
    : anidbMatch;
  return animeId
    ? or(eq(row.animeId, animeId), anilistMatch && and(isNull(row.animeId), anilistMatch))
    : anilistMatch;
}

export function discoveryEvent(job: DiscoveryJob, reason: string) {
  return {
    name: "pipeline/job.discover" as const,
    id: `pipe-job-${job.id}-${reason}-${Date.now()}`,
    data: {
      jobId: job.id,
      animeKey: job.animeId ? `anime:${job.animeId}`
        : job.anilistId ? `anilist:${job.anilistId}`
        : job.anidbId ? `anidb:${job.anidbId}` : `job:${job.id}`,
    },
  };
}
