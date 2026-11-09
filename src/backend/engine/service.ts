import fs from "fs";
import path from "path";
import crypto from "crypto";
import { db, schema } from "../db/index.js";
import { eq, and, inArray, isNull, asc, sql } from "drizzle-orm";
import { TransmissionClient } from "./transmission.client.js";
import { SubtitleManager, inspectMkvStreamsSync } from "./subtitles.manager.js";
import { VideoEncodingManager } from "./video.manager.js";
import { AnimeToshoClient, type FetchTorrentsOptions } from "./animetosho.client.js";
import { ReleaseFilter } from "./release-filter.js";
import { AnimeMetadataResolver } from "./metadata-resolver.js";
import {
  DEFAULT_DOWNLOAD_DIR,
  MAIN_BACKEND_URL,
  INTERNAL_SECRET,
  KIRA_BATCH_WINDOW_MS,
  KIRA_QUEUE_IDLE_SETTLE_MS,
  KIRA_BATCH_SAFE_MAX_BYTES,
  KIRA_BATCH_MAX_ITEMS,
  KIRA_MAX_STAGING_BYTES,
  KIRA_MIN_FREE_SSD_BYTES,
  KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT,
  MAX_JOB_ATTEMPTS,
  MAX_BATCH_ATTEMPTS,
  TorrentEntryNotFoundException,
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
  R2SubtitleRecord,
} from "./types.js";
import { log } from "../utils/logger.js";

let tablesInitialized = false;
let lastWatchdogTimestamp: string | null = new Date().toISOString();

export class PipelineEngineService {
  public static markWatchdogRun(): void {
    lastWatchdogTimestamp = new Date().toISOString();
  }

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

  /**
   * Enqueues one or more episodes for torrent discovery, subtitle extraction, and GPU batch encoding.
   * Automatically extracts animeId & anilistId whether passed at top-level or inside metadata (from Main Backend).
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

    // Extract anilistId / animeId from metadata if Main Backend passed them inside metadata
    if (!anilistId && metadata?.anilistId) {
      const parsed = Number(metadata.anilistId);
      if (!isNaN(parsed) && parsed > 0) anilistId = parsed;
    }
    if (!animeId && metadata?.animeId) {
      const parsed = Number(metadata.animeId);
      if (!isNaN(parsed) && parsed > 0) animeId = parsed;
    }

    // Default callbackUrl to Main Backend (:4000) completion webhook if not explicitly provided
    const effectiveCallbackUrl =
      callbackUrl || `${MAIN_BACKEND_URL}/api/internal/pipeline/completed`;

    // Auto-resolve metadata, anidbId, animeId, and titles if anilistId is known
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
        // If the existing job is still queued and new types were requested, merge them
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
   * Stage 1: Discovers torrent candidates on AnimeTosho, downloads via Transmission with multi-candidate fallback,
   * extracts & uploads subtitles to R2, probes audio streams (sub/dub), and moves MKV into local SSD staging.
   */
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

    if (job.status === "completed" || job.status === "encoding") {
      return { status: "staged", jobId, sizeBytes: job.sizeBytes || 0 };
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

    // Heartbeat ticker while downloading torrent so watchdog knows this job is alive
    const heartbeatInterval = setInterval(() => {
      db.update(schema.pipelineJob)
        .set({ heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.pipelineJob.id, jobId))
        .catch(() => {});
    }, 30_000);

    try {
      log.info(
        "PipelineEngine",
        `Searching AnimeTosho for Job #${job.id} (AniList ${job.anilistId || "n/a"} | AniDB ${job.anidbId || "n/a"} Ep ${job.episodeNumber} [${job.types.join("/")}])...`,
      );

      const wantsDub = job.types.includes("dub");
      const wantsSub = job.types.includes("sub");
      const isDubOnly = wantsDub && !wantsSub;
      const langTypeForSearch = isDubOnly ? "dub" : "all";
      const langQuery = wantsDub ? "dual-audio 1080p" : "1080p";

      const opts: FetchTorrentsOptions = {
        targetEp: job.episodeNumber,
        langType: langTypeForSearch,
        knownTitles: job.knownTitles || [],
        maxPages: 6,
      };

      let torrents: AnimeToshoItem[] = [];

      // 1. Search via AniDB ID if present
      if (job.anidbId) {
        torrents = await AnimeToshoClient.fetchTorrents(job.anidbId, langQuery, opts);

        if (torrents.length === 0 && wantsDub) {
          torrents = await AnimeToshoClient.fetchTorrents(job.anidbId, "dub 1080p", opts);
        }
        if (torrents.length === 0) {
          torrents = await AnimeToshoClient.fetchTorrents(job.anidbId, "1080p", opts);
        }
        if (torrents.length === 0) {
          torrents = await AnimeToshoClient.fetchTorrents(job.anidbId, "", opts);
        }
      }

      // 2. Fallback: Search via known titles if AniDB ID was missing or yielded 0 results
      if (torrents.length === 0 && Array.isArray(job.knownTitles) && job.knownTitles.length > 0) {
        for (const title of job.knownTitles) {
          if (!title || !title.trim()) continue;
          log.info("PipelineEngine", `Searching AnimeTosho by title "${title.trim()}" Ep ${job.episodeNumber}...`);
          torrents = await AnimeToshoClient.fetchTorrentsByTitle(title.trim(), langQuery, opts);
          if (torrents.length > 0) break;
          if (wantsDub) {
            torrents = await AnimeToshoClient.fetchTorrentsByTitle(title.trim(), "dub 1080p", opts);
            if (torrents.length > 0) break;
          }
          torrents = await AnimeToshoClient.fetchTorrentsByTitle(title.trim(), "1080p", opts);
          if (torrents.length > 0) break;
        }
      }

      let topCandidates = ReleaseFilter.selectTopCandidates(
        torrents,
        job.episodeNumber,
        langTypeForSearch,
        {
          knownTitles: job.knownTitles || [],
          maxCandidates: 4,
        },
      );

      // If strict dub filter found 0 candidates when both sub+dub were requested, fallback to "all" so sub still succeeds
      if (topCandidates.length === 0 && wantsSub && wantsDub) {
        topCandidates = ReleaseFilter.selectTopCandidates(
          torrents,
          job.episodeNumber,
          "all",
          {
            knownTitles: job.knownTitles || [],
            maxCandidates: 4,
          },
        );
      }

      if (topCandidates.length === 0) {
        throw new TorrentEntryNotFoundException(
          `No viable candidate releases found for AniList ${job.anilistId || "n/a"} / AniDB ${job.anidbId || "n/a"} Ep ${job.episodeNumber}`,
        );
      }

      let downloadedFilePath: string | null = null;
      let selectedCandidate: AnimeToshoItem | null = null;
      let selectedMagnet = "";
      let activeTorrentId: number | null = null;
      let lastCandidateErr: any = null;

      // Try up to top 3 candidates in order so a dead magnet or mismatched batch doesn't kill the job
      for (let cIdx = 0; cIdx < Math.min(3, topCandidates.length); cIdx++) {
        const [candidate, effectiveEp] = topCandidates[cIdx];
        const magnetUri = candidate.magnet_uri || candidate.torrent_url;
        if (!magnetUri) continue;

        let tId: number | null = null;
        try {
          log.info(
            "PipelineEngine",
            `[Job #${job.id}] Trying candidate ${cIdx + 1}/${Math.min(3, topCandidates.length)}: ${candidate.title}`,
          );

          const tInfo = await transmission.addTorrent(magnetUri, DEFAULT_DOWNLOAD_DIR);
          tId = tInfo.id;

          const metaStatus = await transmission.waitForMetadata(tId);
          const tFiles = metaStatus.files || [];
          const dlDir = metaStatus.downloadDir || DEFAULT_DOWNLOAD_DIR;

          const epMap = ReleaseFilter.matchFilesToEpisodes(tFiles, {
            knownTitles: job.knownTitles || [],
            targetEp: job.episodeNumber,
            effectiveEp,
          });

          if (!epMap.has(job.episodeNumber)) {
            throw new TorrentEntryNotFoundException(
              `Ep ${job.episodeNumber} not found in torrent ${candidate.title}`,
            );
          }

          const [wantedIdx, relPath] = epMap.get(job.episodeNumber)!;
          const fullPath = path.join(dlDir, relPath);

          const fileAlreadyExists = fs.existsSync(fullPath) && fs.statSync(fullPath).size > 1024;
          if (!fileAlreadyExists && tFiles.length > 1) {
            await transmission.selectOnlyFiles(tId, [wantedIdx], tFiles.length);
          }

          await transmission.startTorrent(tId);
          await transmission.waitForCompletion(tId, {
            wantedFileIndex: wantedIdx,
            expectedDiskPath: fullPath,
          });

          if (!fs.existsSync(fullPath) || fs.statSync(fullPath).size <= 1024) {
            throw new Error(`Downloaded video file missing or empty on disk: ${fullPath}`);
          }

          downloadedFilePath = fullPath;
          selectedCandidate = candidate;
          selectedMagnet = magnetUri;
          activeTorrentId = tId;
          break;
        } catch (candErr: any) {
          lastCandidateErr = candErr;
          log.warn(
            "PipelineEngine",
            `[Job #${job.id}] Candidate ${cIdx + 1} (${candidate.title}) failed: ${candErr?.message || candErr}`,
          );
          if (tId) {
            await transmission.removeTorrent(tId, true).catch(() => {});
          }
        }
      }

      if (!downloadedFilePath || !selectedCandidate) {
        throw lastCandidateErr || new Error("All torrent candidates failed to download");
      }

      const fSizeMb = (fs.statSync(downloadedFilePath).size / (1024 * 1024)).toFixed(1);
      log.success("PipelineEngine", `Video downloaded for Job #${job.id}: ${downloadedFilePath} (${fSizeMb} MB)`);

      // Probe MKV audio & subtitle streams to determine exact audio tracks ("sub" / "dub") to encode
      let tracksConfig: [string, number][] = [["sub", 0]];
      try {
        const probe = await inspectMkvStreamsSync(downloadedFilePath);
        const langMode = wantsSub && wantsDub ? "all" : wantsDub ? "dub" : "sub";
        tracksConfig = videoManager.determineTracksToEncode(probe, langMode);
        log.info(
          "PipelineEngine",
          `Job #${job.id} stream probe -> dualAudio=${probe.isDualAudio}, tracksToEncode=${JSON.stringify(tracksConfig)}`,
        );
      } catch (probeErr: any) {
        log.warn("PipelineEngine", `Job #${job.id} ffprobe warning, defaulting track config: ${probeErr?.message || probeErr}`);
        tracksConfig = wantsDub && !wantsSub ? [["dub", 0]] : [["sub", 0]];
      }

      // Extract subtitles & upload to Cloudflare R2
      const taskToken = crypto.randomUUID().slice(0, 8);
      const tempSubsDir = path.join(stagingDir, `subs_${taskToken}`);
      await fs.promises.mkdir(tempSubsDir, { recursive: true });

      let r2SubRecords: R2SubtitleRecord[] = [];
      try {
        const extractedSubs = await subtitles.extractSubtitlesFromMkv(downloadedFilePath, tempSubsDir);
        if (extractedSubs.length > 0) {
          const animeIdForPath = job.animeId || job.anilistId || job.anidbId || job.id;
          // Upload subtitles for each encoded audio track type
          for (const [trackType] of tracksConfig) {
            const uploaded = await subtitles.uploadSubtitles(
              extractedSubs,
              animeIdForPath,
              job.episodeNumber,
              trackType,
            );
            r2SubRecords.push(...uploaded);
          }
        }
      } finally {
        await fs.promises.rm(tempSubsDir, { recursive: true, force: true }).catch(() => {});
      }

      // Move video into persistent staging directory
      const ext = path.extname(downloadedFilePath) || ".mkv";
      const stagedFilename = `staged_${job.id}_${crypto.randomUUID().slice(0, 8)}${ext}`;
      const stagedPath = path.join(stagingDir, stagedFilename);

      try {
        await fs.promises.rename(downloadedFilePath, stagedPath);
      } catch {
        await fs.promises.copyFile(downloadedFilePath, stagedPath);
        await fs.promises.unlink(downloadedFilePath).catch(() => {});
      }

      const sizeBytes = fs.statSync(stagedPath).size;

      // Remove completed torrent from Transmission
      if (activeTorrentId) {
        await transmission.removeTorrent(activeTorrentId, true).catch(() => {});
      }

      await db
        .update(schema.pipelineJob)
        .set({
          status: "staged",
          stagedFilePath: stagedPath,
          sizeBytes,
          tracksConfig,
          torrentTitle: selectedCandidate.title,
          torrentMagnet: selectedMagnet,
          subtitlesPayload: r2SubRecords,
          lastError: null,
          stagedAt: new Date(),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineJob.id, jobId));

      log.success(
        "PipelineEngine",
        `Job #${job.id} staged on SSD: ${(sizeBytes / (1024 * 1024)).toFixed(1)} MB (tracks: ${tracksConfig.map((t) => t[0]).join("+")})`,
      );

      return { status: "staged", jobId, sizeBytes };
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
    totalBytes: number;
    oldestStagedAt: Date | null;
    newestStagedAt: Date | null;
    activeDownloadsOrQueued: number;
  }> {
    await this.ensureTables();

    const [staged, activeQueueRows] = await Promise.all([
      db
        .select({
          id: schema.pipelineJob.id,
          sizeBytes: schema.pipelineJob.sizeBytes,
          stagedAt: schema.pipelineJob.stagedAt,
           stagedFilePath: schema.pipelineJob.stagedFilePath,
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
    let totalBytes = 0;
    for (const s of staged) {
      totalBytes += Number(s.sizeBytes || 0);
    }
    const oldestStagedAt = staged[0]?.stagedAt || null;
    const newestStagedAt = staged[staged.length - 1]?.stagedAt || null;
    const activeDownloadsOrQueued = Number(activeQueueRows[0]?.count || 0);

    return {
      stagedCount,
      totalBytes,
      oldestStagedAt,
      newestStagedAt,
      activeDownloadsOrQueued,
    };
  }

  /**
   * Determines whether the current staged window should be sealed into a batch.
   * When forceFlush is false, seals only if:
   * - Staged count >= 10 files (KIRA_BATCH_MAX_ITEMS)
   * - Staged bytes >= 10 GB (KIRA_BATCH_SAFE_MAX_BYTES)
   * - Oldest staged item has waited >= 30m (KIRA_BATCH_WINDOW_MS)
   * - Queue is completely drained (0 queued & 0 downloading) and staged items have settled for >= 30s
   */
  public static async evaluateBatchSealReadiness(forceFlush = false): Promise<{
    shouldSeal: boolean;
    reason: string;
    stats: Awaited<ReturnType<typeof PipelineEngineService.getStagedWindowStats>>;
  }> {
    const stats = await this.getStagedWindowStats();
    if (stats.stagedCount === 0) {
      return { shouldSeal: false, reason: "no_staged_jobs", stats };
    }

    if (forceFlush) {
      return { shouldSeal: true, reason: "manual_flush", stats };
    }

    if (stats.stagedCount >= KIRA_BATCH_MAX_ITEMS) {
      return { shouldSeal: true, reason: "file_limit_10", stats };
    }

    if (stats.totalBytes >= KIRA_BATCH_SAFE_MAX_BYTES) {
      return { shouldSeal: true, reason: "size_cap_10gb", stats };
    }

    if (stats.oldestStagedAt && Date.now() - stats.oldestStagedAt.getTime() >= KIRA_BATCH_WINDOW_MS) {
      return { shouldSeal: true, reason: "window_30m", stats };
    }

    if (
      stats.activeDownloadsOrQueued === 0 &&
      stats.newestStagedAt &&
      Date.now() - stats.newestStagedAt.getTime() >= KIRA_QUEUE_IDLE_SETTLE_MS
    ) {
      return { shouldSeal: true, reason: "queue_drained", stats };
    }

    return { shouldSeal: false, reason: "waiting_for_window_or_downloads", stats };
  }

  /**
   * Atomically seals a single batch of up to 10 staged jobs / 10 GB and assigns it to the least-loaded Kaggle account (< 2 active notebooks).
   * Uses a PostgreSQL transaction + advisory lock to prevent concurrent race conditions.
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
      log.warn("PipelineEngine", "No Kaggle accounts configured; cannot seal GPU batch");
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    const readiness = await this.evaluateBatchSealReadiness(Boolean(options.forceFlush));
    if (!readiness.shouldSeal) {
      return { batchId: null, jobCount: 0, totalBytes: 0 };
    }

    return await db.transaction(async (tx) => {
      // Acquire transaction-scoped advisory lock so concurrent workers never double-seal
      const lockRes = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(405001) AS locked`);
      const isLocked = Boolean((lockRes[0] as any)?.locked);
      if (!isLocked) {
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      const maxConcurrentBatches = kaggleAccounts.length * KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT;

      const activeBatches = await tx
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
          `Kaggle cluster at full capacity (${activeBatches.length}/${maxConcurrentBatches} active notebooks). Staged episodes will seal as soon as a slot frees.`,
        );
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      const usageMap: Record<string, number> = {};
      for (const b of activeBatches) {
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

      if (stagedJobs.length === 0) {
        return { batchId: null, jobCount: 0, totalBytes: 0 };
      }

      // Verify staged files actually exist on disk; if a staged file is missing, reset job to queued
      const validStagedJobs: typeof stagedJobs = [];
      for (const j of stagedJobs) {
        if (j.stagedFilePath && fs.existsSync(j.stagedFilePath)) {
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

      // Pack up to 10 GB safe cap OR max 10 files
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
          status: "encoding",
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(inArray(schema.pipelineJob.id, jobIds));

      log.success(
        "PipelineEngine",
        `Sealed Batch #${batch.id} [${effectiveReason}] -> @${selectedAccount.username} (Slot ${eligibleAccounts[0].activeCount + 1}/${KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT}): ${packedJobs.length} jobs, ${(accBytes / (1024 * 1024 * 1024)).toFixed(2)} GB`,
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
   * Seals as many concurrent batches as there are available Kaggle slots and eligible staged jobs.
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

  /**
   * Helper to build upload items and manifest items for a batch, resolving audio tracks accurately.
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

      // Resolve audio tracks ("sub" / "dub") from saved tracksConfig or live MKV stream probe
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

      uploadItems.push({
        jobId: job.id,
        localFilePath: job.stagedFilePath,
        remoteFilename: safeRel,
        sizeBytes,
      });

      manifestItems.push({
        jobId: job.id,
        filename: safeRel,
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

  /**
   * Resolves the Kaggle account assigned to a batch (or selects a healthy fallback account).
   */
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

  /**
   * Phase 1 (Durable & Idempotent): Uploads the batch dataset to Kaggle GCS if not already uploaded.
   */
  public static async prepareAndUploadBatchDataset(batchId: number): Promise<{
    skipped: boolean;
    empty: boolean;
    datasetSlug: string;
    kernelSlug: string;
    kaggleUsername: string;
  }> {
    await this.ensureTables();

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch) {
      throw new Error(`Batch #${batchId} not found`);
    }

    const account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
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

    // If batch is already in waiting_dataset or kernel_running after a service restart, check if dataset exists on Kaggle
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
      `Batch #${batchId}: Uploading ${uploadItems.length} staged MKV(s) to Kaggle Dataset '${account.username}/${datasetSlug}'...`,
    );

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

    await db
      .update(schema.pipelineBatch)
      .set({
        status: "waiting_dataset",
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
  }

  /**
   * Phase 2 (Durable & Idempotent): Waits for Kaggle to finish indexing the uploaded dataset before pushing the kernel.
   * This prevents Kaggle "Dataset not found" or empty /kaggle/input errors.
   */
  public static async waitBatchDatasetReady(batchId: number): Promise<void> {
    await this.ensureTables();

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
      600,
      async () => {
        await db
          .update(schema.pipelineBatch)
          .set({ heartbeatAt: new Date(), updatedAt: new Date() })
          .where(eq(schema.pipelineBatch.id, batchId));
      },
    );
  }

  /**
   * Phase 3 (Durable & Idempotent): Pushes the GPU kernel to Kaggle (or re-attaches if already running).
   */
  public static async pushBatchKernel(batchId: number): Promise<void> {
    await this.ensureTables();

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch || batch.status === "completed") {
      return;
    }

    const account = this.resolveBatchKaggleAccount(batch.kaggleUsername);
    const datasetSlug = batch.datasetSlug;
    const kernelSlug = batch.kernelSlug;
    if (!datasetSlug || !kernelSlug) {
      throw new Error(`Batch #${batchId} missing datasetSlug or kernelSlug`);
    }

    const videoManager = new VideoEncodingManager();

    // If batch was already in kernel_running (e.g. after service restart), check if kernel is already active on Kaggle
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

    const { manifestItems } = await this.buildBatchItems(batchId, videoManager);
    if (manifestItems.length === 0) {
      throw new Error(`Batch #${batchId} has 0 valid manifest items to push`);
    }

    await videoManager.pushBatchGpuKernel(
      datasetSlug,
      kernelSlug,
      manifestItems,
      account.username,
      account.key,
    );

    await db
      .update(schema.pipelineBatch)
      .set({
        status: "kernel_running",
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.pipelineBatch.id, batchId));
  }

  /**
   * Phase 4 (Durable Single Check): Checks Kaggle kernel status once and updates batch heartbeat.
   */
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

  /**
   * Delivers a PipelineEpisodeResult payload to Main Backend (localhost:4000) with x-internal-secret and exponential backoff.
   */
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

  /**
   * Phase 5 (Durable & Idempotent): Fetches encoded output from Kaggle, persists results, delivers callbacks to Main Backend,
   * cleans up staged files and Kaggle resources, and re-stages any partial failed jobs.
   */
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
        const canReStage =
          job.attempt < MAX_JOB_ATTEMPTS &&
          job.stagedFilePath &&
          fs.existsSync(job.stagedFilePath);

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

      // Group jobOutputs by track type ("sub" / "dub")
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

      // 1. Persist resultPayload in DB FIRST so even if Main Backend (:4000) is restarting, streams are safe
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

      // 2. Deliver callback(s) to Main Backend (:4000) for each encoded track ("sub" and/or "dub")
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

      // Record callback delivery status in job.metadata so Watchdog can auto-retry if Main Backend was restarting
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

      // 3. Delete local staged MKV file now that encoding is complete
      if (job.stagedFilePath && fs.existsSync(job.stagedFilePath)) {
        await fs.promises.unlink(job.stagedFilePath).catch(() => {});
      }
    }

    // Clean up Kaggle Dataset & Kernel
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
      `Batch #${batchId} completed on Kaggle (@${account.username})! Slot is now free.`,
    );
  }

  /**
   * Handles a batch failure by cleaning up Kaggle artifacts and returning eligible staged jobs
   * back to 'staged' status so they can be re-batched without re-downloading torrents.
   */
  public static async handleBatchFailure(batchId: number, errorMsg: string): Promise<void> {
    await this.ensureTables();

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch || batch.status === "completed") return;

    log.error("PipelineEngine", `Batch #${batchId} failed: ${errorMsg}`);

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

      const hasStagedFile = Boolean(job.stagedFilePath && fs.existsSync(job.stagedFilePath));
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

  /**
   * Direct end-to-end batch executor (used as fallback when running outside multi-step Inngest).
   */
  public static async executeBatch(batchId: number): Promise<void> {
    try {
      const prep = await this.prepareAndUploadBatchDataset(batchId);
      if (prep.empty) return;

      await this.waitBatchDatasetReady(batchId);
      await this.pushBatchKernel(batchId);

      const kernelStartTime = Date.now();
      while (Date.now() - kernelStartTime < 6 * 3600 * 1000) {
        await new Promise((r) => setTimeout(r, 45000));
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

  /**
   * Re-delivers any completed job callbacks that failed while Main Backend (localhost:4000) was restarting.
   */
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

    const maxConcurrentBatches = Math.max(2, kaggleAccounts.length * KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT);

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
        lastWatchdogRun: lastWatchdogTimestamp,
      },
    };
  }
}
