import fs from "fs";
import path from "path";
import crypto from "crypto";
import { db, schema } from "../db/index.js";
import { eq, and, gt, inArray, lte, isNull, or, asc, desc, sql } from "drizzle-orm";
import { TransmissionClient } from "./transmission.client.js";
import { SubtitleManager } from "./subtitles.manager.js";
import { VideoEncodingManager } from "./video.manager.js";
import { AnimeToshoClient, type FetchTorrentsOptions } from "./animetosho.client.js";
import { ReleaseFilter } from "./release-filter.js";
import { AnimeMetadataResolver } from "./metadata-resolver.js";
import {
  DEFAULT_DOWNLOAD_DIR,
  KIRA_BATCH_WINDOW_MS,
  KIRA_BATCH_SAFE_MAX_BYTES,
  KIRA_BATCH_MAX_ITEMS,
  KIRA_MAX_STAGING_BYTES,
  KIRA_MIN_FREE_SSD_BYTES,
  KIRA_PER_DOWNLOAD_RESERVE_BYTES,
  KIRA_MAX_CONCURRENT_BATCHES,
  KIRA_MAX_TOTAL_BATCHES,
  KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT,
  getMaxConcurrentBatches,
  TorrentEntryNotFoundException,
  TorrentDownloadTooSlowException,
  getKiraStagingDir,
  loadAccountsFromEnv,
} from "../config.js";
import { notifyMainBackendRevalidate } from "../utils/notifier.js";
import type {
  AnimeToshoItem,
  EnqueueRequest,
  EnqueueResponse,
  PipelineEpisodeResult,
  PipelineStats,
  KiraBatchManifestItem,
  KiraBatchUploadItem,
  KiraBatchKernelOutput,
} from "./types.js";
import { log } from "../utils/logger.js";

let tablesInitialized = false;

export class PipelineEngineService {
  public static async ensureTables(): Promise<void> {
    if (tablesInitialized) return;
    try {
      await db.execute(sql`
        CREATE TABLE IF NOT EXISTS "pipeline_encoding_batch" (
          "id" bigserial PRIMARY KEY NOT NULL,
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

      // Idempotently add anilist_id and anime_id columns if table already existed
      await db.execute(sql`
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "anilist_id" integer;
        ALTER TABLE "pipeline_encoding_job" ADD COLUMN IF NOT EXISTS "anime_id" integer;
        ALTER TABLE "pipeline_encoding_job" ALTER COLUMN "anidb_id" DROP NOT NULL;
      `);

      await db.execute(sql`
        CREATE INDEX IF NOT EXISTS "sh_pipeline_batch_status_idx" ON "pipeline_encoding_batch" ("status");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_batch_user_idx" ON "pipeline_encoding_batch" ("kaggle_username", "status");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_batch_heartbeat_idx" ON "pipeline_encoding_batch" ("status", "heartbeat_at");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_status_idx" ON "pipeline_encoding_job" ("status");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_anilist_idx" ON "pipeline_encoding_job" ("anilist_id", "episode_number");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_anime_idx" ON "pipeline_encoding_job" ("anime_id");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_anidb_idx" ON "pipeline_encoding_job" ("anidb_id", "episode_number");
        CREATE INDEX IF NOT EXISTS "sh_pipeline_job_batch_idx" ON "pipeline_encoding_job" ("batch_id");
      `);

      tablesInitialized = true;
      log.success("PipelineEngine", "Pipeline tables verified.");
    } catch (err: any) {
      log.warn("PipelineEngine", `ensureTables: ${err?.message || err}`);
    }
  }

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

    // Auto-resolve metadata, anidbId, animeId, and titles if anilistId is given
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
            primaryTitle: resolved.primaryTitle,
            coverImage: resolved.coverImage,
            totalEpisodes: resolved.totalEpisodes,
            source: resolved.source,
          };
          log.info(
            "PipelineEngine",
            `Resolved AniList #${anilistId} -> AniDB: ${anidbId || "n/a"}, AnimeId: ${animeId || "n/a"}, Title: "${resolved.primaryTitle}"`,
          );
        }
      } catch (err: any) {
        log.warn("PipelineEngine", `Metadata resolution error for AniList #${anilistId}: ${err?.message || err}`);
      }
    }

    const queuedJobs: EnqueueResponse["queuedJobs"] = [];
    let skippedExisting = 0;

    for (const ep of episodeNumbers) {
      // Check if already queued or running
      const conditions = [
        eq(schema.pipelineJob.episodeNumber, ep),
        inArray(schema.pipelineJob.status, ["queued", "downloading", "staged", "encoding"]),
      ];

      if (anilistId) {
        conditions.push(eq(schema.pipelineJob.anilistId, anilistId));
      } else if (anidbId) {
        conditions.push(eq(schema.pipelineJob.anidbId, anidbId));
      }

      const existing = await db.query.pipelineJob.findFirst({
        where: and(...conditions),
      });

      if (existing) {
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
          types,
          status: "queued",
          knownTitles,
          metadata,
          callbackUrl,
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
        `Enqueued Job #${inserted.id} -> AniList: ${anilistId || "n/a"} | AniDB: ${anidbId || "n/a"} Ep ${ep} (${types.join("/")})`,
      );
    }

    return { queuedJobs, skippedExisting };
  }

  public static async discoverAndStageJob(jobId: number): Promise<{
    status: "staged" | "download_paused" | "failed";
    jobId: number;
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

    if (job.status === "staged" && job.stagedFilePath && fs.existsSync(job.stagedFilePath)) {
      return { status: "staged", jobId, sizeBytes: job.sizeBytes || 0 };
    }

    await db
      .update(schema.pipelineJob)
      .set({ status: "downloading", heartbeatAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.pipelineJob.id, jobId));

    const transmission = new TransmissionClient();
    const subtitles = new SubtitleManager();
    const videoManager = new VideoEncodingManager();
    const stagingDir = getKiraStagingDir();

    let torrentId: number | null = null;
    let localFile: string | null = null;

    try {
      log.info(
        "PipelineEngine",
        `Searching AnimeTosho for AniList ${job.anilistId || "n/a"} | AniDB ${job.anidbId || "n/a"} Ep ${job.episodeNumber}...`,
      );
      const isDub = job.types.includes("dub") && !job.types.includes("sub");
      const langQuery = isDub ? "dual-audio 1080p" : "1080p";

      const opts: FetchTorrentsOptions = {
        targetEp: job.episodeNumber,
        langType: isDub ? "dub" : "all",
        knownTitles: job.knownTitles || [],
        maxPages: 5,
      };

      let torrents: AnimeToshoItem[] = [];

      // 1. First attempt: search via AniDB ID if present
      if (job.anidbId) {
        torrents = await AnimeToshoClient.fetchTorrents(job.anidbId, langQuery, opts);

        if (torrents.length === 0 && isDub) {
          torrents = await AnimeToshoClient.fetchTorrents(job.anidbId, "dub 1080p", opts);
        }
        if (torrents.length === 0) {
          torrents = await AnimeToshoClient.fetchTorrents(job.anidbId, "", opts);
        }
      }

      // 2. Second attempt: search via known titles if AniDB ID was missing or gave 0 results
      if (torrents.length === 0 && Array.isArray(job.knownTitles) && job.knownTitles.length > 0) {
        for (const title of job.knownTitles) {
          if (!title || !title.trim()) continue;
          log.info("PipelineEngine", `Searching AnimeTosho by title "${title.trim()}" Ep ${job.episodeNumber}...`);
          torrents = await AnimeToshoClient.fetchTorrentsByTitle(title.trim(), langQuery, opts);
          if (torrents.length > 0) break;
          if (isDub) {
            torrents = await AnimeToshoClient.fetchTorrentsByTitle(title.trim(), "dub 1080p", opts);
            if (torrents.length > 0) break;
          }
        }
      }

      const topCandidates = ReleaseFilter.selectTopCandidates(
        torrents,
        job.episodeNumber,
        isDub ? "dub" : "all",
        {
          knownTitles: job.knownTitles || [],
          maxCandidates: 3,
        },
      );

      if (topCandidates.length === 0) {
        throw new TorrentEntryNotFoundException(
          `No viable candidate releases found for AniList ${job.anilistId || "n/a"} / AniDB ${job.anidbId || "n/a"} Ep ${job.episodeNumber}`,
        );
      }

      const [bestCandidate, effectiveEp] = topCandidates[0];
      const magnetUri = bestCandidate.magnet_uri || bestCandidate.torrent_url;
      if (!magnetUri) throw new Error("Torrent candidate missing magnet link");

      log.info("PipelineEngine", `Selected candidate: ${bestCandidate.title}`);

      // Add to Transmission
      const tInfo = await transmission.addTorrent(magnetUri, DEFAULT_DOWNLOAD_DIR);
      torrentId = tInfo.id;

      const metaStatus = await transmission.waitForMetadata(torrentId);
      const tFiles = metaStatus.files || [];
      const dlDir = metaStatus.downloadDir || DEFAULT_DOWNLOAD_DIR;

      const epMap = ReleaseFilter.matchFilesToEpisodes(tFiles, {
        knownTitles: job.knownTitles || [],
        targetEp: job.episodeNumber,
        effectiveEp,
      });

      if (!epMap.has(job.episodeNumber)) {
        throw new TorrentEntryNotFoundException(
          `Ep ${job.episodeNumber} not found in torrent ${bestCandidate.title}`,
        );
      }

      const [wantedIdx, relPath] = epMap.get(job.episodeNumber)!;
      const fullPath = path.join(dlDir, relPath);
      localFile = fullPath;

      const fileAlreadyExists = fs.existsSync(fullPath) && fs.statSync(fullPath).size > 1024;
      if (!fileAlreadyExists && tFiles.length > 1) {
        await transmission.selectOnlyFiles(torrentId, [wantedIdx], tFiles.length);
      }

      await transmission.startTorrent(torrentId);
      await transmission.waitForCompletion(torrentId, {
        wantedFileIndex: wantedIdx,
        expectedDiskPath: fullPath,
      });

      if (!fs.existsSync(fullPath)) {
        throw new Error(`Downloaded video file missing on disk: ${fullPath}`);
      }

      const fSizeMb = (fs.statSync(fullPath).size / (1024 * 1024)).toFixed(1);
      log.success("PipelineEngine", `Video downloaded: ${fullPath} (${fSizeMb} MB)`);

      // Extract subtitles & upload to R2
      const taskToken = crypto.randomUUID().slice(0, 8);
      const tempSubsDir = path.join(stagingDir, `subs_${taskToken}`);
      await fs.promises.mkdir(tempSubsDir, { recursive: true });

      let r2SubRecords: any[] = [];
      try {
        const extractedSubs = await subtitles.extractSubtitlesFromMkv(fullPath, tempSubsDir);
        if (extractedSubs.length > 0) {
          const animeIdForPath = job.animeId || job.anilistId || job.anidbId || job.id;
          r2SubRecords = await subtitles.uploadSubtitles(
            extractedSubs,
            animeIdForPath,
            job.episodeNumber,
            job.types.includes("dub") ? "dub" : "sub",
          );
        }
      } finally {
        await fs.promises.rm(tempSubsDir, { recursive: true, force: true }).catch(() => {});
      }

      // Move into persistent staging
      const stagedFilename = `staged_${job.id}_${crypto.randomUUID().slice(0, 8)}.mkv`;
      const stagedPath = path.join(stagingDir, stagedFilename);

      try {
        await fs.promises.rename(fullPath, stagedPath);
      } catch {
        await fs.promises.copyFile(fullPath, stagedPath);
        await fs.promises.unlink(fullPath).catch(() => {});
      }

      const sizeBytes = fs.statSync(stagedPath).size;

      // Clean up torrent from Transmission
      if (torrentId) {
        await transmission.removeTorrent(torrentId, true).catch(() => {});
      }

      // Save staged state
      await db
        .update(schema.pipelineJob)
        .set({
          status: "staged",
          stagedFilePath: stagedPath,
          sizeBytes,
          torrentTitle: bestCandidate.title,
          torrentMagnet: magnetUri,
          subtitlesPayload: r2SubRecords,
          stagedAt: new Date(),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineJob.id, jobId));

      log.success(
        "PipelineEngine",
        `Job #${job.id} staged successfully: ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`,
      );

      return { status: "staged", jobId, sizeBytes };
    } catch (err: any) {
      if (torrentId) {
        await transmission.removeTorrent(torrentId, true).catch(() => {});
      }

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
    }
  }

  public static async getStagedWindowStats(): Promise<{
    stagedCount: number;
    totalBytes: number;
    oldestStagedAt: Date | null;
  }> {
    await this.ensureTables();

    const staged = await db
      .select({
        id: schema.pipelineJob.id,
        sizeBytes: schema.pipelineJob.sizeBytes,
        stagedAt: schema.pipelineJob.stagedAt,
      })
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.status, "staged"))
      .orderBy(asc(schema.pipelineJob.stagedAt));

    const stagedCount = staged.length;
    let totalBytes = 0;
    for (const s of staged) {
      totalBytes += Number(s.sizeBytes || 0);
    }
    const oldestStagedAt = staged[0]?.stagedAt || null;

    return { stagedCount, totalBytes, oldestStagedAt };
  }

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
      log.warn("PipelineEngine", "No Kaggle accounts configured; cannot seal GPU batch");
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    // Dynamic concurrency limit = total number of kaggle accounts * 2
    const maxConcurrentBatches = kaggleAccounts.length * KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT;

    // Check currently active batches across the system
    const activeBatches = await db
      .select({
        id: schema.pipelineBatch.id,
        status: schema.pipelineBatch.status,
        kaggleUsername: schema.pipelineBatch.kaggleUsername,
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

    if (activeBatches.length >= maxConcurrentBatches) {
      log.info(
        "PipelineEngine",
        `Kaggle capacity reached: ${activeBatches.length}/${maxConcurrentBatches} active notebooks. Waiting for a slot to free.`,
      );
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    // Count active notebooks per Kaggle username
    const usageMap: Record<string, number> = {};
    for (const b of activeBatches) {
      if (b.kaggleUsername) {
        usageMap[b.kaggleUsername] = (usageMap[b.kaggleUsername] || 0) + 1;
      }
    }

    // Find accounts that have < 2 concurrent tasks, sorted by least loaded
    const eligibleAccounts = kaggleAccounts
      .map((acc) => ({
        account: acc,
        activeCount: usageMap[acc.username] || 0,
      }))
      .filter((item) => item.activeCount < KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT)
      .sort((a, b) => a.activeCount - b.activeCount);

    if (eligibleAccounts.length === 0) {
      log.info("PipelineEngine", "All Kaggle accounts currently running at their 2-notebook limit.");
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    const selectedAccount = eligibleAccounts[0].account;

    // Find staged jobs not assigned to any batch
    const stagedJobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(and(eq(schema.pipelineJob.status, "staged"), isNull(schema.pipelineJob.batchId)))
      .orderBy(asc(schema.pipelineJob.stagedAt));

    if (stagedJobs.length === 0) {
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    // Pack up to 10 GB safe cap OR max 10 files (whichever limit is reached first)
    const packedJobs: typeof stagedJobs = [];
    let accBytes = 0;

    for (const job of stagedJobs) {
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

    const [batch] = await db
      .insert(schema.pipelineBatch)
      .values({
        status: "created",
        triggerReason: options.triggerReason || (options.forceFlush ? "manual" : "window_30m"),
        kaggleUsername: selectedAccount.username,
        jobCount: packedJobs.length,
        totalBytes: accBytes,
        heartbeatAt: new Date(),
      })
      .returning();

    const jobIds = packedJobs.map((j) => j.id);
    await db
      .update(schema.pipelineJob)
      .set({
        batchId: batch.id,
        status: "encoding",
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(schema.pipelineJob.id, jobIds));

    log.success(
      "PipelineEngine",
      `Sealed Batch #${batch.id} assigned to ${selectedAccount.username} (${eligibleAccounts[0].activeCount + 1}/${KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT} tasks): ${packedJobs.length} jobs, ${(accBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`,
    );

    return {
      batchId: batch.id,
      jobCount: packedJobs.length,
      totalBytes: accBytes,
      kaggleUsername: selectedAccount.username,
    };
  }

  /**
   * Seals as many batches as there are available Kaggle slots and staged jobs ready.
   */
  public static async sealAvailableBatches(options: {
    forceFlush?: boolean;
    triggerReason?: string;
  } = {}): Promise<number[]> {
    const sealedBatchIds: number[] = [];
    while (true) {
      const res = await this.sealStagedBatch(options);
      if (!res.batchId) break;
      sealedBatchIds.push(res.batchId);
    }
    return sealedBatchIds;
  }

  public static async executeBatch(batchId: number): Promise<void> {
    await this.ensureTables();

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });

    if (!batch) {
      log.warn("PipelineEngine", `Batch #${batchId} not found`);
      return;
    }

    if (batch.status === "completed") {
      log.info("PipelineEngine", `Batch #${batchId} already completed; skipping.`);
      return;
    }

    const jobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.batchId, batchId));

    if (jobs.length === 0) {
      await db
        .update(schema.pipelineBatch)
        .set({ status: "completed", completedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.pipelineBatch.id, batchId));
      return;
    }

    const videoManager = new VideoEncodingManager();
    const { kaggleAccounts, hfAccounts } = loadAccountsFromEnv();

    if (kaggleAccounts.length === 0) {
      const errMsg = "No Kaggle accounts available for GPU encoding";
      await db
        .update(schema.pipelineBatch)
        .set({ status: "failed", lastError: errMsg, updatedAt: new Date() })
        .where(eq(schema.pipelineBatch.id, batchId));
      throw new Error(errMsg);
    }

    // Look up the pre-assigned Kaggle account or fall back
    let account = batch.kaggleUsername
      ? kaggleAccounts.find((a) => a.username === batch.kaggleUsername)
      : null;

    if (!account) {
      account = kaggleAccounts[0];
    }

    let datasetSlug = batch.datasetSlug || `kira-batch-${batchId}-${crypto.randomUUID().slice(0, 6)}`;
    let kernelSlug = batch.kernelSlug || `enc-batch-${batchId}-${crypto.randomUUID().slice(0, 6)}`;

    try {
      log.info(
        "PipelineEngine",
        `Executing Batch #${batchId} on Kaggle GPU (${account.username}) with ${jobs.length} jobs...`,
      );

      // Build batch manifest & upload items
      const uploadItems: KiraBatchUploadItem[] = [];
      const manifestItems: KiraBatchManifestItem[] = [];

      for (const job of jobs) {
        if (!job.stagedFilePath || !fs.existsSync(job.stagedFilePath)) {
          continue;
        }
        const ext = path.extname(job.stagedFilePath);
        const safeRel = `input_${job.id}${ext}`;
        const sizeBytes = Number(job.sizeBytes || 0);

        uploadItems.push({
          jobId: job.id,
          localFilePath: job.stagedFilePath,
          remoteFilename: safeRel,
          sizeBytes,
        });

        manifestItems.push({
          jobId: job.id,
          filename: safeRel,
          animeId: job.animeId || job.anilistId || job.anidbId || 0,
          anilistId: job.anilistId || undefined,
          anidbId: job.anidbId || undefined,
          episodeNumber: job.episodeNumber,
          tracks: [["1080p", 0], ["720p", 0], ["480p", 0], ["360p", 0]],
          hf: hfAccounts[0],
        });
      }

      await db
        .update(schema.pipelineBatch)
        .set({
          status: "uploading",
          kaggleUsername: account.username,
          datasetSlug,
          kernelSlug,
          startedAt: batch.startedAt || new Date(),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));

      // Upload Dataset to Kaggle
      log.info("PipelineEngine", `Uploading dataset ${datasetSlug} to Kaggle (${account.username})...`);
      await videoManager.uploadBatchDatasetRest(
        uploadItems,
        datasetSlug,
        account.username,
        account.key,
      );

      // Push GPU Kernel
      await db
        .update(schema.pipelineBatch)
        .set({ status: "kernel_running", heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.pipelineBatch.id, batchId));

      log.info("PipelineEngine", `Pushing GPU kernel ${kernelSlug} to Kaggle (${account.username})...`);
      await videoManager.pushBatchGpuKernel(
        datasetSlug,
        kernelSlug,
        manifestItems,
        account.username,
        account.key,
      );

      // Poll kernel status
      const kernelStartTime = Date.now();
      let isComplete = false;

      while (Date.now() - kernelStartTime < 6 * 3600 * 1000) {
        await new Promise((r) => setTimeout(r, 60000)); // poll every 1 minute
        const kStatus = await videoManager.checkKernelStatusOnce(kernelSlug, account.username, account.key);
        const st = kStatus.state;

        await db
          .update(schema.pipelineBatch)
          .set({ heartbeatAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.pipelineBatch.id, batchId));

        log.info("PipelineEngine", `Kernel ${kernelSlug} [${account.username}] status: ${st} (${kStatus.rawStatus})`);

        if (st === "completed") {
          isComplete = true;
          break;
        }
        if (st === "failed") {
          throw new Error(`Kaggle kernel finished with error status: ${kStatus.rawStatus}`);
        }
      }

      if (!isComplete) {
        throw new Error("Kaggle kernel timed out after 6 hours");
      }

      // Fetch kernel output & upload to Hugging Face
      log.info("PipelineEngine", `Downloading encoded outputs for Batch #${batchId}...`);
      const output = await videoManager.fetchBatchKernelOutput(
        kernelSlug,
        account.username,
        account.key,
      );

      const records = output.records || [];
      log.success("PipelineEngine", `Received ${records.length} encoded files. Uploading to Hugging Face...`);

      // Group outputs by job
      for (const job of jobs) {
        const jobOutputs = records.filter((o) => {
          if (o.job_id && o.job_id === job.id) return true;
          const matchesAnime =
            (job.anidbId && o.anime_id === job.anidbId) ||
            (job.anilistId && o.anime_id === job.anilistId) ||
            (job.animeId && o.anime_id === job.animeId);
          return matchesAnime && o.episode_number === job.episodeNumber;
        });

        const sources = jobOutputs.map((o) => ({
          quality: o.quality,
          url: o.huggingface?.downloadUrl || "",
          downloadUrl: o.huggingface?.downloadUrl || "",
          sha256: o.sha256,
        }));

        const subtitles = (job.subtitlesPayload as any[]) || [];

        const resultPayload: PipelineEpisodeResult = {
          jobId: job.id,
          anilistId: job.anilistId,
          animeId: job.animeId,
          anidbId: job.anidbId,
          episodeNumber: job.episodeNumber,
          type: job.types.includes("dub") ? "dub" : "sub",
          sources,
          subtitles,
          metadata: job.metadata || {},
          completedAt: new Date().toISOString(),
        };

        // Deliver callback to Main Backend if configured (with retry & backoff)
        if (job.callbackUrl) {
          const maxAttempts = 5;
          let delivered = false;
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              log.info("PipelineEngine", `Calling callbackUrl for Job #${job.id} (attempt ${attempt}/${maxAttempts}): ${job.callbackUrl}`);
              const res = await fetch(job.callbackUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(resultPayload),
              });
              if (res.ok) {
                log.info("PipelineEngine", `✓ Callback successfully delivered to Main Backend for Job #${job.id}`);
                delivered = true;
                break;
              } else {
                const statusText = await res.text().catch(() => "");
                log.warn("PipelineEngine", `Callback HTTP ${res.status} for Job #${job.id}: ${statusText}`);
              }
            } catch (callErr: any) {
              log.warn("PipelineEngine", `Callback delivery failed attempt ${attempt}/${maxAttempts} for Job #${job.id}: ${callErr?.message || callErr}`);
            }
            if (attempt < maxAttempts) {
              const delayMs = Math.min(1000 * Math.pow(2, attempt - 1), 16000);
              await new Promise((r) => setTimeout(r, delayMs));
            }
          }
          if (!delivered) {
            log.error("PipelineEngine", `Failed to deliver callback to ${job.callbackUrl} after ${maxAttempts} attempts. Result payload preserved in pipeline DB.`);
          }
        }

        // Revalidate cache on Main Backend if animeId or anilistId is known
        const targetAnimeId = job.animeId || job.anilistId;
        if (targetAnimeId) {
          notifyMainBackendRevalidate({
            animeId: targetAnimeId,
            episodeNumber: job.episodeNumber,
            airType: job.types.includes("dub") ? "dub" : "sub",
          }).catch(() => {});
        }

        await db
          .update(schema.pipelineJob)
          .set({
            status: "completed",
            resultPayload,
            completedAt: new Date(),
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, job.id));

        // Clean up staged file
        if (job.stagedFilePath && fs.existsSync(job.stagedFilePath)) {
          await fs.promises.unlink(job.stagedFilePath).catch(() => {});
        }
      }

      // Clean up Kaggle dataset & kernel
      await videoManager.deleteKaggleDataset(datasetSlug, account.username, account.key).catch(() => {});
      await videoManager.deleteKaggleKernel(kernelSlug, account.username, account.key).catch(() => {});

      await db
        .update(schema.pipelineBatch)
        .set({
          status: "completed",
          completedAt: new Date(),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));

      log.success("PipelineEngine", `Batch #${batchId} completed successfully on Kaggle (${account.username})!`);
    } catch (err: any) {
      log.error("PipelineEngine", `Execution of Batch #${batchId} failed: ${err?.message || err}`);
      await db
        .update(schema.pipelineBatch)
        .set({
          status: "failed",
          lastError: err?.message || String(err),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));

      // Also mark jobs as failed or retryable
      await db
        .update(schema.pipelineJob)
        .set({
          status: "failed",
          lastError: `Batch #${batchId} failed: ${err?.message || err}`,
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineJob.batchId, batchId));

      // Attempt cleanup
      await videoManager.deleteKaggleDataset(datasetSlug, account.username, account.key).catch(() => {});
      await videoManager.deleteKaggleKernel(kernelSlug, account.username, account.key).catch(() => {});

      throw err;
    }
  }

  public static async getStats(): Promise<PipelineStats> {
    await this.ensureTables();

    const activeBatchRows = await db
      .select()
      .from(schema.pipelineBatch)
      .where(inArray(schema.pipelineBatch.status, ["created", "uploading", "waiting_dataset", "kernel_running"]))
      .orderBy(asc(schema.pipelineBatch.id));

    const activeBatches = activeBatchRows.map((row) => ({
      id: row.id,
      status: row.status,
      kaggleUsername: row.kaggleUsername,
      datasetSlug: row.datasetSlug,
      kernelSlug: row.kernelSlug,
      jobCount: row.jobCount,
      totalBytes: Number(row.totalBytes || 0),
      elapsedSeconds: row.startedAt
        ? Math.floor((Date.now() - row.startedAt.getTime()) / 1000)
        : 0,
      heartbeatAt: row.heartbeatAt.toISOString(),
    }));

    const counts = await db
      .select({
        status: schema.pipelineJob.status,
        count: sql<number>`count(*)`,
      })
      .from(schema.pipelineJob)
      .groupBy(schema.pipelineJob.status);

    const queueMap: Record<string, number> = {};
    let total = 0;
    for (const c of counts) {
      const n = Number(c.count || 0);
      queueMap[c.status] = n;
      total += n;
    }

    const windowStats = await this.getStagedWindowStats();
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

    const maxConcurrentBatches = Math.max(1, kaggleAccounts.length * KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT);

    return {
      activeBatch: activeBatches[0] || null,
      activeBatches,
      concurrency: {
        active: activeBatches.length,
        max: maxConcurrentBatches,
        accountsCount: kaggleAccounts.length,
        maxPerAccount: KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT,
      },
      queue: {
        queued: queueMap["queued"] || 0,
        downloading: queueMap["downloading"] || 0,
        staged: queueMap["staged"] || 0,
        encoding: queueMap["encoding"] || 0,
        completed: queueMap["completed"] || 0,
        failed: queueMap["failed"] || 0,
        paused: queueMap["paused"] || 0,
        total,
      },
      storage: {
        stagedBytes: windowStats.totalBytes,
        stagedCount: windowStats.stagedCount,
        maxBatchItems: KIRA_BATCH_MAX_ITEMS,
        maxStagingBytes: KIRA_MAX_STAGING_BYTES,
        minFreeBytes: KIRA_MIN_FREE_SSD_BYTES,
        stagingDir: getKiraStagingDir(),
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
        lastWatchdogRun: new Date().toISOString(),
      },
    };
  }
}
