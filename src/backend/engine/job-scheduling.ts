import { and, eq, isNull, lte, or } from "drizzle-orm";
import { schema } from "../db/index.js";

export function queuedDiscoveryCondition() {
  return and(
    eq(schema.pipelineJob.status, "queued"),
    or(isNull(schema.pipelineJob.discoverAfter), lte(schema.pipelineJob.discoverAfter, new Date())),
  );
}

export const RELEASE_DISCOVERY_DELAYS_MS = [5, 15, 30, 60, 120, 240].map(minutes => minutes * 60_000);
export const CALLBACK_DELAYS_MS = [1, 5, 15, 60, 240, 720].map(minutes => minutes * 60_000);

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
