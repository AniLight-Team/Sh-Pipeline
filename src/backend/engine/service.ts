import fs from "fs";
import path from "path";
import crypto from "crypto";
import PQueue from "p-queue";
import { db, schema } from "../db/index.js";
import { eq, and, inArray, isNull, asc, sql } from "drizzle-orm";
import { TransmissionClient } from "./transmission.client.js";
import { SubtitleManager, inspectMkvStreamsSync } from "./subtitles.manager.js";
import { VideoEncodingManager } from "./video.manager.js";
import { AnimeToshoClient, type FetchTorrentsOptions } from "./animetosho.client.js";
import { TsukihimeClient } from "./tsukihime.client.js";
import { ReleaseFilter } from "./release-filter.js";
import { AnimeMetadataResolver } from "./metadata-resolver.js";
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
import { notifyMainBackendRevalidate } from "../utils/notifier.js";
import { inngest } from "../inngest/client.js";
import type {
  AnimeToshoItem,
  CandidateSelectionTier,
  EnqueueRequest,
  EnqueueResponse,
  PipelineEpisodeResult,
  PipelineExecutionType,
  PipelineStats,
  KiraBatchManifestItem,
  KiraBatchUploadItem,
  KiraBatchHfRecord,
  R2SubtitleRecord,
  ReleaseCandidateBundle,
  VideoResolutionQuality,
} from "./types.js";
import { log } from "../utils/logger.js";

let tablesInitialized = false;
let lastWatchdogTimestamp: string | null = new Date().toISOString();

// Dedicated VM direct-remux concurrency limiter (Pipeline 1: H.264 -c:v copy)
const vmRemuxQueue = new PQueue({ concurrency: KIRA_VM_MAX_CONCURRENT_BATCHES });

// High-concurrency Stage 1 discovery & download queue for standalone fallback execution
export const stage1DiscoveryQueue = new PQueue({ concurrency: KIRA_DISCOVERY_CONCURRENCY });

export class PipelineEngineService {
  public static readonly stage1DiscoveryQueue = stage1DiscoveryQueue;
  private static readonly activeVmRemuxJobIds = new Set<number>();
  private static readonly activeExecutingBatchIds = new Set<number>();
  private static isDrainingVmRemux = false;

  public static isBatchCurrentlyExecutingInProcess(batchId: number): boolean {
    return this.activeExecutingBatchIds.has(batchId);
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
    const reservedBytes = activeDownloadingCount * KIRA_PER_DOWNLOAD_RESERVE_BYTES;
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
    stagedFilePath?: string | null;
    stagedQualities?: Partial<Record<VideoResolutionQuality, string>> | null;
    metadata?: Record<string, any> | null;
  }): Promise<void> {
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
   * Checks if all staged files required by a job exist on disk.
   */
  public static hasValidStagedFiles(job: {
    stagedFilePath?: string | null;
    stagedQualities?: Partial<Record<VideoResolutionQuality, string>> | null;
    metadata?: Record<string, any> | null;
  }): boolean {
    if (!job.stagedFilePath || !fs.existsSync(job.stagedFilePath)) {
      return false;
    }
    const sq = job.stagedQualities || job.metadata?.stagedQualities;
    if (sq && typeof sq === "object") {
      const paths = Object.values(sq).filter((p): p is string => typeof p === "string" && p.length > 0);
      if (paths.length > 0 && !paths.some((p) => fs.existsSync(p))) {
        return false;
      }
    }
    return true;
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
      knownTitles = [],
      metadata = {},
      callbackUrl,
    } = req;

    if (!anilistId && metadata?.anilistId) {
      const parsed = Number(metadata.anilistId);
      if (!isNaN(parsed) && parsed > 0) anilistId = parsed;
    }
    if (!animeId && metadata?.animeId) {
      const parsed = Number(metadata.animeId);
      if (!isNaN(parsed) && parsed > 0) animeId = parsed;
    }

    const effectiveCallbackUrl =
      callbackUrl || `${MAIN_BACKEND_URL}/api/internal/pipeline/completed`;

    if (anilistId) {
      try {
        const resolved = await AnimeMetadataResolver.resolve(anilistId);
        if (resolved) {
          if (!anidbId && resolved.anidbId) {
            anidbId = resolved.anidbId;
          }
          if (!animeId && resolved.animeId) {
            animeId = resolved.animeId;
          }
          if (resolved.synonyms && resolved.synonyms.length > 0) {
            knownTitles = Array.from(new Set([...knownTitles, ...resolved.synonyms]));
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

    const normalizedTypes = Array.from(new Set(types.filter((t) => t === "sub" || t === "dub"))) as ("sub" | "dub")[];
    if (normalizedTypes.length === 0) {
      normalizedTypes.push("sub");
    }

    const queuedJobs: EnqueueResponse["queuedJobs"] = [];
    let skippedExisting = 0;

    for (const ep of episodeNumbers) {
      const conditions = [
        eq(schema.pipelineJob.episodeNumber, ep),
        inArray(schema.pipelineJob.status, ["queued", "downloading", "staged", "encoding"]),
      ];

      if (anilistId) {
        conditions.push(eq(schema.pipelineJob.anilistId, anilistId));
      } else if (anidbId) {
        conditions.push(eq(schema.pipelineJob.anidbId, anidbId));
      } else if (animeId) {
        conditions.push(eq(schema.pipelineJob.animeId, animeId));
      }

      const existing = await db.query.pipelineJob.findFirst({
        where: and(...conditions),
      });

      if (existing) {
        const existingTypes = Array.isArray(existing.types) ? existing.types : ["sub"];
        const mergedTypes = Array.from(new Set([...existingTypes, ...normalizedTypes])) as ("sub" | "dub")[];
        if (existing.status === "queued" && mergedTypes.length > existingTypes.length) {
          await db
            .update(schema.pipelineJob)
            .set({
              types: mergedTypes,
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, existing.id));
        }
        skippedExisting++;
        continue;
      }

      const [inserted] = await db
        .insert(schema.pipelineJob)
        .values({
          anilistId: anilistId || null,
          animeId: animeId || null,
          anidbId: anidbId || null,
          episodeNumber: ep,
          types: normalizedTypes,
          status: "queued",
          pipelineType: "vm_remux",
          knownTitles,
          metadata: {
            ...metadata,
            animeId: animeId || null,
            anilistId: anilistId || null,
          },
          callbackUrl: effectiveCallbackUrl,
          heartbeatAt: new Date(),
        })
        .returning();

      queuedJobs.push({
        id: inserted.id,
        anilistId: inserted.anilistId,
        animeId: inserted.animeId,
        anidbId: inserted.anidbId,
        episodeNumber: inserted.episodeNumber,
        types: inserted.types,
      });

      log.info(
        "PipelineEngine",
        `Enqueued Job #${inserted.id} -> AniList: ${anilistId || "n/a"} | AnimeId: ${animeId || "n/a"} | AniDB: ${anidbId || "n/a"} Ep ${ep} (${normalizedTypes.join("/")})`,
      );
    }

    return { queuedJobs, skippedExisting };
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
  private static async downloadCandidateEpisodeToStaging(params: {
    jobId: number;
    episodeNumber: number;
    knownTitles: string[];
    candidate: AnimeToshoItem;
    effectiveEp: number | string;
    qualityTag: VideoResolutionQuality;
    transmission: TransmissionClient;
    stagingDir: string;
    enforceHardCapBeforeStart: boolean;
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

    const magnetUri =
      candidate.magnet_uri ||
      (candidate.info_hash ? `magnet:?xt=urn:btih:${candidate.info_hash}` : "") ||
      candidate.torrent_url;
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
        false,
        magnetUri || undefined,
      );
      tId = tInfo.id;

      const metaStatus = await transmission.waitForMetadata(tId);
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
      });

      if (!epMap.has(episodeNumber)) {
        await transmission.releaseTorrentClaim(tId, undefined, true, false).catch(() => {});
        tId = null;
        throw new TorrentEntryNotFoundException(
          `Ep ${episodeNumber} could not be selectively isolated in torrent '${candidate.title}' (${tFiles.length} files)`,
        );
      }

      const [wantedIdx, relPath] = epMap.get(episodeNumber)!;
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

      if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size <= 1024) {
        throw new Error(`Downloaded video file missing or empty on disk: ${fullPath}`);
      }

      const ext = path.extname(fullPath) || ".mkv";
      const stagedFilename = `staged_${jobId}_${qualityTag}_${crypto.randomUUID().slice(0, 8)}${ext}`;
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
   * 2. Discovers all candidate torrents across Tsukihime & AnimeTosho in parallel.
   * 3. Evaluates the 3-Tier Deterministic Waterfall (always preferring Solo releases over Batch packs):
   *    - Tier 1 (`h264_multi` -> Pipeline 1 `vm_remux`): 1080p H.264 group that ALSO has 720p and/or 480p from the same group.
   *      If the first 1080p H.264 group lacks 720p/480p, goes back to 1080p candidates to pick another H.264 group that has them.
   *    - Tier 2 (`h264_single_1080p` -> Pipeline 1 `vm_remux`, 1 quality only): If no H.264 group has lower qualities,
   *      picks the best 1080p H.264 release and ONLY processes 1 quality (1080p).
   *    - Tier 3 (`hevc_av1_gpu` -> Pipeline 2 `kaggle_gpu`): If no H.264 release exists at all, picks the best 1080p HEVC/AV1
   *      release and routes to the Kaggle GPU batch pipeline.
   * 4. Extracts & uploads subtitles to Cloudflare R2 strictly from the 1080p version.
   * 5. For Tier 1 (`h264_multi`), downloads same-group 720p & 480p in parallel!
   */
  public static async discoverAndStageJob(jobId: number): Promise<{
    status: "staged" | "download_paused" | "failed";
    jobId: number;
    pipelineType?: PipelineExecutionType;
    selectionTier?: CandidateSelectionTier;
    sizeBytes?: number;
    error?: string;
  }> {
    await this.ensureTables();

    const job = await db.query.pipelineJob.findFirst({
      where: eq(schema.pipelineJob.id, jobId),
    });

    if (!job) {
      return { status: "failed", jobId, error: "Job not found" };
    }

    if (job.status === "completed" || job.status === "encoding") {
      return {
        status: "staged",
        jobId,
        pipelineType: this.isJobVmRemux(job) ? "vm_remux" : "kaggle_gpu",
        sizeBytes: job.sizeBytes || 0,
      };
    }

    if (job.status === "staged" && this.hasValidStagedFiles(job)) {
      if (this.isJobVmRemux(job)) {
        setImmediate(() => {
          this.drainVmRemuxQueue().catch(() => {});
        });
      }
      return {
        status: "staged",
        jobId,
        pipelineType: this.isJobVmRemux(job) ? "vm_remux" : "kaggle_gpu",
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
        .where(eq(schema.pipelineJob.id, jobId));

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

    await db
      .update(schema.pipelineJob)
      .set({ status: "downloading", heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.pipelineJob.id, jobId));

    const transmission = new TransmissionClient();
    const subtitles = new SubtitleManager();
    const videoManager = new VideoEncodingManager();
    const stagingDir = getKiraStagingDir();

    const heartbeatInterval = setInterval(() => {
      db.update(schema.pipelineJob)
        .set({ heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.pipelineJob.id, jobId))
        .catch(() => {});
    }, 30_000);

    try {
      log.info(
        "PipelineEngine",
        `[Stage 1 Discovery] Job #${job.id} (AniList ${job.anilistId || "n/a"} | AniDB ${job.anidbId || "n/a"} Ep ${job.episodeNumber} [${job.types.join("/")}])...`,
      );

      const wantsDub = job.types.includes("dub");
      const wantsSub = job.types.includes("sub");
      const isDubOnly = wantsDub && !wantsSub;
      const isSubOnly = wantsSub && !wantsDub;
      const langTypeForSearch = isDubOnly ? "dub" : isSubOnly ? "sub" : "all";
      let totalExpectedEps =
        typeof job.metadata?.totalEpisodes === "number" && job.metadata.totalEpisodes > 0
          ? job.metadata.totalEpisodes
          : null;
      const effectiveKnownTitles = Array.from(new Set([...(job.knownTitles || [])]));

      const torrentByKey = new Map<string | number, AnimeToshoItem>();
      const allTorrents: AnimeToshoItem[] = [];
      const mergeTorrents = (items: AnimeToshoItem[]) => {
        for (const item of items) {
          const hashKey = item.info_hash ? item.info_hash.toLowerCase().trim() : null;
          const key = hashKey || item.id || item.title;
          if (!key) continue;

          const existing = torrentByKey.get(key);
          if (!existing) {
            torrentByKey.set(key, item);
            allTorrents.push(item);
          } else {
            if (item.tsukihime_id && !existing.tsukihime_id) existing.tsukihime_id = item.tsukihime_id;
            if (typeof item.tsukihime_episode_no === "number" && existing.tsukihime_episode_no == null) {
              existing.tsukihime_episode_no = item.tsukihime_episode_no;
            }
            if (Array.isArray(item.audiolangs) && item.audiolangs.length > 0 && !existing.audiolangs?.length) {
              existing.audiolangs = item.audiolangs;
            }
            if (Array.isArray(item.sublangs) && item.sublangs.length > 0 && !existing.sublangs?.length) {
              existing.sublangs = item.sublangs;
            }
            if (item.group_name && !existing.group_name) existing.group_name = item.group_name;
            if (item.is_seadex) existing.is_seadex = true;
            if ((item.seeders || 0) > (existing.seeders || 0)) existing.seeders = item.seeders;
            if ((item.leechers || 0) > (existing.leechers || 0)) existing.leechers = item.leechers;
            if (item.torrent_url && !existing.torrent_url) existing.torrent_url = item.torrent_url;
          }
        }
      };

      const evaluateBundles = (): ReleaseCandidateBundle[] => {
        if (allTorrents.length === 0) return [];
        let bundles = ReleaseFilter.selectTopCandidateBundles(
          allTorrents,
          job.episodeNumber,
          langTypeForSearch,
          {
            knownTitles: effectiveKnownTitles,
            totalExpectedEps,
            maxBundles: 5,
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
              maxBundles: 5,
            },
          );
        }
        return bundles;
      };

      let topBundles: ReleaseCandidateBundle[] = [];

      // 1. Search Tsukihime API first (returns all resolutions 1080p/720p/480p for the episode)
      let tsukihimeAnidbId: number | null = null;
      try {
        const tsukiLookup = {
          tsukihimeId: job.metadata?.tsukihimeId ? Number(job.metadata.tsukihimeId) : null,
          anilistId: job.anilistId,
          malId: job.metadata?.malId ? Number(job.metadata.malId) : null,
          anidbId: job.anidbId,
        };
        const { anime: tsukiAnime, torrents: tsukiTorrents } = await TsukihimeClient.fetchTorrents(
          tsukiLookup,
          {
            targetEp: job.episodeNumber,
            langType: langTypeForSearch,
            knownTitles: effectiveKnownTitles,
            episodeCount: totalExpectedEps,
            maxPages: 4,
          },
        );
        if (tsukiAnime) {
          if (!totalExpectedEps && tsukiAnime.total_episodes && tsukiAnime.total_episodes > 0) {
            totalExpectedEps = tsukiAnime.total_episodes;
          }
          if (tsukiAnime.title && !effectiveKnownTitles.includes(tsukiAnime.title)) {
            effectiveKnownTitles.push(tsukiAnime.title);
          }
          if (tsukiAnime.english_title && !effectiveKnownTitles.includes(tsukiAnime.english_title)) {
            effectiveKnownTitles.push(tsukiAnime.english_title);
          }
          if (tsukiAnime.anidb && tsukiAnime.anidb > 0) {
            tsukihimeAnidbId = tsukiAnime.anidb;
          }
        }
        if (tsukiTorrents.length > 0) {
          mergeTorrents(tsukiTorrents);
          topBundles = evaluateBundles();
        }
      } catch (tsukiErr: any) {
        log.warn("PipelineEngine", `[Job #${job.id}] Tsukihime search warning: ${tsukiErr?.message || tsukiErr}`);
      }

      const opts: FetchTorrentsOptions = {
        targetEp: job.episodeNumber,
        langType: langTypeForSearch,
        knownTitles: effectiveKnownTitles,
        episodeCount: totalExpectedEps,
        maxPages: 6,
      };

      const searchByAnidbId = async (aid: number) => {
        const [allResItems, hdItems] = await Promise.all([
          AnimeToshoClient.fetchTorrents(aid, "", opts),
          AnimeToshoClient.fetchTorrents(aid, "1080p", opts),
        ]);
        mergeTorrents(allResItems);
        mergeTorrents(hdItems);
        topBundles = evaluateBundles();

        if (topBundles.length === 0 && wantsDub) {
          mergeTorrents(await AnimeToshoClient.fetchTorrents(aid, "dual-audio", opts));
          topBundles = evaluateBundles();
        }
        if (topBundles.length === 0 && wantsDub) {
          mergeTorrents(await AnimeToshoClient.fetchTorrents(aid, "dub", opts));
          topBundles = evaluateBundles();
        }
      };

      // 2. If Tsukihime didn't already give us a Solo Tier 1 (h264_multi) bundle, also query AnimeTosho so we find all 720p/480p siblings
      const hasSoloMultiQualityH264 = topBundles.some(
        (b) => b.selectionTier === "h264_multi" && b.isSolo,
      );
      if (job.anidbId && !hasSoloMultiQualityH264) {
        await searchByAnidbId(job.anidbId);
      }

      // 3. Search canonical AniDB ID if different
      const canonicalAnidb =
        tsukihimeAnidbId ||
        (topBundles.length === 0 && job.anilistId
          ? await AnimeMetadataResolver.resolveAnimapAnidbId(job.anilistId)
          : null);
      if (
        canonicalAnidb &&
        canonicalAnidb !== job.anidbId &&
        !topBundles.some((b) => b.selectionTier === "h264_multi" && b.isSolo)
      ) {
        log.info(
          "PipelineEngine",
          `[Job #${job.id}] Searching AnimeTosho via canonical AniDB #${canonicalAnidb} for AniList #${job.anilistId || "n/a"}...`,
        );
        await searchByAnidbId(canonicalAnidb);
      }

      // 4. Fallback: Search via known titles if ID searches yielded 0 viable candidates
      if (topBundles.length === 0 && effectiveKnownTitles.length > 0) {
        for (const title of effectiveKnownTitles) {
          if (!title || !title.trim()) continue;
          const clean = title.trim();
          log.info("PipelineEngine", `Searching AnimeTosho by title "${clean}" Ep ${job.episodeNumber}...`);
          const [allTitleItems, hdTitleItems] = await Promise.all([
            AnimeToshoClient.fetchTorrentsByTitle(clean, "", opts),
            AnimeToshoClient.fetchTorrentsByTitle(clean, "1080p", opts),
          ]);
          mergeTorrents(allTitleItems);
          mergeTorrents(hdTitleItems);
          topBundles = evaluateBundles();
          if (topBundles.length > 0) break;

          if (wantsDub) {
            mergeTorrents(await AnimeToshoClient.fetchTorrentsByTitle(clean, "dual-audio", opts));
            topBundles = evaluateBundles();
            if (topBundles.length > 0) break;

            mergeTorrents(await AnimeToshoClient.fetchTorrentsByTitle(clean, "dub", opts));
            topBundles = evaluateBundles();
            if (topBundles.length > 0) break;
          }
        }
      }

      if (topBundles.length === 0) {
        throw new TorrentEntryNotFoundException(
          `No viable candidate releases found for AniList ${job.anilistId || "n/a"} / AniDB ${job.anidbId || "n/a"} Ep ${job.episodeNumber}`,
        );
      }

      // Hydrate all quality entries (1080p, 720p, 480p) in the top bundles with Tsukihime tracker URLs & seeders
      topBundles = await TsukihimeClient.hydrateCandidateBundles(topBundles);

      let selectedBundle: ReleaseCandidateBundle | null = null;
      let primaryStagedPath: string | null = null;
      let primarySizeBytes = 0;
      let primaryMagnet = "";
      let primaryQuality: VideoResolutionQuality = "1080p";
      let isBatchExtracted = false;
      const qualitiesPayload: Record<string, any> = {};
      let lastCandidateErr: any = null;

      // Try up to top 4 candidate bundles in strict waterfall order:
      // Solo Tier 1 (h264_multi) -> Solo Tier 2 (h264_single_1080p) -> Solo Tier 3 (hevc_av1_gpu) -> Selective-Batch fallbacks
      for (let bIdx = 0; bIdx < Math.min(4, topBundles.length); bIdx++) {
        const bundle = topBundles[bIdx];
        const primaryEntry = bundle.primaryEntry;
        const qualList = (Object.keys(bundle.qualities) as VideoResolutionQuality[]).join("/");

        log.info(
          "PipelineEngine",
          `[Job #${job.id}] Trying bundle ${bIdx + 1}/${Math.min(4, topBundles.length)} [tier=${bundle.selectionTier}, pipeline=${bundle.pipelineType}, solo=${bundle.isSolo}, group=${bundle.group}, qualities=${qualList}]: ${primaryEntry.item.title}`,
        );

        const dlRes = await this.downloadCandidateEpisodeToStaging({
          jobId: job.id,
          episodeNumber: job.episodeNumber,
          knownTitles: effectiveKnownTitles,
          candidate: primaryEntry.item,
          effectiveEp: primaryEntry.effectiveEp,
          qualityTag: primaryEntry.quality,
          transmission,
          stagingDir,
          enforceHardCapBeforeStart: true,
        });

        if (dlRes.ok) {
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

      if (!primaryStagedPath || !selectedBundle) {
        throw lastCandidateErr || new Error("All torrent candidate bundles failed to download");
      }

      const fSizeMb = (primarySizeBytes / (1024 * 1024)).toFixed(1);
      log.success(
        "PipelineEngine",
        `Primary (${primaryQuality}) video staged for Job #${job.id}: ${primaryStagedPath} (${fSizeMb} MB)`,
      );

      // Probe primary (1080p) MKV streams for audio track mapping AND actual video codec verification
      let tracksConfig: [string, number][] = [["sub", 0]];
      let detectedVideoCodec = selectedBundle.isH264 ? "h264" : "hevc";
      let isBrowserCompatibleH264 = selectedBundle.isH264;

      try {
        const probe = await inspectMkvStreamsSync(primaryStagedPath);
        const langMode = wantsSub && wantsDub ? "all" : wantsDub ? "dub" : "sub";
        tracksConfig = videoManager.determineTracksToEncode(probe, langMode);
        if (probe.videoCodec) {
          detectedVideoCodec = probe.videoCodec;
          isBrowserCompatibleH264 = Boolean(probe.isBrowserCompatibleH264);
        }
        log.info(
          "PipelineEngine",
          `Job #${job.id} stream probe -> codec=${detectedVideoCodec} (h264DirectRemux=${isBrowserCompatibleH264}), dualAudio=${probe.isDualAudio}, tracks=${JSON.stringify(tracksConfig)}`,
        );
      } catch (probeErr: any) {
        log.warn("PipelineEngine", `Job #${job.id} ffprobe warning, defaulting track config: ${probeErr?.message || probeErr}`);
        tracksConfig = wantsDub && !wantsSub ? [["dub", 0]] : [["sub", 0]];
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

      // Run 1080p R2 subtitle extraction AND (if Tier 1 h264_multi) parallel sibling 720p/480p downloads concurrently!
      const extract1080pSubtitlesTask = async (): Promise<R2SubtitleRecord[]> => {
        const taskToken = crypto.randomUUID().slice(0, 8);
        const tempSubsDir = path.join(stagingDir, `subs_${taskToken}`);
        await fs.promises.mkdir(tempSubsDir, { recursive: true });
        const records: R2SubtitleRecord[] = [];
        try {
          const extractedSubs = await subtitles.extractSubtitlesFromMkv(primaryStagedPath!, tempSubsDir);
          if (extractedSubs.length > 0) {
            const animeIdForPath = job.animeId || job.anilistId || job.anidbId || job.id;
            for (const [trackType] of tracksConfig) {
              const uploaded = await subtitles.uploadSubtitles(
                extractedSubs,
                animeIdForPath,
                job.episodeNumber,
                trackType,
              );
              records.push(...uploaded);
            }
            log.info(
              "PipelineEngine",
              `Job #${job.id}: Extracted & uploaded ${records.length} subtitle track(s) from ${primaryQuality} source only.`,
            );
          }
        } finally {
          await fs.promises.rm(tempSubsDir, { recursive: true, force: true }).catch(() => {});
        }
        return records;
      };

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
              qualityTag: siblingQ,
              transmission,
              stagingDir,
              enforceHardCapBeforeStart: true,
            });

            if (sibDl.ok) {
              try {
                const sibProbe = await inspectMkvStreamsSync(sibDl.stagedPath);
                if (sibProbe.videoCodec && !sibProbe.isBrowserCompatibleH264) {
                  log.warn(
                    "PipelineEngine",
                    `[Job #${job.id}] Sibling ${siblingQ} is ${sibProbe.videoCodec} (not 8-bit H.264); discarding sibling file.`,
                  );
                  await fs.promises.unlink(sibDl.stagedPath).catch(() => {});
                  return;
                }
              } catch {}

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

      const [r2SubRecords] = await Promise.all([
        extract1080pSubtitlesTask(),
        downloadSiblingQualitiesTask(),
      ]);

      const stagedQualityList = Object.keys(stagedQualities) as VideoResolutionQuality[];
      if (processingMode === "vm_remux" && stagedQualityList.length === 1) {
        effectiveSelectionTier = "h264_single_1080p";
      }

      const updatedMetadata = {
        ...(job.metadata || {}),
        processingMode,
        selectionTier: effectiveSelectionTier,
        releaseGroup: selectedBundle.group,
        videoCodec: detectedVideoCodec,
        isBatchTorrent: isBatchExtracted,
        stagedQualities,
        availableQualities: stagedQualityList,
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
          stagedFilePath: primaryStagedPath,
          sizeBytes: totalJobBytes,
          tracksConfig,
          torrentTitle: selectedBundle.primaryEntry.item.title,
          torrentMagnet: primaryMagnet,
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
      await db
        .update(schema.pipelineJob)
        .set({
          status: "failed",
          lastError: err?.message || String(err),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineJob.id, jobId));

      log.error("PipelineEngine", `Job #${jobId} staging failed: ${err?.message || err}`);
      return { status: "failed", jobId, error: err?.message || String(err) };
    } finally {
      clearInterval(heartbeatInterval);
    }
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
        .where(inArray(schema.pipelineJob.status, ["queued", "downloading"])),
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
    const stats = await this.getStagedWindowStats();

    // Always ensure Pipeline 1 (2-at-a-time VM Remux) is draining any staged H.264 jobs immediately
    if (stats.stagedRemuxCount > 0) {
      setImmediate(() => {
        this.drainVmRemuxQueue().catch(() => {});
      });
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
    this.isDrainingVmRemux = true;
    const startedJobIds: number[] = [];

    try {
      await this.ensureTables();

      // 1. Recover any orphaned VM remux job stuck in 'encoding' with batchId IS NULL and stale heartbeat (> 3m)
      const threeMinsAgo = new Date(Date.now() - 3 * 60 * 1000);
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
          (!sj.heartbeatAt || sj.heartbeatAt < threeMinsAgo)
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
          log.warn("PipelineEngine", `Staged file missing for VM Remux Job #${job.id}; re-queuing job.`);
          await db
            .update(schema.pipelineJob)
            .set({ status: "queued", stagedFilePath: null, batchId: null, updatedAt: new Date() })
            .where(eq(schema.pipelineJob.id, job.id));
          continue;
        }

        this.activeVmRemuxJobIds.add(job.id);
        startedJobIds.push(job.id);

        await db
          .update(schema.pipelineJob)
          .set({
            status: "encoding",
            pipelineType: "vm_remux",
            batchId: null,
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, job.id));

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
    const completedAtIso = new Date().toISOString();

    for (const trackType of encodedTrackTypes) {
      const trackRecords = jobOutputs.filter((o) => {
        if (o.type === "sub" || o.type === "dub") return o.type === trackType;
        return true;
      });

      const sources = trackRecords.map((o) => ({
        quality: o.quality,
        url: o.huggingface?.downloadUrl || "",
        downloadUrl: o.huggingface?.downloadUrl || "",
        sha256: o.sha256,
        sizeBytes: o.metadata?.size,
      }));

      const formattedSubs = SubtitleManager.formatForCallback(rawSubtitles, trackType);

      trackPayloads.push({
        jobId: job.id,
        anilistId: job.anilistId ?? (job.metadata?.anilistId ? Number(job.metadata.anilistId) : null),
        animeId: job.animeId ?? (job.metadata?.animeId ? Number(job.metadata.animeId) : null),
        anidbId: job.anidbId,
        episodeNumber: job.episodeNumber,
        type: trackType,
        sources,
        subtitles: formattedSubs,
        metadata: job.metadata || {},
        completedAt: completedAtIso,
      });
    }

    const primaryResult: PipelineEpisodeResult = {
      ...trackPayloads[0],
      allTrackPayloads: trackPayloads,
    };

    await db
      .update(schema.pipelineJob)
      .set({
        status: "completed",
        resultPayload: primaryResult,
        lastError: null,
        completedAt: new Date(),
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.pipelineJob.id, job.id));

    const targetCallbackUrl =
      job.callbackUrl || `${MAIN_BACKEND_URL}/api/internal/pipeline/completed`;
    let allDelivered = true;

    for (const payload of trackPayloads) {
      const ok = await this.deliverCallbackPayload(targetCallbackUrl, payload);
      if (!ok) {
        allDelivered = false;
      } else {
        log.success(
          "PipelineEngine",
          `Delivered ${payload.type.toUpperCase()} callback (${payload.sources.length} qualities) to Main Backend for Job #${job.id}`,
        );
      }

      const targetAnimeId = payload.animeId || payload.anilistId;
      if (targetAnimeId) {
        await notifyMainBackendRevalidate({
          animeId: targetAnimeId,
          slug: job.metadata?.slug || null,
          episodeNumber: job.episodeNumber,
          airType: payload.type,
        }).catch(() => {});
      }
    }

    const updatedMeta = {
      ...(job.metadata || {}),
      callbackDelivered: allDelivered,
      callbackLastAttemptAt: new Date().toISOString(),
    };
    await db
      .update(schema.pipelineJob)
      .set({ metadata: updatedMeta, updatedAt: new Date() })
      .where(eq(schema.pipelineJob.id, job.id));

    if (!allDelivered) {
      log.warn(
        "PipelineEngine",
        `Job #${job.id} completed and saved in DB, but Main Backend callback (${targetCallbackUrl}) is pending retry by Watchdog.`,
      );
    }

    // Delete all staged quality files (1080p, 720p, 480p) immediately so SSD space is freed
    await this.cleanupJobStagedFiles(job);
  }

  /**
   * Pipeline 1 Single-Job Executor (2-At-A-Time Streaming Worker — NO Batching!):
   * Remuxes a single H.264 job (`h264_multi` 1080p/720p/480p or `h264_single_1080p`) on the VM with `-c:v copy`,
   * uploads to Hugging Face, delivers the Main Backend callback, deletes local staged files,
   * and immediately pulls the next staged `vm_remux` job into the freed slot.
   */
  public static async executeVmRemuxJob(jobId: number): Promise<void> {
    await this.ensureTables();

    const heartbeatTimer = setInterval(() => {
      db.update(schema.pipelineJob)
        .set({ heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.pipelineJob.id, jobId))
        .catch(() => {});
    }, 20_000);

    try {
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

        const allowedQualities: VideoResolutionQuality[] =
          job.selectionTier === "h264_single_1080p"
            ? ["1080p"]
            : (["1080p", "720p", "480p"] as VideoResolutionQuality[]);

        for (const q of allowedQualities) {
          const p = stagedQualitiesMap[q];
          if (p && fs.existsSync(p)) {
            qualityFiles[q] = p;
          }
        }
        if (Object.keys(qualityFiles).length === 0 && job.stagedFilePath && fs.existsSync(job.stagedFilePath)) {
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

        const hfAccount = videoManager.getNextHfAccount();
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
          .where(eq(schema.pipelineJob.status, "queued"))
          .orderBy(asc(schema.pipelineJob.id))
          .limit(KIRA_DISCOVERY_CONCURRENCY);

        for (const qJob of queuedRows) {
          await inngest
            .send({
              name: "pipeline/job.discover",
              id: `pipe-job-${qJob.id}-freed-${Date.now()}`,
              data: {
                jobId: qJob.id,
                anilistId: qJob.anilistId,
                animeId: qJob.animeId,
                anidbId: qJob.anidbId,
                episodeNumber: qJob.episodeNumber,
                types: qJob.types,
                knownTitles: qJob.knownTitles || [],
              },
            })
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
          const allowedQualities: VideoResolutionQuality[] =
            job.selectionTier === "h264_single_1080p"
              ? ["1080p"]
              : (["1080p", "720p", "480p"] as VideoResolutionQuality[]);

          for (const q of allowedQualities) {
            const p = stagedQualitiesMap[q];
            if (p && fs.existsSync(p)) {
              qualityFiles[q] = p;
            }
          }
          if (Object.keys(qualityFiles).length === 0 && job.stagedFilePath && fs.existsSync(job.stagedFilePath)) {
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

          const hfAccount = videoManager.getNextHfAccount();
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
        } catch {
          tracks = job.types.includes("dub") && !job.types.includes("sub") ? [["dub", 0]] : [["sub", 0]];
        }
      }

      const hfAccount = videoManager.getNextHfAccount();
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

  public static async deliverCallbackPayload(
    callbackUrl: string,
    payload: PipelineEpisodeResult,
    maxAttempts = 4,
  ): Promise<boolean> {
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const res = await fetch(callbackUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-internal-secret": INTERNAL_SECRET,
          },
          body: JSON.stringify(payload),
        });
        if (res.ok) {
          return true;
        }
        const statusText = await res.text().catch(() => "");
        log.warn(
          "PipelineEngine",
          `Callback HTTP ${res.status} for Job #${payload.jobId} (${payload.type}): ${statusText.slice(0, 200)}`,
        );
      } catch (callErr: any) {
        log.warn(
          "PipelineEngine",
          `Callback attempt ${attempt}/${maxAttempts} failed for Job #${payload.jobId} (${payload.type}): ${callErr?.message || callErr}`,
        );
      }
      if (attempt < maxAttempts) {
        const delayMs = Math.min(1500 * Math.pow(2, attempt - 1), 12000);
        await new Promise((r) => setTimeout(r, delayMs));
      }
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
    const output = await videoManager.fetchBatchKernelOutput(
      kernelSlug,
      account.username,
      account.key,
    );

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
      const jobOutputs = records.filter((o) => {
        if (o.job_id && o.job_id === job.id) return true;
        const matchesAnime =
          (job.animeId && o.anime_id === job.animeId) ||
          (job.anilistId && o.anime_id === job.anilistId) ||
          (job.anidbId && o.anime_id === job.anidbId);
        return Boolean(matchesAnime && o.episode_number === job.episodeNumber);
      });

      if (jobOutputs.length === 0) {
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
            lastError: `Batch #${batchId} failed: ${errorMsg}`,
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, job.id));
      }
    }
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

  public static async retryPendingCallbacks(): Promise<number> {
    await this.ensureTables();

    const completedJobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.status, "completed"));

    let redeliveredCount = 0;

    for (const job of completedJobs) {
      const meta = (job.metadata as Record<string, any>) || {};
      if (meta.callbackDelivered !== false) continue;

      const resultPayload = job.resultPayload as PipelineEpisodeResult | null;
      if (!resultPayload) continue;

      const targetUrl = job.callbackUrl || `${MAIN_BACKEND_URL}/api/internal/pipeline/completed`;
      const payloadsToDeliver: PipelineEpisodeResult[] = Array.isArray(resultPayload.allTrackPayloads)
        ? resultPayload.allTrackPayloads
        : [resultPayload];

      let allOk = true;
      for (const p of payloadsToDeliver) {
        const ok = await this.deliverCallbackPayload(targetUrl, p, 2);
        if (!ok) {
          allOk = false;
          break;
        }
        const targetAnimeId = p.animeId || p.anilistId;
        if (targetAnimeId) {
          await notifyMainBackendRevalidate({
            animeId: targetAnimeId,
            slug: meta.slug || null,
            episodeNumber: job.episodeNumber,
            airType: p.type,
          }).catch(() => {});
        }
      }

      if (allOk) {
        redeliveredCount++;
        await db
          .update(schema.pipelineJob)
          .set({
            metadata: {
              ...meta,
              callbackDelivered: true,
              callbackDeliveredAt: new Date().toISOString(),
            },
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, job.id));
        log.success("PipelineEngine", `Re-delivered pending Main Backend callback for Job #${job.id}`);
      }
    }

    return redeliveredCount;
  }

  public static async getStats(): Promise<PipelineStats> {
    await this.ensureTables();

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

    return {
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
        total,
      },
      storage: {
        stagedBytes: effectiveStagedBytes,
        stagedCount: windowStats.stagedCount,
        maxBatchItems: KIRA_BATCH_MAX_ITEMS,
        maxStagingBytes: KIRA_MAX_STAGING_BYTES,
        minFreeBytes: KIRA_MIN_FREE_SSD_BYTES,
        stagingDir: getKiraStagingDir(),
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
      },
    };
  }
}
