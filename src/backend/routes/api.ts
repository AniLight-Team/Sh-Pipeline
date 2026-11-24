import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, and, inArray, asc, notInArray, isNull, or } from "drizzle-orm";
import { PipelineEngineService } from "../engine/service.js";
import { AnimeMetadataResolver } from "../engine/metadata-resolver.js";
import { TsukihimeClient } from "../engine/tsukihime.client.js";
import { ReleaseFilter } from "../engine/release-filter.js";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { INTERNAL_SECRET, TorrentEntryNotFoundException } from "../config.js";
import { discoveryEvent, resetRetryMetadata } from "../engine/job-scheduling.js";
import { inngest } from "../inngest/client.js";
import { log } from "../utils/logger.js";
import type {
  PipelineExecutionPolicy,
} from "../engine/types.js";

const positiveId = z.number().int().positive();
const streamTypes = z.array(z.enum(["sub", "dub"])).min(1).max(2);
const enqueueSchema = z.object({
  animeId: positiveId.optional(),
  anilistId: positiveId.optional(),
  anidbId: positiveId.optional(),
  episodeNumbers: z.array(positiveId).min(1).max(1000).optional(),
  types: streamTypes.optional(),
  episodes: z.array(z.object({
    episodeNumber: positiveId,
    types: streamTypes,
    sourceJobId: positiveId.nullable().optional(),
    sourceUrl: z.url({ protocol: /^https?$/ }).max(2048).optional(),
    manualTsukihimeTorrentId: positiveId.optional(),
  })).min(1).max(100).optional(),
  kind: z.enum(["release", "stream_refresh", "caption_refresh"]).optional(),
  requestId: z.string().min(1).max(200).optional(),
  knownTitles: z.array(z.string().min(1).max(500)).max(30).optional(),
  episodeCount: positiveId.optional(),
  metadata: z.record(z.string(), z.any()).optional(),
  executionPolicy: z.enum(["all", "vm_remux_only", "kaggle_gpu_only"]).optional(),
  manualTsukihimeTorrentId: positiveId.optional(),
});

async function dispatchJobDiscovery(...jobs: Parameters<typeof discoveryEvent>[0][]) {
  if (!jobs.length) return;
  try {
    await inngest.send(jobs.map(job => discoveryEvent(job, "discover")));
  } catch (err: any) {
    log.warn("API", `Inngest server unavailable (${err?.message || err}); using the background queue for ${jobs.length} job(s).`);
    for (const job of jobs) {
      PipelineEngineService.stage1DiscoveryQueue.add(async () => {
        const result = await PipelineEngineService.discoverAndStageJob(job.id);
        if (result.status !== "staged") return;
        await PipelineEngineService.drainVmRemuxQueue();
        const readiness = await PipelineEngineService.evaluateBatchSealReadiness(false);
        if (!readiness.shouldSeal) return;
        const batchIds = await PipelineEngineService.sealAvailableBatches({
          forceFlush: false,
          triggerReason: readiness.reason,
        });
        for (const id of batchIds) await PipelineEngineService.executeBatch(id).catch(() => {});
      }).catch(error => log.warn("API", `Background discovery for job #${job.id}: ${String(error)}`));
    }
  }
}

/**
 * Helper that dispatches a batch execution event via Inngest, falling back to direct async execution
 * if the external Inngest server (:8288) is unreachable.
 */
async function dispatchBatchExecution(batchId: number) {
  try {
    await inngest.send({
      name: "pipeline/batch.execute",
      id: `pipeline-batch-${batchId}-${Date.now()}`,
      data: { batchId },
    });
  } catch (err: any) {
    log.warn("API", `Inngest server unreachable (${err?.message || err}); executing Batch #${batchId} directly in background.`);
    setImmediate(() => {
      PipelineEngineService.executeBatch(batchId).catch(() => {});
    });
  }
}

export const apiRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get("/health", async () => {
    return { ok: true, timestamp: new Date().toISOString() };
  });

  app.get("/stats", async () => {
    return await PipelineEngineService.getStats();
  });

  app.get("/pipeline/policy", async () => {
    return {
      ok: true,
      policy: PipelineEngineService.getExecutionPolicy(),
    };
  });

  app.post("/pipeline/policy", async (req, reply) => {
    const body = req.body as {
      policy?: PipelineExecutionPolicy;
      requeueSkipped?: boolean;
    };
    const policy = body?.policy;
    if (
      policy !== "all" &&
      policy !== "vm_remux_only" &&
      policy !== "kaggle_gpu_only"
    ) {
      return reply.status(400).send({
        error: "Valid policy ('all' | 'vm_remux_only' | 'kaggle_gpu_only') is required",
      });
    }

    const res = await PipelineEngineService.setExecutionPolicy(policy, {
      requeueSkipped: Boolean(body?.requeueSkipped),
      applyToStaged: true,
    });

    for (const rJob of res.requeuedJobs) {
      if (rJob.status === "queued") {
        await dispatchJobDiscovery(rJob);
      }
    }

    const startedVmJobIds = await PipelineEngineService.drainVmRemuxQueue();
    const sealedBatchIds = await PipelineEngineService.sealAvailableBatches({
      forceFlush: false,
      triggerReason: `policy_${policy}`,
    });
    for (const bId of sealedBatchIds) {
      await dispatchBatchExecution(bId);
    }

    const policyLabel =
      policy === "vm_remux_only"
        ? "Pipeline 1 Only (VM H.264 Remux)"
        : policy === "kaggle_gpu_only"
          ? "Pipeline 2 Only (Kaggle GPU)"
          : "Both Pipelines (Auto Waterfall)";

    return {
      ok: true,
      policy: res.policy,
      skippedStagedCount: res.skippedStagedCount,
      requeuedCount: res.requeuedJobs.length,
      startedVmJobIds,
      dispatchedBatchIds: sealedBatchIds,
      message: `Switched execution mode to ${policyLabel}${res.skippedStagedCount > 0 ? ` (${res.skippedStagedCount} incompatible staged job(s) marked skipped)` : ""}${res.requeuedJobs.length > 0 ? ` (${res.requeuedJobs.length} skipped job(s) re-queued)` : ""}.`,
    };
  });

  app.get("/storage/staged-files", async () => {
    const report = await PipelineEngineService.inspectStagedFilesOnDisk();
    return { ok: true, report };
  });

  app.post("/storage/cleanup-orphans", async () => {
    const res = await PipelineEngineService.cleanupOrphanedStagedFiles();
    const freedMb = (res.freedBytes / (1024 * 1024)).toFixed(1);
    return {
      ok: true,
      ...res,
      message: `Cleaned ${res.deletedCount} orphaned file(s) (${freedMb} MB freed)${res.requeuedMissingJobs > 0 ? ` and re-queued ${res.requeuedMissingJobs} job(s) with missing files` : ""}.`,
    };
  });

  app.post("/storage/cleanup-kaggle", async () => {
    const res = await PipelineEngineService.cleanupOrphanedKaggleResources({
      maxDeletesPerAccount: 200,
      minAgeMinutes: 10,
    });
    const freedGb = (res.freedBytes / (1024 ** 3)).toFixed(2);
    return {
      ok: true,
      ...res,
      message: `Deleted ${res.deletedDatasets} Kaggle dataset(s) (${freedGb} GiB freed) and ${res.deletedKernels} notebook(s)${res.skippedLiveRunning > 0 ? `, protected ${res.skippedLiveRunning} active item(s)` : ""}${res.failedDeletes > 0 ? ` (${res.failedDeletes} failed)` : ""}.`,
    };
  });


  // Resolve AniList ID to AniDB ID, Tsukihime ID, internal anime ID, title variations, and cover art
  app.get("/anime/resolve", async (req, reply) => {
    const query = req.query as { anilistId?: string };
    const anilistId = parseInt(query.anilistId || "", 10);
    if (isNaN(anilistId) || anilistId <= 0) {
      return reply.status(400).send({ error: "Valid anilistId query parameter is required" });
    }

    try {
      const metadata = await AnimeMetadataResolver.resolve(anilistId);
      return { ok: true, metadata };
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || "Failed to resolve anime metadata" });
    }
  });

  // Per-anime discovery rules (strict episode offset, source Tsukihime/AniDB override, custom search titles)
  app.get("/anime/rules", async () => {
    const rules = await PipelineEngineService.listAnimeDiscoveryRules();
    return { ok: true, rules };
  });

  app.post("/anime/rules", async (req, reply) => {
    const ruleSchema = z.object({
      anilistId: positiveId.nullable().optional(),
      animeId: positiveId.nullable().optional(),
      episodeOffset: z.number().int().min(0).max(5000).default(0),
      sourceTsukihimeId: positiveId.nullable().optional(),
      sourceAnidbId: positiveId.nullable().optional(),
      searchTitles: z.array(z.string().min(1).max(300)).max(20).optional(),
      notes: z.string().max(500).nullable().optional(),
    });
    const parsed = ruleSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "Invalid anime discovery rule payload" });
    }
    if (!parsed.data.anilistId && !parsed.data.animeId) {
      return reply.status(400).send({ error: "Either anilistId or animeId is required" });
    }
    try {
      const rule = await PipelineEngineService.upsertAnimeDiscoveryRule(parsed.data);
      return {
        ok: true,
        rule,
        message: `Saved discovery rule for ${rule.anilistId ? `AniList #${rule.anilistId}` : `Anime #${rule.animeId}`} (offset +${rule.episodeOffset}).`,
      };
    } catch (err: any) {
      return reply.status(500).send({ error: err?.message || "Failed to save anime discovery rule" });
    }
  });

  app.delete("/anime/rules/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const ruleId = Number.parseInt(id, 10);
    if (!Number.isSafeInteger(ruleId) || ruleId <= 0) {
      return reply.status(400).send({ error: "Valid rule ID is required" });
    }
    const deleted = await PipelineEngineService.deleteAnimeDiscoveryRule(ruleId);
    if (!deleted) return reply.status(404).send({ error: "Rule not found" });
    return { ok: true, message: `Deleted discovery rule #${ruleId}.` };
  });

  // Resolve a single Tsukihime torrent ID directly for manual discovery preview
  app.get("/tsukihime/torrents/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const torrentId = Number.parseInt(id, 10);
    if (!Number.isSafeInteger(torrentId) || torrentId <= 0 || String(torrentId) !== id.trim()) {
      return reply.status(400).send({ error: "Valid numeric Tsukihime torrent ID is required" });
    }

    try {
      const entry = await TsukihimeClient.fetchTorrentById(torrentId);
      if (!entry) {
        return reply.status(404).send({ error: `Tsukihime torrent #${torrentId} was not found` });
      }
      const item = TsukihimeClient.toAnimeToshoItem(entry);
      const knownTitles = [entry.anime?.title, entry.anime?.english_title].filter(Boolean);
      const parsed = ReleaseFilter.parseTitle(entry.name, knownTitles, item);
      return {
        ok: true,
        torrent: {
          id: entry.id,
          name: entry.name,
          btih: entry.btih,
          state: entry.state,
          totalsize: entry.totalsize ?? null,
          filecount: entry.filecount ?? entry.files?.length ?? 1,
          episode_no: entry.episode_no ?? null,
          audiolangs: entry.audiolangs ?? [],
          sublangs: entry.sublangs ?? [],
          group: entry.group ?? null,
          anime: entry.anime ?? null,
          seeders: item.seeders ?? 0,
          leechers: item.leechers ?? 0,
          resolution: parsed.resolution ?? "1080p",
          videoCodec: parsed.isAv1 ? "av1" : parsed.isHevcOrAv1 ? "hevc" : "h264",
          expectedPipeline: parsed.isH264 ? "vm_remux" : "kaggle_gpu",
          isDualAudio: parsed.isDualAudio,
          isEnglishDub: parsed.isEnglishDub,
          files: Array.isArray(entry.files)
            ? entry.files.slice(0, 25).map(file => ({
                id: file.id,
                filename: file.filename,
                size: file.size,
              }))
            : [],
        },
      };
    } catch (err: any) {
      const message = err?.message || "Failed to look up Tsukihime torrent";
      const status = /adult|valid info hash|incomplete metadata/i.test(message) ? 400 : 502;
      return reply.status(status).send({ error: message });
    }
  });

  app.post("/pipeline/enqueue", async (req, reply) => {
    const parsed = enqueueSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: "Invalid enqueue request" });
    const body = parsed.data;
    const hasManualTorrent = Boolean(
      body.manualTsukihimeTorrentId || body.episodes?.some(ep => ep.manualTsukihimeTorrentId),
    );
    if (!(body.anilistId || body.animeId || body.anidbId || hasManualTorrent ||
        positiveId.safeParse(Number(body.metadata?.anilistId)).success ||
        positiveId.safeParse(Number(body.metadata?.animeId)).success)) {
      return reply.status(400).send({ error: "An anime identifier or Tsukihime torrent ID is required" });
    }
    if (body.kind || body.episodes || body.requestId) {
      const token = req.headers["x-internal-secret"];
      if (!INTERNAL_SECRET) return reply.status(503).send({ error: "Pipeline authentication is not configured" });
      if (typeof token !== "string" || Buffer.byteLength(token) !== Buffer.byteLength(INTERNAL_SECRET) ||
          !timingSafeEqual(Buffer.from(token), Buffer.from(INTERNAL_SECRET))) {
        return reply.status(401).send({ error: "Unauthorized" });
      }
      if (!body.episodes || !body.kind || !body.requestId) {
        return reply.status(400).send({ error: "episodes, kind, and requestId are required" });
      }
    } else if (!body.episodeNumbers && !hasManualTorrent) {
      return reply.status(400).send({ error: "episodeNumbers are required" });
    }

    try {
      const res = await PipelineEngineService.enqueue(body);
      await dispatchJobDiscovery(...res.queuedJobs);
      return res;
    } catch (err: any) {
      if (err instanceof TorrentEntryNotFoundException) {
        return reply.status(404).send({ error: err.message });
      }
      const message = err?.message || "Failed to enqueue jobs";
      if (/adult|valid info hash|incomplete metadata/i.test(message)) {
        return reply.status(400).send({ error: message });
      }
      return reply.status(500).send({ error: message });
    }
  });

  app.get("/jobs", async (req) => {
    const query = req.query as Record<string, string | undefined>;
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit || "100", 10) || 100));
    const offset = Math.max(0, Number.parseInt(query.offset || "0", 10) || 0);
    await PipelineEngineService.ensureTables();
    const conditions: any[] = [];
    if (query.status === "active") conditions.push(inArray(schema.pipelineJob.status, ["downloading", "encoding"]));
    else if (query.status && query.status !== "all") conditions.push(eq(schema.pipelineJob.status, query.status as any));
    for (const key of ["anilistId", "animeId", "anidbId"] as const) {
      const value = Number(query[key]);
      if (Number.isSafeInteger(value) && value > 0) conditions.push(eq(schema.pipelineJob[key], value));
    }
    if (query.mode === "vm_remux" || query.mode === "kaggle_gpu") conditions.push(eq(schema.pipelineJob.pipelineType, query.mode));
    if (query.search?.trim()) {
      const term = query.search.trim().slice(0, 200);
      conditions.push(sql`(strpos(lower(coalesce(${schema.pipelineJob.torrentTitle}, '')), lower(${term})) > 0
        OR strpos(lower(coalesce(${schema.pipelineJob.metadata}->>'primaryTitle', '')), lower(${term})) > 0
        OR strpos(lower(coalesce(${schema.pipelineJob.knownTitles}::text, '')), lower(${term})) > 0
        OR ${schema.pipelineJob.id}::text = ${term} OR ${schema.pipelineJob.animeId}::text = ${term}
        OR ${schema.pipelineJob.anilistId}::text = ${term} OR ${schema.pipelineJob.anidbId}::text = ${term})`);
    }
    const where = and(...conditions);
    const [jobs, counts] = await Promise.all([
      db.select().from(schema.pipelineJob).where(where).orderBy(desc(schema.pipelineJob.id)).limit(limit).offset(offset),
      db.select({ total: sql<number>`count(*)::int` }).from(schema.pipelineJob).where(where),
    ]);
    return { jobs, total: counts[0]?.total ?? 0, limit, offset };
  });

  app.post("/jobs/:id/retry", async (req, reply) => {
    const { id } = req.params as { id: string };
    const jobId = parseInt(id, 10);

    const existing = await db.query.pipelineJob.findFirst({
      where: eq(schema.pipelineJob.id, jobId),
    });

    if (!existing) {
      return reply.status(404).send({ error: "Job not found" });
    }

    if (["downloading", "encoding", "completed"].includes(existing.status) || (existing.batchId && existing.status !== "failed")) {
      return reply.status(409).send({ error: "This job is active or completed. Only inactive unfinished jobs can be retried." });
    }
    const hasStagedFile = PipelineEngineService.hasValidStagedFiles(existing);

    const [updated] = await db
      .update(schema.pipelineJob)
      .set({
        status: hasStagedFile ? "staged" : "queued",
        batchId: null,
        lastError: null,
        attempt: 0,
        discoverAfter: null,
        ...(hasStagedFile ? {} : { metadata: resetRetryMetadata(existing.metadata) }),
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, existing.status)))
      .returning();
    if (!updated) return reply.status(409).send({ error: "Job changed while retrying. Refresh and try again." });

    if (hasStagedFile) {
      log.info("API", `Job #${jobId} already has staged MKV on SSD; returned directly to 'staged' queue.`);
      const sealed = await PipelineEngineService.sealAvailableBatches({
        forceFlush: false,
        triggerReason: "job_retried_staged",
      });
      for (const bId of sealed) {
        await dispatchBatchExecution(bId);
      }
      await inngest
        .send({
          name: "pipeline/batch.arm-timer",
          data: { reason: "job_retried_staged", jobId: updated.id },
        })
        .catch(() => {});
    } else {
      await dispatchJobDiscovery(updated);
      log.info("API", `Retried Job #${jobId} (dispatched torrent discovery)`);
    }

    return { ok: true, job: updated };
  });

  // Pin (or clear) a manual Tsukihime torrent ID for an existing job and immediately re-run discovery
  app.post("/jobs/:id/manual-torrent", async (req, reply) => {
    const { id } = req.params as { id: string };
    const jobId = Number.parseInt(id, 10);
    if (!Number.isSafeInteger(jobId) || jobId <= 0) {
      return reply.status(400).send({ error: "Valid job ID is required" });
    }

    const body = (req.body || {}) as { tsukihimeTorrentId?: number | string | null };
    const rawTid = body.tsukihimeTorrentId;
    const isClear = rawTid === null || rawTid === undefined || rawTid === "";
    const torrentId = isClear ? null : Number(rawTid);
    if (!isClear && (!Number.isSafeInteger(torrentId) || (torrentId ?? 0) <= 0)) {
      return reply.status(400).send({ error: "Valid numeric Tsukihime torrent ID is required" });
    }

    await PipelineEngineService.ensureTables();
    const existing = await db.query.pipelineJob.findFirst({
      where: eq(schema.pipelineJob.id, jobId),
    });
    if (!existing) {
      return reply.status(404).send({ error: "Job not found" });
    }
    if (["downloading", "encoding", "completed"].includes(existing.status) || (existing.batchId && existing.status !== "failed")) {
      return reply.status(409).send({ error: "This job is active or completed. Only inactive unfinished jobs can be reassigned." });
    }
    if (existing.metadata?.kind === "quality_backfill") {
      return reply.status(409).send({ error: "Quality backfill jobs cannot be pinned to a manual Tsukihime torrent." });
    }

    let entryName: string | undefined;
    let entryAnimeId: number | undefined;
    if (torrentId !== null) {
      try {
        const entry = await TsukihimeClient.fetchTorrentById(torrentId);
        if (!entry) {
          return reply.status(404).send({ error: `Tsukihime torrent #${torrentId} was not found` });
        }
        entryName = entry.name;
        entryAnimeId = entry.anime?.id;
      } catch (err: any) {
        return reply.status(400).send({ error: err?.message || `Failed to fetch Tsukihime torrent #${torrentId}` });
      }
    }

    const nextMeta = resetRetryMetadata(existing.metadata);
    if (torrentId !== null) {
      nextMeta.manualTsukihimeTorrentId = torrentId;
      if (entryName) nextMeta.manualTsukihimeTorrentName = entryName;
      if (entryAnimeId && !nextMeta.tsukihimeId) nextMeta.tsukihimeId = entryAnimeId;
    } else {
      delete nextMeta.manualTsukihimeTorrentId;
      delete nextMeta.manualTsukihimeTorrentName;
    }

    const now = new Date();
    const [updated] = await db
      .update(schema.pipelineJob)
      .set({
        status: "queued",
        batchId: null,
        lastError: null,
        attempt: 0,
        discoverAfter: null,
        stagedFilePath: null,
        stagedQualities: null,
        torrentId: torrentId ?? null,
        torrentTitle: torrentId !== null ? (entryName ?? null) : null,
        metadata: nextMeta,
        heartbeatAt: now,
        updatedAt: now,
      })
      .where(and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, existing.status)))
      .returning();

    if (!updated) {
      return reply.status(409).send({ error: "Job changed while updating manual torrent. Refresh and try again." });
    }

    await PipelineEngineService.cleanupJobStagedFiles(existing).catch(() => {});
    await dispatchJobDiscovery(updated);

    const message = torrentId !== null
      ? `Job #${jobId} pinned to Tsukihime torrent #${torrentId} and queued for immediate staging.`
      : `Cleared manual torrent override on Job #${jobId} and queued for automatic discovery.`;
    log.info("API", message);
    return { ok: true, job: updated, message };
  });

  app.post("/jobs/:id/delete", async (req, reply) => {
    const { id } = req.params as { id: string };
    const jobId = parseInt(id, 10);

    const existing = await db.query.pipelineJob.findFirst({
      where: eq(schema.pipelineJob.id, jobId),
    });
    if (existing && (["downloading", "encoding"].includes(existing.status) || (existing.batchId && !["failed", "completed"].includes(existing.status)))) {
      return reply.status(409).send({ error: "This job is active. Wait for processing to stop before deleting files." });
    }
    if (!existing) return reply.status(404).send({ error: "Job not found" });
    const deleted = await db.delete(schema.pipelineJob)
      .where(and(eq(schema.pipelineJob.id, jobId), eq(schema.pipelineJob.status, existing.status)))
      .returning();
    if (!deleted.length) return reply.status(409).send({ error: "Job changed while deleting. Refresh and try again." });
    await PipelineEngineService.cleanupJobStagedFiles(existing);

    log.info("API", `Deleted Job #${jobId}`);
    return { ok: true };
  });

  /**
   * Multi-Select Bulk Job Operations:
   * - "retry": Retry selected jobs (preserving staged files on SSD if present)
   * - "delete": Delete selected jobs and clean up all staged quality files
   * - "force_remux": Route selected staged/failed jobs to VM Direct-Remux (-c:v copy) and seal immediately
   * - "force_gpu": Route selected staged/failed jobs to Kaggle GPU re-encoding
   * - "sync_callbacks": Re-deliver Main Backend webhook callbacks for selected completed jobs
   */
  app.post("/jobs/bulk", async (req, reply) => {
    const body = req.body as {
      jobIds?: number[];
      action?: "retry" | "delete" | "force_remux" | "force_gpu" | "sync_callbacks";
    };

    const rawIds = Array.isArray(body?.jobIds) ? body.jobIds : [];
    const jobIds = Array.from(new Set(rawIds.map((n) => Number(n)).filter((n) => !isNaN(n) && n > 0)));
    const action = body?.action;

    if (jobIds.length === 0 || !action) {
      return reply.status(400).send({ error: "Valid jobIds array and action are required" });
    }

    await PipelineEngineService.ensureTables();
    const targetJobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(inArray(schema.pipelineJob.id, jobIds));

    if (targetJobs.length === 0) {
      return { ok: true, affected: 0, message: "No matching jobs found" };
    }

    if (action !== "sync_callbacks" && targetJobs.some(job => ["downloading", "encoding"].includes(job.status) || (job.batchId && !["failed", "completed"].includes(job.status)))) {
      return reply.status(409).send({ error: "Selection contains active jobs. Wait for processing to stop before changing them." });
    }
    if (action === "retry" && targetJobs.some(job => job.status === "completed")) {
      return reply.status(409).send({ error: "Completed jobs cannot be retried. Use delivery callback recovery instead." });
    }
    if (action === "delete") {
      const deleted = await db.delete(schema.pipelineJob).where(and(
        inArray(schema.pipelineJob.id, jobIds),
        notInArray(schema.pipelineJob.status, ["downloading", "encoding"]),
        or(isNull(schema.pipelineJob.batchId), inArray(schema.pipelineJob.status, ["failed", "completed"])),
      )).returning();
      for (const job of deleted) await PipelineEngineService.cleanupJobStagedFiles(job);
      return { ok: true, affected: deleted.length, message: `Deleted ${deleted.length} job(s) and their local files; ${targetJobs.length - deleted.length} changed jobs were left untouched.` };
    }

    if (action === "retry") {
      let stagedRestored = 0;
      let rediscovered = 0;

      for (const job of targetJobs) {
        const hasStaged = PipelineEngineService.hasValidStagedFiles(job);
        const [updated] = await db
          .update(schema.pipelineJob)
          .set({
            status: hasStaged ? "staged" : "queued",
            batchId: null,
            lastError: null,
            attempt: 0,
            discoverAfter: null,
            ...(hasStaged ? {} : { metadata: resetRetryMetadata(job.metadata) }),
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(and(eq(schema.pipelineJob.id, job.id), eq(schema.pipelineJob.status, job.status)))
          .returning();
        if (!updated) continue;

        if (hasStaged) {
          stagedRestored++;
        } else if (updated) {
          rediscovered++;
          await dispatchJobDiscovery(updated);
        }
      }

      if (stagedRestored > 0) {
        const sealed = await PipelineEngineService.sealAvailableBatches({
          forceFlush: false,
          triggerReason: "bulk_retry",
        });
        for (const bId of sealed) {
          await dispatchBatchExecution(bId);
        }
      }

      return {
        ok: true,
        affected: stagedRestored + rediscovered,
        message: `Retried ${stagedRestored + rediscovered} job(s) (${stagedRestored} restored from SSD staging, ${rediscovered} queued for discovery).`,
      };
    }

    if (action === "force_remux" || action === "force_gpu") {
      if (targetJobs.some(job => job.metadata?.kind === "quality_backfill")) {
        return reply.status(409).send({ error: "Quality backfills choose the worker from their source. Use Retry to run a backfill again." });
      }
      const targetMode = action === "force_remux" ? "vm_remux" : "kaggle_gpu";
      let updatedCount = 0;

      for (const job of targetJobs) {
        if (job.status === "completed") continue;
        const hasStaged = PipelineEngineService.hasValidStagedFiles(job);
        const nextStatus =
          job.status === "completed"
            ? "completed"
            : hasStaged
              ? "staged"
              : "queued";

        const changed = await db
          .update(schema.pipelineJob)
          .set({
            status: nextStatus,
            batchId: nextStatus === "staged" ? null : job.batchId,
            pipelineType: targetMode,
            metadata: {
              ...(job.metadata || {}),
              processingMode: targetMode,
            },
            updatedAt: new Date(),
          })
          .where(and(eq(schema.pipelineJob.id, job.id), eq(schema.pipelineJob.status, job.status)))
          .returning({ id: schema.pipelineJob.id });
        if (changed.length) updatedCount++;
      }

      const startedVmIds = await PipelineEngineService.drainVmRemuxQueue();
      const sealed = await PipelineEngineService.sealAvailableBatches({
        forceFlush: action === "force_gpu",
        triggerReason: action === "force_remux" ? "manual_vm_remux" : "manual_mode_switch",
      });
      for (const bId of sealed) {
        await dispatchBatchExecution(bId);
      }

      return {
        ok: true,
        affected: updatedCount,
        startedVmJobIds: startedVmIds,
        dispatchedBatchIds: sealed,
        message: `Updated ${updatedCount} job(s) to ${targetMode === "vm_remux" ? "VM Direct Remux (-c:v copy, 2-slot queue)" : "Kaggle GPU Encode"}${startedVmIds.length > 0 ? ` and started ${startedVmIds.length} VM remux slot(s)` : ""}${sealed.length > 0 ? ` and dispatched ${sealed.length} GPU batch(es)` : ""}.`,
      };
    }

    if (action === "sync_callbacks") {
      let delivered = 0;
      for (const job of targetJobs) {
        if (await PipelineEngineService.retryJobCallback(job.id, true)) delivered++;
      }
      return {
        ok: true,
        affected: delivered,
        message: `Synchronized webhook callbacks for ${delivered}/${targetJobs.length} selected job(s).`,
      };
    }

    return reply.status(400).send({ error: `Unsupported bulk action: ${action}` });
  });

  app.post("/jobs/retry-all-failed", async () => {
    await PipelineEngineService.ensureTables();
    const failedJobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.status, "failed"));

    if (failedJobs.length === 0) {
      return { ok: true, count: 0, message: "No failed jobs to retry." };
    }

    let stagedCount = 0;
    for (const job of failedJobs) {
      const hasStaged = PipelineEngineService.hasValidStagedFiles(job);
      const [updated] = await db
        .update(schema.pipelineJob)
        .set({
          status: hasStaged ? "staged" : "queued",
          batchId: null,
          lastError: null,
          attempt: 0,
          discoverAfter: null,
          ...(hasStaged ? {} : { metadata: resetRetryMetadata(job.metadata) }),
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineJob.id, job.id))
        .returning();

      if (hasStaged) {
        stagedCount++;
      } else if (updated) {
        await dispatchJobDiscovery(updated);
      }
    }

    if (stagedCount > 0) {
      const sealed = await PipelineEngineService.sealAvailableBatches({
        forceFlush: false,
        triggerReason: "retry_all_failed",
      });
      for (const bId of sealed) {
        await dispatchBatchExecution(bId);
      }
    }

    return {
      ok: true,
      count: failedJobs.length,
      message: `Retried all ${failedJobs.length} failed job(s).`,
    };
  });

  app.post("/jobs/requeue-skipped", async (req) => {
    const body = (req.body || {}) as { switchPolicyToAll?: boolean };
    await PipelineEngineService.ensureTables();

    if (body?.switchPolicyToAll) {
      PipelineEngineService.persistExecutionPolicyToDisk("all");
    }

    const skippedJobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.status, "skipped"))
      .orderBy(asc(schema.pipelineJob.id));

    if (skippedJobs.length === 0) {
      return { ok: true, count: 0, message: "No skipped jobs to re-queue." };
    }

    let stagedCount = 0;
    for (const job of skippedJobs) {
      const hasStaged = PipelineEngineService.hasValidStagedFiles(job);
      const nextMeta = { ...(job.metadata || {}) };
      delete nextMeta.skippedByPolicy;
      delete nextMeta.executionPolicy;

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
        .where(eq(schema.pipelineJob.id, job.id))
        .returning();

      if (hasStaged) {
        stagedCount++;
      } else if (updated) {
        await dispatchJobDiscovery(updated);
      }
    }

    if (stagedCount > 0) {
      await PipelineEngineService.drainVmRemuxQueue();
      const sealed = await PipelineEngineService.sealAvailableBatches({
        forceFlush: false,
        triggerReason: "requeue_skipped",
      });
      for (const bId of sealed) {
        await dispatchBatchExecution(bId);
      }
    }

    return {
      ok: true,
      count: skippedJobs.length,
      message: `Re-queued ${skippedJobs.length} skipped job(s)${body?.switchPolicyToAll ? " (Pipeline policy reset to 'Both Pipelines')" : ""}.`,
    };
  });

  app.post("/jobs/clear-completed", async () => {
    await PipelineEngineService.ensureTables();
    const completedJobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(and(eq(schema.pipelineJob.status, "completed"), sql`${schema.pipelineJob.metadata}->>'callbackDelivered' = 'true'`));

    for (const job of completedJobs) {
      await PipelineEngineService.cleanupJobStagedFiles(job);
    }

    if (completedJobs.length > 0) {
      await db
        .delete(schema.pipelineJob)
        .where(and(eq(schema.pipelineJob.status, "completed"), sql`${schema.pipelineJob.metadata}->>'callbackDelivered' = 'true'`));
    }

    return {
      ok: true,
      count: completedJobs.length,
      message: `Cleared ${completedJobs.length} completed job record(s).`,
    };
  });

  app.get("/batches", async () => {
    await PipelineEngineService.ensureTables();
    try {
      const batches = await db
        .select()
        .from(schema.pipelineBatch)
        .orderBy(desc(schema.pipelineBatch.id))
        .limit(35);
      return { batches };
    } catch {
      return { batches: [] };
    }
  });

  app.get("/batches/:id/jobs", async (req) => {
    const { id } = req.params as { id: string };
    const batchId = parseInt(id, 10);
    await PipelineEngineService.ensureTables();
    try {
      const jobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(eq(schema.pipelineJob.batchId, batchId))
        .orderBy(asc(schema.pipelineJob.episodeNumber));
      return { jobs };
    } catch {
      return { jobs: [] };
    }
  });

  app.post("/batches/bulk", async (req, reply) => {
    const body = req.body as {
      batchIds?: number[];
      action?: "execute" | "delete";
    };
    const rawIds = Array.isArray(body?.batchIds) ? body.batchIds : [];
    const batchIds = Array.from(new Set(rawIds.map((n) => Number(n)).filter((n) => !isNaN(n) && n > 0)));
    const action = body?.action;

    if (batchIds.length === 0 || !action) {
      return reply.status(400).send({ error: "Valid batchIds array and action are required" });
    }

    await PipelineEngineService.ensureTables();

    if (action === "execute") {
      for (const bId of batchIds) {
        await PipelineEngineService.reconcileStuckEncodingStates({
          liveKaggleCheck: true,
          forceBatchId: bId,
        });
        const batch = await db.query.pipelineBatch.findFirst({
          where: eq(schema.pipelineBatch.id, bId),
        });
        if (!batch || batch.status === "completed") continue;
        if (batch.status === "failed") {
          await db
            .update(schema.pipelineBatch)
            .set({
              status: "created",
              lastError: null,
              datasetSlug: PipelineEngineService.isBatchVmRemux(batch) ? "vm-direct-remux" : null,
              kernelSlug: PipelineEngineService.isBatchVmRemux(batch) ? "ffmpeg-copy-remux" : null,
              attempt: batch.attempt + 1,
              heartbeatAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineBatch.id, bId));
        }
        await dispatchBatchExecution(bId);
      }
      return {
        ok: true,
        affected: batchIds.length,
        message: `Synced live Kaggle state & dispatched execution for ${batchIds.length} selected batch(es).`,
      };
    }

    if (action === "delete") {
      const selectedBatches = await db.select().from(schema.pipelineBatch).where(inArray(schema.pipelineBatch.id, batchIds));
      if (selectedBatches.some(batch => !["completed", "failed"].includes(batch.status))) {
        return reply.status(409).send({ error: "Active batches cannot be deleted. Wait for them to finish or fail." });
      }
      // Return any non-completed jobs in these batches back to staged
      const batchJobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(inArray(schema.pipelineJob.batchId, batchIds));

      for (const j of batchJobs) {
        if (j.status !== "completed") {
          const hasStaged = PipelineEngineService.hasValidStagedFiles(j);
          await db
            .update(schema.pipelineJob)
            .set({
              status: hasStaged ? "staged" : "queued",
              batchId: null,
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, j.id));
        }
      }

      for (const batch of selectedBatches) {
        await PipelineEngineService.cleanupBatchKaggleResourcesByRecord(batch);
      }

      await db.delete(schema.pipelineBatch).where(inArray(schema.pipelineBatch.id, batchIds));
      return {
        ok: true,
        affected: batchIds.length,
        message: `Deleted ${batchIds.length} batch record(s).`,
      };
    }

    return reply.status(400).send({ error: `Unsupported batch bulk action: ${action}` });
  });

  app.post("/batches/flush", async () => {
    log.info("API", "Force-flush & live encoding sync triggered manually");

    // 1. First verify live Kaggle status for all running batches so any Kaggle error frees its slot & re-stages jobs!
    const syncRes = await PipelineEngineService.reconcileStuckEncodingStates({
      liveKaggleCheck: true,
    });

    // 2. Drain Pipeline 1 (2-slot VM Remux queue)
    const startedVmJobIds = await PipelineEngineService.drainVmRemuxQueue();

    // 3. Seal & dispatch Pipeline 2 (Kaggle GPU) batches
    const pendingBatches = await db
      .select({ id: schema.pipelineBatch.id })
      .from(schema.pipelineBatch)
      .where(eq(schema.pipelineBatch.status, "created"));

    const pendingIds = pendingBatches.map((b) => b.id);

    const sealedBatchIds = await PipelineEngineService.sealAvailableBatches({
      forceFlush: true,
      triggerReason: "manual_api",
    });

    const allDispatchIds = Array.from(new Set([...pendingIds, ...sealedBatchIds]));

    for (const bId of allDispatchIds) {
      await dispatchBatchExecution(bId);
      log.info("API", `Dispatched execution event for Batch #${bId}`);
    }

    await inngest
      .send({
        name: "pipeline/batch.force-flush",
        data: { reason: "manual_api" },
      })
      .catch(() => {});

    return {
      ok: true,
      message: `Force flush & sync complete: ${startedVmJobIds.length} VM slot(s) started, ${allDispatchIds.length} GPU batch(es) dispatched${syncRes.failedBatches > 0 || syncRes.reconciledJobs > 0 ? `, reconciled ${syncRes.failedBatches} errored batch(es) & ${syncRes.reconciledJobs} stuck job(s)` : ""}.`,
      startedVmJobIds,
      dispatchedBatchIds: allDispatchIds,
      reconciled: syncRes,
    };
  });

  app.post("/batches/:id/execute", async (req, reply) => {
    const { id } = req.params as { id: string };
    const batchId = parseInt(id, 10);

    const existingBatch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });

    if (!existingBatch) {
      return reply.status(404).send({ error: "Batch not found" });
    }

    // First verify live Kaggle status if the batch was in kernel_running or waiting_dataset
    if (
      existingBatch.status === "kernel_running" ||
      existingBatch.status === "waiting_dataset" ||
      existingBatch.status === "uploading"
    ) {
      const syncRes = await PipelineEngineService.reconcileStuckEncodingStates({
        liveKaggleCheck: true,
        forceBatchId: batchId,
      });
      const refreshed = await db.query.pipelineBatch.findFirst({
        where: eq(schema.pipelineBatch.id, batchId),
      });
      if (refreshed?.status === "failed") {
        return {
          ok: true,
          message: `Kaggle reported error on Batch #${batchId}: ${refreshed.lastError || "Kernel failed"}. Jobs were automatically returned to staged/failed state.`,
          batch: refreshed,
          reconciled: syncRes,
        };
      }
      if (refreshed?.status === "completed") {
        return {
          ok: true,
          message: `Batch #${batchId} completed on Kaggle and outputs were finalized!`,
          batch: refreshed,
          reconciled: syncRes,
        };
      }
    }

    const batch = await db.query.pipelineBatch.findFirst({
      where: eq(schema.pipelineBatch.id, batchId),
    });
    if (!batch) {
      return reply.status(404).send({ error: "Batch not found" });
    }

    if (batch.status === "failed") {
      await db
        .update(schema.pipelineBatch)
        .set({
          status: "created",
          lastError: null,
          datasetSlug: PipelineEngineService.isBatchVmRemux(batch) ? "vm-direct-remux" : null,
          kernelSlug: PipelineEngineService.isBatchVmRemux(batch) ? "ffmpeg-copy-remux" : null,
          attempt: batch.attempt + 1,
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));
    }

    await dispatchBatchExecution(batchId);

    log.info("API", `Direct execute triggered for Batch #${batchId}`);
    return { ok: true, message: `Dispatched execution for Batch #${batchId}`, batch };
  });

  app.post("/system/sync-encoding", async () => {
    log.info("API", "Live encoding & Kaggle status reconciliation triggered manually");
    const syncRes = await PipelineEngineService.reconcileStuckEncodingStates({
      liveKaggleCheck: true,
    });
    const startedVmJobIds = await PipelineEngineService.drainVmRemuxQueue();
    const sealedBatchIds = await PipelineEngineService.sealAvailableBatches({
      forceFlush: false,
      triggerReason: "sync_encoding",
    });
    for (const bId of sealedBatchIds) {
      await dispatchBatchExecution(bId);
    }

    return {
      ok: true,
      ...syncRes,
      startedVmJobIds,
      sealedBatchIds,
      message:
        syncRes.failedBatches > 0 || syncRes.completedBatches > 0 || syncRes.reconciledJobs > 0
          ? `Live Sync resolved ${syncRes.failedBatches} errored batch(es), ${syncRes.completedBatches} completed batch(es), and ${syncRes.reconciledJobs} stuck encoding job(s).`
          : `Verified all active VM Remux & Kaggle GPU encoding tasks (${startedVmJobIds.length} VM slot(s) started, ${sealedBatchIds.length} batch(es) sealed).`,
    };
  });

  app.post("/system/recovery", async () => {
    log.info("API", "Recovery watchdog triggered manually");
    const syncRes = await PipelineEngineService.reconcileStuckEncodingStates({
      liveKaggleCheck: true,
    });
    const startedVmIds = await PipelineEngineService.drainVmRemuxQueue();
    const redelivered = await PipelineEngineService.retryPendingCallbacks().catch(() => 0);
    await inngest
      .send({
        name: "pipeline/recovery.run",
        data: { reason: "manual_api" },
      })
      .catch(() => {});
    return {
      ok: true,
      reconciled: syncRes,
      startedVmIds,
      message: `Recovery & live Kaggle check completed: ${syncRes.reconciledJobs} stuck job(s) healed, ${syncRes.failedBatches} failed batch(es) cleaned, ${redelivered} callback(s) delivered.`,
    };
  });

  app.post("/system/sync-callbacks", async () => {
    const redelivered = await PipelineEngineService.retryPendingCallbacks();
    return { ok: true, redelivered };
  });
};

