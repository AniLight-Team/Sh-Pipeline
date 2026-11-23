import fs from "fs";
import path from "path";
import crypto from "crypto";
import PQueue from "p-queue";
import { db, schema } from "../db/index.js";
import { eq, and, inArray, isNull, isNotNull, asc, sql, or, lte } from "drizzle-orm";
import { TransmissionClient } from "./transmission.client.js";
import { SubtitleManager, inspectMkvStreamsSync, type ExtractedSubtitleTrack, type MkvStreamProbe } from "./subtitles.manager.js";
import { VideoEncodingManager } from "./video.manager.js";
import { AnimeToshoClient, type FetchTorrentsOptions } from "./animetosho.client.js";
import { TsukihimeClient, sharesDistinctiveTitleOverlap, type TsukihimeTorrentEntry } from "./tsukihime.client.js";
import { ReleaseFilter } from "./release-filter.js";
import {
  detectVerifiedEpisodeOffset,
  loadPrequelOffsetContext,
  type AnimeDiscoveryRule,
  type PrequelOffsetContext,
} from "./episode-offset.js";
import { normalizeBtih, torrentIdentityKey, torrentInfoHash } from "./torrent-identity.js";
import { AnimeMetadataResolver } from "./metadata-resolver.js";
import { canonicalDiscoveryTitles } from "./discovery-titles.js";
import {
  DATABASE_URL,
  DEFAULT_DOWNLOAD_DIR,
  MAIN_BACKEND_URL,
  INTERNAL_SECRET,
  KIRA_DISCOVERY_CONCURRENCY,
  KIRA_BATCH_WINDOW_MS,
  KIRA_QUEUE_IDLE_SETTLE_MS,
  KIRA_BATCH_SAFE_MAX_BYTES,
  KIRA_BATCH_MAX_ITEMS,
  KIRA_MAX_STAGING_BYTES,
  KIRA_MIN_FREE_SSD_BYTES,
  KIRA_PER_DOWNLOAD_RESERVE_BYTES,
  KIRA_VM_MAX_CONCURRENT_BATCHES,
  KIRA_VM_BATCH_MAX_ITEMS,
  KIRA_VM_BATCH_SAFE_MAX_BYTES,
  KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT,
  MAX_JOB_ATTEMPTS,
  MAX_BATCH_ATTEMPTS,
  TorrentEntryNotFoundException,
  getKiraStagingDir,
  loadAccountsFromEnv,
} from "../config.js";
import {
  CALLBACK_DELAYS_MS,
  FAILED_RELEASE_REOPEN_COOLDOWN_MS,
  QUALITY_BACKFILL_SEARCH_DELAYS_MS,
  discoveryEvent,
  discoveryRetryDelaysForJob,
  jobAnimeCondition,
  queuedDiscoveryCondition,
  resetRetryMetadata,
} from "./job-scheduling.js";
import {
  BACKFILL_QUALITIES,
  fetchMissingBackfillQualities,
  missingBackfillQualities,
  stageStored1080p,
  type BackfillQuality,
} from "./quality-backfill.js";
import { inngest } from "../inngest/client.js";
import type {
  AnimeToshoItem,
  CandidateSelectionTier,
  EnqueueRequest,
  EnqueueResponse,
  PipelineEpisodeResult,
  PipelineExecutionPolicy,
  PipelineExecutionType,
  PipelineStats,
  KiraBatchManifestItem,
  KiraBatchUploadItem,
  KiraBatchHfRecord,
  R2SubtitleRecord,
  ReleaseCandidateBundle,
  StagedFileDiskEntry,
  StorageInspectionReport,
  VideoResolutionQuality,
} from "./types.js";
import { log } from "../utils/logger.js";

let tablesInitialized = false;
let lastWatchdogTimestamp: string | null = new Date().toISOString();
let lastQuickReconcileAt = 0;

type PipelineJob = typeof schema.pipelineJob.$inferSelect;
type DiscoveryResult = {
  status: "staged" | "completed" | "retry_scheduled" | "download_paused" | "skipped" | "failed";
  jobId: number;
  pipelineType?: PipelineExecutionType;
  selectionTier?: CandidateSelectionTier;
  sizeBytes?: number;
  error?: string;
};

function loadInitialExecutionPolicy(): PipelineExecutionPolicy {
  try {
    const policyFile = path.join(getKiraStagingDir(), ".pipeline-policy.json");
    if (fs.existsSync(policyFile)) {
      const parsed = JSON.parse(fs.readFileSync(policyFile, "utf8"));
      if (
        parsed?.policy === "all" ||
        parsed?.policy === "vm_remux_only" ||
        parsed?.policy === "kaggle_gpu_only"
      ) {
        return parsed.policy;
      }
    }
  } catch {}
  const envPolicy = (process.env.KIRA_EXECUTION_POLICY || "").trim().toLowerCase();
  if (envPolicy === "vm_remux_only" || envPolicy === "pipeline_1" || envPolicy === "pipeline1") {
    return "vm_remux_only";
  }
  if (envPolicy === "kaggle_gpu_only" || envPolicy === "pipeline_2" || envPolicy === "pipeline2") {
    return "kaggle_gpu_only";
  }
  return "all";
}

let currentExecutionPolicy: PipelineExecutionPolicy = loadInitialExecutionPolicy();

// Dedicated VM direct-remux concurrency limiter (Pipeline 1: H.264 -c:v copy)
const vmRemuxQueue = new PQueue({ concurrency: KIRA_VM_MAX_CONCURRENT_BATCHES });

// High-concurrency Stage 1 discovery & download queue for standalone fallback execution
export const stage1DiscoveryQueue = new PQueue({ concurrency: KIRA_DISCOVERY_CONCURRENCY });

export class PipelineEngineService {
  public static readonly stage1DiscoveryQueue = stage1DiscoveryQueue;
  private static readonly activeVmRemuxJobIds = new Set<number>();
  private static readonly activeExecutingBatchIds = new Set<number>();
  private static readonly activeDiscoveringJobIds = new Set<number>();
  private static readonly torrentFileTransfers = new Map<string, Promise<unknown>>();
  private static storedSourceDownload: { jobId: number; sizeBytes: number } | null = null;
  private static isDrainingVmRemux = false;
  private static isReconcilingEncoding = false;

  public static getExecutionPolicy(): PipelineExecutionPolicy {
    return currentExecutionPolicy;
  }

  public static persistExecutionPolicyToDisk(policy: PipelineExecutionPolicy): void {
    currentExecutionPolicy = policy;
    try {
      const policyFile = path.join(getKiraStagingDir(), ".pipeline-policy.json");
      fs.writeFileSync(
        policyFile,
        JSON.stringify({ policy, updatedAt: new Date().toISOString() }, null, 2),
        "utf8",
      );
    } catch {}
  }

  /**
   * Pure deterministic policy filter for candidate bundles:
   * - `all`: Allows both Pipeline 1 (`vm_remux` H.264) and Pipeline 2 (`kaggle_gpu` HEVC/AV1).
   * - `vm_remux_only` (Pipeline 1 Only): Allows only `vm_remux` (H.264) bundles. If an episode only has HEVC/AV1 (`kaggle_gpu`) releases, marks it as skipped.
   * - `kaggle_gpu_only` (Pipeline 2 Only): Allows only `kaggle_gpu` (HEVC/AV1) episodes. If an episode is a Pipeline 1 (H.264) release (unless explicitly forced to `kaggle_gpu`), marks it as skipped.
   */
  public static filterCandidateBundlesByPolicy(
    bundles: ReleaseCandidateBundle[],
    policy: PipelineExecutionPolicy,
    forcedMode?: PipelineExecutionType | null,
  ): {
    allowedBundles: ReleaseCandidateBundle[];
    skippedReason: string | null;
    naturalPipeline: PipelineExecutionType | null;
  } {
    if (bundles.length === 0) {
      return { allowedBundles: [], skippedReason: null, naturalPipeline: null };
    }

    const hasVmRemuxCandidate = bundles.some((b) => b.pipelineType === "vm_remux");
    const hasKaggleGpuCandidate = bundles.some((b) => b.pipelineType === "kaggle_gpu");
    const naturalPipeline: PipelineExecutionType = hasVmRemuxCandidate ? "vm_remux" : "kaggle_gpu";

    if (policy === "all") {
      if (forcedMode === "vm_remux" && hasVmRemuxCandidate) {
        return {
          allowedBundles: bundles.filter((b) => b.pipelineType === "vm_remux"),
          skippedReason: null,
          naturalPipeline,
        };
      }
      if (forcedMode === "kaggle_gpu" && hasKaggleGpuCandidate) {
        return {
          allowedBundles: bundles.filter((b) => b.pipelineType === "kaggle_gpu"),
          skippedReason: null,
          naturalPipeline,
        };
      }
      return { allowedBundles: bundles, skippedReason: null, naturalPipeline };
    }

    if (policy === "vm_remux_only") {
      const vmBundles = bundles.filter((b) => b.pipelineType === "vm_remux");
      if (vmBundles.length > 0) {
        return {
          allowedBundles: vmBundles,
          skippedReason: null,
          naturalPipeline: "vm_remux",
        };
      }
      return {
        allowedBundles: [],
        skippedReason:
          "Skipped: Only HEVC/AV1 (Pipeline 2 GPU) releases found while 'Pipeline 1 Only (VM H.264 Remux)' mode is active.",
        naturalPipeline: "kaggle_gpu",
      };
    }

    // policy === "kaggle_gpu_only"
    if (hasVmRemuxCandidate && forcedMode !== "kaggle_gpu") {
      return {
        allowedBundles: [],
        skippedReason:
          "Skipped: Episode has H.264 (Pipeline 1 VM Remux) release while 'Pipeline 2 Only (Kaggle GPU)' mode is active.",
        naturalPipeline: "vm_remux",
      };
    }

    const gpuBundles = bundles.filter((b) => b.pipelineType === "kaggle_gpu");
    if (gpuBundles.length > 0) {
      return {
        allowedBundles: gpuBundles,
        skippedReason: null,
        naturalPipeline: "kaggle_gpu",
      };
    }

    return {
      allowedBundles: [],
      skippedReason:
        "Skipped: No Pipeline 2 (HEVC/AV1 Kaggle GPU) releases found while 'Pipeline 2 Only' mode is active.",
      naturalPipeline: "vm_remux",
    };
  }

  public static isBatchCurrentlyExecutingInProcess(batchId: number): boolean {
    return this.activeExecutingBatchIds.has(batchId);
  }

  public static isJobDiscoveringInProcess(jobId: number): boolean {
    return this.activeDiscoveringJobIds.has(jobId);
  }

  public static getActiveVmRemuxCount(): number {
    return this.activeVmRemuxJobIds.size;
  }

  public static markWatchdogRun(): void {
    lastWatchdogTimestamp = new Date().toISOString();
  }


  public static async ensureTables(): Promise<void> {
    if (tablesInitialized || !DATABASE_URL) return;
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "pipeline_encoding_batch" (
          "id" bigserial PRIMARY KEY NOT NULL,
          "pipeline_type" text DEFAULT 'kaggle_gpu' NOT NULL,
          "status" text DEFAULT 'created' NOT NULL,
          "trigger_reason" text DEFAULT 'window_30m' NOT NULL,
          "kaggle_username" text,
          "dataset_slug" text,
          "kernel_slug" text,
          "total_bytes" bigint DEFAULT 0 NOT NULL,
          "job_count" integer DEFAULT 0 NOT NULL,
          "attempt" integer DEFAULT 1 NOT NULL,
          "last_error" text,
          "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
          "started_at" timestamp with time zone,
          "completed_at" timestamp with time zone,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "pipeline_encoding_job" (
          "id" bigserial PRIMARY KEY NOT NULL,
          "anilist_id" integer,
          "anime_id" integer,
          "anidb_id" integer,
          "episode_number" integer NOT NULL,
          "types" jsonb NOT NULL,
          "status" text DEFAULT 'queued' NOT NULL,
          "pipeline_type" text DEFAULT 'vm_remux' NOT NULL,
          "selection_tier" text,
          "release_group" text,
          "video_codec" text,
          "is_batch_torrent" boolean DEFAULT false NOT NULL,
          "quality_count" integer DEFAULT 1 NOT NULL,
          "staged_qualities" jsonb,
          "qualities_payload" jsonb,
          "known_titles" jsonb,
          "metadata" jsonb,
          "callback_url" text,
          "attempt" integer DEFAULT 1 NOT NULL,
          "torrent_magnet" text,
          "torrent_title" text,
          "torrent_id" integer,
          "staged_file_path" text,
          "size_bytes" bigint,
          "tracks_config" jsonb,
          "subtitles_payload" jsonb,
          "result_payload" jsonb,
          "batch_id" bigint REFERENCES "pipeline_encoding_batch"("id") ON DELETE SET NULL,
          "last_error" text,
          "heartbeat_at" timestamp with time zone DEFAULT now() NOT NULL,
          "staged_at" timestamp with time zone,
          "completed_at" timestamp with time zone,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
      `);

      await db.execute(sql`
        ALTER TABLE "pipeline_encoding_batch" ADD COLUMN IF NOT EXISTS "pipeline_type" text DEFAULT 'kaggle_gpu' NOT NULL;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "anilist_id" integer;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "anime_id" integer;
        ALTER TABLE "pipeline_encoding_job" ALTER COLUMN "anidb_id" DROP NOT NULL;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "pipeline_type" text DEFAULT 'vm_remux' NOT NULL;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "selection_tier" text;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "release_group" text;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "video_codec" text;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "is_batch_torrent" boolean DEFAULT false NOT NULL;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "quality_count" integer DEFAULT 1 NOT NULL;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "staged_qualities" jsonb;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "qualities_payload" jsonb;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "discover_after" timestamp with time zone;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "callback_after" timestamp with time zone;
      `);

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "sh_pipeline_batch_status_idx" ON "pipeline_encoding_batch" ("status");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_batch_pipeline_type_idx" ON "pipeline_encoding_batch" ("pipeline_type", "status");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_batch_user_idx" ON "pipeline_encoding_batch" ("kaggle_username", "status");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_batch_heartbeat_idx" ON "pipeline_encoding_batch" ("status", "heartbeat_at");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_status_idx" ON "pipeline_encoding_job" ("status");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_pipeline_status_idx" ON "pipeline_encoding_job" ("status", "pipeline_type", "batch_id", "staged_at");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_anilist_idx" ON "pipeline_encoding_job" ("anilist_id", "episode_number");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_anime_idx" ON "pipeline_encoding_job" ("anime_id");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_anidb_idx" ON "pipeline_encoding_job" ("anidb_id", "episode_number");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_batch_idx" ON "pipeline_encoding_job" ("batch_id");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_discover_after_idx" ON "pipeline_encoding_job" ("status", "discover_after");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_callback_after_idx" ON "pipeline_encoding_job" ("status", "callback_after");
      `);

      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "pipeline_anime_rule" (
          "id" bigserial PRIMARY KEY NOT NULL,
          "anilist_id" integer UNIQUE,
          "anime_id" integer,
          "episode_offset" integer DEFAULT 0 NOT NULL,
          "source_tsukihime_id" integer,
          "source_anidb_id" integer,
          "search_titles" jsonb,
          "notes" text,
          "created_at" timestamp with time zone DEFAULT now() NOT NULL,
          "updated_at" timestamp with time zone DEFAULT now() NOT NULL
        );
        CREATE INDEX IF NOT EXISTS "sh_pipeline_anime_rule_anime_idx" ON "pipeline_anime_rule" ("anime_id");
      `);

      tablesInitialized = true;
      log.success("PipelineEngine", "Pipeline dual-pipeline tables & indexes verified.");
    } catch (err: any) {
      log.warn("PipelineEngine", `ensureTables: ${err?.message || err}`);
    }
  }

  /**
   * Computes actual physical bytes present inside the local SSD staging directory.
   */
  public static getActualStagingDiskBytes(): number {
    try {
      const stagingDir = getKiraStagingDir();
      if (!fs.existsSync(stagingDir)) return 0;
      const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
      let total = 0;
      for (const entry of entries) {
        const fullPath = path.join(stagingDir, entry.name);
        try {
          if (entry.isFile()) {
            total += fs.statSync(fullPath).size;
          } else if (entry.isDirectory()) {
            const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
            for (const sub of subEntries) {
              if (sub.isFile()) {
                total += fs.statSync(path.join(fullPath, sub.name)).size;
              }
            }
          }
        } catch {}
      }
      return total;
    } catch {
      return 0;
    }
  }

  /**
   * Strictly checks whether the 56 GB staging limit (KIRA_MAX_STAGING_BYTES) or minimum free SSD floor
   * has been reached before allowing a new torrent download to start.
   */
  public static async checkStorageCapacityForDownload(excludeJobId?: number): Promise<{
    allowed: boolean;
    usedBytes: number;
    reservedBytes: number;
    freeDiskBytes: number;
    reason?: string;
  }> {
    const diskBytes = this.getActualStagingDiskBytes();
    let dbBytes = 0;
    let activeDownloadingCount = 0;

    if (DATABASE_URL) {
      try {
        await this.ensureTables();
        const [stagedAndEncodingRows, downloadingRows] = await Promise.all([
          db
            .select({
              id: schema.pipelineJob.id,
              sizeBytes: schema.pipelineJob.sizeBytes,
            })
            .from(schema.pipelineJob)
            .where(inArray(schema.pipelineJob.status, ["staged", "encoding"])),
          db
            .select({
              id: schema.pipelineJob.id,
            })
            .from(schema.pipelineJob)
            .where(eq(schema.pipelineJob.status, "downloading")),
        ]);

        for (const r of stagedAndEncodingRows) {
          dbBytes += Number(r.sizeBytes || 0);
        }
        activeDownloadingCount = downloadingRows.filter((r) => r.id !== excludeJobId).length;
      } catch {}
    }

    const usedBytes = Math.max(diskBytes, dbBytes);
    const stored = this.storedSourceDownload;
    const storedReserve = stored && stored.jobId !== excludeJobId
      ? Math.max(0, stored.sizeBytes - KIRA_PER_DOWNLOAD_RESERVE_BYTES) : 0;
    const reservedBytes = activeDownloadingCount * KIRA_PER_DOWNLOAD_RESERVE_BYTES + storedReserve;
    const projectedBytes = usedBytes + reservedBytes;

    let freeDiskBytes = Number.MAX_SAFE_INTEGER;
    try {
      const stagingDir = getKiraStagingDir();
      const statFs = fs.statfsSync(stagingDir);
      freeDiskBytes = Number(statFs.bavail) * Number(statFs.bsize);
    } catch {}

    if (usedBytes >= KIRA_MAX_STAGING_BYTES) {
      const usedGb = (usedBytes / (1024 * 1024 * 1024)).toFixed(2);
      const maxGb = (KIRA_MAX_STAGING_BYTES / (1024 * 1024 * 1024)).toFixed(1);
      return {
        allowed: false,
        usedBytes,
        reservedBytes,
        freeDiskBytes,
        reason: `Staging buffer at ${usedGb} GB / ${maxGb} GB max limit; pausing new downloads until active batches clear SSD space.`,
      };
    }

    if (projectedBytes >= KIRA_MAX_STAGING_BYTES && (usedBytes > 0 || activeDownloadingCount > 0)) {
      const projGb = (projectedBytes / (1024 * 1024 * 1024)).toFixed(2);
      const maxGb = (KIRA_MAX_STAGING_BYTES / (1024 * 1024 * 1024)).toFixed(1);
      return {
        allowed: false,
        usedBytes,
        reservedBytes,
        freeDiskBytes,
        reason: `Projected staging usage (${projGb} GB with ${activeDownloadingCount} active download(s)) reaches ${maxGb} GB limit.`,
      };
    }

    if (freeDiskBytes < KIRA_MIN_FREE_SSD_BYTES) {
      const freeGb = (freeDiskBytes / (1024 * 1024 * 1024)).toFixed(2);
      const minFreeGb = (KIRA_MIN_FREE_SSD_BYTES / (1024 * 1024 * 1024)).toFixed(1);
      return {
        allowed: false,
        usedBytes,
        reservedBytes,
        freeDiskBytes,
        reason: `SSD free disk space (${freeGb} GB) is below minimum floor (${minFreeGb} GB).`,
      };
    }

    return {
      allowed: true,
      usedBytes,
      reservedBytes,
      freeDiskBytes,
    };
  }

  /**
   * Deletes all local staged video files for a job (including 1080p, 720p, and 480p quality files).
   */
  public static async cleanupJobStagedFiles(job: {
    id?: number;
    stagedFilePath?: string | null;
    stagedQualities?: Partial<Record<VideoResolutionQuality, string>> | null;
    metadata?: Record<string, any> | null;
  }): Promise<void> {
    if (job.id && Number.isSafeInteger(job.id)) {
      const root = path.resolve(getKiraStagingDir());
      const entries = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.isDirectory() && entry.name.startsWith(`vm_remux_${job.id}_`)) {
          const target = path.resolve(root, entry.name);
          if (path.dirname(target) === root) await fs.promises.rm(target, { recursive: true, force: true });
        }
      }
    }
    const pathsToDelete = new Set<string>();
    if (job.stagedFilePath) {
      pathsToDelete.add(job.stagedFilePath);
    }
    const sqDirect = job.stagedQualities;
    if (sqDirect && typeof sqDirect === "object") {
      for (const p of Object.values(sqDirect)) {
        if (typeof p === "string" && p.trim()) {
          pathsToDelete.add(p);
        }
      }
    }
    const stagedQualitiesMeta = job.metadata?.stagedQualities;
    if (stagedQualitiesMeta && typeof stagedQualitiesMeta === "object") {
      for (const p of Object.values(stagedQualitiesMeta)) {
        if (typeof p === "string" && p.trim()) {
          pathsToDelete.add(p);
        }
      }
    }
    for (const filePath of pathsToDelete) {
      try {
        if (fs.existsSync(filePath)) {
          await fs.promises.unlink(filePath);
        }
      } catch {}
    }
  }

  /**
   * Checks whether the staged files can be reused for processing.
   */
  public static async getAnimeDiscoveryRule(lookup: {
    anilistId?: number | null;
    animeId?: number | null;
  }): Promise<AnimeDiscoveryRule | null> {
    if (!DATABASE_URL || (!lookup.anilistId && !lookup.animeId)) return null;
    try {
      await this.ensureTables();
      const conditions = [];
      if (lookup.anilistId && lookup.anilistId > 0) {
        conditions.push(eq(schema.pipelineAnimeRule.anilistId, lookup.anilistId));
      }
      if (lookup.animeId && lookup.animeId > 0) {
        conditions.push(eq(schema.pipelineAnimeRule.animeId, lookup.animeId));
      }
      if (!conditions.length) return null;
      const row = await db.query.pipelineAnimeRule.findFirst({
        where: conditions.length > 1 ? or(...conditions) : conditions[0],
      });
      if (!row) return null;
      return {
        id: row.id,
        anilistId: row.anilistId,
        animeId: row.animeId,
        episodeOffset: Math.max(0, Number(row.episodeOffset || 0)),
        sourceTsukihimeId: row.sourceTsukihimeId,
        sourceAnidbId: row.sourceAnidbId,
        searchTitles: Array.isArray(row.searchTitles) ? row.searchTitles.filter(t => typeof t === "string" && t.trim()) : [],
        notes: row.notes,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    } catch {
      return null;
    }
  }

  public static async listAnimeDiscoveryRules(): Promise<AnimeDiscoveryRule[]> {
    if (!DATABASE_URL) return [];
    await this.ensureTables();
    const rows = await db.select().from(schema.pipelineAnimeRule).orderBy(asc(schema.pipelineAnimeRule.id));
    return rows.map(row => ({
      id: row.id,
      anilistId: row.anilistId,
      animeId: row.animeId,
      episodeOffset: Math.max(0, Number(row.episodeOffset || 0)),
      sourceTsukihimeId: row.sourceTsukihimeId,
      sourceAnidbId: row.sourceAnidbId,
      searchTitles: Array.isArray(row.searchTitles) ? row.searchTitles.filter(t => typeof t === "string" && t.trim()) : [],
      notes: row.notes,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  public static async upsertAnimeDiscoveryRule(input: {
    anilistId?: number | null;
    animeId?: number | null;
    episodeOffset: number;
    sourceTsukihimeId?: number | null;
    sourceAnidbId?: number | null;
    searchTitles?: string[];
    notes?: string | null;
  }): Promise<AnimeDiscoveryRule> {
    await this.ensureTables();
    const anilistId = input.anilistId && input.anilistId > 0 ? input.anilistId : null;
    const animeId = input.animeId && input.animeId > 0 ? input.animeId : null;
    if (!anilistId && !animeId) {
      throw new Error("Either anilistId or animeId is required for an anime discovery rule");
    }
    const episodeOffset = Math.max(0, Math.min(5000, Math.floor(Number(input.episodeOffset || 0))));
    const sourceTsukihimeId = input.sourceTsukihimeId && input.sourceTsukihimeId > 0 ? input.sourceTsukihimeId : null;
    const sourceAnidbId = input.sourceAnidbId && input.sourceAnidbId > 0 ? input.sourceAnidbId : null;
    const searchTitles = Array.from(new Set((input.searchTitles ?? []).map(t => t.trim()).filter(Boolean))).slice(0, 20);
    const notes = input.notes?.trim() || null;
    const now = new Date();

    const existing = await this.getAnimeDiscoveryRule({ anilistId, animeId });
    const [saved] = existing
      ? await db
          .update(schema.pipelineAnimeRule)
          .set({
            anilistId: anilistId ?? existing.anilistId,
            animeId: animeId ?? existing.animeId,
            episodeOffset,
            sourceTsukihimeId,
            sourceAnidbId,
            searchTitles,
            notes,
            updatedAt: now,
          })
          .where(eq(schema.pipelineAnimeRule.id, existing.id))
          .returning()
      : await db
          .insert(schema.pipelineAnimeRule)
          .values({
            anilistId,
            animeId,
            episodeOffset,
            sourceTsukihimeId,
            sourceAnidbId,
            searchTitles,
            notes,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

    return {
      id: saved.id,
      anilistId: saved.anilistId,
      animeId: saved.animeId,
      episodeOffset: saved.episodeOffset,
      sourceTsukihimeId: saved.sourceTsukihimeId,
      sourceAnidbId: saved.sourceAnidbId,
      searchTitles: Array.isArray(saved.searchTitles) ? saved.searchTitles : [],
      notes: saved.notes,
      createdAt: saved.createdAt,
      updatedAt: saved.updatedAt,
    };
  }

  public static async deleteAnimeDiscoveryRule(id: number): Promise<boolean> {
    await this.ensureTables();
    const deleted = await db
      .delete(schema.pipelineAnimeRule)
      .where(eq(schema.pipelineAnimeRule.id, id))
      .returning({ id: schema.pipelineAnimeRule.id });
    return deleted.length > 0;
  }

  public static hasValidStagedFiles(job: {
    stagedFilePath?: string | null;
    stagedQualities?: Partial<Record<VideoResolutionQuality, string>> | null;
    metadata?: Record<string, any> | null;
    torrentTitle?: string | null;
    qualitiesPayload?: Record<string, any> | null;
    knownTitles?: string[] | null;
  }): boolean {
    const isManualTorrent = Number.isSafeInteger(Number(job.metadata?.manualTsukihimeTorrentId)) &&
      Number(job.metadata?.manualTsukihimeTorrentId) > 0;
    const stagedTitles = [job.torrentTitle, job.metadata?.sourceTorrentTitle,
      ...Object.values(job.qualitiesPayload ?? {}).map(source => source?.title)];
    if (!isManualTorrent) {
      if (stagedTitles.some(title => typeof title === "string" && ReleaseFilter.hasWatermarkedSource(title))) return false;
      const knownTitles = job.knownTitles;
      if (knownTitles?.length && stagedTitles.some(title => typeof title === "string" &&
          !ReleaseFilter.matchesSeriesTitle(title, knownTitles, { allowUnmarkedSeason: true, allowVerifiedSeason: true }))) return false;
    }
    const sq = job.stagedQualities || job.metadata?.stagedQualities;
    const paths = new Set<string>(job.stagedFilePath ? [job.stagedFilePath] : []);
    if (sq && typeof sq === "object") {
      for (const value of Object.values(sq)) if (typeof value === "string" && value) paths.add(value);
    }
    if (!paths.size) return false;
    return [...paths].every(file => {
      try { const stat = fs.statSync(file); return stat.isFile() && stat.size > 0; }
      catch { return false; }
    });
  }

  public static buildManualTsukihimeBundle(
    entry: TsukihimeTorrentEntry,
    episodeNumber: number,
    knownTitles: (string | null | undefined)[] = [],
  ): ReleaseCandidateBundle {
    const item = TsukihimeClient.toAnimeToshoItem(entry);
    const parsed = ReleaseFilter.parseTitle(item.title, knownTitles, item);
    const quality: VideoResolutionQuality = parsed.resolution || "1080p";
    const isH264 = Boolean(parsed.isH264);
    const isSolo = !parsed.isBatch && parsed.epRange === null && (item.num_files || 1) === 1;
    const effectiveEp = parsed.singleEp ??
      (typeof entry.episode_no === "number" && Number.isSafeInteger(entry.episode_no) && entry.episode_no > 0
        ? entry.episode_no
        : episodeNumber);
    const group = parsed.group || entry.group?.name || "Manual";
    const primaryEntry = {
      quality,
      item,
      effectiveEp,
      score: 1000,
    };
    return {
      group,
      groupLower: group.toLowerCase(),
      isH264,
      isDualAudio: parsed.isDualAudio,
      isEnglishDub: parsed.isEnglishDub,
      isSolo,
      selectionTier: isH264 ? "h264_single_1080p" : "hevc_av1_gpu",
      pipelineType: isH264 ? "vm_remux" : "kaggle_gpu",
      bundleScore: 10000,
      primaryEntry,
      qualities: { [quality]: primaryEntry },
    };
  }

  /**
   * Helper to determine whether a job belongs to Pipeline 1: VM Direct-Remux (-c:v copy)
   * vs Pipeline 2: Kaggle Dual-T4 GPU Encode.
   */
  public static isJobVmRemux(job: {
    pipelineType?: string | null;
    metadata?: Record<string, any> | null;
  }): boolean {
    if (job.metadata?.processingMode === "kaggle_gpu" || job.pipelineType === "kaggle_gpu") {
      if (job.metadata?.processingMode === "vm_remux") return true;
      if (job.metadata?.processingMode === "kaggle_gpu") return false;
      return false;
    }
    return job.pipelineType === "vm_remux" || job.metadata?.processingMode === "vm_remux";
  }

  /**
   * Helper to determine whether a batch is a Pipeline 1 VM Direct-Remux batch rather than a Pipeline 2 Kaggle GPU batch.
   */
  public static isBatchVmRemux(batch: {
    pipelineType?: string | null;
    kaggleUsername?: string | null;
    triggerReason?: string | null;
  }): boolean {
    return (
      batch.pipelineType === "vm_remux" ||
      batch.kaggleUsername === "local-vm" ||
      Boolean(batch.triggerReason && batch.triggerReason.startsWith("vm_remux"))
    );
  }

  /**
   * Enqueues one or more episodes for high-concurrency torrent discovery, 1080p R2 subtitle extraction,
   * and routing into Pipeline 1 (VM Direct Remux) or Pipeline 2 (Kaggle GPU Encode).
   */
  public static async enqueue(req: EnqueueRequest): Promise<EnqueueResponse> {
    await this.ensureTables();

    let {
      anilistId,
      animeId,
      anidbId,
      episodeNumbers,
      types = ["sub", "dub"],
      metadata = {},
    } = req;

    const topManualTorrentId = Number(req.manualTsukihimeTorrentId ?? metadata?.manualTsukihimeTorrentId);
    const defaultManualTorrentId = Number.isSafeInteger(topManualTorrentId) && topManualTorrentId > 0
      ? topManualTorrentId
      : undefined;
    const manualTorrentIds = new Set<number>();
    if (defaultManualTorrentId) manualTorrentIds.add(defaultManualTorrentId);
    for (const ep of req.episodes ?? []) {
      const epTid = Number(ep.manualTsukihimeTorrentId);
      if (Number.isSafeInteger(epTid) && epTid > 0) manualTorrentIds.add(epTid);
    }
    const manualTorrents = new Map<number, TsukihimeTorrentEntry>();
    for (const tid of manualTorrentIds) {
      const entry = await TsukihimeClient.fetchTorrentById(tid);
      if (!entry) {
        throw new TorrentEntryNotFoundException(`Tsukihime torrent #${tid} was not found`);
      }
      manualTorrents.set(tid, entry);
    }
    const primaryManualEntry = defaultManualTorrentId ? manualTorrents.get(defaultManualTorrentId) : [...manualTorrents.values()][0];

    if (!anilistId && metadata?.anilistId) {
      const parsed = Number(metadata.anilistId);
      if (!isNaN(parsed) && parsed > 0) anilistId = parsed;
    }
    if (!animeId && metadata?.animeId) {
      const parsed = Number(metadata.animeId);
      if (!isNaN(parsed) && parsed > 0) animeId = parsed;
    }
    if (!anilistId && primaryManualEntry?.anime?.anilist && primaryManualEntry.anime.anilist > 0) {
      anilistId = primaryManualEntry.anime.anilist;
    }
    if (!anidbId && primaryManualEntry?.anime?.anidb && primaryManualEntry.anime.anidb > 0) {
      anidbId = primaryManualEntry.anime.anidb;
    }
    if (!req.episodes?.length && !episodeNumbers?.length && primaryManualEntry?.episode_no && primaryManualEntry.episode_no > 0) {
      episodeNumbers = [primaryManualEntry.episode_no];
    }

    let knownTitles = anilistId
      ? await AnimeMetadataResolver.resolveDiscoveryTitles(anilistId)
      : animeId ? await AnimeMetadataResolver.resolveLocalDiscoveryTitles(animeId) : [];
    if (anilistId && (!anidbId || !animeId || knownTitles.length === 0)) {
      try {
        const resolved = await AnimeMetadataResolver.resolve(anilistId);
        if (resolved) {
          if (!anidbId && resolved.anidbId) {
            anidbId = resolved.anidbId;
          }
          if (!animeId && resolved.animeId) {
            animeId = resolved.animeId;
          }
          if (knownTitles.length === 0) {
            knownTitles = canonicalDiscoveryTitles(resolved);
          }
          metadata = {
            ...metadata,
            animeId: animeId || metadata?.animeId,
            anilistId,
            malId: resolved.malId || metadata?.malId,
            tsukihimeId: resolved.tsukihimeId || metadata?.tsukihimeId,
            primaryTitle: resolved.primaryTitle,
            coverImage: resolved.coverImage,
            totalEpisodes: resolved.totalEpisodes,
            source: resolved.source,
          };
          log.info(
            "PipelineEngine",
            `Resolved AniList #${anilistId} -> AniDB: ${anidbId || "n/a"}, Tsukihime: ${resolved.tsukihimeId || "n/a"}, AnimeId: ${animeId || "n/a"}, Title: "${resolved.primaryTitle}"`,
          );
        }
      } catch (err: any) {
        log.warn("PipelineEngine", `Metadata resolution error for AniList #${anilistId}: ${err?.message || err}`);
      }
    }
    if (knownTitles.length === 0 && primaryManualEntry?.anime) {
      knownTitles = canonicalDiscoveryTitles({
        titleRomaji: primaryManualEntry.anime.title,
        titleEnglish: primaryManualEntry.anime.english_title,
      });
    }
    if (primaryManualEntry?.anime) {
      metadata = {
        ...metadata,
        tsukihimeId: metadata?.tsukihimeId || primaryManualEntry.anime.id,
        malId: metadata?.malId || primaryManualEntry.anime.mal || undefined,
        primaryTitle: metadata?.primaryTitle || primaryManualEntry.anime.english_title || primaryManualEntry.anime.title,
        coverImage: metadata?.coverImage || primaryManualEntry.anime.thumbnail || undefined,
        totalEpisodes: metadata?.totalEpisodes || primaryManualEntry.anime.total_episodes || undefined,
      };
    }

    const kind = req.kind ?? "stream_refresh";
    const episodes: NonNullable<EnqueueRequest["episodes"]> = req.episodes ?? (episodeNumbers ?? []).map(episodeNumber => ({
      episodeNumber,
      types,
      manualTsukihimeTorrentId: defaultManualTorrentId,
    }));
    const targets = new Map<string, {
      episodeNumber: number;
      type: "sub" | "dub";
      sourceJobId?: number | null;
      sourceUrl?: string;
      manualTsukihimeTorrentId?: number;
    }>();
    for (const episode of episodes) {
      for (const type of episode.types) {
        targets.set(`${episode.episodeNumber}:${type}`, {
          episodeNumber: episode.episodeNumber,
          type,
          sourceJobId: episode.sourceJobId,
          sourceUrl: episode.sourceUrl,
          manualTsukihimeTorrentId: episode.manualTsukihimeTorrentId ?? defaultManualTorrentId,
        });
      }
    }

    // Serialize overlapping enqueue requests for the same anime across processes.
    const animeKey = animeId ? `anime:${animeId}` : anilistId ? `anilist:${anilistId}` : `anidb:${anidbId}`;
    const staleStagedJobsToClean: {
      id: number;
      stagedFilePath?: string | null;
      stagedQualities?: Partial<Record<VideoResolutionQuality, string>> | null;
      metadata?: Record<string, any> | null;
    }[] = [];
    const response = await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`kira-enqueue:${animeKey}`}, 0))`);
      const queuedJobs: EnqueueResponse["queuedJobs"] = [];
      let skippedExisting = 0;
      const pending = ["queued", "downloading", "staged", "encoding", "download_paused"];

      for (const { episodeNumber, type, sourceJobId, sourceUrl, manualTsukihimeTorrentId } of targets.values()) {
        const manualEntry = manualTsukihimeTorrentId ? manualTorrents.get(manualTsukihimeTorrentId) : undefined;
        const manualFields = manualTsukihimeTorrentId
          ? {
              manualTsukihimeTorrentId,
              manualTsukihimeTorrentName: manualEntry?.name,
            }
          : {};
        const existingRows = await tx.query.pipelineJob.findMany({
          columns: {
            id: true,
            status: true,
            batchId: true,
            stagedFilePath: true,
            stagedQualities: true,
            metadata: true,
            knownTitles: true,
            updatedAt: true,
          },
          where: and(
            jobAnimeCondition({ animeId, anilistId, anidbId }),
            eq(schema.pipelineJob.episodeNumber, episodeNumber),
            sql`${schema.pipelineJob.types} @> ${JSON.stringify([type])}::jsonb`,
            or(
              req.requestId ? sql`${schema.pipelineJob.metadata}->>'requestId' = ${req.requestId}` : undefined,
              kind === "release"
                ? or(
                    sql`${schema.pipelineJob.metadata}->>'kind' = 'release'`,
                    and(sql`${schema.pipelineJob.metadata}->>'kind' is null`, inArray(schema.pipelineJob.status, pending)),
                  )
                : and(
                    inArray(schema.pipelineJob.status, pending),
                    sql`coalesce(${schema.pipelineJob.metadata}->>'kind', 'stream_refresh') = ${kind}`,
                    kind === "caption_refresh"
                      ? sql`${schema.pipelineJob.metadata}->>'sourceJobId' is not distinct from ${sourceJobId == null ? null : String(sourceJobId)}::text`
                      : undefined,
                    kind === "caption_refresh" && sourceJobId == null
                      ? sql`${schema.pipelineJob.metadata}->>'sourceUrl' is not distinct from ${sourceUrl ?? null}::text`
                      : undefined,
                  ),
            ),
          ),
        });
        if (existingRows.length > 0) {
          const sameRequest = Boolean(req.requestId && existingRows.some(row => row.metadata?.requestId === req.requestId));
          const activeRow = existingRows.find(row =>
            ["downloading", "encoding"].includes(row.status) ||
            (row.batchId != null && !["failed", "completed"].includes(row.status)),
          );
          if (manualTsukihimeTorrentId && !sameRequest && !activeRow) {
            const reusableRow = existingRows.find(row =>
              ["queued", "download_paused", "failed", "skipped", "staged"].includes(row.status),
            );
            if (reusableRow) {
              const now = new Date();
              const [updated] = await tx.update(schema.pipelineJob).set({
                animeId: animeId ?? undefined,
                anilistId: anilistId ?? undefined,
                anidbId: anidbId ?? undefined,
                status: "queued",
                batchId: null,
                lastError: null,
                attempt: 1,
                discoverAfter: null,
                stagedFilePath: null,
                stagedQualities: null,
                torrentId: manualTsukihimeTorrentId,
                torrentTitle: manualEntry?.name ?? null,
                knownTitles: knownTitles.length ? knownTitles : reusableRow.knownTitles,
                metadata: resetRetryMetadata(
                  { ...(reusableRow.metadata || {}), ...metadata },
                  {
                    ...manualFields,
                    totalEpisodes: req.episodeCount ?? metadata.totalEpisodes ?? reusableRow.metadata?.totalEpisodes,
                    ...(req.executionPolicy ? { executionPolicy: req.executionPolicy } : {}),
                  },
                ),
                heartbeatAt: now,
                updatedAt: now,
              }).where(and(
                eq(schema.pipelineJob.id, reusableRow.id),
                eq(schema.pipelineJob.status, reusableRow.status),
              )).returning({
                id: schema.pipelineJob.id,
                animeId: schema.pipelineJob.animeId,
                anilistId: schema.pipelineJob.anilistId,
                anidbId: schema.pipelineJob.anidbId,
                episodeNumber: schema.pipelineJob.episodeNumber,
                types: schema.pipelineJob.types,
              });
              if (updated) {
                staleStagedJobsToClean.push(reusableRow);
                queuedJobs.push(updated);
                continue;
              }
            }
          }

          const blockingRow = existingRows.find(row => kind !== "release" || row.status !== "failed");
          const failedReleaseRow = !sameRequest && !blockingRow && kind === "release"
            ? existingRows.find(row => row.status === "failed" && row.metadata?.kind === "release")
            : undefined;

          if (failedReleaseRow && Date.now() - failedReleaseRow.updatedAt.getTime() >= FAILED_RELEASE_REOPEN_COOLDOWN_MS) {
            const now = new Date();
            const [reopened] = await tx.update(schema.pipelineJob).set({
              animeId: animeId ?? undefined,
              anilistId: anilistId ?? undefined,
              anidbId: anidbId ?? undefined,
              status: "queued",
              batchId: null,
              lastError: null,
              attempt: 1,
              discoverAfter: null,
              stagedFilePath: null,
              stagedQualities: null,
              ...(manualTsukihimeTorrentId ? { torrentId: manualTsukihimeTorrentId, torrentTitle: manualEntry?.name ?? null } : {}),
              knownTitles: knownTitles.length ? knownTitles : failedReleaseRow.knownTitles,
              metadata: resetRetryMetadata(
                { ...(failedReleaseRow.metadata || {}), ...metadata },
                {
                  kind: "release",
                  ...manualFields,
                  totalEpisodes: req.episodeCount ?? metadata.totalEpisodes ?? failedReleaseRow.metadata?.totalEpisodes,
                  requestId: req.requestId,
                  reopenCount: Number(failedReleaseRow.metadata?.reopenCount ?? 0) + 1,
                  reopenedAt: now.toISOString(),
                  ...(req.executionPolicy ? { executionPolicy: req.executionPolicy } : {}),
                },
              ),
              heartbeatAt: now,
              updatedAt: now,
            }).where(and(eq(schema.pipelineJob.id, failedReleaseRow.id), eq(schema.pipelineJob.status, "failed"))).returning({
              id: schema.pipelineJob.id,
              animeId: schema.pipelineJob.animeId,
              anilistId: schema.pipelineJob.anilistId,
              anidbId: schema.pipelineJob.anidbId,
              episodeNumber: schema.pipelineJob.episodeNumber,
              types: schema.pipelineJob.types,
            });
            if (reopened) {
              queuedJobs.push(reopened);
              continue;
            }
          }

          skippedExisting++;
          continue;
        }

        const [job] = await tx.insert(schema.pipelineJob).values({
          animeId,
          anilistId,
          anidbId,
          episodeNumber,
          types: [type],
          knownTitles,
          ...(manualTsukihimeTorrentId ? { torrentId: manualTsukihimeTorrentId, torrentTitle: manualEntry?.name ?? null } : {}),
          metadata: {
            ...metadata,
            ...manualFields,
            kind,
            totalEpisodes: req.episodeCount ?? metadata.totalEpisodes,
            requestId: req.requestId,
            sourceJobId: kind === "caption_refresh" ? sourceJobId ?? null : undefined,
            sourceUrl: kind === "caption_refresh" ? sourceUrl : undefined,
            ...(req.executionPolicy ? { executionPolicy: req.executionPolicy } : {}),
          },
        }).returning({
          id: schema.pipelineJob.id,
          animeId: schema.pipelineJob.animeId,
          anilistId: schema.pipelineJob.anilistId,
          anidbId: schema.pipelineJob.anidbId,
          episodeNumber: schema.pipelineJob.episodeNumber,
          types: schema.pipelineJob.types,
        });
        queuedJobs.push(job);
      }
      return { queuedJobs, skippedExisting };
    });
    for (const stale of staleStagedJobsToClean) {
      await this.cleanupJobStagedFiles(stale).catch(() => {});
    }
    return response;
  }

  /**
   * Downloads a single episode file from a torrent candidate via Transmission and moves it into stagingDir.
   * CRITICAL BATCH-EXTRACTION GUARDRAIL:
   * - Always prefers solo single-file episode torrents.
   * - If a candidate is a batch torrent (`isBatch` or `tFiles.length > 1`), it strictly extracts ONLY the
   *   target episode file (`selectOnlyFiles(tId, [wantedIdx], tFiles.length)`).
   * - If the batch torrent is a single monolithic combined file or archive where 1 episode cannot be isolated,
   *   it immediately aborts and removes the torrent (`no fallback to download the whole batch`).
   */
  private static async downloadCandidateEpisodeToStaging(
    params: Parameters<typeof PipelineEngineService.transferEpisodeFile>[0],
  ) {
    const { candidate, effectiveEp } = params;
    const key = `${torrentIdentityKey(candidate)}:${effectiveEp}`;
    const previous = this.torrentFileTransfers.get(key) ?? Promise.resolve();
    const transfer = previous.catch(() => {}).then(() => this.transferEpisodeFile(params));
    this.torrentFileTransfers.set(key, transfer);
    try {
      return await transfer;
    } finally {
      if (this.torrentFileTransfers.get(key) === transfer) this.torrentFileTransfers.delete(key);
    }
  }

  private static async transferEpisodeFile(params: {
    jobId: number;
    episodeNumber: number;
    knownTitles: string[];
    candidate: AnimeToshoItem;
    effectiveEp: number | string;
    totalExpectedEps?: number | null;
    qualityTag: VideoResolutionQuality;
    transmission: TransmissionClient;
    stagingDir: string;
    enforceHardCapBeforeStart: boolean;
    allowWatermarkedSource?: boolean;
    manualTorrent?: boolean;
  }): Promise<
    | {
        ok: true;
        stagedPath: string;
        sizeBytes: number;
        magnetUri: string;
        isBatchExtracted: boolean;
        fileIndex: number;
      }
    | { ok: false; pausedForCapacity?: boolean; reason: string }
  > {
    const {
      jobId,
      episodeNumber,
      knownTitles,
      candidate,
      effectiveEp,
      qualityTag,
      transmission,
      stagingDir,
      enforceHardCapBeforeStart,
    } = params;

    if (!params.allowWatermarkedSource && ReleaseFilter.hasWatermarkedSource(candidate.title)) {
      return { ok: false, reason: "Torrent is marked as a watermarked source" };
    }
    const expectedHash = torrentInfoHash(candidate);
    if (!expectedHash) return { ok: false, reason: "Torrent has no consistent info hash" };
    const magnetUri = candidate.magnet_uri || `magnet:?xt=urn:btih:${expectedHash}`;
    const primarySourceUrl = candidate.torrent_url || magnetUri;
    if (!primarySourceUrl) {
      return { ok: false, reason: "Missing magnet_uri and torrent_url" };
    }

    const parsedCandidateTitle = ReleaseFilter.parseTitle(candidate.title || "", knownTitles, candidate);

    let tId: number | null = null;
    let claimedWantedIdx: number | undefined = undefined;
    try {
      const tInfo = await transmission.addTorrent(
        primarySourceUrl,
        DEFAULT_DOWNLOAD_DIR,
        true,
        magnetUri || undefined,
      );
      tId = tInfo.id;
      if (normalizeBtih(tInfo.hashString) !== expectedHash) {
        await transmission.releaseTorrentClaim(tId, undefined, false, false, !tInfo.isDuplicate).catch(() => {});
        tId = null;
        throw new Error("Transmission returned a different or missing torrent info hash");
      }

      const metaStatus = await transmission.waitForMetadata(tId);
      if (normalizeBtih(metaStatus.hashString) !== expectedHash) {
        throw new Error("Transmission metadata does not match the selected torrent");
      }
      const tFiles = metaStatus.files || [];
      const dlDir = metaStatus.downloadDir || DEFAULT_DOWNLOAD_DIR;
      const isMultiFile = tFiles.length > 1;
      const isMarkedBatch = Boolean(parsedCandidateTitle.isBatch || parsedCandidateTitle.epRange !== null);

      // Guardrail 1: If a torrent is marked as a batch/range pack, it MUST have multiple files so we can extract 1 episode.
      // Never download a monolithic 1-file season pack!
      if (isMarkedBatch && !isMultiFile) {
        await transmission.releaseTorrentClaim(tId, undefined, true, false).catch(() => {});
        tId = null;
        throw new TorrentEntryNotFoundException(
          `Batch torrent '${candidate.title}' is a single monolithic file (cannot selectively extract Ep ${episodeNumber}); skipping to next candidate`,
        );
      }

      // Immediately isolate the target episode file before allowing bulk piece transfer
      const epMap = ReleaseFilter.matchFilesToEpisodes(tFiles, {
        knownTitles,
        targetEp: episodeNumber,
        effectiveEp,
        torrentTitle: candidate.title,
        totalExpectedEps: params.totalExpectedEps,
        allowWatermarkedSource: params.allowWatermarkedSource,
        allowVerifiedSeason: Boolean(candidate.provider === "tsukihime" || Number(candidate.anidb_aid) > 0),
        manualTorrent: Boolean(params.manualTorrent),
      });

      if (!epMap.has(episodeNumber)) {
        await transmission.releaseTorrentClaim(tId, undefined, true, false).catch(() => {});
        tId = null;
        throw new TorrentEntryNotFoundException(
          `Ep ${episodeNumber} could not be selectively isolated in torrent '${candidate.title}' (${tFiles.length} files)`,
        );
      }

      const [wantedIdx, relPath] = epMap.get(episodeNumber)!;
      if (path.win32.isAbsolute(relPath) || path.posix.isAbsolute(relPath) || relPath.split(/[\\/]/).includes("..")) {
        throw new Error("Torrent file path is outside its download directory");
      }
      claimedWantedIdx = wantedIdx;
      const wantedFileBytes = Number(tFiles[wantedIdx]?.length || candidate.size || 0);

      // Guardrail 2: Reject abnormally huge single files (> 8.5 GB) from batch torrents (allows up to 8.5 GB for BD Remux single episodes while blocking combined season files)
      if ((isMarkedBatch || isMultiFile) && wantedFileBytes > 8.5 * 1024 * 1024 * 1024) {
        await transmission.releaseTorrentClaim(tId, wantedIdx, true, false).catch(() => {});
        tId = null;
        throw new TorrentEntryNotFoundException(
          `Matched file in batch '${candidate.title}' is ${(wantedFileBytes / (1024 * 1024 * 1024)).toFixed(2)} GB (exceeds 8.5 GB single-episode safety threshold)`,
        );
      }

      // Guardrail 3: If this is a multi-file batch torrent, register our wantedIdx in the shared active set and exclude unclaimed batch files
      if (isMultiFile) {
        await transmission.selectOnlyFiles(tId, [wantedIdx], tFiles.length);
      }

      // Gate 2: Verify exact wanted episode file size against 56 GB cap before data transfer completes
      if (enforceHardCapBeforeStart && wantedFileBytes > 0) {
        const capNow = await this.checkStorageCapacityForDownload(jobId);
        if (capNow.usedBytes > 0 && capNow.usedBytes + wantedFileBytes > KIRA_MAX_STAGING_BYTES) {
          await transmission.releaseTorrentClaim(tId, wantedIdx, true, false).catch(() => {});
          tId = null;
          const usedGb = (capNow.usedBytes / (1024 * 1024 * 1024)).toFixed(2);
          const fileGb = (wantedFileBytes / (1024 * 1024 * 1024)).toFixed(2);
          const maxGb = (KIRA_MAX_STAGING_BYTES / (1024 * 1024 * 1024)).toFixed(1);
          return {
            ok: false,
            pausedForCapacity: true,
            reason: `File size (${fileGb} GB) + current staged usage (${usedGb} GB) would exceed ${maxGb} GB limit`,
          };
        }
      }

      const fullPath = path.join(dlDir, relPath);
      await transmission.startTorrentNow(tId);
      await transmission.waitForCompletion(tId, {
        wantedFileIndex: wantedIdx,
        expectedDiskPath: fullPath,
      });

      const realDownloadDir = await fs.promises.realpath(dlDir);
      const realFile = await fs.promises.realpath(fullPath);
      const relative = path.relative(realDownloadDir, realFile);
      if (!relative || path.isAbsolute(relative) || relative.split(path.sep)[0] === "..") {
        throw new Error("Torrent file resolves outside its download directory");
      }
      const stat = await fs.promises.lstat(fullPath);
      if (!stat.isFile() || stat.size <= 1024 || (Number(tFiles[wantedIdx]?.length) > 0 &&
          stat.size !== Number(tFiles[wantedIdx].length))) {
        throw new Error(`Downloaded file did not match the expected video size: ${fullPath}`);
      }

      const ext = path.extname(fullPath) || ".mkv";
      const stagedFilename = `job_${jobId}_ep${episodeNumber}_${qualityTag}_${crypto.randomUUID().slice(0, 6)}${ext}`;
      const stagedPath = path.join(stagingDir, stagedFilename);

      try {
        await fs.promises.rename(fullPath, stagedPath);
      } catch {
        await fs.promises.copyFile(fullPath, stagedPath);
        await fs.promises.unlink(fullPath).catch(() => {});
      }

      const sizeBytes = fs.statSync(stagedPath).size;
      await transmission.releaseTorrentClaim(tId, wantedIdx, true, true).catch(() => {});
      tId = null;

      return {
        ok: true,
        stagedPath,
        sizeBytes,
        magnetUri: magnetUri || primarySourceUrl,
        isBatchExtracted: isMultiFile || isMarkedBatch,
        fileIndex: wantedIdx,
      };
    } catch (err: any) {
      if (tId) {
        await transmission.releaseTorrentClaim(tId, claimedWantedIdx, true, false).catch(() => {});
      }
      return { ok: false, reason: err?.message || String(err) };
    }
  }

  /**
   * Common High-Concurrency Stage 1:
   * 1. Enforces the 56 GB staging limit (KIRA_MAX_STAGING_BYTES) before starting any download.
   * 2. Discovers candidate torrents from Tsukihime and fills gaps from AnimeTosho.
   * 3. Evaluates the 3-Tier Deterministic Waterfall (always preferring Solo releases over Batch packs):
   *    - Tier 1 (`h264_multi` -> Pipeline 1 `vm_remux`): 1080p H.264 group that ALSO has 720p and/or 480p from the same group.
   *      If the first 1080p H.264 group lacks 720p/480p, goes back to 1080p candidates to pick another H.264 group that has them.
   *    - Tier 2 (`h264_single_1080p` -> Pipeline 1 `vm_remux`, 1 quality only): If no H.264 group has lower qualities,
   *      picks the best 1080p H.264 release and ONLY processes 1 quality (1080p).
   *    - Tier 3 (`hevc_av1_gpu` -> Pipeline 2 `kaggle_gpu`): If no H.264 release exists at all, picks the best 1080p HEVC/AV1
   *      release and routes to the Kaggle GPU batch pipeline.
   * 4. Enforces the active PipelineExecutionPolicy (`all` | `vm_remux_only` | `kaggle_gpu_only`):
   *    - If `vm_remux_only` (Pipeline 1 Only) is active and an episode only has HEVC/AV1 (`kaggle_gpu`) releases, marks the job as `skipped`.
   *    - If `kaggle_gpu_only` (Pipeline 2 Only) is active and an episode is a Pipeline 1 (`vm_remux` H.264) release, marks the job as `skipped`.
   * 5. Extracts & uploads subtitles to Cloudflare R2 strictly from the 1080p version.
   * 6. For Tier 1 (`h264_multi`), downloads same-group 720p & 480p in parallel!
   */
  public static async discoverAndStageJob(jobId: number): Promise<DiscoveryResult> {
    await this.ensureTables();

    const job = await db.query.pipelineJob.findFirst({
      where: eq(schema.pipelineJob.id, jobId),
    });

    if (!job) {
      return { status: "failed", jobId, error: "Job not found" };
    }

    if (job.status !== "queued" && job.status !== "staged") return { status: "skipped", jobId };
    if (job.discoverAfter && job.discoverAfter.getTime() > Date.now()) return { status: "skipped", jobId };

    // Prevent duplicate concurrent downloads/discovery for the same jobId (which creates orphaned MKVs on disk)
    if (this.activeDiscoveringJobIds.has(jobId)) {
      log.info(
        "PipelineEngine",
        `[Stage 1 Discovery] Job #${jobId} is already actively downloading; skipping duplicate run.`,
      );
      return {
        status: "skipped",
        jobId,
        error: "Discovery/download already in progress for this job",
      };
    }

    const rawManualTorrentId = Number(job.metadata?.manualTsukihimeTorrentId);
    const manualTorrentId = Number.isSafeInteger(rawManualTorrentId) && rawManualTorrentId > 0
      ? rawManualTorrentId
      : null;
    const hasExplicitJobPolicy =
      job.metadata?.executionPolicy === "vm_remux_only" ||
      job.metadata?.executionPolicy === "kaggle_gpu_only" ||
      job.metadata?.executionPolicy === "all";
    const effectivePolicy: PipelineExecutionPolicy = hasExplicitJobPolicy
      ? job.metadata!.executionPolicy
      : manualTorrentId
        ? "all"
        : this.getExecutionPolicy();
    const forcedMode: PipelineExecutionType | null =
      job.metadata?.processingMode === "vm_remux" || job.metadata?.processingMode === "kaggle_gpu"
        ? job.metadata.processingMode
        : null;

    if (job.status === "staged" && this.hasValidStagedFiles(job)) {
      const jobIsRemux = this.isJobVmRemux(job);
      if (job.metadata?.kind !== "quality_backfill" && effectivePolicy === "vm_remux_only" && !jobIsRemux) {
        const skipReason =
          "Skipped: Staged HEVC/AV1 (Pipeline 2) release skipped while 'Pipeline 1 Only (VM Remux)' policy is active.";
        await this.cleanupJobStagedFiles(job);
        await db
          .update(schema.pipelineJob)
          .set({
            status: "skipped",
            batchId: null,
            stagedFilePath: null,
            lastError: skipReason,
            metadata: {
              ...(job.metadata || {}),
              skippedByPolicy: effectivePolicy,
              incompatiblePipeline: "kaggle_gpu",
            },
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, jobId));
        return { status: "skipped", jobId, pipelineType: "kaggle_gpu", error: skipReason };
      }

      if (
        job.metadata?.kind !== "quality_backfill" && effectivePolicy === "kaggle_gpu_only" &&
        jobIsRemux &&
        job.metadata?.processingMode !== "kaggle_gpu"
      ) {
        const skipReason =
          "Skipped: Staged H.264 (Pipeline 1) release skipped while 'Pipeline 2 Only (Kaggle GPU)' policy is active.";
        await this.cleanupJobStagedFiles(job);
        await db
          .update(schema.pipelineJob)
          .set({
            status: "skipped",
            batchId: null,
            stagedFilePath: null,
            lastError: skipReason,
            metadata: {
              ...(job.metadata || {}),
              skippedByPolicy: effectivePolicy,
              incompatiblePipeline: "vm_remux",
            },
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, jobId));
        return { status: "skipped", jobId, pipelineType: "vm_remux", error: skipReason };
      }

      if (jobIsRemux) {
        setImmediate(() => {
          this.drainVmRemuxQueue().catch(() => {});
        });
      }
      return {
        status: "staged",
        jobId,
        pipelineType: jobIsRemux ? "vm_remux" : "kaggle_gpu",
        sizeBytes: job.sizeBytes || 0,
      };
    }

    // Gate 1: Strict 56 GB Staging Limit Check BEFORE transitioning job to "downloading"
    const capCheck = await this.checkStorageCapacityForDownload(jobId);
    if (!capCheck.allowed) {
      log.warn(
        "PipelineEngine",
        `[Job #${jobId}] Download paused by 56 GB storage guardrail: ${capCheck.reason}`,
      );
      await db
        .update(schema.pipelineJob)
        .set({
          status: "queued",
          lastError: capCheck.reason || "Waiting for staging buffer (< 56 GB) to free space",
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, job.status)));

      await this.drainVmRemuxQueue().catch(() => {});
      await this.sealAvailableBatches({
        forceFlush: true,
        triggerReason: "storage_limit_56gb",
      }).catch(() => {});

      return {
        status: "download_paused",
        jobId,
        error: capCheck.reason,
      };
    }

    const [claimed] = await db.update(schema.pipelineJob).set({
      status: "downloading",
      stagedFilePath: null,
      stagedQualities: null,
      discoverAfter: null,
      heartbeatAt: new Date(),
      updatedAt: new Date(),
    }).where(and(
      eq(schema.pipelineJob.id, jobId),
      job.status === "queued" ? queuedDiscoveryCondition() : eq(schema.pipelineJob.status, "staged"),
    )).returning({ id: schema.pipelineJob.id });
    if (!claimed) return { status: "skipped", jobId };

    this.activeDiscoveringJobIds.add(jobId);
    await this.cleanupJobStagedFiles(job).catch(() => {});

    const transmission = new TransmissionClient();
    const subtitles = new SubtitleManager();
    const videoManager = new VideoEncodingManager();
    const stagingDir = getKiraStagingDir();
    const tempSubsDir = path.join(stagingDir, `subs_${crypto.randomUUID()}`);
    const downloadedPaths = new Set<string>();
    const kind = job.metadata?.kind;
    const captionsOnly = kind === "caption_refresh";
    let nonRetryableManualError = false;

    try {
      const entries = await fs.promises.readdir(stagingDir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (entry.name.startsWith(`job_${jobId}_`)) {
          await fs.promises.rm(path.join(stagingDir, entry.name), { recursive: true, force: true }).catch(() => {});
        }
      }
    } catch {}

    const heartbeatInterval = setInterval(() => {
      db.update(schema.pipelineJob)
        .set({ heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.pipelineJob.id, jobId))
        .catch(() => {});
    }, 30_000);

    try {
      if (job.animeId && job.anilistId && await AnimeMetadataResolver.hasConflictingLocalIdentity(job.animeId, job.anilistId)) {
        throw new TorrentEntryNotFoundException("The job's anime ID and AniList ID refer to different shows");
      }
      if (kind === "quality_backfill") {
        return await this.discoverAndStageQualityBackfill(job, transmission, videoManager, stagingDir, downloadedPaths);
      }
      log.info(
        "PipelineEngine",
        `[Stage 1 Discovery] Job #${job.id} (AniList ${job.anilistId || "n/a"} | AniDB ${job.anidbId || "n/a"} Ep ${job.episodeNumber} [${job.types.join("/")}] | Policy: ${effectivePolicy})...`,
      );

      const wantsDub = job.types.includes("dub");
      const wantsSub = job.types.includes("sub");
      const isDubOnly = wantsDub && !wantsSub;
      const isSubOnly = wantsSub && !wantsDub;
      const langTypeForSearch = isDubOnly ? "dub" : isSubOnly ? "sub" : "all";
      let totalExpectedEps =
        typeof job.metadata?.totalEpisodes === "number" && job.metadata.totalEpisodes >= job.episodeNumber
          ? job.metadata.totalEpisodes
          : null;
      const resolvedTitles = job.anilistId
        ? await AnimeMetadataResolver.resolveDiscoveryTitles(job.anilistId)
        : job.animeId ? await AnimeMetadataResolver.resolveLocalDiscoveryTitles(job.animeId) : [];
      const animeRule = !captionsOnly && !manualTorrentId
        ? await this.getAnimeDiscoveryRule({ anilistId: job.anilistId, animeId: job.animeId })
        : null;
      let effectiveKnownTitles = Array.from(
        new Set([...resolvedTitles, ...(animeRule?.searchTitles ?? [])].filter(Boolean)),
      );
      const prequelOffsetContext: PrequelOffsetContext = !captionsOnly && !manualTorrentId && !(animeRule && animeRule.episodeOffset > 0)
        ? await loadPrequelOffsetContext({ animeId: job.animeId, anilistId: job.anilistId })
        : { candidateOffsets: [], prequelStartDates: [], localEpisodes: [] };

      let resolvedEpisodeOffset = animeRule?.episodeOffset && animeRule.episodeOffset > 0 ? animeRule.episodeOffset : 0;
      let strictEpisodeOffset = resolvedEpisodeOffset > 0;
      let episodeOffsetReason = resolvedEpisodeOffset > 0 ? "anime_rule" : "default_zero";

      const torrentByKey = new Map<string, AnimeToshoItem>();
      const allTorrents: AnimeToshoItem[] = [];
      const animeToshoSeeds = new Map<string, number>();
      const checkedTrackerDetails = new Set<string>();
      const mergeTorrents = (items: AnimeToshoItem[]) => {
        for (const item of items) {
          const infoHash = torrentInfoHash(item);
          if (!infoHash) continue;
          const key = torrentIdentityKey(item);
          if (item.provider !== "tsukihime") {
            animeToshoSeeds.set(key, Math.max(animeToshoSeeds.get(key) ?? 0, item.seeders ?? 0));
          }
          const existing = torrentByKey.get(key);
          if (!existing) {
            const copy = { ...item, info_hash: infoHash };
            torrentByKey.set(key, copy);
            allTorrents.push(copy);
          } else {
            if (ReleaseFilter.hasWatermarkedSource(item.title)) existing.title = item.title;
            if (item.tsukihime_id && !existing.tsukihime_id) existing.tsukihime_id = item.tsukihime_id;
            if (typeof item.tsukihime_episode_no === "number" && existing.tsukihime_episode_no == null) {
              existing.tsukihime_episode_no = item.tsukihime_episode_no;
            }
            if (Array.isArray(item.audiolangs) && item.audiolangs.length > 0 && !existing.audiolangs?.length) {
              existing.audiolangs = item.audiolangs;
            }
            if (Array.isArray(item.sublangs) && (existing.sublangs === undefined || (item.sublangs.length > 0 && existing.sublangs.length === 0))) {
              existing.sublangs = item.sublangs;
            }
            if (item.group_name && !existing.group_name) existing.group_name = item.group_name;
            if (item.is_seadex) existing.is_seadex = true;
            if (item.tsukihime_seeders_known) existing.tsukihime_seeders_known = true;
            if ((item.seeders || 0) > (existing.seeders || 0)) existing.seeders = item.seeders;
            if ((item.leechers || 0) > (existing.leechers || 0)) existing.leechers = item.leechers;
            if (item.torrent_url && !existing.torrent_url) existing.torrent_url = item.torrent_url;
            if (item.magnet_uri && !existing.magnet_uri) existing.magnet_uri = item.magnet_uri;
          }
        }
      };

      const evaluateBundles = (): ReleaseCandidateBundle[] => {
        if (allTorrents.length === 0) return [];
        if (!(animeRule && animeRule.episodeOffset > 0) && prequelOffsetContext.candidateOffsets.length > 0) {
          const detected = detectVerifiedEpisodeOffset({
            torrents: allTorrents,
            knownTitles: effectiveKnownTitles,
            targetEp: job.episodeNumber,
            totalExpectedEps,
            context: prequelOffsetContext,
          });
          if (detected.offset > 0) {
            if (resolvedEpisodeOffset !== detected.offset || strictEpisodeOffset !== detected.strict) {
              log.info(
                "PipelineEngine",
                `[Job #${job.id}] Verified cumulative episode offset +${detected.offset} (${detected.reason}, strict=${detected.strict}: Ep ${job.episodeNumber} -> Torrent Ep ${job.episodeNumber + detected.offset})`,
              );
            }
            resolvedEpisodeOffset = detected.offset;
            strictEpisodeOffset = detected.strict;
            episodeOffsetReason = detected.reason;
          } else {
            resolvedEpisodeOffset = 0;
            strictEpisodeOffset = false;
            episodeOffsetReason = detected.reason;
          }
        }
        let bundles = ReleaseFilter.selectTopCandidateBundles(
          allTorrents,
          job.episodeNumber,
          langTypeForSearch,
          {
            knownTitles: effectiveKnownTitles,
            totalExpectedEps,
            episodeOffset: resolvedEpisodeOffset,
            strictEpisodeOffset,
            maxBundles: 10,
          },
        );
        if (bundles.length === 0 && wantsSub && wantsDub) {
          bundles = ReleaseFilter.selectTopCandidateBundles(
            allTorrents,
            job.episodeNumber,
            "sub",
            {
              knownTitles: effectiveKnownTitles,
              totalExpectedEps,
              episodeOffset: resolvedEpisodeOffset,
              strictEpisodeOffset,
              maxBundles: 10,
            },
          );
        }
        return bundles;
      };

      let topBundles: ReleaseCandidateBundle[] = [];
      let searchAlternateProviders: ((excluded: Set<string>) => Promise<void>) | undefined;
      const hydrateTorrentDetails = async (bundles: ReleaseCandidateBundle[]) => {
        const pending = new Map<string, [AnimeToshoItem, number | string]>();
        for (const bundle of bundles) {
          for (const { item, effectiveEp } of Object.values(bundle.qualities)) {
            const key = torrentIdentityKey(item);
            if (item.tsukihime_id && !checkedTrackerDetails.has(key)) pending.set(key, [item, effectiveEp]);
          }
        }
        if (!pending.size) return false;

        const keys = [...pending.keys()];
        keys.forEach(key => checkedTrackerDetails.add(key));
        const hydrated = await TsukihimeClient.hydrateCandidates([...pending.values()]).catch((error: unknown) => {
          log.warn("PipelineEngine", `[Job #${job.id}] Torrent tracker lookup failed: ${String(error)}`);
          return [];
        });
        hydrated.forEach(([detail], index) => {
          const key = keys[index];
          const [original] = pending.get(key)!;
          if (detail === original) return;
          Object.assign(original, detail, { seeders: Math.max(detail.seeders ?? 0, animeToshoSeeds.get(key) ?? 0) });
        });
        topBundles = evaluateBundles();
        return true;
      };

      const sourceJobId = captionsOnly ? job.metadata?.sourceJobId : null;
      if (captionsOnly) {
        // Reuse the input for the published video so the extracted tracks match its timing.
        const sourceUrl = job.metadata?.sourceUrl;
        const source = await db.query.pipelineJob.findFirst({
          where: and(
            jobAnimeCondition(job),
            eq(schema.pipelineJob.episodeNumber, job.episodeNumber),
            eq(schema.pipelineJob.status, "completed"),
            sourceJobId ? eq(schema.pipelineJob.id, sourceJobId) : sql`exists (
              select from jsonb_array_elements(coalesce(${schema.pipelineJob.resultPayload}->'allTrackPayloads',
                jsonb_build_array(${schema.pipelineJob.resultPayload}))) track
              cross join lateral jsonb_array_elements(track->'sources') source
              where track->>'type' = ${job.types[0]} and
                (source->>'url' = ${sourceUrl ?? null} or source->>'downloadUrl' = ${sourceUrl ?? null})
            )`,
          ),
        });
        if (!source?.torrentMagnet || !source.torrentTitle || !source.types.some(type => job.types.includes(type))) {
          throw new Error("The torrent for the published stream could not be recovered. Rebuild the stream to record its source.");
        }
        if (!effectiveKnownTitles.length && source.knownTitles?.length) {
          effectiveKnownTitles = source.knownTitles;
        }
        if (!effectiveKnownTitles.length) {
          throw new TorrentEntryNotFoundException("Discovery could not verify a canonical title for this anime");
        }
        const quality = (Object.keys(source.qualitiesPayload ?? {})[0] ?? "1080p") as VideoResolutionQuality;
        const isMagnet = source.torrentMagnet.startsWith("magnet:?");
        const primaryEntry = {
          quality,
          item: {
            title: source.torrentTitle,
            magnet_uri: isMagnet ? source.torrentMagnet : undefined,
            torrent_url: isMagnet ? undefined : source.torrentMagnet,
          },
          effectiveEp: source.qualitiesPayload?.[quality]?.effectiveEp ??
            ReleaseFilter.parseTitle(source.torrentTitle, effectiveKnownTitles).singleEp ?? job.episodeNumber,
          score: 0,
        };
        topBundles = [{
          group: source.releaseGroup ?? "",
          groupLower: (source.releaseGroup ?? "").toLowerCase(),
          isH264: source.videoCodec === "h264",
          isDualAudio: source.types.length > 1,
          isEnglishDub: source.types.includes("dub"),
          isSolo: !source.isBatchTorrent,
          selectionTier: "h264_single_1080p",
          pipelineType: "vm_remux",
          bundleScore: 0,
          primaryEntry,
          qualities: { [quality]: primaryEntry },
        }];
      } else if (manualTorrentId) {
        log.info(
          "PipelineEngine",
          `[Stage 1 Manual Discovery] Job #${job.id}: fetching Tsukihime torrent #${manualTorrentId} directly...`,
        );
        const manualEntry = await TsukihimeClient.fetchTorrentById(manualTorrentId);
        if (!manualEntry) {
          nonRetryableManualError = true;
          throw new TorrentEntryNotFoundException(
            `Manual Tsukihime torrent #${manualTorrentId} was not found`,
          );
        }
        if (effectiveKnownTitles.length === 0 && manualEntry.anime) {
          effectiveKnownTitles = canonicalDiscoveryTitles({
            titleRomaji: manualEntry.anime.title,
            titleEnglish: manualEntry.anime.english_title,
          });
        }
        if (manualEntry.anime?.id) {
          const mapping = {
            ...(!job.metadata?.tsukihimeId ? { tsukihimeId: manualEntry.anime.id } : {}),
            ...(manualEntry.anime.mal && manualEntry.anime.mal > 0 && !job.metadata?.malId ? { malId: manualEntry.anime.mal } : {}),
            ...(manualEntry.anime.total_episodes && manualEntry.anime.total_episodes >= job.episodeNumber && !totalExpectedEps
              ? { totalEpisodes: manualEntry.anime.total_episodes }
              : {}),
            manualTsukihimeTorrentName: manualEntry.name,
          };
          if (manualEntry.anime.total_episodes && manualEntry.anime.total_episodes >= job.episodeNumber && !totalExpectedEps) {
            totalExpectedEps = manualEntry.anime.total_episodes;
          }
          job.metadata = { ...job.metadata, ...mapping };
          await db.update(schema.pipelineJob).set({
            metadata: sql`coalesce(${schema.pipelineJob.metadata}, '{}'::jsonb) || ${JSON.stringify(mapping)}::jsonb`,
            updatedAt: new Date(),
          }).where(and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, "downloading")))
            .catch(error => log.warn("PipelineEngine", `[Job #${jobId}] Could not save manual Tsukihime metadata: ${String(error)}`));
        }
        topBundles = [this.buildManualTsukihimeBundle(manualEntry, job.episodeNumber, effectiveKnownTitles)];
      } else {
        // Search both indexes for the target episode and requested language.
        let tsukihimeAnidbId: number | null = animeRule?.sourceAnidbId ?? null;
        const gpuSearch = effectivePolicy === "kaggle_gpu_only" || (effectivePolicy === "all" && forcedMode === "kaggle_gpu");
        try {
          const tsukiLookup = {
            tsukihimeId: animeRule?.sourceTsukihimeId ?? (job.metadata?.tsukihimeId ? Number(job.metadata.tsukihimeId) : null),
            trustedSourceTsukihimeId: animeRule?.sourceTsukihimeId ?? null,
            anilistId: job.anilistId,
            malId: job.metadata?.malId ? Number(job.metadata.malId) : null,
            anidbId: animeRule?.sourceAnidbId ?? job.anidbId,
          };
          const previousEpisode = Number(job.qualitiesPayload?.["1080p"]?.effectiveEp);
          const tsukiTargetEp = strictEpisodeOffset ? job.episodeNumber + resolvedEpisodeOffset : job.episodeNumber;
          const prequelAliases = strictEpisodeOffset
            ? []
            : prequelOffsetContext.candidateOffsets.slice(0, 2).map(off => job.episodeNumber + off);
          const episodeAliases = Array.from(
            new Set([
              ...(Number.isInteger(previousEpisode) && previousEpisode > job.episodeNumber ? [previousEpisode] : []),
              ...prequelAliases,
            ]),
          );
          const { anime: tsukiAnime, torrents: tsukiTorrents } = await TsukihimeClient.fetchTorrents(
            tsukiLookup,
            {
              targetEp: tsukiTargetEp,
              episodeAliases,
              langType: langTypeForSearch,
              knownTitles: effectiveKnownTitles,
              episodeCount: strictEpisodeOffset ? null : totalExpectedEps,
              preferredPipeline: gpuSearch ? "kaggle_gpu" : "vm_remux",
              maxPages: 4,
              reportErrors: true,
              probeRecentTorrents: !strictEpisodeOffset && prequelOffsetContext.candidateOffsets.length > 0,
            },
          );
          if (tsukiAnime && (effectiveKnownTitles.length > 0 || !job.anilistId || Number(tsukiAnime.anilist) === job.anilistId || Boolean(animeRule?.sourceTsukihimeId))) {
            if (!totalExpectedEps && tsukiAnime.total_episodes && tsukiAnime.total_episodes >= job.episodeNumber) {
              totalExpectedEps = tsukiAnime.total_episodes;
            }
            const tsukiTitles = canonicalDiscoveryTitles({
              titleRomaji: tsukiAnime.title,
              titleEnglish: tsukiAnime.english_title,
            });
            if (effectiveKnownTitles.length === 0) {
              effectiveKnownTitles = tsukiTitles;
            } else {
              for (const tt of tsukiTitles) {
                const exists = effectiveKnownTitles.some(existing => existing.trim().toLowerCase() === tt.toLowerCase());
                if (!exists && (Boolean(animeRule?.sourceTsukihimeId) || sharesDistinctiveTitleOverlap(tt, effectiveKnownTitles))) {
                  effectiveKnownTitles = [...effectiveKnownTitles, tt];
                }
              }
            }
            if (!tsukihimeAnidbId && tsukiAnime.anidb && tsukiAnime.anidb > 0) {
              tsukihimeAnidbId = tsukiAnime.anidb;
            }
            const mapping = {
              tsukihimeId: tsukiAnime.id,
              ...(tsukiAnime.mal && tsukiAnime.mal > 0 ? { malId: tsukiAnime.mal } : {}),
              ...(totalExpectedEps ? { totalEpisodes: totalExpectedEps } : {}),
            };
            if (Object.entries(mapping).some(([key, value]) => job.metadata?.[key] !== value)) {
              job.metadata = { ...job.metadata, ...mapping };
              await db.update(schema.pipelineJob).set({
                metadata: sql`coalesce(${schema.pipelineJob.metadata}, '{}'::jsonb) || ${JSON.stringify(mapping)}::jsonb`,
                updatedAt: new Date(),
              }).where(and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, "downloading")))
                .catch(error => log.warn("PipelineEngine", `[Job #${jobId}] Could not save Tsukihime mapping: ${String(error)}`));
            }
          }
          if (effectiveKnownTitles.length && tsukiTorrents.length > 0) {
            mergeTorrents(tsukiTorrents);
            topBundles = evaluateBundles();
          }
        } catch (tsukiErr: any) {
          log.warn("PipelineEngine", `[Job #${job.id}] Tsukihime search warning: ${tsukiErr?.message || tsukiErr}`);
        }

        if (effectiveKnownTitles.length === 0) {
          throw new TorrentEntryNotFoundException("Discovery could not verify a canonical title for this anime");
        }

        const opts: FetchTorrentsOptions = {
          targetEp: strictEpisodeOffset ? job.episodeNumber + resolvedEpisodeOffset : job.episodeNumber,
          langType: langTypeForSearch,
          knownTitles: effectiveKnownTitles,
          episodeCount: strictEpisodeOffset ? null : totalExpectedEps,
          maxPages: 6,
        };

        const matchesAudio = (bundle: ReleaseCandidateBundle) => !wantsDub || bundle.isDualAudio || bundle.isEnglishDub;
        const preferredBundle = (bundle: ReleaseCandidateBundle) => {
          if (!bundle.isSolo || !bundle.qualities["1080p"] || !matchesAudio(bundle)) return false;
          if (gpuSearch) return bundle.pipelineType === "kaggle_gpu";
          return bundle.pipelineType === "vm_remux" && BACKFILL_QUALITIES.every(quality => bundle.qualities[quality]);
        };
        const hasLiveCoverage = async () => {
          const hasLiveSeeds = ({ item }: ReleaseCandidateBundle["primaryEntry"]) => {
            const key = torrentIdentityKey(item);
            return (item.seeders ?? 0) > 0 && (!item.tsukihime_id || item.tsukihime_seeders_known ||
              (animeToshoSeeds.get(key) ?? 0) > 0);
          };
          const live = () => topBundles.some(bundle => preferredBundle(bundle) &&
            Object.values(bundle.qualities).every(hasLiveSeeds));
          if (live()) return true;
          const preferred = topBundles.find(preferredBundle);
          if (preferred) await hydrateTorrentDetails([preferred]);
          return live();
        };

        const searchAnimeTosho = async (fetch: (query: string) => Promise<AnimeToshoItem[]>) => {
          const search = (query: string) => fetch(query).catch((error: unknown) => {
            log.warn("PipelineEngine", `[Job #${job.id}] AnimeTosho ${query || "all qualities"} search warning: ${String(error)}`);
            return [];
          });
          const mergeQueries = async (queries: readonly string[]) => {
            mergeTorrents((await Promise.all(queries.map(search))).flat());
            topBundles = evaluateBundles();
          };

          await mergeQueries(["", "1080p"]);
          if (wantsDub && !topBundles.some(matchesAudio)) {
            await mergeQueries(["dual-audio", "dub"]);
          }
          if (gpuSearch || topBundles.some(preferredBundle)) return;

          const primary = topBundles.find(bundle => bundle.isSolo && bundle.pipelineType === "vm_remux" &&
            bundle.qualities["1080p"] && matchesAudio(bundle));
          if (primary) await mergeQueries(BACKFILL_QUALITIES.filter(quality => !primary.qualities[quality]));
        };

        const searchByAnidbId = (aid: number) => searchAnimeTosho(async query => {
          const items = await AnimeToshoClient.fetchTorrents(aid, query, opts);
          return effectiveKnownTitles.length > 0 ? items : items.filter(item => Number(item.anidb_aid) === aid);
        });

        const searchedAniDbIds = new Set<number>();
        const searchedTitles = new Set<string>();
        let canonicalAnidb: number | null | undefined = tsukihimeAnidbId ?? undefined;
        const searchFallbacks = async (excluded?: Set<string>) => {
          let ranSearch = false;
          const searchId = async (id: number | null) => {
            if (!id || searchedAniDbIds.has(id)) return;
            searchedAniDbIds.add(id);
            await searchByAnidbId(id);
            ranSearch = true;
          };
          const covered = () => excluded
            ? ranSearch && this.filterCandidateBundlesByPolicy(topBundles, effectivePolicy, forcedMode).allowedBundles
              .some(bundle => !excluded.has(torrentIdentityKey(bundle.primaryEntry.item)))
            : hasLiveCoverage();

          if (await covered()) return;
          if (canonicalAnidb === undefined) {
            canonicalAnidb = job.anilistId ? await AnimeMetadataResolver.resolveAnimapAnidbId(job.anilistId) : null;
          }
          const anidbId = canonicalAnidb ?? job.anidbId;
          opts.expectedAnidbId = anidbId;
          await searchId(anidbId);
          if (await covered()) return;

          for (const title of effectiveKnownTitles.slice(0, 6)) {
            const key = title.trim().toLowerCase();
            if (!key || searchedTitles.has(key)) continue;
            searchedTitles.add(key);
            await searchAnimeTosho(query => AnimeToshoClient.fetchTorrentsByTitle(title, query, opts));
            ranSearch = true;
            if (await covered()) break;
          }
        };
        searchAlternateProviders = searchFallbacks;
        await searchFallbacks();
      }

      if (topBundles.length === 0) {
        throw new TorrentEntryNotFoundException(
          `No viable candidate releases found for AniList ${job.anilistId || "n/a"} / AniDB ${job.anidbId || "n/a"} Ep ${job.episodeNumber}`,
        );
      }

      // 5. Enforce Pipeline Execution Policy BEFORE downloading any files!
      const policyDecision = captionsOnly ? { allowedBundles: topBundles, skippedReason: null, naturalPipeline: null }
        : this.filterCandidateBundlesByPolicy(topBundles, effectivePolicy, forcedMode);

      if (policyDecision.skippedReason) {
        const naturalBundle = topBundles[0];
        log.warn(
          "PipelineEngine",
          `[Job #${job.id}] Marking job as SKIPPED under policy '${effectivePolicy}': ${policyDecision.skippedReason}`,
        );
        await db
          .update(schema.pipelineJob)
          .set({
            status: "skipped",
            pipelineType: policyDecision.naturalPipeline || naturalBundle.pipelineType,
            selectionTier: naturalBundle.selectionTier,
            releaseGroup: naturalBundle.group,
            videoCodec: naturalBundle.isH264 ? "h264" : "hevc",
            torrentTitle: naturalBundle.primaryEntry.item.title,
            lastError: policyDecision.skippedReason,
            metadata: {
              ...(job.metadata || {}),
              skippedByPolicy: effectivePolicy,
              incompatiblePipeline: policyDecision.naturalPipeline || naturalBundle.pipelineType,
              candidateTitle: naturalBundle.primaryEntry.item.title,
            },
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, jobId));

        return {
          status: "skipped",
          jobId,
          pipelineType: policyDecision.naturalPipeline || naturalBundle.pipelineType,
          selectionTier: naturalBundle.selectionTier,
          error: policyDecision.skippedReason,
        };
      }

      const attemptedPrimaries = new Set<string>();
      const prepareCandidateBatch = async () => {
        if (captionsOnly || manualTorrentId) return policyDecision.allowedBundles;
        while (true) {
          const allowed = this.filterCandidateBundlesByPolicy(topBundles, effectivePolicy, forcedMode).allowedBundles;
          const candidates = allowed.filter(bundle => !attemptedPrimaries.has(torrentIdentityKey(bundle.primaryEntry.item))).slice(0, 4);
          if (!await hydrateTorrentDetails(candidates)) return candidates;
        }
      };
      const downloadBundles = await prepareCandidateBatch();

      let selectedBundle: ReleaseCandidateBundle | null = null;
      let primaryStagedPath: string | null = null;
      let primarySizeBytes = 0;
      let primaryMagnet = "";
      let primaryQuality: VideoResolutionQuality = "1080p";
      let isBatchExtracted = false;
      const qualitiesPayload: Record<string, any> = {};
      let lastCandidateErr: unknown;
      let primaryProbe: MkvStreamProbe | undefined;
      let tracksConfig: [string, number][] = [];
      let extractedSubs: ExtractedSubtitleTrack[] = [];

      // Try up to four bundles per search pass in strict waterfall order:
      // Solo Tier 1 (h264_multi) -> Solo Tier 2 (h264_single_1080p) -> Solo Tier 3 (hevc_av1_gpu) -> Selective-Batch fallbacks
      for (let bIdx = 0; ; bIdx++) {
        if (bIdx >= downloadBundles.length && searchAlternateProviders) {
          const search = searchAlternateProviders;
          searchAlternateProviders = undefined;
          await search(attemptedPrimaries);
          downloadBundles.push(...await prepareCandidateBatch());
        }
        if (bIdx >= downloadBundles.length) break;
        const bundle = downloadBundles[bIdx];
        const primaryEntry = bundle.primaryEntry;
        attemptedPrimaries.add(torrentIdentityKey(primaryEntry.item));
        const qualList = (Object.keys(bundle.qualities) as VideoResolutionQuality[]).join("/");

        log.info(
          "PipelineEngine",
          `[Job #${job.id}] Trying bundle ${bIdx + 1}/${downloadBundles.length} [tier=${bundle.selectionTier}, pipeline=${bundle.pipelineType}, solo=${bundle.isSolo}, group=${bundle.group}, qualities=${qualList}]: ${primaryEntry.item.title}`,
        );

        const dlRes = await this.downloadCandidateEpisodeToStaging({
          jobId: job.id,
          episodeNumber: job.episodeNumber,
          knownTitles: effectiveKnownTitles,
          candidate: primaryEntry.item,
          effectiveEp: primaryEntry.effectiveEp,
          totalExpectedEps,
          qualityTag: primaryEntry.quality,
          transmission,
          stagingDir,
          enforceHardCapBeforeStart: true,
          allowWatermarkedSource: captionsOnly || Boolean(manualTorrentId),
          manualTorrent: Boolean(manualTorrentId),
        });

        if (dlRes.ok) {
          downloadedPaths.add(dlRes.stagedPath);
          try {
            const probe = await inspectMkvStreamsSync(dlRes.stagedPath);
            if (probe.video.length === 0) throw new Error("No video stream in candidate");
            const tracks = videoManager.determineTracksToEncode(probe, langTypeForSearch);
            if (tracks.length === 0) {
              if (manualTorrentId) nonRetryableManualError = true;
              throw new Error("Requested audio language is missing");
            }
            const candidateSubs = await subtitles.extractSubtitlesFromMkv(dlRes.stagedPath, tempSubsDir, probe);
            const hasFullCaptions = candidateSubs.some(track => track.role !== "signs");
            const verifiedTracks = tracks.filter(([type]) => type !== "sub" || hasFullCaptions);
            if (verifiedTracks.length === 0 || (captionsOnly && candidateSubs.length === 0)) {
              if (manualTorrentId) nonRetryableManualError = true;
              throw new Error("Candidate has no usable captions for the requested language");
            }
            primaryProbe = probe;
            tracksConfig = verifiedTracks;
            extractedSubs = candidateSubs;
          } catch (error) {
            lastCandidateErr = error;
            log.warn("PipelineEngine", `[Job #${job.id}] Rejecting ${primaryEntry.item.title}: ${String(error)}`);
            await fs.promises.unlink(dlRes.stagedPath).catch(() => {});
            continue;
          }

          selectedBundle = bundle;
          primaryStagedPath = dlRes.stagedPath;
          primarySizeBytes = dlRes.sizeBytes;
          primaryMagnet = dlRes.magnetUri;
          primaryQuality = primaryEntry.quality;
          isBatchExtracted = dlRes.isBatchExtracted;
          qualitiesPayload[primaryQuality] = {
            title: primaryEntry.item.title,
            magnet: dlRes.magnetUri,
            sizeBytes: dlRes.sizeBytes,
            isBatchExtracted: dlRes.isBatchExtracted,
            fileIndex: dlRes.fileIndex,
            effectiveEp: primaryEntry.effectiveEp,
            durationSeconds: primaryProbe.durationSeconds,
          };
          break;
        }

        if (dlRes.pausedForCapacity) {
          log.warn("PipelineEngine", `[Job #${job.id}] Pausing download before transfer: ${dlRes.reason}`);
          await db
            .update(schema.pipelineJob)
            .set({
              status: "queued",
              lastError: dlRes.reason,
              heartbeatAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, jobId));

          await this.sealAvailableBatches({
            forceFlush: true,
            triggerReason: "storage_limit_56gb",
          }).catch(() => {});

          return { status: "download_paused", jobId, error: dlRes.reason };
        }

        lastCandidateErr = new Error(dlRes.reason);
        log.warn(
          "PipelineEngine",
          `[Job #${job.id}] Bundle ${bIdx + 1} (${primaryEntry.item.title}) failed: ${dlRes.reason}`,
        );
      }

      if (!primaryStagedPath || !selectedBundle || !primaryProbe) {
        throw lastCandidateErr || new Error("All torrent candidate bundles failed to download");
      }

      const fSizeMb = (primarySizeBytes / (1024 * 1024)).toFixed(1);
      log.success(
        "PipelineEngine",
        `Primary (${primaryQuality}) video staged for Job #${job.id}: ${primaryStagedPath} (${fSizeMb} MB)`,
      );

      const detectedVideoCodec = primaryProbe.videoCodec;
      const isBrowserCompatibleH264 = primaryProbe.isBrowserCompatibleH264;
      const uploadCaptions = async (): Promise<R2SubtitleRecord[]> => {
        const records: R2SubtitleRecord[] = [];
        const animeId = job.animeId || job.anilistId || job.anidbId || job.id;
        for (const [type] of tracksConfig) {
          records.push(...await subtitles.uploadSubtitles(extractedSubs, animeId, job.episodeNumber, type));
        }
        return records;
      };

      if (captionsOnly) {
        const records = await uploadCaptions();
        const type = job.types[0];
        await this.persistAndDeliverPayloads({
          ...job,
          torrentMagnet: primaryMagnet,
          torrentTitle: selectedBundle.primaryEntry.item.title,
          stagedFilePath: primaryStagedPath,
          subtitlesPayload: records,
        }, [{
          ...this.completionIdentity(job, type),
          sources: [],
          subtitles: SubtitleManager.formatForCallback(records, type),
        }]);
        return { status: "completed", jobId };
      }

      const stagedQualities: Partial<Record<VideoResolutionQuality, string>> = {
        [primaryQuality]: primaryStagedPath,
      };
      let totalJobBytes = primarySizeBytes;

      // Determine final Pipeline Route ("vm_remux" vs "kaggle_gpu") & Selection Tier
      const processingMode: PipelineExecutionType = isBrowserCompatibleH264
        ? "vm_remux"
        : "kaggle_gpu";

      let effectiveSelectionTier: CandidateSelectionTier = isBrowserCompatibleH264
        ? selectedBundle.selectionTier
        : "hevc_av1_gpu";

      // Post-Probe Policy Guardrail: If ffprobe revealed the stream is actually HEVC/AV1/10-bit when 'vm_remux_only' is active,
      // or 8-bit H.264 when 'kaggle_gpu_only' is active, mark as skipped and clean up the downloaded file!
      if (effectivePolicy === "vm_remux_only" && processingMode !== "vm_remux") {
        const skipReason = `Skipped: Probed stream is '${detectedVideoCodec}' (requires Pipeline 2 GPU encode) while 'Pipeline 1 Only (VM Remux)' policy is active.`;
        await fs.promises.unlink(primaryStagedPath).catch(() => {});
        await db
          .update(schema.pipelineJob)
          .set({
            status: "skipped",
            pipelineType: "kaggle_gpu",
            selectionTier: "hevc_av1_gpu",
            releaseGroup: selectedBundle.group,
            videoCodec: detectedVideoCodec,
            stagedFilePath: null,
            lastError: skipReason,
            metadata: {
              ...(job.metadata || {}),
              skippedByPolicy: effectivePolicy,
              incompatiblePipeline: "kaggle_gpu",
              videoCodec: detectedVideoCodec,
            },
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, jobId));
        return {
          status: "skipped",
          jobId,
          pipelineType: "kaggle_gpu",
          selectionTier: "hevc_av1_gpu",
          error: skipReason,
        };
      }

      if (
        effectivePolicy === "kaggle_gpu_only" &&
        processingMode === "vm_remux" &&
        forcedMode !== "kaggle_gpu"
      ) {
        const skipReason = `Skipped: Probed stream is 8-bit H.264 (Pipeline 1 VM Remux) while 'Pipeline 2 Only (Kaggle GPU)' policy is active.`;
        await fs.promises.unlink(primaryStagedPath).catch(() => {});
        await db
          .update(schema.pipelineJob)
          .set({
            status: "skipped",
            pipelineType: "vm_remux",
            selectionTier: effectiveSelectionTier,
            releaseGroup: selectedBundle.group,
            videoCodec: detectedVideoCodec,
            stagedFilePath: null,
            lastError: skipReason,
            metadata: {
              ...(job.metadata || {}),
              skippedByPolicy: effectivePolicy,
              incompatiblePipeline: "vm_remux",
              videoCodec: detectedVideoCodec,
            },
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, jobId));
        return {
          status: "skipped",
          jobId,
          pipelineType: "vm_remux",
          selectionTier: effectiveSelectionTier,
          error: skipReason,
        };
      }


      const downloadSiblingQualitiesTask = async (): Promise<void> => {
        // Only download 720p/480p siblings when in Tier 1 (h264_multi) and primary is verified H.264!
        // In Tier 2 (h264_single_1080p), we strictly only process 1 quality (1080p).
        if (processingMode !== "vm_remux" || effectiveSelectionTier !== "h264_multi") {
          return;
        }

        const siblingQualities: VideoResolutionQuality[] = (["720p", "480p"] as VideoResolutionQuality[]).filter(
          (q) => q !== primaryQuality && Boolean(selectedBundle!.qualities[q]),
        );

        if (siblingQualities.length === 0) return;

        // Check 56 GB capacity before launching parallel sibling downloads
        const sibCap = await this.checkStorageCapacityForDownload(job.id);
        if (!sibCap.allowed) {
          log.warn(
            "PipelineEngine",
            `[Job #${job.id}] Skipping optional 720p/480p siblings to respect 56 GB cap (${sibCap.reason})`,
          );
          return;
        }

        await Promise.all(
          siblingQualities.map(async (siblingQ) => {
            const siblingEntry = selectedBundle!.qualities[siblingQ];
            if (!siblingEntry) return;

            log.info(
              "PipelineEngine",
              `[Job #${job.id}] Downloading same-group (${selectedBundle!.group}) ${siblingQ} release in parallel: ${siblingEntry.item.title}`,
            );

            const sibDl = await this.downloadCandidateEpisodeToStaging({
              jobId: job.id,
              episodeNumber: job.episodeNumber,
              knownTitles: effectiveKnownTitles,
              candidate: siblingEntry.item,
              effectiveEp: siblingEntry.effectiveEp,
              totalExpectedEps,
              qualityTag: siblingQ,
              transmission,
              stagingDir,
              enforceHardCapBeforeStart: true,
            });

            if (sibDl.ok) {
              downloadedPaths.add(sibDl.stagedPath);
              let compatible = false;
              try {
                const probe = await inspectMkvStreamsSync(sibDl.stagedPath);
                const matchesRes =
                  siblingQ === "720p" || siblingQ === "480p"
                    ? this.matchesBackfillResolution(probe, siblingQ)
                    : true;
                compatible = probe.isBrowserCompatibleH264 && matchesRes && tracksConfig.every(([type]) =>
                  videoManager.determineTracksToEncode(probe, type).length > 0);
              } catch {}
              if (!compatible) {
                log.warn("PipelineEngine", `[Job #${job.id}] Sibling ${siblingQ} has incompatible video, mismatched resolution, or missing audio`);
                await fs.promises.unlink(sibDl.stagedPath).catch(() => {});
                return;
              }

              stagedQualities[siblingQ] = sibDl.stagedPath;
              totalJobBytes += sibDl.sizeBytes;
              if (sibDl.isBatchExtracted) {
                isBatchExtracted = true;
              }
              qualitiesPayload[siblingQ] = {
                title: siblingEntry.item.title,
                magnet: sibDl.magnetUri,
                sizeBytes: sibDl.sizeBytes,
                isBatchExtracted: sibDl.isBatchExtracted,
                fileIndex: sibDl.fileIndex,
              };
              log.success(
                "PipelineEngine",
                `[Job #${job.id}] Same-group ${siblingQ} staged (${(sibDl.sizeBytes / (1024 * 1024)).toFixed(1)} MB) — subtitles skipped (1080p only).`,
              );
            } else {
              log.warn(
                "PipelineEngine",
                `[Job #${job.id}] Same-group ${siblingQ} download skipped: ${sibDl.reason}`,
              );
            }
          }),
        );
      };

      const r2SubRecords = await uploadCaptions();
      await downloadSiblingQualitiesTask();

      const stagedQualityList = Object.keys(stagedQualities) as VideoResolutionQuality[];
      if (processingMode === "vm_remux" && stagedQualityList.length === 1) {
        effectiveSelectionTier = "h264_single_1080p";
      }

      const selectedEffectiveEp = Number(selectedBundle.primaryEntry.effectiveEp);
      const appliedEpisodeOffset =
        Number.isSafeInteger(selectedEffectiveEp) && selectedEffectiveEp > job.episodeNumber
          ? selectedEffectiveEp - job.episodeNumber
          : 0;
      const updatedMetadata = {
        ...(job.metadata || {}),
        processingMode,
        selectionTier: effectiveSelectionTier,
        releaseGroup: selectedBundle.group,
        videoCodec: detectedVideoCodec,
        isBatchTorrent: isBatchExtracted,
        stagedQualities,
        availableQualities: stagedQualityList,
        ...(appliedEpisodeOffset > 0
          ? {
              episodeOffset: appliedEpisodeOffset,
              episodeOffsetReason,
              effectiveEpisodeNumber: selectedEffectiveEp,
            }
          : {}),
      };

      await db
        .update(schema.pipelineJob)
        .set({
          status: "staged",
          pipelineType: processingMode,
          selectionTier: effectiveSelectionTier,
          releaseGroup: selectedBundle.group,
          videoCodec: detectedVideoCodec,
          isBatchTorrent: isBatchExtracted,
          qualityCount: stagedQualityList.length,
          stagedQualities,
          qualitiesPayload,
          knownTitles: effectiveKnownTitles,
          stagedFilePath: primaryStagedPath,
          sizeBytes: totalJobBytes,
          tracksConfig,
          torrentTitle: selectedBundle.primaryEntry.item.title,
          torrentMagnet: primaryMagnet,
          torrentId: manualTorrentId ?? selectedBundle.primaryEntry.item.tsukihime_id ?? job.torrentId ?? null,
          subtitlesPayload: r2SubRecords,
          metadata: updatedMetadata,
          lastError: null,
          stagedAt: new Date(),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineJob.id, jobId));

      log.success(
        "PipelineEngine",
        `Job #${job.id} staged on SSD [pipeline=${processingMode.toUpperCase()} | tier=${effectiveSelectionTier} | group=${selectedBundle.group} | qualities=${stagedQualityList.join("/")} (${stagedQualityList.length})]: ${(totalJobBytes / (1024 * 1024)).toFixed(1)} MB`,
      );

      // If Pipeline 1 (vm_remux), immediately pass into the 2-slot VM Remux queue (no batching!)
      if (processingMode === "vm_remux") {
        setImmediate(() => {
          this.drainVmRemuxQueue().catch(() => {});
        });
      }

      return {
        status: "staged",
        jobId,
        pipelineType: processingMode,
        selectionTier: effectiveSelectionTier,
        sizeBytes: totalJobBytes,
      };
    } catch (err: any) {
      await Promise.all([...downloadedPaths].map(file => fs.promises.unlink(file).catch(() => {})));
      if (kind === "quality_backfill") {
        const error = err?.message || String(err);
        const delay = job.attempt < MAX_JOB_ATTEMPTS
          ? CALLBACK_DELAYS_MS[Math.min(job.attempt, CALLBACK_DELAYS_MS.length - 1)] : undefined;
        log.warn("PipelineEngine", `[Job #${jobId}] Quality backfill ${delay ? "will retry" : "failed"}: ${error}`);
        await db.update(schema.pipelineJob).set({
          status: delay ? "queued" : "failed",
          attempt: job.attempt + (delay ? 1 : 0),
          discoverAfter: delay ? new Date(Date.now() + delay) : null,
          lastError: error,
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        }).where(and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, "downloading")));
        return { status: delay ? "retry_scheduled" : "failed", jobId, error };
      }
      const retrySchedule = discoveryRetryDelaysForJob(job.types, kind);
      const retryIndex = Number(job.metadata?.discoveryRetries ?? 0);
      const retryDelay = nonRetryableManualError ? undefined : retrySchedule[retryIndex];
      const discoverAfter = retryDelay ? new Date(Date.now() + retryDelay) : null;
      await db.update(schema.pipelineJob).set({
        status: discoverAfter ? "queued" : "failed",
        discoverAfter,
        stagedFilePath: null,
        stagedQualities: null,
        lastError: err?.message || String(err),
        ...(discoverAfter
          ? {
              metadata: {
                ...(job.metadata || {}),
                discoveryRetries: retryIndex + 1,
                maxDiscoveryRetries: retrySchedule.length,
              },
            }
          : {}),
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      }).where(and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, "downloading")));

      if (discoverAfter) {
        log.warn("PipelineEngine", `Job #${jobId} will retry (${retryIndex + 1}/${retrySchedule.length}) after ${discoverAfter.toISOString()}: ${err?.message || err}`);
        return { status: "retry_scheduled", jobId, error: err?.message || String(err) };
      }
      log.error("PipelineEngine", `Job #${jobId} staging failed: ${err?.message || err}`);
      return { status: "failed", jobId, error: err?.message || String(err) };
    } finally {
      clearInterval(heartbeatInterval);
      this.activeDiscoveringJobIds.delete(jobId);
      await fs.promises.rm(tempSubsDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private static async discoverAndStageQualityBackfill(
    job: PipelineJob,
    _transmission: TransmissionClient,
    videoManager: VideoEncodingManager,
    stagingDir: string,
    downloadedPaths: Set<string>,
  ): Promise<DiscoveryResult> {
    const jobId = job.id;
    const type = job.types[0];
    const metadata = job.metadata ?? {};
    const requestedQualities = this.backfillOutputQualities(job);
    const sourceUrl = metadata.sourceUrl as string | undefined;
    if (!type || !sourceUrl || !metadata.sourceJobId) throw new Error("Missing backfill source");

    const runningJob = and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, "downloading"));
    const retryLater = async (delay: number, reason: string, nextMetadata = metadata): Promise<DiscoveryResult> => {
      await db.update(schema.pipelineJob).set({
        status: "queued", discoverAfter: new Date(Date.now() + delay), metadata: nextMetadata,
        lastError: reason, heartbeatAt: new Date(), updatedAt: new Date(),
      }).where(runningJob);
      log.info("PipelineEngine", `[Job #${jobId}] ${requestedQualities.join("/")} backfill: ${reason}`);
      return { status: "retry_scheduled", jobId, error: reason };
    };

    const { animeId, anilistId, anidbId, episodeNumber } = job;
    const sourceWatermarked = typeof metadata.sourceTorrentTitle === "string" &&
      ReleaseFilter.hasWatermarkedSource(metadata.sourceTorrentTitle);
    const missingFromApi = sourceWatermarked
      ? null
      : await fetchMissingBackfillQualities({
          animeId, anilistId, anidbId, episodeNumber, type,
          sourceUrl, sourceJobId: metadata.sourceJobId,
        });
    const targetQualities = missingFromApi
      ? requestedQualities.filter(q => missingFromApi.includes(q))
      : [];
    if (sourceWatermarked || targetQualities.length === 0) {
      await db.update(schema.pipelineJob).set({
        status: "skipped",
        lastError: sourceWatermarked ? "Published source is marked as watermarked" : "Published source changed or qualities are already available",
        updatedAt: new Date(),
      }).where(runningJob);
      return { status: "skipped", jobId };
    }

    const searchDelays = QUALITY_BACKFILL_SEARCH_DELAYS_MS;
    if (this.getExecutionPolicy() === "vm_remux_only" || !videoManager.getKaggleAccounts().length) {
      return retryLater(searchDelays[1], "Waiting for Kaggle GPU encoding to be available for lower-quality backfill");
    }

    const expectedBytes = Number(metadata.sourceSizeBytes) || undefined;
    if (expectedBytes && expectedBytes > KIRA_MAX_STAGING_BYTES) throw new Error("Stored 1080p exceeds the staging limit");
    if (this.storedSourceDownload) {
      return retryLater(CALLBACK_DELAYS_MS[0], "Waiting for another stored 1080p transfer to finish");
    }
    this.storedSourceDownload = { jobId, sizeBytes: expectedBytes ?? 0 };
    try {
      const cap = await this.checkStorageCapacityForDownload(jobId);
      const availableBytes = Math.min(KIRA_MAX_STAGING_BYTES - cap.usedBytes - cap.reservedBytes,
        cap.freeDiskBytes - KIRA_MIN_FREE_SSD_BYTES);
      if (!cap.allowed || availableBytes < (expectedBytes ?? 10_240)) {
        return await retryLater(searchDelays[0], cap.reason || "Waiting for disk space to stage the stored 1080p");
      }

      const destination = path.join(stagingDir, `job_${jobId}_ep${episodeNumber}_1080p_${crypto.randomUUID().slice(0, 6)}.mp4`);
      downloadedPaths.add(destination);
      const sizeBytes = await stageStored1080p(
        { url: sourceUrl, sha256: metadata.sourceSha256, sizeBytes: expectedBytes },
        destination,
        availableBytes,
      );

      if (this.getExecutionPolicy() === "vm_remux_only") {
        await fs.promises.unlink(destination).catch(() => {});
        return retryLater(searchDelays[0], "Execution policy changed during backfill staging");
      }

      const now = new Date();
      // The published 1080p MP4 already contains the requested language as its only audio track.
      const nextMetadata = {
        ...metadata,
        processingMode: "kaggle_gpu" as const,
        targetQualities,
        targetQuality: targetQualities[0],
      };
      const [updated] = await db.update(schema.pipelineJob).set({
        status: "staged",
        pipelineType: "kaggle_gpu",
        selectionTier: null,
        videoCodec: "h264",
        qualityCount: targetQualities.length,
        stagedQualities: { "1080p": destination },
        stagedFilePath: destination,
        sizeBytes,
        tracksConfig: [[type, 0]],
        torrentTitle: null,
        torrentMagnet: null,
        metadata: nextMetadata,
        lastError: null,
        stagedAt: now,
        heartbeatAt: now,
        updatedAt: now,
      }).where(runningJob).returning({ id: schema.pipelineJob.id });
      if (!updated) throw new Error("Lost the backfill staging claim");
      log.success(
        "PipelineEngine",
        `[Job #${jobId}] Staged stored 1080p directly for Kaggle GPU encode (${targetQualities.join(" + ")})`,
      );
      return { status: "staged", jobId, pipelineType: "kaggle_gpu", sizeBytes };
    } finally {
      this.storedSourceDownload = null;
    }
  }

  private static matchesBackfillResolution(probe: MkvStreamProbe, quality: BackfillQuality) {
    const { height, width } = probe;
    if (!height || !width) return false;
    if (quality === "480p") return height >= 360 && height <= 576 && width <= 1024;
    return height <= 720 && width <= 1280 && (height > 576 || (width === 1280 && height > 480));
  }

  public static async getStagedWindowStats(): Promise<{
    stagedCount: number;
    stagedRemuxCount: number;
    stagedGpuCount: number;
    totalBytes: number;
    gpuStagedBytes: number;
    oldestStagedAt: Date | null;
    newestStagedAt: Date | null;
    oldestGpuStagedAt: Date | null;
    newestGpuStagedAt: Date | null;
    activeDownloadsOrQueued: number;
  }> {
    await this.ensureTables();

    const [staged, activeQueueRows] = await Promise.all([
      db
        .select({
          id: schema.pipelineJob.id,
          pipelineType: schema.pipelineJob.pipelineType,
          sizeBytes: schema.pipelineJob.sizeBytes,
          stagedAt: schema.pipelineJob.stagedAt,
          stagedFilePath: schema.pipelineJob.stagedFilePath,
          metadata: schema.pipelineJob.metadata,
        })
        .from(schema.pipelineJob)
        .where(and(eq(schema.pipelineJob.status, "staged"), isNull(schema.pipelineJob.batchId)))
        .orderBy(asc(schema.pipelineJob.stagedAt)),
      db
        .select({ count: sql<number>`count(*)` })
        .from(schema.pipelineJob)
        .where(or(eq(schema.pipelineJob.status, "downloading"), queuedDiscoveryCondition())),
    ]);

    const stagedCount = staged.length;
    let stagedRemuxCount = 0;
    let stagedGpuCount = 0;
    let totalBytes = 0;
    let gpuStagedBytes = 0;
    let oldestGpuStagedAt: Date | null = null;
    let newestGpuStagedAt: Date | null = null;

    for (const s of staged) {
      const sz = Number(s.sizeBytes || 0);
      totalBytes += sz;
      if (this.isJobVmRemux(s)) {
        stagedRemuxCount++;
      } else {
        stagedGpuCount++;
        gpuStagedBytes += sz;
        if (!oldestGpuStagedAt && s.stagedAt) oldestGpuStagedAt = s.stagedAt;
        if (s.stagedAt) newestGpuStagedAt = s.stagedAt;
      }
    }

    const oldestStagedAt = staged[0]?.stagedAt || null;
    const newestStagedAt = staged[staged.length - 1]?.stagedAt || null;
    const activeDownloadsOrQueued = Number(activeQueueRows[0]?.count || 0);

    return {
      stagedCount,
      stagedRemuxCount,
      stagedGpuCount,
      totalBytes,
      gpuStagedBytes,
      oldestStagedAt,
      newestStagedAt,
      oldestGpuStagedAt,
      newestGpuStagedAt,
      activeDownloadsOrQueued,
    };
  }

  /**
   * Determines whether the current staged GPU window should be sealed into a Kaggle GPU batch.
   * - Pipeline 1 (`vm_remux`): Runs continuously 2-at-a-time on the VM with ZERO batching via `drainVmRemuxQueue()`.
   * - Pipeline 2 (`kaggle_gpu`): Seals when 10 files / 10 GB / 30m window / 90s GPU idle settle / queue-drain / 56 GB pressure is reached.
   */
  public static async evaluateBatchSealReadiness(forceFlush = false): Promise<{
    shouldSeal: boolean;
    reason: string;
    stats: Awaited<ReturnType<typeof PipelineEngineService.getStagedWindowStats>>;
  }> {
    const policy = this.getExecutionPolicy();
    const stats = await this.getStagedWindowStats();

    // Always ensure Pipeline 1 (2-at-a-time VM Remux) is draining any staged H.264 jobs immediately (unless policy is kaggle_gpu_only)
    if (stats.stagedRemuxCount > 0 && policy !== "kaggle_gpu_only") {
      setImmediate(() => {
        this.drainVmRemuxQueue().catch(() => {});
      });
    }

    if (policy === "vm_remux_only") {
      return { shouldSeal: false, reason: "policy_vm_remux_only", stats };
    }

    if (stats.stagedGpuCount === 0) {
      return { shouldSeal: false, reason: "no_staged_gpu_jobs", stats };
    }

    if (forceFlush) {
      return { shouldSeal: true, reason: "manual_flush", stats };
    }

    // 1. If total staging disk usage is >= 80% of the 56 GB limit, flush GPU batches immediately to free SSD space
    const diskBytes = Math.max(stats.totalBytes, this.getActualStagingDiskBytes());
    if (diskBytes >= KIRA_MAX_STAGING_BYTES * 0.8) {
      return { shouldSeal: true, reason: "storage_pressure_56gb", stats };
    }

    // 2. Pipeline 2: Kaggle GPU batch triggers
    if (stats.stagedGpuCount >= KIRA_BATCH_MAX_ITEMS) {
      return { shouldSeal: true, reason: "file_limit_10", stats };
    }

    if (stats.gpuStagedBytes >= KIRA_BATCH_SAFE_MAX_BYTES) {
      return { shouldSeal: true, reason: "size_cap_10gb", stats };
    }

    if (stats.oldestGpuStagedAt && Date.now() - stats.oldestGpuStagedAt.getTime() >= KIRA_BATCH_WINDOW_MS) {
      return { shouldSeal: true, reason: "window_30m", stats };
    }

    if (
      stats.activeDownloadsOrQueued === 0 &&
      stats.newestGpuStagedAt &&
      Date.now() - stats.newestGpuStagedAt.getTime() >= KIRA_QUEUE_IDLE_SETTLE_MS
    ) {
      return { shouldSeal: true, reason: "queue_drained", stats };
    }

    // 3. Anti-stall GPU idle settle: if no new HEVC/AV1 episode has arrived in >= 90s, seal and dispatch to available GPU slot
    if (
      stats.newestGpuStagedAt &&
      Date.now() - stats.newestGpuStagedAt.getTime() >= 90_000
    ) {
      return { shouldSeal: true, reason: "gpu_idle_settle_90s", stats };
    }

    return { shouldSeal: false, reason: "waiting_for_window_or_downloads", stats };
  }

  /**
   * Pipeline 1 Direct 2-Slot Queue Drainer (NO Batching!):
   * Pulls staged `vm_remux` jobs one-by-one into `vmRemuxQueue` (`concurrency = 2`).
   * As soon as 1 of the 2 VM remux jobs completes, the next staged `vm_remux` job immediately enters the slot.
   */
  public static async drainVmRemuxQueue(): Promise<number[]> {
    if (this.isDrainingVmRemux) return [];
    const policy = this.getExecutionPolicy();
    if (policy === "kaggle_gpu_only") {
      return [];
    }

    this.isDrainingVmRemux = true;
    const startedJobIds: number[] = [];

    try {
      await this.ensureTables();

      // 1. Recover any orphaned VM remux job stuck in 'encoding' with batchId IS NULL and stale heartbeat (> 2m)
      const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000);
      const encodingUnbatched = await db
        .select()
        .from(schema.pipelineJob)
        .where(
          and(
            eq(schema.pipelineJob.status, "encoding"),
            isNull(schema.pipelineJob.batchId),
          ),
        );

      for (const sj of encodingUnbatched) {
        if (
          this.isJobVmRemux(sj) &&
          !this.activeVmRemuxJobIds.has(sj.id) &&
          (!sj.heartbeatAt || sj.heartbeatAt < twoMinsAgo)
        ) {
          if (this.hasValidStagedFiles(sj)) {
            log.warn(
              "PipelineEngine",
              `[Pipeline 1: VM Remux] Recovering interrupted Job #${sj.id} back to 'staged' queue...`,
            );
            await db
              .update(schema.pipelineJob)
              .set({
                status: "staged",
                heartbeatAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, sj.id));
          } else {
            await db
              .update(schema.pipelineJob)
              .set({
                status: "queued",
                stagedFilePath: null,
                heartbeatAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, sj.id));
          }
        }
      }

      if (this.activeVmRemuxJobIds.size >= KIRA_VM_MAX_CONCURRENT_BATCHES) {
        return [];
      }

      // 2. Fetch staged unbatched jobs in FIFO order
      const allStagedJobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(and(eq(schema.pipelineJob.status, "staged"), isNull(schema.pipelineJob.batchId)))
        .orderBy(asc(schema.pipelineJob.stagedAt), asc(schema.pipelineJob.id));

      const remuxCandidates = allStagedJobs.filter(
        (j) => this.isJobVmRemux(j) && !this.activeVmRemuxJobIds.has(j.id),
      );

      for (const job of remuxCandidates) {
        if (this.activeVmRemuxJobIds.size >= KIRA_VM_MAX_CONCURRENT_BATCHES) {
          break;
        }

        if (!this.hasValidStagedFiles(job)) {
          log.warn("PipelineEngine", `Staged source is unavailable for VM Remux Job #${job.id}; re-queuing job.`);
          await db
            .update(schema.pipelineJob)
            .set({ status: "queued", stagedFilePath: null, batchId: null, updatedAt: new Date() })
            .where(eq(schema.pipelineJob.id, job.id));
          continue;
        }

        const claimed = await db
          .update(schema.pipelineJob)
          .set({ status: "encoding", pipelineType: "vm_remux", batchId: null,
            heartbeatAt: new Date(), updatedAt: new Date() })
          .where(and(eq(schema.pipelineJob.id, job.id), eq(schema.pipelineJob.status, "staged"), isNull(schema.pipelineJob.batchId)))
          .returning({ id: schema.pipelineJob.id });
        if (!claimed.length) continue;
        this.activeVmRemuxJobIds.add(job.id);
        startedJobIds.push(job.id);

        const slotIndex = this.activeVmRemuxJobIds.size;
        log.success(
          "PipelineEngine",
          `[Pipeline 1: VM Remux] Passing Job #${job.id} (Ep ${job.episodeNumber} | ${job.selectionTier || "h264"} | ${job.qualityCount || 1}Q) directly into VM Slot ${slotIndex}/${KIRA_VM_MAX_CONCURRENT_BATCHES} (zero batching)...`,
        );

        vmRemuxQueue
          .add(async () => {
            await this.executeVmRemuxJob(job.id);
          })
          .catch((err) => {
            log.error("PipelineEngine", `VM Remux worker error for Job #${job.id}: ${err?.message || err}`);
          });
      }
    } catch (err: any) {
      log.warn("PipelineEngine", `drainVmRemuxQueue warning: ${err?.message || err}`);
    } finally {
      this.isDrainingVmRemux = false;
    }

    return startedJobIds;
  }

  /**
   * Backward-compatible wrapper: instead of creating a batch for Pipeline 1, drains the 2-slot VM Remux queue directly.
   */
  public static async sealVmRemuxBatch(_options: {
    triggerReason?: string;
  } = {}): Promise<{
    batchId: null;
    jobCount: number;
    totalBytes: number;
  }> {
    const startedIds = await this.drainVmRemuxQueue();
    return {
      batchId: null,
      jobCount: startedIds.length,
      totalBytes: 0,
    };
  }

  /**
   * Pipeline 2 Batch Sealer:
   * Atomically seals a Kaggle GPU batch (`pipelineType = "kaggle_gpu"`) of up to 10 staged HEVC/AV1 jobs / 10 GB
   * and assigns it to the least-loaded Kaggle account (< 2 active notebooks).
   */
  public static async sealStagedBatch(options: {
    forceFlush?: boolean;
    triggerReason?: string;
  } = {}): Promise<{
    batchId: number | null;
    jobCount: number;
    totalBytes: number;
    kaggleUsername?: string | null;
  }> {
    await this.ensureTables();

    if (this.getExecutionPolicy() === "vm_remux_only") {
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    const { kaggleAccounts } = loadAccountsFromEnv();
    if (kaggleAccounts.length === 0) {
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    const readiness = await this.evaluateBatchSealReadiness(Boolean(options.forceFlush));
    if (!readiness.shouldSeal || readiness.stats.stagedGpuCount === 0) {
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    return await db.transaction(async (tx) => {
      const lockRes = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(405001) AS locked`);
      const isLocked = Boolean((lockRes[0] as any)?.locked);
      if (!isLocked) {
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      const maxConcurrentBatches = kaggleAccounts.length * KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT;

      const allActiveBatches = await tx
        .select({
          id: schema.pipelineBatch.id,
          pipelineType: schema.pipelineBatch.pipelineType,
          status: schema.pipelineBatch.status,
          kaggleUsername: schema.pipelineBatch.kaggleUsername,
          triggerReason: schema.pipelineBatch.triggerReason,
        })
        .from(schema.pipelineBatch)
        .where(
          inArray(schema.pipelineBatch.status, [
            "created",
            "uploading",
            "waiting_dataset",
            "kernel_running",
          ]),
        );

      const activeGpuBatches = allActiveBatches.filter((b) => !this.isBatchVmRemux(b));

      if (activeGpuBatches.length >= maxConcurrentBatches) {
        log.info(
          "PipelineEngine",
          `[Pipeline 2: Kaggle GPU] Cluster at full capacity (${activeGpuBatches.length}/${maxConcurrentBatches} active notebooks). Staged HEVC/AV1 episodes will seal as soon as a slot frees.`,
        );
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      const usageMap: Record<string, number> = {};
      for (const b of activeGpuBatches) {
        if (b.kaggleUsername) {
          usageMap[b.kaggleUsername] = (usageMap[b.kaggleUsername] || 0) + 1;
        }
      }

      const eligibleAccounts = kaggleAccounts
        .map((acc) => ({
          account: acc,
          activeCount: usageMap[acc.username] || 0,
        }))
        .filter((item) => item.activeCount < KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT)
        .sort((a, b) => a.activeCount - b.activeCount);

      if (eligibleAccounts.length === 0) {
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      const selectedAccount = eligibleAccounts[0].account;

      const stagedJobs = await tx
        .select()
        .from(schema.pipelineJob)
        .where(and(eq(schema.pipelineJob.status, "staged"), isNull(schema.pipelineJob.batchId)))
        .orderBy(asc(schema.pipelineJob.stagedAt));

      // Only pack jobs that belong to Pipeline 2 (HEVC/AV1 Kaggle GPU encode)
      const gpuStagedJobs = stagedJobs.filter((j) => !this.isJobVmRemux(j));
      if (gpuStagedJobs.length === 0) {
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      const validStagedJobs: typeof gpuStagedJobs = [];
      for (const j of gpuStagedJobs) {
        if (this.hasValidStagedFiles(j)) {
          validStagedJobs.push(j);
        } else {
          log.warn("PipelineEngine", `Staged file missing for Job #${j.id} (${j.stagedFilePath}); re-queuing job.`);
          await tx
            .update(schema.pipelineJob)
            .set({ status: "queued", stagedFilePath: null, batchId: null, updatedAt: new Date() })
            .where(eq(schema.pipelineJob.id, j.id));
        }
      }

      if (validStagedJobs.length === 0) {
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      const packedJobs: typeof validStagedJobs = [];
      let accBytes = 0;

      for (const job of validStagedJobs) {
        const sz = Number(job.sizeBytes || 0);
        if (
          (accBytes + sz > KIRA_BATCH_SAFE_MAX_BYTES || packedJobs.length >= KIRA_BATCH_MAX_ITEMS) &&
          packedJobs.length > 0
        ) {
          break;
        }
        packedJobs.push(job);
        accBytes += sz;
      }

      if (packedJobs.length === 0) {
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      const effectiveReason = options.triggerReason || readiness.reason || "window_30m";

      const [batch] = await tx
        .insert(schema.pipelineBatch)
        .values({
          pipelineType: "kaggle_gpu",
          status: "created",
          triggerReason: effectiveReason,
          kaggleUsername: selectedAccount.username,
          jobCount: packedJobs.length,
          totalBytes: accBytes,
          heartbeatAt: new Date(),
        })
        .returning();

      const jobIds = packedJobs.map((j) => j.id);
      await tx
        .update(schema.pipelineJob)
        .set({
          batchId: batch.id,
          pipelineType: "kaggle_gpu",
          status: "encoding",
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(inArray(schema.pipelineJob.id, jobIds));

      log.success(
        "PipelineEngine",
        `[Pipeline 2: Kaggle GPU] Sealed Batch #${batch.id} [${effectiveReason}] -> @${selectedAccount.username} (Slot ${eligibleAccounts[0].activeCount + 1}/${KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT}): ${packedJobs.length} HEVC/AV1 job(s), ${(accBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`,
      );

      return {
        batchId: batch.id,
        jobCount: packedJobs.length,
        totalBytes: accBytes,
        kaggleUsername: selectedAccount.username,
      };
    });
  }

  /**
   * Triggers Pipeline 1 (continuous 2-at-a-time VM Direct-Remux queue) AND seals eligible Pipeline 2 (Kaggle GPU) batches.
   */
  public static async sealAvailableBatches(options: {
    forceFlush?: boolean;
    triggerReason?: string;
  } = {}): Promise<number[]> {
    // 1. Drain Pipeline 1 (VM Direct-Remux) 2-slot worker queue immediately (no batching!)
    await this.drainVmRemuxQueue();

    // 2. Seal Pipeline 2 (Kaggle GPU) batches
    const sealedBatchIds: number[] = [];
    while (true) {
      const gpuRes = await this.sealStagedBatch(options);
      if (!gpuRes.batchId) break;
      sealedBatchIds.push(gpuRes.batchId);
    }

    return sealedBatchIds;
  }

  /**
   * Persist completed output records for a job, deliver webhook callbacks to Main Backend, and clean up local staged files.
   */
  private static async persistAndDeliverJobCompletion(
    job: typeof schema.pipelineJob.$inferSelect,
    jobOutputs: KiraBatchHfRecord[],
  ): Promise<void> {
    const encodedTrackTypes = Array.from(
      new Set(
        jobOutputs.map((o) =>
          o.type === "dub" || o.type === "sub"
            ? o.type
            : job.types.includes("dub") && !job.types.includes("sub")
              ? "dub"
              : "sub",
        ),
      ),
    ) as ("sub" | "dub")[];

    const rawSubtitles = (job.subtitlesPayload as R2SubtitleRecord[]) || [];
    const trackPayloads: PipelineEpisodeResult[] = [];

    for (const trackType of encodedTrackTypes) {
      const trackRecords = jobOutputs.filter((o) => {
        if (o.type === "sub" || o.type === "dub") return o.type === trackType;
        return true;
      });

      const sources = trackRecords
        .map((o) => ({
          quality: o.quality,
          url: o.huggingface?.downloadUrl || "",
          downloadUrl: o.huggingface?.downloadUrl || "",
          sha256: o.sha256,
          sizeBytes: o.metadata?.size,
        }))
        .sort((a, b) => parseInt(String(b.quality), 10) - parseInt(String(a.quality), 10));

      const formattedSubs = SubtitleManager.formatForCallback(rawSubtitles, trackType);

      trackPayloads.push({
        ...this.completionIdentity(job, trackType),
        sources,
        subtitles: formattedSubs,
      });
    }

    await this.persistAndDeliverPayloads(job, trackPayloads);
  }

  private static completionIdentity(job: typeof schema.pipelineJob.$inferSelect, type: "sub" | "dub") {
    return {
      jobId: job.id,
      animeId: job.animeId,
      anilistId: job.anilistId,
      anidbId: job.anidbId,
      episodeNumber: job.episodeNumber,
      type,
      kind: job.metadata?.kind,
      sourceJobId: job.metadata?.sourceJobId,
      sourceUrl: job.metadata?.sourceUrl,
      completedAt: new Date().toISOString(),
    };
  }

  private static async persistAndDeliverPayloads(
    job: typeof schema.pipelineJob.$inferSelect,
    payloads: PipelineEpisodeResult[],
  ): Promise<void> {
    if (!payloads.length) throw new Error(`No deliverable tracks for job #${job.id}`);
    const now = new Date();
    await db.update(schema.pipelineJob).set({
      status: "completed",
      resultPayload: { ...payloads[0], allTrackPayloads: payloads },
      metadata: { ...(job.metadata || {}), callbackDelivered: false },
      callbackAfter: now,
      torrentTitle: job.torrentTitle,
      torrentMagnet: job.torrentMagnet,
      subtitlesPayload: job.subtitlesPayload,
      lastError: null,
      completedAt: now,
      heartbeatAt: now,
      updatedAt: now,
    }).where(eq(schema.pipelineJob.id, job.id));

    await this.retryJobCallback(job.id).catch(error =>
      log.warn("PipelineEngine", `Job #${job.id} is complete; delivery remains pending: ${String(error)}`));
    await this.cleanupJobStagedFiles(job).catch(error =>
      log.warn("PipelineEngine", `Job #${job.id} cleanup pending: ${String(error)}`));
  }

  public static async executeVmRemuxJob(jobId: number): Promise<void> {

    const heartbeatTimer = setInterval(() => {
      db.update(schema.pipelineJob)
        .set({ heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.pipelineJob.id, jobId))
        .catch(() => {});
    }, 20_000);

    try {
      await this.ensureTables();
      const job = await db.query.pipelineJob.findFirst({
        where: eq(schema.pipelineJob.id, jobId),
      });
      if (!job || job.status === "completed") {
        return;
      }

      const videoManager = new VideoEncodingManager();

      try {
        const stagedQualitiesMap = (job.stagedQualities ||
          job.metadata?.stagedQualities ||
          {}) as Partial<Record<VideoResolutionQuality, string>>;
        const qualityFiles: Partial<Record<VideoResolutionQuality, string>> = {};

        const isBackfill = job.metadata?.kind === "quality_backfill";
        const allowedQualities: VideoResolutionQuality[] = isBackfill
          ? this.backfillOutputQualities(job)
          : job.selectionTier === "h264_single_1080p"
            ? ["1080p"]
            : (["1080p", "720p", "480p"] as VideoResolutionQuality[]);

        for (const q of allowedQualities) {
          const p = stagedQualitiesMap[q];
          if (p && fs.existsSync(p)) {
            qualityFiles[q] = p;
          }
        }
        if (!isBackfill && Object.keys(qualityFiles).length === 0 && job.stagedFilePath && fs.existsSync(job.stagedFilePath)) {
          qualityFiles["1080p"] = job.stagedFilePath;
        }

        if (Object.keys(qualityFiles).length === 0) {
          throw new Error(`No staged video files found on disk for Job #${job.id}`);
        }

        let tracks: [string, number][] = [];
        if (Array.isArray(job.tracksConfig) && job.tracksConfig.length > 0) {
          tracks = (job.tracksConfig as [string, number][]).filter(
            (t) => Array.isArray(t) && (t[0] === "sub" || t[0] === "dub"),
          );
        }
        if (tracks.length === 0) {
          tracks = job.types.includes("dub") && !job.types.includes("sub") ? [["dub", 0]] : [["sub", 0]];
        }

        const hfAccount = videoManager.getHfAccountForTarget(job.metadata?.hfUploadTarget);
        job.metadata = { ...(job.metadata || {}), hfUploadTarget: { owner: hfAccount.owner, bucket: hfAccount.bucket } };
        await db.update(schema.pipelineJob).set({ metadata: job.metadata }).where(eq(schema.pipelineJob.id, job.id));
        const animeId = job.animeId || job.anilistId || job.anidbId || job.id;

        const records = await videoManager.remuxAndUploadJobOnVm({
          jobId: job.id,
          animeId,
          episodeNumber: job.episodeNumber,
          stagedQualities: qualityFiles,
          tracks,
          hf: hfAccount,
          workBaseDir: getKiraStagingDir(),
          onProgress: async () => {
            const hb = new Date();
            await db
              .update(schema.pipelineJob)
              .set({ heartbeatAt: hb, updatedAt: hb })
              .where(eq(schema.pipelineJob.id, job.id));
          },
        });

        await this.persistAndDeliverJobCompletion(job, records);

        log.success(
          "PipelineEngine",
          `[Pipeline 1: VM Remux] Job #${job.id} (Ep ${job.episodeNumber}) finished! Passing next staged job into VM slot...`,
        );
      } catch (jobErr: any) {
        const lastJobErr = jobErr?.message || String(jobErr);
        log.error(
          "PipelineEngine",
          `[Pipeline 1: VM Remux] Job #${job.id} failed: ${lastJobErr}`,
        );

        const canReStage = job.attempt < MAX_JOB_ATTEMPTS && this.hasValidStagedFiles(job);
        if (canReStage) {
          await db
            .update(schema.pipelineJob)
            .set({
              status: "staged",
              batchId: null,
              attempt: job.attempt + 1,
              lastError: lastJobErr,
              heartbeatAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, job.id));
        } else {
          await db
            .update(schema.pipelineJob)
            .set({
              status: "failed",
              lastError: lastJobErr,
              heartbeatAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, job.id));
        }
      }
    } finally {
      clearInterval(heartbeatTimer);
      this.activeVmRemuxJobIds.delete(jobId);
      // Immediately pass the next waiting VM remux job into the freed slot and wake up any downloads waiting on the 56 GB cap!
      setImmediate(() => {
        this.drainVmRemuxQueue().catch(() => {});
        this.onStagingSpaceFreed().catch(() => {});
      });
    }
  }

  /**
   * Called whenever a job or batch deletes its staged files from SSD.
   * Immediately drains next VM Remux jobs, seals any ready GPU batches, and wakes up downloads paused by the 56 GB limit.
   */
  public static async onStagingSpaceFreed(): Promise<void> {
    try {
      await this.drainVmRemuxQueue();

      const readiness = await this.evaluateBatchSealReadiness(false);
      if (readiness.shouldSeal) {
        const sealedIds = await this.sealAvailableBatches({
          forceFlush: false,
          triggerReason: readiness.reason,
        });
        for (const bId of sealedIds) {
          await inngest
            .send({
              name: "pipeline/batch.execute",
              id: `pipeline-batch-${bId}-freed-${Date.now()}`,
              data: { batchId: bId },
            })
            .catch(() => {
              this.executeBatch(bId).catch(() => {});
            });
        }
      }

      const cap = await this.checkStorageCapacityForDownload();
      if (cap.allowed) {
        const queuedRows = await db
          .select()
          .from(schema.pipelineJob)
          .where(queuedDiscoveryCondition())
          .orderBy(asc(schema.pipelineJob.id))
          .limit(KIRA_DISCOVERY_CONCURRENCY);

        for (const qJob of queuedRows) {
          await inngest
            .send(discoveryEvent(qJob, "freed"))
            .catch(() => {
              this.stage1DiscoveryQueue
                .add(async () => {
                  await this.discoverAndStageJob(qJob.id).catch(() => {});
                })
                .catch(() => {});
            });
        }
      }
    } catch {}
  }

  /**
   * Legacy Pipeline 1 Batch Executor (retained for backward-compatibility with any pre-existing vm_remux batch records).
   */
  public static async executeVmRemuxBatch(batchId: number): Promise<void> {
    await this.ensureTables();

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch || batch.status === "completed") {
      return;
    }

    await vmRemuxQueue.add(async () => {
      const now = new Date();
      await db
        .update(schema.pipelineBatch)
        .set({
          pipelineType: "vm_remux",
          status: "kernel_running",
          kaggleUsername: "local-vm",
          datasetSlug: batch.datasetSlug || "vm-direct-remux",
          kernelSlug: batch.kernelSlug || "ffmpeg-copy-remux",
          startedAt: batch.startedAt || now,
          heartbeatAt: now,
          updatedAt: now,
        })
        .where(eq(schema.pipelineBatch.id, batchId));

      const videoManager = new VideoEncodingManager();
      const jobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(eq(schema.pipelineJob.batchId, batchId))
        .orderBy(asc(schema.pipelineJob.id));

      if (jobs.length === 0) {
        await db
          .update(schema.pipelineBatch)
          .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.pipelineBatch.id, batchId));
        return;
      }

      log.info(
        "PipelineEngine",
        `[Pipeline 1: VM Remux] Batch #${batchId}: Processing ${jobs.length} H.264 job(s) on VM with -c:v copy...`,
      );

      let anyJobFailed = false;
      let lastJobErr = "";

      for (const job of jobs) {
        if (job.status === "completed") continue;

        try {
          const stagedQualitiesMap = (job.stagedQualities ||
            job.metadata?.stagedQualities ||
            {}) as Partial<Record<VideoResolutionQuality, string>>;
          const qualityFiles: Partial<Record<VideoResolutionQuality, string>> = {};

          // If Tier 2 (h264_single_1080p), strictly only remux 1080p (1 quality)
          const isBackfill = job.metadata?.kind === "quality_backfill";
          const allowedQualities: VideoResolutionQuality[] = isBackfill
            ? this.backfillOutputQualities(job)
            : job.selectionTier === "h264_single_1080p"
              ? ["1080p"]
              : (["1080p", "720p", "480p"] as VideoResolutionQuality[]);

          for (const q of allowedQualities) {
            const p = stagedQualitiesMap[q];
            if (p && fs.existsSync(p)) {
              qualityFiles[q] = p;
            }
          }
          if (!isBackfill && Object.keys(qualityFiles).length === 0 && job.stagedFilePath && fs.existsSync(job.stagedFilePath)) {
            qualityFiles["1080p"] = job.stagedFilePath;
          }

          if (Object.keys(qualityFiles).length === 0) {
            throw new Error(`No staged video files found on disk for Job #${job.id}`);
          }

          let tracks: [string, number][] = [];
          if (Array.isArray(job.tracksConfig) && job.tracksConfig.length > 0) {
            tracks = (job.tracksConfig as [string, number][]).filter(
              (t) => Array.isArray(t) && (t[0] === "sub" || t[0] === "dub"),
            );
          }
          if (tracks.length === 0) {
            tracks = job.types.includes("dub") && !job.types.includes("sub") ? [["dub", 0]] : [["sub", 0]];
          }

          const hfAccount = videoManager.getHfAccountForTarget(job.metadata?.hfUploadTarget);
          job.metadata = { ...(job.metadata || {}), hfUploadTarget: { owner: hfAccount.owner, bucket: hfAccount.bucket } };
          await db.update(schema.pipelineJob).set({ metadata: job.metadata }).where(eq(schema.pipelineJob.id, job.id));
          const animeId = job.animeId || job.anilistId || job.anidbId || job.id;

          const records = await videoManager.remuxAndUploadJobOnVm({
            jobId: job.id,
            animeId,
            episodeNumber: job.episodeNumber,
            stagedQualities: qualityFiles,
            tracks,
            hf: hfAccount,
            workBaseDir: getKiraStagingDir(),
            onProgress: async () => {
              const hb = new Date();
              await db
                .update(schema.pipelineBatch)
                .set({ heartbeatAt: hb, updatedAt: hb })
                .where(eq(schema.pipelineBatch.id, batchId));
              await db
                .update(schema.pipelineJob)
                .set({ heartbeatAt: hb, updatedAt: hb })
                .where(eq(schema.pipelineJob.id, job.id));
            },
          });

          await this.persistAndDeliverJobCompletion(job, records);
        } catch (jobErr: any) {
          anyJobFailed = true;
          lastJobErr = jobErr?.message || String(jobErr);
          log.error(
            "PipelineEngine",
            `VM Direct-Remux Job #${job.id} failed in Batch #${batchId}: ${lastJobErr}`,
          );

          const canReStage = job.attempt < MAX_JOB_ATTEMPTS && this.hasValidStagedFiles(job);
          if (canReStage) {
            await db
              .update(schema.pipelineJob)
              .set({
                status: "staged",
                batchId: null,
                attempt: job.attempt + 1,
                lastError: lastJobErr,
                heartbeatAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, job.id));
          } else {
            await db
              .update(schema.pipelineJob)
              .set({
                status: "failed",
                lastError: lastJobErr,
                heartbeatAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, job.id));
          }
        }
      }

      await db
        .update(schema.pipelineBatch)
        .set({
          status: anyJobFailed && jobs.length === 1 ? "failed" : "completed",
          lastError: anyJobFailed ? lastJobErr : null,
          completedAt: new Date(),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));

      log.success(
        "PipelineEngine",
        `[Pipeline 1: VM Remux] Batch #${batchId} finished! Local VM slot is now free.`,
      );
    });
  }

  /**
   * Helper to build upload items and manifest items for a Kaggle GPU batch, resolving audio tracks accurately.
   */
  private static async buildBatchItems(
    batchId: number,
    videoManager: VideoEncodingManager,
  ) {
    const jobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.batchId, batchId))
      .orderBy(asc(schema.pipelineJob.id));

    const uploadItems: KiraBatchUploadItem[] = [];
    const manifestItems: KiraBatchManifestItem[] = [];

    for (const job of jobs) {
      if (!job.stagedFilePath || !fs.existsSync(job.stagedFilePath)) {
        log.warn("PipelineEngine", `Batch #${batchId}: Staged file missing for Job #${job.id} (${job.stagedFilePath})`);
        continue;
      }

      const ext = path.extname(job.stagedFilePath) || ".mkv";
      const safeRel = `input_${job.id}${ext}`;
      const sizeBytes = Number(job.sizeBytes || fs.statSync(job.stagedFilePath).size);

      let tracks: [string, number][] = [];
      if (Array.isArray(job.tracksConfig) && job.tracksConfig.length > 0) {
        const valid = (job.tracksConfig as [string, number][]).filter(
          (t) => Array.isArray(t) && (t[0] === "sub" || t[0] === "dub"),
        );
        if (valid.length > 0) {
          tracks = valid;
        }
      }

      if (tracks.length === 0) {
        try {
          const probe = await inspectMkvStreamsSync(job.stagedFilePath);
          const wantsSub = job.types.includes("sub");
          const wantsDub = job.types.includes("dub");
          const langMode = wantsSub && wantsDub ? "all" : wantsDub ? "dub" : "sub";
          tracks = videoManager.determineTracksToEncode(probe, langMode);
        } catch (error) {
          throw new Error(`Could not verify audio for job #${job.id}: ${String(error)}`);
        }
        if (!tracks.length) throw new Error(`No verified audio for job #${job.id}`);
      }

      const hfAccount = videoManager.getHfAccountForTarget(job.metadata?.hfUploadTarget);
        job.metadata = { ...(job.metadata || {}), hfUploadTarget: { owner: hfAccount.owner, bucket: hfAccount.bucket } };
        await db.update(schema.pipelineJob).set({ metadata: job.metadata }).where(eq(schema.pipelineJob.id, job.id));
      const isRemux = this.isJobVmRemux(job);
      const qualityFilesManifest: Partial<Record<VideoResolutionQuality, string>> = {};
      const sq = (job.stagedQualities || job.metadata?.stagedQualities) as
        | Partial<Record<VideoResolutionQuality, string>>
        | undefined;

      if (isRemux && sq) {
        for (const q of ["1080p", "720p", "480p"] as VideoResolutionQuality[]) {
          const localP = sq[q];
          if (localP && fs.existsSync(localP)) {
            const qExt = path.extname(localP) || ".mkv";
            const remoteName = `input_${job.id}_${q}${qExt}`;
            qualityFilesManifest[q] = remoteName;
            uploadItems.push({
              jobId: job.id,
              localFilePath: localP,
              remoteFilename: remoteName,
              sizeBytes: fs.statSync(localP).size,
            });
          }
        }
      }

      if (Object.keys(qualityFilesManifest).length === 0) {
        uploadItems.push({
          jobId: job.id,
          localFilePath: job.stagedFilePath,
          remoteFilename: safeRel,
          sizeBytes,
        });
      }

      manifestItems.push({
        jobId: job.id,
        filename: safeRel,
        mode: isRemux ? "remux" : "transcode",
        qualityFiles: Object.keys(qualityFilesManifest).length > 0 ? qualityFilesManifest : undefined,
        outputQualities: job.metadata?.kind === "quality_backfill" ? this.backfillOutputQualities(job) : undefined,
        animeId: job.animeId || job.anilistId || job.anidbId || job.id,
        anilistId: job.anilistId || undefined,
        anidbId: job.anidbId || undefined,
        episodeNumber: job.episodeNumber,
        tracks,
        hf: hfAccount,
      });
    }

    return { jobs, uploadItems, manifestItems };
  }

  private static backfillOutputQualities(job: PipelineJob): BackfillQuality[] {
    const rawList = Array.isArray(job.metadata?.targetQualities)
      ? job.metadata.targetQualities
      : job.metadata?.targetQuality
        ? [job.metadata.targetQuality]
        : [];
    const qualities = BACKFILL_QUALITIES.filter(q => rawList.includes(q));
    if (!qualities.length) throw new Error(`Job #${job.id} is missing valid backfill output qualities`);
    return qualities;
  }

  private static resolveBatchKaggleAccount(batchKaggleUsername: string | null) {
    const { kaggleAccounts } = loadAccountsFromEnv();
    if (kaggleAccounts.length === 0) {
      throw new Error("No Kaggle accounts available in KAGGLE_ACCOUNTS / KAGGLE_USERNAME");
    }
    const assigned = batchKaggleUsername
      ? kaggleAccounts.find((a) => a.username === batchKaggleUsername)
      : null;
    return assigned || kaggleAccounts[0];
  }

  private static async selectAlternateKaggleAccount(excludeUsername: string) {
    const { kaggleAccounts } = loadAccountsFromEnv();
    const candidates = kaggleAccounts.filter((a) => a.username !== excludeUsername);
    if (candidates.length === 0) return null;

    try {
      const activeBatches = await db
        .select({ kaggleUsername: schema.pipelineBatch.kaggleUsername })
        .from(schema.pipelineBatch)
        .where(
          inArray(schema.pipelineBatch.status, [
            "created",
            "uploading",
            "waiting_dataset",
            "kernel_running",
          ]),
        );
      const usageMap: Record<string, number> = {};
      for (const b of activeBatches) {
        if (b.kaggleUsername) {
          usageMap[b.kaggleUsername] = (usageMap[b.kaggleUsername] || 0) + 1;
        }
      }
      candidates.sort(
        (a, b) => (usageMap[a.username] || 0) - (usageMap[b.username] || 0),
      );
      if ((usageMap[candidates[0].username] || 0) < KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT) {
        return candidates[0];
      }
    } catch {}

    return candidates[0];
  }

  public static async prepareAndUploadBatchDataset(batchId: number): Promise<{
    skipped: boolean;
    empty: boolean;
    datasetSlug: string;
    kernelSlug: string;
    kaggleUsername: string;
  }> {
    await this.ensureTables();
    this.activeExecutingBatchIds.add(batchId);

    try {
      const batch = await db.query.pipelineBatch.findFirst({
        where: eq(schema.pipelineBatch.id, batchId),
      });
      if (!batch) {
        throw new Error(`Batch #${batchId} not found`);
      }

      let account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
      const datasetSlug = batch.datasetSlug || `kira-batch-${batchId}-${crypto.randomUUID().slice(0, 6)}`;
      const kernelSlug = batch.kernelSlug || `enc-batch-${batchId}-${crypto.randomUUID().slice(0, 6)}`;

      if (batch.status === "completed") {
        return {
          skipped: true,
          empty: false,
          datasetSlug,
          kernelSlug,
          kaggleUsername: account.username,
        };
      }

      const videoManager = new VideoEncodingManager();

      if (
        (batch.status === "waiting_dataset" || batch.status === "kernel_running") &&
        batch.datasetSlug
      ) {
        const dsStatus = await videoManager.checkDatasetStatusOnce(
          batch.datasetSlug,
          account.username,
          account.key,
        );
        if (dsStatus.state === "ready" || batch.status === "kernel_running") {
          log.info(
            "PipelineEngine",
            `Batch #${batchId} resuming existing dataset '${account.username}/${batch.datasetSlug}' (status=${batch.status})`,
          );
          return {
            skipped: true,
            empty: false,
            datasetSlug: batch.datasetSlug,
            kernelSlug,
            kaggleUsername: account.username,
          };
        }
      }

      const { uploadItems } = await this.buildBatchItems(batchId, videoManager);
      if (uploadItems.length === 0) {
        await db
          .update(schema.pipelineBatch)
          .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.pipelineBatch.id, batchId));
        return {
          skipped: true,
          empty: true,
          datasetSlug,
          kernelSlug,
          kaggleUsername: account.username,
        };
      }

      await db
        .update(schema.pipelineBatch)
        .set({
          pipelineType: "kaggle_gpu",
          status: "uploading",
          kaggleUsername: account.username,
          datasetSlug,
          kernelSlug,
          startedAt: batch.startedAt || new Date(),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));

      log.info(
        "PipelineEngine",
        `[Pipeline 2: Kaggle GPU] Batch #${batchId}: Uploading ${uploadItems.length} staged MKV(s) to Kaggle Dataset '${account.username}/${datasetSlug}'...`,
      );

      try {
        await videoManager.uploadBatchDatasetRest(
          uploadItems,
          datasetSlug,
          account.username,
          account.key,
          async () => {
            await db
              .update(schema.pipelineBatch)
              .set({ heartbeatAt: new Date(), updatedAt: new Date() })
              .where(eq(schema.pipelineBatch.id, batchId));
          },
        );
      } catch (uploadErr: any) {
        const altAccount = await this.selectAlternateKaggleAccount(account.username);
        if (!altAccount) {
          throw uploadErr;
        }
        log.warn(
          "PipelineEngine",
          `Batch #${batchId}: Dataset upload failed on @${account.username} (${uploadErr?.message || uploadErr}). Rotating to alternate Kaggle account @${altAccount.username}...`,
        );
        account = altAccount;
        await db
          .update(schema.pipelineBatch)
          .set({
            kaggleUsername: account.username,
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineBatch.id, batchId));

        await videoManager.uploadBatchDatasetRest(
          uploadItems,
          datasetSlug,
          account.username,
          account.key,
          async () => {
            await db
              .update(schema.pipelineBatch)
              .set({ heartbeatAt: new Date(), updatedAt: new Date() })
              .where(eq(schema.pipelineBatch.id, batchId));
          },
        );
      }

      await db
        .update(schema.pipelineBatch)
        .set({
          status: "waiting_dataset",
          kaggleUsername: account.username,
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));

      return {
        skipped: false,
        empty: false,
        datasetSlug,
        kernelSlug,
        kaggleUsername: account.username,
      };
    } finally {
      this.activeExecutingBatchIds.delete(batchId);
    }
  }

  public static async waitBatchDatasetReady(batchId: number): Promise<void> {
    await this.ensureTables();
    this.activeExecutingBatchIds.add(batchId);

    try {
      const batch = await db.query.pipelineBatch.findFirst({
        where: eq(schema.pipelineBatch.id, batchId),
      });
      if (!batch || batch.status === "completed" || batch.status === "kernel_running") {
        return;
      }

      const account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
      const datasetSlug = batch.datasetSlug;
      if (!datasetSlug) {
        throw new Error(`Batch #${batchId} missing datasetSlug in waitBatchDatasetReady`);
      }

      const videoManager = new VideoEncodingManager();
      await videoManager.waitForDatasetReady(
        datasetSlug,
        account.username,
        account.key,
        720,
        async () => {
          await db
            .update(schema.pipelineBatch)
            .set({ heartbeatAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.pipelineBatch.id, batchId));
        },
      );
    } finally {
      this.activeExecutingBatchIds.delete(batchId);
    }
  }

  public static async pushBatchKernel(batchId: number): Promise<void> {
    await this.ensureTables();
    this.activeExecutingBatchIds.add(batchId);

    try {
      const batch = await db.query.pipelineBatch.findFirst({
        where: eq(schema.pipelineBatch.id, batchId),
      });
      if (!batch || batch.status === "completed") {
        return;
      }

      let account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
      const datasetSlug = batch.datasetSlug;
      const kernelSlug = batch.kernelSlug;
      if (!datasetSlug || !kernelSlug) {
        throw new Error(`Batch #${batchId} missing datasetSlug or kernelSlug`);
      }

      const videoManager = new VideoEncodingManager();

      if (batch.status === "kernel_running") {
        const existingStatus = await videoManager.checkKernelStatusOnce(
          kernelSlug,
          account.username,
          account.key,
        );
        if (existingStatus.state === "running" || existingStatus.state === "completed") {
          log.info(
            "PipelineEngine",
            `Batch #${batchId}: Re-attached to existing Kaggle kernel '${account.username}/${kernelSlug}' (state=${existingStatus.state})`,
          );
          await db
            .update(schema.pipelineBatch)
            .set({ heartbeatAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.pipelineBatch.id, batchId));
          return;
        }
      }

      const { uploadItems, manifestItems } = await this.buildBatchItems(batchId, videoManager);
      if (manifestItems.length === 0) {
        throw new Error(`Batch #${batchId} has 0 valid manifest items to push`);
      }

      try {
        await videoManager.pushBatchGpuKernel(
          datasetSlug,
          kernelSlug,
          manifestItems,
          account.username,
          account.key,
        );
      } catch (pushErr: any) {
        const altAccount = await this.selectAlternateKaggleAccount(account.username);
        if (!altAccount || uploadItems.length === 0) {
          throw pushErr;
        }
        log.warn(
          "PipelineEngine",
          `Batch #${batchId}: Kernel push failed on @${account.username} (${pushErr?.message || pushErr}). Rotating to alternate Kaggle account @${altAccount.username}...`,
        );
        account = altAccount;
        await db
          .update(schema.pipelineBatch)
          .set({
            kaggleUsername: account.username,
            status: "uploading",
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineBatch.id, batchId));

        await videoManager.uploadBatchDatasetRest(
          uploadItems,
          datasetSlug,
          account.username,
          account.key,
          async () => {
            await db
              .update(schema.pipelineBatch)
              .set({ heartbeatAt: new Date(), updatedAt: new Date() })
              .where(eq(schema.pipelineBatch.id, batchId));
          },
        );

        await videoManager.waitForDatasetReady(
          datasetSlug,
          account.username,
          account.key,
          720,
          async () => {
            await db
              .update(schema.pipelineBatch)
              .set({ heartbeatAt: new Date(), updatedAt: new Date() })
              .where(eq(schema.pipelineBatch.id, batchId));
          },
        );

        await videoManager.pushBatchGpuKernel(
          datasetSlug,
          kernelSlug,
          manifestItems,
          account.username,
          account.key,
        );
      }

      await db
        .update(schema.pipelineBatch)
        .set({
          status: "kernel_running",
          kaggleUsername: account.username,
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));
    } finally {
      this.activeExecutingBatchIds.delete(batchId);
    }
  }

  public static async checkBatchKernelProgress(batchId: number): Promise<{
    state: "running" | "completed" | "failed";
    rawStatus: string;
    errorDetail?: string;
  }> {
    await this.ensureTables();

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch) {
      return { state: "failed", rawStatus: "batch_not_found", errorDetail: "Batch not found" };
    }
    if (batch.status === "completed") {
      return { state: "completed", rawStatus: "completed" };
    }

    const account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
    const kernelSlug = batch.kernelSlug;
    if (!kernelSlug) {
      return { state: "failed", rawStatus: "no_kernel_slug", errorDetail: "Missing kernelSlug" };
    }

    const videoManager = new VideoEncodingManager();
    const kStatus = await videoManager.checkKernelStatusOnce(
      kernelSlug,
      account.username,
      account.key,
    );

    const now = new Date();
    await db
      .update(schema.pipelineBatch)
      .set({ heartbeatAt: now, updatedAt: now })
      .where(eq(schema.pipelineBatch.id, batchId));

    await db
      .update(schema.pipelineJob)
      .set({ heartbeatAt: now, updatedAt: now })
      .where(eq(schema.pipelineJob.batchId, batchId));

    log.info(
      "PipelineEngine",
      `Batch #${batchId} Kernel '${kernelSlug}' [@${account.username}] -> ${kStatus.state} (${kStatus.rawStatus})`,
    );

    if (kStatus.state === "completed") {
      return { state: "completed", rawStatus: kStatus.rawStatus };
    }

    if (kStatus.state === "failed" || kStatus.state === "not_found") {
      const logSnippet = await videoManager.fetchKernelErrorSnippet(
        kernelSlug,
        account.username,
        account.key,
      );
      const detail = [
        `Kaggle kernel '${kernelSlug}' finished with status '${kStatus.rawStatus}'`,
        kStatus.failureMessage ? `(${kStatus.failureMessage})` : "",
        logSnippet ? `Log tail: ${logSnippet}` : "",
      ]
        .filter(Boolean)
        .join(" — ");
      return { state: "failed", rawStatus: kStatus.rawStatus, errorDetail: detail };
    }

    return { state: "running", rawStatus: kStatus.rawStatus };
  }

  public static async deliverCallbackPayload(payload: PipelineEpisodeResult): Promise<boolean> {
    if (!INTERNAL_SECRET) {
      log.warn("PipelineEngine", "INTERNAL_SECRET must be configured to deliver callbacks");
      return false;
    }
    try {
      const res = await fetch(`${MAIN_BACKEND_URL}/api/internal/pipeline/completed`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15_000),
        redirect: "error",
      });
      if (res.ok) return true;
      const message = (await res.text().catch(() => "")).slice(0, 200);
      log.warn("PipelineEngine", `Callback HTTP ${res.status} for job #${payload.jobId} (${payload.type}): ${message}`);
    } catch (error) {
      log.warn("PipelineEngine", `Callback for job #${payload.jobId} (${payload.type}) failed: ${String(error)}`);
    }
    return false;
  }

  public static async finalizeCompletedBatch(batchId: number): Promise<void> {
    await this.ensureTables();

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch || batch.status === "completed") {
      return;
    }

    const account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
    const datasetSlug = batch.datasetSlug || "";
    const kernelSlug = batch.kernelSlug || "";

    const videoManager = new VideoEncodingManager();
    const jobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.batchId, batchId));

    log.info("PipelineEngine", `Fetching encoded outputs for Batch #${batchId} (${kernelSlug})...`);
    let output;
    try {
      output = await videoManager.fetchBatchKernelOutput(
        kernelSlug,
        account.username,
        account.key,
      );
    } catch (fetchErr: any) {
      const errMsg = fetchErr?.message || String(fetchErr);
      await this.handleBatchFailure(batchId, errMsg);
      throw fetchErr;
    }

    const records = output.records || [];
    const failedJobMap = new Map<number, string>();
    for (const fj of output.failedJobs || []) {
      if (fj && typeof fj.jobId === "number") {
        failedJobMap.set(fj.jobId, fj.error || "Kernel reported job failure");
      }
    }

    log.success(
      "PipelineEngine",
      `Batch #${batchId}: Received ${records.length} encoded MP4 stream(s) from Kaggle.`,
    );

    for (const job of jobs) {
      if (job.status === "completed") continue;
      const backfillQualities = job.metadata?.kind === "quality_backfill" ? this.backfillOutputQualities(job) : undefined;
      const jobOutputs = records.filter((o) => {
        if (backfillQualities) {
          return o.job_id === job.id &&
            backfillQualities.includes(o.quality as BackfillQuality) &&
            o.type === job.types[0];
        }
        if (o.job_id != null) return o.job_id === job.id;
        const matchesAnime =
          (job.animeId && o.anime_id === job.animeId) ||
          (job.anilistId && o.anime_id === job.anilistId) ||
          (job.anidbId && o.anime_id === job.anidbId);
        return Boolean(matchesAnime && o.episode_number === job.episodeNumber);
      });

      const producedQualities = new Set(jobOutputs.map(o => o.quality));
      const missingExpectedBackfill = Boolean(
        backfillQualities &&
        (jobOutputs.length !== backfillQualities.length || !backfillQualities.every(q => producedQualities.has(q))),
      );
      if (jobOutputs.length === 0 || missingExpectedBackfill) {
        const failErr = failedJobMap.get(job.id) || "No encoded output records produced by kernel";
        const canReStage = job.attempt < MAX_JOB_ATTEMPTS && this.hasValidStagedFiles(job);

        if (canReStage) {
          log.warn(
            "PipelineEngine",
            `Job #${job.id} failed in Batch #${batchId} (${failErr}); returning to 'staged' for retry (attempt ${job.attempt + 1}/${MAX_JOB_ATTEMPTS}).`,
          );
          await db
            .update(schema.pipelineJob)
            .set({
              status: "staged",
              batchId: null,
              attempt: job.attempt + 1,
              lastError: failErr,
              heartbeatAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, job.id));
        } else {
          await db
            .update(schema.pipelineJob)
            .set({
              status: "failed",
              lastError: failErr,
              heartbeatAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, job.id));
        }
        continue;
      }

      await this.persistAndDeliverJobCompletion(job, jobOutputs);
    }

    if (datasetSlug) {
      await videoManager.deleteKaggleDataset(datasetSlug, account.username, account.key).catch(() => {});
    }
    if (kernelSlug) {
      await videoManager.deleteKaggleKernel(kernelSlug, account.username, account.key).catch(() => {});
    }

    await db
      .update(schema.pipelineBatch)
      .set({
        status: "completed",
        lastError: null,
        completedAt: new Date(),
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.pipelineBatch.id, batchId));

    log.success(
      "PipelineEngine",
      `[Pipeline 2: Kaggle GPU] Batch #${batchId} completed on Kaggle (@${account.username})! Slot is now free.`,
    );
  }

  public static async handleBatchFailure(batchId: number, errorMsg: string): Promise<void> {
    await this.ensureTables();

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch || batch.status === "completed") return;

    log.error("PipelineEngine", `Batch #${batchId} failed: ${errorMsg}`);

    if (!this.isBatchVmRemux(batch)) {
      const videoManager = new VideoEncodingManager();
      try {
        const account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
        if (batch.datasetSlug) {
          await videoManager.deleteKaggleDataset(batch.datasetSlug, account.username, account.key).catch(() => {});
        }
        if (batch.kernelSlug) {
          await videoManager.deleteKaggleKernel(batch.kernelSlug, account.username, account.key).catch(() => {});
        }
      } catch {}
    }

    await db
      .update(schema.pipelineBatch)
      .set({
        status: "failed",
        lastError: errorMsg,
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.pipelineBatch.id, batchId));

    const batchJobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.batchId, batchId));

    for (const job of batchJobs) {
      if (job.status === "completed") continue;

      const hasStagedFile = this.hasValidStagedFiles(job);
      if (hasStagedFile && job.attempt < MAX_JOB_ATTEMPTS) {
        log.info(
          "PipelineEngine",
          `Returning Job #${job.id} from failed Batch #${batchId} back to 'staged' (attempt ${job.attempt + 1}/${MAX_JOB_ATTEMPTS})`,
        );
        await db
          .update(schema.pipelineJob)
          .set({
            status: "staged",
            batchId: null,
            attempt: job.attempt + 1,
            lastError: `Previous Batch #${batchId} failed (${errorMsg}); re-staged for retry`,
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, job.id));
      } else {
        await db
          .update(schema.pipelineJob)
          .set({
            status: "failed",
            batchId: null,
            lastError: `Batch #${batchId} failed: ${errorMsg}`,
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, job.id));
      }
    }
  }

  /**
   * Updates the global Pipeline Execution Policy ("all" | "vm_remux_only" | "kaggle_gpu_only").
   * - Marks incompatible staged jobs as "skipped" and frees their staged SSD files.
   * - Optionally re-queues previously "skipped" jobs that are now compatible with the new policy.
   */
  public static async setExecutionPolicy(
    policy: PipelineExecutionPolicy,
    options: { requeueSkipped?: boolean; applyToStaged?: boolean } = {},
  ): Promise<{
    policy: PipelineExecutionPolicy;
    skippedStagedCount: number;
    requeuedJobs: (typeof schema.pipelineJob.$inferSelect)[];
  }> {
    this.persistExecutionPolicyToDisk(policy);
    let skippedStagedCount = 0;
    const requeuedJobs: (typeof schema.pipelineJob.$inferSelect)[] = [];

    if (!DATABASE_URL) {
      return { policy, skippedStagedCount, requeuedJobs };
    }

    try {
      await this.ensureTables();

      // 1. Apply policy to currently staged unbatched jobs
      if (options.applyToStaged !== false && policy !== "all") {
        const stagedRows = await db
          .select()
          .from(schema.pipelineJob)
          .where(and(eq(schema.pipelineJob.status, "staged"), isNull(schema.pipelineJob.batchId)));

        for (const job of stagedRows) {
          const isRemux = this.isJobVmRemux(job);
          if (job.metadata?.kind === "quality_backfill") {
            if ((policy === "vm_remux_only" && !isRemux) || (policy === "kaggle_gpu_only" && isRemux)) {
              const [updated] = await db.update(schema.pipelineJob).set({
                status: "queued", stagedFilePath: null, stagedQualities: null,
                discoverAfter: new Date(Date.now() + QUALITY_BACKFILL_SEARCH_DELAYS_MS[0]),
                lastError: "Backfill requeued after execution policy changed", updatedAt: new Date(),
              }).where(and(eq(schema.pipelineJob.id, job.id), eq(schema.pipelineJob.status, "staged"),
                isNull(schema.pipelineJob.batchId))).returning({ id: schema.pipelineJob.id });
              if (updated) await this.cleanupJobStagedFiles(job);
            }
            continue;
          }
          if (policy === "vm_remux_only" && !isRemux) {
            const skipReason =
              "Skipped: Staged HEVC/AV1 (Pipeline 2) release skipped when switching to 'Pipeline 1 Only (VM Remux)' mode.";
            await this.cleanupJobStagedFiles(job);
            await db
              .update(schema.pipelineJob)
              .set({
                status: "skipped",
                batchId: null,
                stagedFilePath: null,
                lastError: skipReason,
                metadata: {
                  ...(job.metadata || {}),
                  skippedByPolicy: policy,
                  incompatiblePipeline: "kaggle_gpu",
                },
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, job.id));
            skippedStagedCount++;
          } else if (
            policy === "kaggle_gpu_only" &&
            isRemux &&
            job.metadata?.processingMode !== "kaggle_gpu"
          ) {
            const skipReason =
              "Skipped: Staged H.264 (Pipeline 1) release skipped when switching to 'Pipeline 2 Only (Kaggle GPU)' mode.";
            await this.cleanupJobStagedFiles(job);
            await db
              .update(schema.pipelineJob)
              .set({
                status: "skipped",
                batchId: null,
                stagedFilePath: null,
                lastError: skipReason,
                metadata: {
                  ...(job.metadata || {}),
                  skippedByPolicy: policy,
                  incompatiblePipeline: "vm_remux",
                },
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, job.id));
            skippedStagedCount++;
          }
        }
      }

      // 2. Optionally re-queue previously skipped jobs that are now allowed by the new policy
      if (options.requeueSkipped) {
        const skippedRows = await db
          .select()
          .from(schema.pipelineJob)
          .where(eq(schema.pipelineJob.status, "skipped"))
          .orderBy(asc(schema.pipelineJob.id));

        for (const sJob of skippedRows) {
          const incomp = sJob.metadata?.incompatiblePipeline || sJob.pipelineType;
          const isAllowedNow =
            policy === "all" ||
            (policy === "vm_remux_only" && incomp === "vm_remux") ||
            (policy === "kaggle_gpu_only" && incomp === "kaggle_gpu");

          if (isAllowedNow) {
            const nextMeta = { ...(sJob.metadata || {}) };
            delete nextMeta.skippedByPolicy;
            delete nextMeta.executionPolicy;

            const hasStaged = this.hasValidStagedFiles(sJob);
            const [updated] = await db
              .update(schema.pipelineJob)
              .set({
                status: hasStaged ? "staged" : "queued",
                batchId: null,
                lastError: null,
                metadata: nextMeta,
                heartbeatAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, sJob.id))
              .returning();
            if (updated) {
              requeuedJobs.push(updated);
            }
          }
        }
      }
    } catch (err: any) {
      log.warn("PipelineEngine", `setExecutionPolicy warning: ${err?.message || err}`);
    }

    return { policy, skippedStagedCount, requeuedJobs };
  }

  /**
   * Reconciles any jobs or batches stuck in 'encoding' state:
   * 1. Heals orphaned 'encoding' jobs whose batchId points to a failed, completed, or deleted batch.
   * 2. Heals unbatched VM Remux 'encoding' jobs that are not in `activeVmRemuxJobIds` and have a stale heartbeat.
   * 3. When `liveKaggleCheck: true` (or when a Kaggle batch heartbeat is stale), actively queries Kaggle API right now
   *    to verify kernel/dataset status. If Kaggle returned an error or the kernel is missing/failed, immediately calls
   *    `handleBatchFailure` so neither the batch nor its jobs remain stuck in 'encoding'.
   */
  public static async reconcileStuckEncodingStates(
    options: { liveKaggleCheck?: boolean; forceBatchId?: number } = {},
  ): Promise<{
    reconciledJobs: number;
    failedBatches: number;
    completedBatches: number;
    details: string[];
  }> {
    if (this.isReconcilingEncoding && !options.liveKaggleCheck && !options.forceBatchId) {
      return { reconciledJobs: 0, failedBatches: 0, completedBatches: 0, details: [] };
    }
    this.isReconcilingEncoding = true;

    let reconciledJobs = 0;
    let failedBatches = 0;
    let completedBatches = 0;
    const details: string[] = [];

    try {
      if (!DATABASE_URL) {
        return { reconciledJobs, failedBatches, completedBatches, details };
      }
      await this.ensureTables();

      // Step 1: Live Kaggle status check for active batches when requested or when heartbeat is stale (> 2m)
      const activeBatches = await db
        .select()
        .from(schema.pipelineBatch)
        .where(
          inArray(schema.pipelineBatch.status, [
            "created",
            "uploading",
            "waiting_dataset",
            "kernel_running",
          ]),
        )
        .orderBy(asc(schema.pipelineBatch.id));

      const twoMinsAgo = new Date(Date.now() - 2 * 60 * 1000);
      const fourMinsAgo = new Date(Date.now() - 4 * 60 * 1000);
      const videoManager = new VideoEncodingManager();

      for (const batch of activeBatches) {
        const isTargetBatch = options.forceBatchId === batch.id;
        const isStale = !batch.heartbeatAt || batch.heartbeatAt < twoMinsAgo;

        if (!options.liveKaggleCheck && !isTargetBatch && !isStale) {
          continue;
        }

        if (this.isBatchVmRemux(batch)) {
          if (!this.activeExecutingBatchIds.has(batch.id) && (!batch.heartbeatAt || batch.heartbeatAt < fourMinsAgo)) {
            await this.handleBatchFailure(batch.id, "Interrupted VM remux batch recovered");
            failedBatches++;
            details.push(`Batch #${batch.id} (VM Remux): recovered stale batch`);
          }
          continue;
        }

        if (batch.status === "kernel_running") {
          if (!batch.kernelSlug) {
            await this.handleBatchFailure(batch.id, "Batch in kernel_running state without a kernelSlug");
            failedBatches++;
            details.push(`Batch #${batch.id}: failed (missing kernelSlug)`);
            continue;
          }

          const progress = await this.checkBatchKernelProgress(batch.id);
          if (progress.state === "failed") {
            const errMsg = progress.errorDetail || `Kaggle kernel failed (${progress.rawStatus})`;
            await this.handleBatchFailure(batch.id, errMsg);
            failedBatches++;
            details.push(`Batch #${batch.id}: Kaggle error detected (${errMsg})`);
          } else if (progress.state === "completed") {
            try {
              await this.finalizeCompletedBatch(batch.id);
              completedBatches++;
              details.push(`Batch #${batch.id}: Kaggle kernel completed & finalized`);
            } catch (finErr: any) {
              failedBatches++;
              details.push(`Batch #${batch.id}: Output finalization failed (${finErr?.message || finErr})`);
            }
          }
        } else if (batch.status === "waiting_dataset" && batch.datasetSlug) {
          try {
            const account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
            const dsStatus = await videoManager.checkDatasetStatusOnce(
              batch.datasetSlug,
              account.username,
              account.key,
              true,
            );
            if (dsStatus.state === "failed") {
              const errMsg = `Kaggle dataset '${batch.datasetSlug}' indexing failed (${dsStatus.rawStatus})`;
              await this.handleBatchFailure(batch.id, errMsg);
              failedBatches++;
              details.push(`Batch #${batch.id}: ${errMsg}`);
            } else if (!this.activeExecutingBatchIds.has(batch.id) && (!batch.heartbeatAt || batch.heartbeatAt < fourMinsAgo)) {
              // Dataset is ready or indexing, but no worker is polling it — resume execution
              setImmediate(() => {
                this.executeBatch(batch.id).catch(() => {});
              });
              details.push(`Batch #${batch.id}: resumed dataset wait worker`);
            }
          } catch (dsErr: any) {
            if (!this.activeExecutingBatchIds.has(batch.id) && (!batch.heartbeatAt || batch.heartbeatAt < fourMinsAgo)) {
              await this.handleBatchFailure(batch.id, dsErr?.message || "Dataset status check failed");
              failedBatches++;
            }
          }
        } else if (
          (batch.status === "uploading" || batch.status === "created") &&
          !this.activeExecutingBatchIds.has(batch.id) &&
          (!batch.heartbeatAt || batch.heartbeatAt < fourMinsAgo)
        ) {
          if (batch.status === "uploading") {
            await this.handleBatchFailure(
              batch.id,
              "Dataset upload interrupted or stalled; returning jobs to staged queue",
            );
            failedBatches++;
            details.push(`Batch #${batch.id}: aborted stalled upload and returned jobs to staged`);
          } else if (options.liveKaggleCheck || isTargetBatch) {
            setImmediate(() => {
              this.executeBatch(batch.id).catch(() => {});
            });
            details.push(`Batch #${batch.id}: triggered created batch execution`);
          }
        }
      }

      // Step 2: Reconcile any job in status = 'encoding' whose batch is already failed/completed/missing,
      // or whose unbatched VM Remux worker is no longer active.
      const encodingJobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(eq(schema.pipelineJob.status, "encoding"))
        .orderBy(asc(schema.pipelineJob.id));

      for (const job of encodingJobs) {
        if (job.batchId != null) {
          const parentBatch = await db.query.pipelineBatch.findFirst({
            where: eq(schema.pipelineBatch.id, job.batchId),
          });

          if (!parentBatch || parentBatch.status === "failed" || parentBatch.status === "completed") {
            if (job.resultPayload) {
              await db
                .update(schema.pipelineJob)
                .set({
                  status: "completed",
                  lastError: null,
                  completedAt: job.completedAt || new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(schema.pipelineJob.id, job.id));
              reconciledJobs++;
              details.push(`Job #${job.id}: marked completed (had resultPayload)`);
            } else {
              const hasStaged = this.hasValidStagedFiles(job);
              const canRetry = hasStaged && job.attempt < MAX_JOB_ATTEMPTS;
              const batchErr = parentBatch?.lastError || "Batch terminated while job was in encoding state";
              await db
                .update(schema.pipelineJob)
                .set({
                  status: canRetry ? "staged" : "failed",
                  batchId: null,
                  attempt: canRetry ? job.attempt + 1 : job.attempt,
                  lastError: canRetry
                    ? `Recovered from Batch #${job.batchId} (${batchErr}); re-staged for retry`
                    : `Batch #${job.batchId} failed: ${batchErr}`,
                  heartbeatAt: new Date(),
                  updatedAt: new Date(),
                })
                .where(eq(schema.pipelineJob.id, job.id));
              reconciledJobs++;
              details.push(`Job #${job.id}: transitioned from stuck 'encoding' -> '${canRetry ? "staged" : "failed"}'`);
            }
          }
        } else {
          // Unbatched job in 'encoding' (Pipeline 1 VM Remux)
          const isActivelyRemuxing = this.activeVmRemuxJobIds.has(job.id);
          const isStaleJob = !job.heartbeatAt || job.heartbeatAt < twoMinsAgo;

          if (!isActivelyRemuxing && (options.liveKaggleCheck || isStaleJob)) {
            const hasStaged = this.hasValidStagedFiles(job);
            await db
              .update(schema.pipelineJob)
              .set({
                status: hasStaged ? "staged" : "queued",
                batchId: null,
                stagedFilePath: hasStaged ? job.stagedFilePath : null,
                lastError: hasStaged
                  ? "Recovered from interrupted VM remux slot; re-staged"
                  : "Staged file missing after interrupted VM remux; re-queued for discovery",
                heartbeatAt: new Date(),
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, job.id));
            reconciledJobs++;
            details.push(`Job #${job.id}: recovered unbatched VM Remux job -> '${hasStaged ? "staged" : "queued"}'`);
          }
        }
      }
    } catch (err: any) {
      log.warn("PipelineEngine", `reconcileStuckEncodingStates warning: ${err?.message || err}`);
    } finally {
      this.isReconcilingEncoding = false;
    }

    return { reconciledJobs, failedBatches, completedBatches, details };
  }

  /**
   * Inspects the local SSD staging folder (`getKiraStagingDir()`) and cross-references every file on disk
   * with the jobs in `pipeline_encoding_job` so the operator can see exactly where staged files are stored,
   * which job/episode/quality owns each file, and whether any orphaned files exist on disk.
   */
  public static async inspectStagedFilesOnDisk(): Promise<StorageInspectionReport> {
    const stagingDir = getKiraStagingDir();
    const downloadDir = DEFAULT_DOWNLOAD_DIR;
    const files: StagedFileDiskEntry[] = [];
    let totalDiskBytes = 0;
    let orphanCount = 0;
    let orphanBytes = 0;

    let freeDiskBytes = Number.MAX_SAFE_INTEGER;
    try {
      const statFs = fs.statfsSync(stagingDir);
      freeDiskBytes = Number(statFs.bavail) * Number(statFs.bsize);
    } catch {}

    // Map known staged file paths to jobs in DB
    const pathToJobInfo = new Map<
      string,
      {
        jobId: number;
        anilistId: number | null;
        animeTitle: string | null;
        episodeNumber: number;
        quality: VideoResolutionQuality | null;
        pipelineType: PipelineExecutionType;
        jobStatus: string;
      }
    >();
    const jobIdsWithKnownPaths = new Set<number>();
    const jobById = new Map<
      number,
      {
        jobId: number;
        anilistId: number | null;
        animeTitle: string | null;
        episodeNumber: number;
        pipelineType: PipelineExecutionType;
        jobStatus: string;
      }
    >();

    if (DATABASE_URL) {
      try {
        await this.ensureTables();
        const allJobs = await db
          .select({
            id: schema.pipelineJob.id,
            anilistId: schema.pipelineJob.anilistId,
            episodeNumber: schema.pipelineJob.episodeNumber,
            status: schema.pipelineJob.status,
            pipelineType: schema.pipelineJob.pipelineType,
            stagedFilePath: schema.pipelineJob.stagedFilePath,
            stagedQualities: schema.pipelineJob.stagedQualities,
            metadata: schema.pipelineJob.metadata,
          })
          .from(schema.pipelineJob);

        for (const j of allJobs) {
          const pType: PipelineExecutionType = this.isJobVmRemux(j) ? "vm_remux" : "kaggle_gpu";
          const title = (j.metadata as any)?.primaryTitle || null;
          jobById.set(j.id, {
            jobId: j.id,
            anilistId: j.anilistId,
            animeTitle: title,
            episodeNumber: j.episodeNumber,
            pipelineType: pType,
            jobStatus: j.status,
          });

          if (j.stagedFilePath) {
            jobIdsWithKnownPaths.add(j.id);
            pathToJobInfo.set(path.resolve(j.stagedFilePath), {
              jobId: j.id,
              anilistId: j.anilistId,
              animeTitle: title,
              episodeNumber: j.episodeNumber,
              quality: "1080p",
              pipelineType: pType,
              jobStatus: j.status,
            });
          }

          const sq = (j.stagedQualities || (j.metadata as any)?.stagedQualities) as
            | Partial<Record<VideoResolutionQuality, string>>
            | undefined;
          if (sq && typeof sq === "object") {
            for (const [qKey, qPath] of Object.entries(sq)) {
              if (typeof qPath === "string" && qPath.trim()) {
                jobIdsWithKnownPaths.add(j.id);
                pathToJobInfo.set(path.resolve(qPath), {
                  jobId: j.id,
                  anilistId: j.anilistId,
                  animeTitle: title,
                  episodeNumber: j.episodeNumber,
                  quality: qKey as VideoResolutionQuality,
                  pipelineType: pType,
                  jobStatus: j.status,
                });
              }
            }
          }
        }
      } catch {
        throw new Error("Cannot verify staged file ownership while the database is unavailable. Cleanup is disabled.");
      }
    }

    try {
      if (fs.existsSync(stagingDir)) {
        const entries = fs.readdirSync(stagingDir, { withFileTypes: true });
        for (const entry of entries) {
          if (entry.name === ".pipeline-policy.json") continue;
          const fullPath = path.resolve(stagingDir, entry.name);
          try {
            let sizeBytes = 0;
            const stat = fs.statSync(fullPath);
            if (entry.isFile()) {
              sizeBytes = stat.size;
            } else if (entry.isDirectory()) {
              const subEntries = fs.readdirSync(fullPath, { withFileTypes: true });
              for (const sub of subEntries) {
                if (sub.isFile()) {
                  sizeBytes += fs.statSync(path.join(fullPath, sub.name)).size;
                }
              }
            }

            totalDiskBytes += sizeBytes;

            const exactPathMatched = pathToJobInfo.get(fullPath) || null;
            let matched = exactPathMatched;
            let inferredQuality: VideoResolutionQuality | null = matched?.quality || null;
            let isActiveTempWorkDir = false;

            if (!matched) {
              // Try inferring Job ID from filename/dir pattern: job_123_ep1_1080p_..., staged_123_1080p_..., vm_remux_123_..., vm_remux_job_123_...
              const m = entry.name.match(
                /^(?:job|staged|vm_remux(?:_job)?)_(\d+)(?:_ep(\d+))?(?:_(1080p|720p|480p))?/i,
              );
              if (m) {
                const parsedJobId = parseInt(m[1], 10);
                if (m[3]) {
                  inferredQuality = m[3].toLowerCase() as VideoResolutionQuality;
                }
                const jInfo = jobById.get(parsedJobId);
                if (jInfo) {
                  matched = {
                    ...jInfo,
                    quality: inferredQuality,
                  };
                }
                if (
                  entry.isDirectory() &&
                  /^vm_remux_/i.test(entry.name) &&
                  (this.activeVmRemuxJobIds.has(parsedJobId) ||
                    ["encoding", "staged", "failed"].includes(jInfo?.jobStatus || ""))
                ) {
                  isActiveTempWorkDir = true;
                }
              } else if (entry.isDirectory() && /^subs_[a-f0-9]+$/i.test(entry.name)) {
                // Keep in-flight subtitle extraction temp directories for 15 minutes
                const ageMs = Date.now() - stat.mtime.getTime();
                if (ageMs < 15 * 60 * 1000 || this.activeDiscoveringJobIds.size > 0) {
                  isActiveTempWorkDir = true;
                }
              }
            }

            // A file is active (not orphan) ONLY if:
            // - It is an active temp workDir (vm_remux_<id>_* for an active encoding job, or recent subs_*), OR
            // - Its exact path is currently linked in DB to a downloading/staged/encoding job, OR
            // - DB wasn't queried and its filename belongs to an active job.
            // Any superseded duplicate file (same jobId, not in pathToJobInfo) IS marked orphan so cleanup frees it.
            const hasActiveDbStatus = Boolean(
              matched && ["downloading", "staged", "encoding", "failed"].includes(matched.jobStatus),
            );
            const isSupersededDuplicate =
              !exactPathMatched &&
              !entry.isDirectory() &&
              Boolean(matched) &&
              jobIdsWithKnownPaths.has(matched!.jobId);

            const isActiveOwner =
              isActiveTempWorkDir || (hasActiveDbStatus && !isSupersededDuplicate);
            const isOrphan = !isActiveOwner;

            if (isOrphan) {
              orphanCount++;
              orphanBytes += sizeBytes;
            }

            files.push({
              filename: entry.name,
              fullPath,
              sizeBytes,
              modifiedAt: stat.mtime.toISOString(),
              isDirectory: entry.isDirectory(),
              jobId: matched?.jobId ?? null,
              anilistId: matched?.anilistId ?? null,
              animeTitle: matched?.animeTitle ?? null,
              episodeNumber: matched?.episodeNumber ?? null,
              quality: matched?.quality ?? inferredQuality,
              pipelineType: matched?.pipelineType ?? null,
              jobStatus: matched?.jobStatus ?? null,
              isOrphan,
            });
          } catch {}
        }
      }
    } catch {}

    files.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    return {
      stagingDir,
      downloadDir,
      totalDiskBytes,
      maxStagingBytes: KIRA_MAX_STAGING_BYTES,
      freeDiskBytes: freeDiskBytes === Number.MAX_SAFE_INTEGER ? 0 : freeDiskBytes,
      fileCount: files.length,
      orphanCount,
      orphanBytes,
      files,
    };
  }

  /**
   * Deletes all orphaned files and temporary folders in `getKiraStagingDir()` that do not belong
   * to any currently active (`downloading`, `staged`, or `encoding`) job.
   */
  public static async cleanupOrphanedStagedFiles(): Promise<{
    deletedCount: number;
    freedBytes: number;
    requeuedMissingJobs: number;
  }> {
    if (!DATABASE_URL) throw new Error("Database connection is required before orphan cleanup.");
    const report = await this.inspectStagedFilesOnDisk();
    let deletedCount = 0;
    let freedBytes = 0;
    let requeuedMissingJobs = 0;

    for (const file of report.files) {
      if (file.isOrphan && Date.now() - new Date(file.modifiedAt).getTime() > 10 * 60_000) {
        try {
          await fs.promises.rm(file.fullPath, { recursive: true, force: true });
          deletedCount++;
          freedBytes += file.sizeBytes;
        } catch {}
      }
    }

    if (DATABASE_URL) {
      try {
        await this.ensureTables();
        const stagedJobs = await db
          .select()
          .from(schema.pipelineJob)
          .where(eq(schema.pipelineJob.status, "staged"));

        for (const j of stagedJobs) {
          if (!this.hasValidStagedFiles(j)) {
            await db
              .update(schema.pipelineJob)
              .set({
                status: "queued",
                batchId: null,
                stagedFilePath: null,
                lastError: "Staged file missing on disk; re-queued for torrent discovery",
                updatedAt: new Date(),
              })
              .where(eq(schema.pipelineJob.id, j.id));
            requeuedMissingJobs++;
          }
        }
      } catch {}
    }

    if (deletedCount > 0) {
      setImmediate(() => {
        this.onStagingSpaceFreed().catch(() => {});
      });
    }

    return { deletedCount, freedBytes, requeuedMissingJobs };
  }

  public static async executeBatch(batchId: number): Promise<void> {
    if (this.activeExecutingBatchIds.has(batchId)) {
      return;
    }
    await this.ensureTables();
    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch || batch.status === "completed") return;

    if (this.isBatchVmRemux(batch)) {
      try {
        await this.executeVmRemuxBatch(batchId);
      } catch (err: any) {
        await this.handleBatchFailure(batchId, err?.message || String(err));
        throw err;
      }
      return;
    }

    try {
      const prep = await this.prepareAndUploadBatchDataset(batchId);
      if (prep.empty) return;

      await this.waitBatchDatasetReady(batchId);
      await this.pushBatchKernel(batchId);

      const kernelStartTime = Date.now();
      while (Date.now() - kernelStartTime < 6 * 3600 * 1000) {
        // Gentle 75s kernel status polling interval to prevent Kaggle HTTP 429 rate limits
        await new Promise((r) => setTimeout(r, 75_000));
        const progress = await this.checkBatchKernelProgress(batchId);
        if (progress.state === "completed") {
          await this.finalizeCompletedBatch(batchId);
          return;
        }
        if (progress.state === "failed") {
          throw new Error(progress.errorDetail || `Kernel failed with status ${progress.rawStatus}`);
        }
      }
      throw new Error("Kaggle kernel timed out after 6 hours");
    } catch (err: any) {
      await this.handleBatchFailure(batchId, err?.message || String(err));
      throw err;
    }
  }

  public static async retryJobCallback(id: number, force = false): Promise<boolean> {
    const job = await db.query.pipelineJob.findFirst({
      where: and(eq(schema.pipelineJob.id, id), eq(schema.pipelineJob.status, "completed")),
    });
    const result = job?.resultPayload as PipelineEpisodeResult | null;
    if (!job || !result || (!force && job.metadata?.callbackDelivered !== false)) return false;

    const metadata = job.metadata ?? {};
    const attempts = Number(metadata.callbackAttempts ?? 0);
    const now = new Date();
    if (!force && job.callbackAfter && job.callbackAfter > now) return false;
    const delay = CALLBACK_DELAYS_MS[Math.min(attempts, CALLBACK_DELAYS_MS.length - 1)];
    const nextAttempt = new Date(now.getTime() + delay);
    const [claimed] = await db.update(schema.pipelineJob).set({
      callbackAfter: nextAttempt,
      metadata: { ...metadata, callbackDelivered: false, callbackAttempts: attempts + 1, callbackLastAttemptAt: now.toISOString() },
    }).where(and(
      eq(schema.pipelineJob.id, id),
      eq(schema.pipelineJob.status, "completed"),
      job.callbackAfter ? eq(schema.pipelineJob.callbackAfter, job.callbackAfter) : isNull(schema.pipelineJob.callbackAfter),
    )).returning({ id: schema.pipelineJob.id });
    if (!claimed) return false;

    const payloads = result.allTrackPayloads ?? [result];
    const deliveredTypes = new Set<string>(force ? [] : metadata.callbackDeliveredTypes ?? []);
    for (const { allTrackPayloads: _unused, metadata: legacyMetadata, ...payload } of payloads) {
      if (!deliveredTypes.has(payload.type) && await this.deliverCallbackPayload({
        ...payload,
        animeId: payload.animeId ?? legacyMetadata?.animeId,
      })) deliveredTypes.add(payload.type);
    }

    const delivered = payloads.every(payload => deliveredTypes.has(payload.type));
    const backfillTracks = new Set<string>(metadata.qualityBackfillTracks ?? []);
    const backfills: (typeof schema.pipelineJob.$inferInsert)[] = [];
    const isEligibleForBackfill =
      !metadata.kind || metadata.kind === "release" || metadata.kind === "stream_refresh";
    if (isEligibleForBackfill && this.isJobVmRemux(job) && job.qualitiesPayload?.["1080p"] &&
        !ReleaseFilter.hasWatermarkedSource(job.torrentTitle)) {
      for (const payload of payloads) {
        if (!deliveredTypes.has(payload.type) || backfillTracks.has(payload.type)) continue;
        const source = payload.sources.find(source => source.quality === "1080p");
        const sourceUrl = source?.downloadUrl || source?.url;
        if (!source || !sourceUrl) continue;
        const missing = missingBackfillQualities(payload.sources);
        if (missing.length > 0) {
          backfills.push({
            animeId: job.animeId, anilistId: job.anilistId, anidbId: job.anidbId,
            episodeNumber: job.episodeNumber, types: [payload.type], knownTitles: job.knownTitles,
            releaseGroup: job.releaseGroup,
            pipelineType: "kaggle_gpu",
            qualityCount: missing.length,
            discoverAfter: null,
            metadata: {
              kind: "quality_backfill",
              targetQualities: missing,
              targetQuality: missing[0],
              processingMode: "kaggle_gpu",
              sourceJobId: job.id, sourceUrl,
              sourceTorrentTitle: job.torrentTitle, sourceEffectiveEp: job.qualitiesPayload?.["1080p"]?.effectiveEp,
              sourceDurationSeconds: job.qualitiesPayload?.["1080p"]?.durationSeconds,
              sourceSha256: source.sha256, sourceSizeBytes: source.sizeBytes,
              totalEpisodes: metadata.totalEpisodes, tsukihimeId: metadata.tsukihimeId, malId: metadata.malId,
              ...(metadata.manualTsukihimeTorrentId ? { manualTsukihimeTorrentId: metadata.manualTsukihimeTorrentId } : {}),
            },
          });
        }
        backfillTracks.add(payload.type);
      }
    }

    // Record callback delivery and enqueue its backfills together. A lost callback lease cannot enqueue duplicates.
    const insertedBackfills: { id: number; animeId: number | null; anilistId: number | null; anidbId: number | null; episodeNumber: number; types: ("sub" | "dub")[] }[] = [];
    const committed = await db.transaction(async tx => {
      const [updated] = await tx.update(schema.pipelineJob).set({
        callbackAfter: delivered ? null : nextAttempt,
        metadata: {
          ...metadata,
          callbackAttempts: attempts + 1,
          callbackLastAttemptAt: now.toISOString(),
          callbackDeliveredTypes: [...deliveredTypes],
          callbackDelivered: delivered,
          ...(delivered ? { callbackDeliveredAt: new Date().toISOString() } : {}),
          ...(backfillTracks.size ? { qualityBackfillTracks: [...backfillTracks] } : {}),
        },
      }).where(and(eq(schema.pipelineJob.id, id), eq(schema.pipelineJob.status, "completed"),
        eq(schema.pipelineJob.callbackAfter, nextAttempt))).returning({ id: schema.pipelineJob.id });
      if (!updated) return false;
      if (backfills.length) {
        const rows = await tx.insert(schema.pipelineJob).values(backfills).returning({
          id: schema.pipelineJob.id,
          animeId: schema.pipelineJob.animeId,
          anilistId: schema.pipelineJob.anilistId,
          anidbId: schema.pipelineJob.anidbId,
          episodeNumber: schema.pipelineJob.episodeNumber,
          types: schema.pipelineJob.types,
        });
        insertedBackfills.push(...rows);
      }
      return true;
    });
    if (committed && insertedBackfills.length) {
      log.info("PipelineEngine", `[Job #${id}] Queued ${insertedBackfills.length} direct GPU backfill job(s) for missing lower qualities`);
      await inngest.send(insertedBackfills.map(bf => discoveryEvent(bf, "discover"))).catch(() => {});
    }
    return committed && delivered;
  }

  public static async retryPendingCallbacks(): Promise<number> {
    if (!INTERNAL_SECRET) return 0;
    await this.ensureTables();
    const pending = await db.select({ id: schema.pipelineJob.id }).from(schema.pipelineJob).where(and(
      eq(schema.pipelineJob.status, "completed"),
      sql`${schema.pipelineJob.metadata}->>'callbackDelivered' = 'false'`,
      isNotNull(schema.pipelineJob.resultPayload),
      or(isNull(schema.pipelineJob.callbackAfter), lte(schema.pipelineJob.callbackAfter, new Date())),
    )).orderBy(sql`${schema.pipelineJob.callbackAfter} asc nulls first`, asc(schema.pipelineJob.id)).limit(8);

    let delivered = 0;
    for (const { id } of pending) {
      if (await this.retryJobCallback(id)) delivered++;
    }
    return delivered;
  }

  public static async getStats(): Promise<PipelineStats> {
    await this.ensureTables();

    // Throttled background reconciliation (every 12s) so jobs whose batch failed/completed never stay stuck in 'encoding'
    if (Date.now() - lastQuickReconcileAt > 12_000) {
      lastQuickReconcileAt = Date.now();
      setImmediate(() => {
        this.reconcileStuckEncodingStates({ liveKaggleCheck: false }).catch(() => {});
      });
    }

    let activeBatchRows: (typeof schema.pipelineBatch.$inferSelect)[] = [];
    let activeUnbatchedVmJobs: (typeof schema.pipelineJob.$inferSelect)[] = [];
    let counts: { status: string; count: number }[] = [];
    let windowStats: {
      stagedCount: number;
      stagedRemuxCount: number;
      stagedGpuCount: number;
      totalBytes: number;
    } = {
      stagedCount: 0,
      stagedRemuxCount: 0,
      stagedGpuCount: 0,
      totalBytes: 0,
    };

    try {
      activeBatchRows = await db
        .select()
        .from(schema.pipelineBatch)
        .where(inArray(schema.pipelineBatch.status, ["created", "uploading", "waiting_dataset", "kernel_running"]))
        .orderBy(asc(schema.pipelineBatch.id));

      activeUnbatchedVmJobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(
          and(
            eq(schema.pipelineJob.status, "encoding"),
            isNull(schema.pipelineJob.batchId),
          ),
        )
        .orderBy(asc(schema.pipelineJob.id));

      counts = await db
        .select({
          status: schema.pipelineJob.status,
          count: sql<number>`count(*)`,
        })
        .from(schema.pipelineJob)
        .groupBy(schema.pipelineJob.status);

      windowStats = await this.getStagedWindowStats();
    } catch {
      // PostgreSQL not connected in standalone UI preview; return zeroed DB counters gracefully
    }

    const activeBatches = activeBatchRows.map((row) => {
      const mode: PipelineExecutionType = this.isBatchVmRemux(row) ? "vm_remux" : "kaggle_gpu";
      return {
        id: row.id,
        status: row.status,
        pipelineType: mode,
        mode,
        kaggleUsername: row.kaggleUsername,
        datasetSlug: row.datasetSlug,
        kernelSlug: row.kernelSlug,
        jobCount: row.jobCount,
        totalBytes: Number(row.totalBytes || 0),
        elapsedSeconds: row.startedAt
          ? Math.floor((Date.now() - row.startedAt.getTime()) / 1000)
          : 0,
        heartbeatAt: row.heartbeatAt.toISOString(),
        lastError: row.lastError,
      };
    });

    // Include active 2-at-a-time VM Remux jobs (which run without batching) in live activeBatches telemetry
    for (const vmJob of activeUnbatchedVmJobs) {
      if (this.isJobVmRemux(vmJob)) {
        activeBatches.push({
          id: vmJob.id,
          status: "kernel_running",
          pipelineType: "vm_remux",
          mode: "vm_remux",
          kaggleUsername: "local-vm",
          datasetSlug: vmJob.releaseGroup || "vm-direct-remux",
          kernelSlug: `Job #${vmJob.id} • Ep ${vmJob.episodeNumber} (${vmJob.qualityCount || 1}Q -c:v copy)`,
          jobCount: 1,
          totalBytes: Number(vmJob.sizeBytes || 0),
          elapsedSeconds: vmJob.stagedAt
            ? Math.max(1, Math.floor((Date.now() - vmJob.stagedAt.getTime()) / 1000))
            : 1,
          heartbeatAt: vmJob.heartbeatAt.toISOString(),
          lastError: vmJob.lastError || null,
        });
      }
    }

    const vmActiveCount = Math.max(
      this.activeVmRemuxJobIds.size,
      activeUnbatchedVmJobs.filter((j) => this.isJobVmRemux(j)).length,
      activeBatches.filter((b) => b.mode === "vm_remux").length,
    );
    const gpuActiveBatches = activeBatches.filter((b) => b.mode === "kaggle_gpu");

    const queueMap: Record<string, number> = {};
    let total = 0;
    for (const c of counts) {
      const n = Number(c.count || 0);
      queueMap[c.status] = n;
      total += n;
    }

    const { kaggleAccounts, hfAccounts } = loadAccountsFromEnv();

    const kaggleAccountStatus = kaggleAccounts.map((a) => {
      const activeTasks = activeBatchRows.filter((b) => b.kaggleUsername === a.username).length;
      return {
        username: a.username,
        activeTasks,
        maxTasks: KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT,
        isBusy: activeTasks >= KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT,
        slots: [activeTasks >= 1, activeTasks >= 2] as [boolean, boolean],
      };
    });

    const maxConcurrentBatches = Math.max(2, kaggleAccounts.length * KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT);
    const effectiveStagedBytes = Math.max(windowStats.totalBytes, this.getActualStagingDiskBytes());
    const policy = this.getExecutionPolicy();

    return {
      executionPolicy: policy,
      activeBatch: activeBatches[0] || null,
      activeBatches,
      concurrency: {
        active: gpuActiveBatches.length,
        max: maxConcurrentBatches,
        accountsCount: kaggleAccounts.length,
        maxPerAccount: KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT,
        vmActive: Math.min(KIRA_VM_MAX_CONCURRENT_BATCHES, vmActiveCount),
        vmMax: KIRA_VM_MAX_CONCURRENT_BATCHES,
        discoveryConcurrency: KIRA_DISCOVERY_CONCURRENCY,
      },
      queue: {
        queued: queueMap["queued"] || 0,
        downloading: queueMap["downloading"] || 0,
        staged: queueMap["staged"] || 0,
        stagedRemux: windowStats.stagedRemuxCount,
        stagedGpu: windowStats.stagedGpuCount,
        encoding: queueMap["encoding"] || 0,
        completed: queueMap["completed"] || 0,
        failed: queueMap["failed"] || 0,
        paused: queueMap["paused"] || 0,
        skipped: queueMap["skipped"] || 0,
        total,
      },
      storage: {
        stagedBytes: effectiveStagedBytes,
        stagedCount: windowStats.stagedCount,
        maxBatchItems: KIRA_BATCH_MAX_ITEMS,
        maxStagingBytes: KIRA_MAX_STAGING_BYTES,
        minFreeBytes: KIRA_MIN_FREE_SSD_BYTES,
        stagingDir: getKiraStagingDir(),
        downloadDir: DEFAULT_DOWNLOAD_DIR,
        isAtCapacity: effectiveStagedBytes >= KIRA_MAX_STAGING_BYTES,
      },
      accounts: {
        kaggle: kaggleAccountStatus,
        huggingFace: hfAccounts.map((h) => ({
          owner: h.owner,
          bucket: h.bucket,
        })),
      },
      engine: {
        isRunning: true,
        isPaused: false,
        uptimeSeconds: Math.floor(process.uptime()),
        lastWatchdogRun: lastWatchdogTimestamp,
        executionPolicy: policy,
      },
    };
  }
}

