import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, inArray, and } from "drizzle-orm";
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
    if ((!body?.anilistId && !body?.anidbId) || !Array.isArray(body?.episodeNumbers) || body.episodeNumbers.length === 0) {
      return reply.status(400).send({ error: "anilistId (or anidbId) and episodeNumbers are required" });
    }

    const res = await PipelineEngineService.enqueue(body);

    // Fan-out Inngest events for newly queued jobs
    if (res.queuedJobs.length > 0) {
      const events = res.queuedJobs.map((j) => ({
        name: "pipeline/job.discover" as const,
        id: `pipe-job-${j.id}-discover`,
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
        log.warn("API", `Failed to send inngest events: ${e?.message || e}`);
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

    const [updated] = await db
      .update(schema.pipelineJob)
      .set({
        status: "queued",
        lastError: null,
        attempt: sql`${schema.pipelineJob.attempt} + 1`,
        heartbeatAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(schema.pipelineJob.id, jobId))
      .returning();

    if (!updated) {
      return reply.status(404).send({ error: "Job not found" });
    }

    await inngest.send({
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
    });

    log.info("API", `Retried Job #${jobId}`);
    return { ok: true, job: updated };
  });

  app.post("/jobs/:id/delete", async (req, reply) => {
    const { id } = req.params as { id: string };
    const jobId = parseInt(id, 10);

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
    const sealedBatchIds = await PipelineEngineService.sealAvailableBatches({
      forceFlush: true,
      triggerReason: "manual_api",
    });

    for (const bId of sealedBatchIds) {
      await inngest.send({
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${bId}`,
        data: { batchId: bId },
      });
    }

    await inngest.send({
      name: "pipeline/batch.force-flush",
      data: { reason: "manual_api" },
    });

    return { ok: true, message: `Force flush processed: sealed ${sealedBatchIds.length} batch(es)` };
  });

  app.post("/system/recovery", async () => {
    log.info("API", "Recovery watchdog triggered manually");
    await inngest.send({
      name: "pipeline/recovery.run",
      data: { reason: "manual_api" },
    });
    return { ok: true, message: "Recovery event sent" };
  });
};

