import { FastifyInstance, FastifyPluginAsync } from "fastify";
import fs from "fs";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, and } from "drizzle-orm";
import { PipelineEngineService } from "../engine/service.js";
import { AnimeMetadataResolver } from "../engine/metadata-resolver.js";
import { inngest } from "../inngest/client.js";
import { log } from "../utils/logger.js";
import type { EnqueueRequest } from "../engine/types.js";

export const apiRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get("/health", async () => {
    return { ok: true, timestamp: new Date().toISOString() };
  });

  app.get("/stats", async () => {
    return await PipelineEngineService.getStats();
  });

  // Resolve AniList ID to AniDB ID, internal anime ID, title variations, and cover art
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

  app.post("/pipeline/enqueue", async (req, reply) => {
    const body = req.body as EnqueueRequest;
    const hasId = Boolean(
      body?.anilistId ||
      body?.anidbId ||
      body?.animeId ||
      body?.metadata?.anilistId ||
      body?.metadata?.animeId,
    );
    if (!hasId || !Array.isArray(body?.episodeNumbers) || body.episodeNumbers.length === 0) {
      return reply.status(400).send({ error: "anilistId (or anidbId/animeId) and episodeNumbers are required" });
    }

    const res = await PipelineEngineService.enqueue(body);

    // Fan-out Inngest events for newly queued jobs
    if (res.queuedJobs.length > 0) {
      const events = res.queuedJobs.map((j) => ({
        name: "pipeline/job.discover" as const,
        id: `pipe-job-${j.id}-discover-${Date.now()}`,
        data: {
          jobId: j.id,
          anilistId: j.anilistId,
          animeId: j.animeId,
          anidbId: j.anidbId,
          episodeNumber: j.episodeNumber,
          types: j.types,
          knownTitles: body.knownTitles || [],
        },
      }));
      await inngest.send(events).catch((e) => {
        log.warn("API", `Inngest send warning (watchdog will auto-dispatch): ${e?.message || e}`);
      });
    }

    return res;
  });

  app.get("/jobs", async (req) => {
    const query = req.query as {
      status?: string;
      anilistId?: string;
      animeId?: string;
      anidbId?: string;
      limit?: string;
      offset?: string;
    };
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || "50", 10)));
    const offset = Math.max(0, parseInt(query.offset || "0", 10));

    await PipelineEngineService.ensureTables();

    const conditions: any[] = [];
    if (query.status && query.status !== "all") {
      conditions.push(eq(schema.pipelineJob.status, query.status));
    }
    if (query.anilistId) {
      const parsed = parseInt(query.anilistId, 10);
      if (!isNaN(parsed)) conditions.push(eq(schema.pipelineJob.anilistId, parsed));
    }
    if (query.animeId) {
      const parsed = parseInt(query.animeId, 10);
      if (!isNaN(parsed)) conditions.push(eq(schema.pipelineJob.animeId, parsed));
    }
    if (query.anidbId) {
      const parsed = parseInt(query.anidbId, 10);
      if (!isNaN(parsed)) conditions.push(eq(schema.pipelineJob.anidbId, parsed));
    }

    let q = db
      .select()
      .from(schema.pipelineJob)
      .orderBy(desc(schema.pipelineJob.id))
      .limit(limit)
      .offset(offset);

    if (conditions.length > 0) {
      q = db
        .select()
        .from(schema.pipelineJob)
        .where(and(...conditions))
        .orderBy(desc(schema.pipelineJob.id))
        .limit(limit)
        .offset(offset) as any;
    }

    const jobs = await q;
    return { jobs, limit, offset };
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

    const hasStagedFile = Boolean(existing.stagedFilePath && fs.existsSync(existing.stagedFilePath));

    const [updated] = await db
      .update(schema.pipelineJob)
      .set({
        status: hasStagedFile ? "staged" : "queued",
        batchId: null,
        lastError: null,
        attempt: sql`${schema.pipelineJob.attempt} + 1`,
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.pipelineJob.id, jobId))
      .returning();

    if (hasStagedFile) {
      log.info("API", `Job #${jobId} already has staged MKV on SSD; returned directly to 'staged' queue.`);
      await inngest
        .send({
          name: "pipeline/batch.arm-timer",
          data: { reason: "job_retried_staged", jobId: updated.id },
        })
        .catch(() => {});
    } else {
      await inngest
        .send({
          name: "pipeline/job.discover",
          id: `pipe-job-${updated.id}-retry-${Date.now()}`,
          data: {
            jobId: updated.id,
            anilistId: updated.anilistId,
            animeId: updated.animeId,
            anidbId: updated.anidbId,
            episodeNumber: updated.episodeNumber,
            types: updated.types,
            knownTitles: updated.knownTitles || [],
          },
        })
        .catch(() => {});
      log.info("API", `Retried Job #${jobId} (dispatched torrent discovery)`);
    }

    return { ok: true, job: updated };
  });

  app.post("/jobs/:id/delete", async (req) => {
    const { id } = req.params as { id: string };
    const jobId = parseInt(id, 10);

    const existing = await db.query.pipelineJob.findFirst({
      where: eq(schema.pipelineJob.id, jobId),
    });
    if (existing?.stagedFilePath && fs.existsSync(existing.stagedFilePath)) {
      await fs.promises.unlink(existing.stagedFilePath).catch(() => {});
    }

    await db.delete(schema.pipelineJob).where(eq(schema.pipelineJob.id, jobId));
    log.info("API", `Deleted Job #${jobId}`);
    return { ok: true };
  });

  app.get("/batches", async () => {
    await PipelineEngineService.ensureTables();
    const batches = await db
      .select()
      .from(schema.pipelineBatch)
      .orderBy(desc(schema.pipelineBatch.id))
      .limit(25);
    return { batches };
  });

  app.post("/batches/flush", async () => {
    log.info("API", "Force-flush triggered manually");

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
      await inngest
        .send({
          name: "pipeline/batch.execute",
          id: `pipeline-batch-${bId}-${Date.now()}`,
          data: { batchId: bId },
        })
        .catch(() => {});
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
      message: `Force flush processed: dispatched ${allDispatchIds.length} batch(es) (${pendingIds.length} resumed, ${sealedBatchIds.length} new)`,
      dispatchedBatchIds: allDispatchIds,
    };
  });

  app.post("/batches/:id/execute", async (req, reply) => {
    const { id } = req.params as { id: string };
    const batchId = parseInt(id, 10);

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
          datasetSlug: null,
          kernelSlug: null,
          attempt: batch.attempt + 1,
          heartbeatAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(schema.pipelineBatch.id, batchId));
    }

    await inngest.send({
      name: "pipeline/batch.execute",
      id: `pipeline-batch-${batchId}-${Date.now()}`,
      data: { batchId },
    });

    log.info("API", `Direct execute triggered for Batch #${batchId}`);
    return { ok: true, message: `Dispatched execution event for Batch #${batchId}`, batch };
  });

  app.post("/system/recovery", async () => {
    log.info("API", "Recovery watchdog triggered manually");
    const redelivered = await PipelineEngineService.retryPendingCallbacks().catch(() => 0);
    await inngest
      .send({
        name: "pipeline/recovery.run",
        data: { reason: "manual_api" },
      })
      .catch(() => {});
    return { ok: true, message: `Recovery event sent (synced ${redelivered} pending callback(s))` };
  });

  app.post("/system/sync-callbacks", async () => {
    const redelivered = await PipelineEngineService.retryPendingCallbacks();
    return { ok: true, redelivered };
  });
};
