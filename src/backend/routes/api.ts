import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { db, schema } from "../db/index.js";
import { eq, desc, sql, and, inArray, asc } from "drizzle-orm";
import { PipelineEngineService } from "../engine/service.js";
import { AnimeMetadataResolver } from "../engine/metadata-resolver.js";
import { MAIN_BACKEND_URL } from "../config.js";
import { inngest } from "../inngest/client.js";
import { log } from "../utils/logger.js";
import type { EnqueueRequest, PipelineEpisodeResult } from "../engine/types.js";

/**
 * Helper that dispatches a job discovery event via Inngest, falling back to direct async execution
 * if the external Inngest server (:8288) is unreachable.
 */
async function dispatchJobDiscovery(job: {
  id: number;
  anilistId?: number | null;
  animeId?: number | null;
  anidbId?: number | null;
  episodeNumber: number;
  types: string[];
  knownTitles?: string[] | null;
}) {
  try {
    await inngest.send({
      name: "pipeline/job.discover",
      id: `pipe-job-${job.id}-discover-${Date.now()}`,
      data: {
        jobId: job.id,
        anilistId: job.anilistId,
        animeId: job.animeId,
        anidbId: job.anidbId,
        episodeNumber: job.episodeNumber,
        types: job.types,
        knownTitles: job.knownTitles || [],
      },
    });
  } catch (err: any) {
    log.warn("API", `Inngest server unreachable (${err?.message || err}); queuing discovery for Job #${job.id} in high-concurrency background worker.`);
    PipelineEngineService.stage1DiscoveryQueue
      .add(async () => {
        try {
          const res = await PipelineEngineService.discoverAndStageJob(job.id);
          if (res.status === "staged") {
            await PipelineEngineService.drainVmRemuxQueue();
            const readiness = await PipelineEngineService.evaluateBatchSealReadiness(false);
            if (readiness.shouldSeal) {
              const batchIds = await PipelineEngineService.sealAvailableBatches({
                forceFlush: false,
                triggerReason: readiness.reason,
              });
              for (const bId of batchIds) {
                await PipelineEngineService.executeBatch(bId).catch(() => {});
              }
            }
          }
        } catch {}
      })
      .catch(() => {});
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

    // Fan-out discovery for newly queued jobs
    for (const j of res.queuedJobs) {
      await dispatchJobDiscovery({
        id: j.id,
        anilistId: j.anilistId,
        animeId: j.animeId,
        anidbId: j.anidbId,
        episodeNumber: j.episodeNumber,
        types: j.types,
        knownTitles: body.knownTitles || [],
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
    const limit = Math.min(200, Math.max(1, parseInt(query.limit || "100", 10)));
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

    try {
      const jobs = await q;
      return { jobs, limit, offset };
    } catch {
      return { jobs: [], limit, offset };
    }
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

    const hasStagedFile = PipelineEngineService.hasValidStagedFiles(existing);

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

  app.post("/jobs/:id/delete", async (req) => {
    const { id } = req.params as { id: string };
    const jobId = parseInt(id, 10);

    const existing = await db.query.pipelineJob.findFirst({
      where: eq(schema.pipelineJob.id, jobId),
    });
    if (existing) {
      await PipelineEngineService.cleanupJobStagedFiles(existing);
    }

    await db.delete(schema.pipelineJob).where(eq(schema.pipelineJob.id, jobId));
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

    if (action === "delete") {
      for (const job of targetJobs) {
        await PipelineEngineService.cleanupJobStagedFiles(job);
      }
      await db.delete(schema.pipelineJob).where(inArray(schema.pipelineJob.id, jobIds));
      log.info("API", `Bulk deleted ${targetJobs.length} job(s) and cleaned staged SSD files.`);
      return {
        ok: true,
        affected: targetJobs.length,
        message: `Deleted ${targetJobs.length} job(s) and freed associated SSD staging files.`,
      };
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
            attempt: sql`${schema.pipelineJob.attempt} + 1`,
            heartbeatAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.id, job.id))
          .returning();

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
        affected: targetJobs.length,
        message: `Retried ${targetJobs.length} job(s) (${stagedRestored} restored from SSD staging, ${rediscovered} queued for discovery).`,
      };
    }

    if (action === "force_remux" || action === "force_gpu") {
      const targetMode = action === "force_remux" ? "vm_remux" : "kaggle_gpu";
      let updatedCount = 0;

      for (const job of targetJobs) {
        const hasStaged = PipelineEngineService.hasValidStagedFiles(job);
        const nextStatus =
          job.status === "completed"
            ? "completed"
            : hasStaged
              ? "staged"
              : "queued";

        await db
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
          .where(eq(schema.pipelineJob.id, job.id));
        updatedCount++;
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
        const resultPayload = job.resultPayload as PipelineEpisodeResult | null;
        if (!resultPayload) continue;
        const targetUrl = job.callbackUrl || `${MAIN_BACKEND_URL}/api/internal/pipeline/completed`;
        const payloads: PipelineEpisodeResult[] = Array.isArray(resultPayload.allTrackPayloads)
          ? resultPayload.allTrackPayloads
          : [resultPayload];
        let allOk = true;
        for (const p of payloads) {
          const ok = await PipelineEngineService.deliverCallbackPayload(targetUrl, p, 2);
          if (!ok) allOk = false;
        }
        if (allOk) {
          delivered++;
          await db
            .update(schema.pipelineJob)
            .set({
              metadata: {
                ...(job.metadata || {}),
                callbackDelivered: true,
                callbackDeliveredAt: new Date().toISOString(),
              },
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, job.id));
        }
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
          attempt: sql`${schema.pipelineJob.attempt} + 1`,
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

  app.post("/jobs/clear-completed", async () => {
    await PipelineEngineService.ensureTables();
    const completedJobs = await db
      .select()
      .from(schema.pipelineJob)
      .where(eq(schema.pipelineJob.status, "completed"));

    for (const job of completedJobs) {
      await PipelineEngineService.cleanupJobStagedFiles(job);
    }

    if (completedJobs.length > 0) {
      await db
        .delete(schema.pipelineJob)
        .where(eq(schema.pipelineJob.status, "completed"));
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
        const batch = await db.query.pipelineBatch.findFirst({
          where: eq(schema.pipelineBatch.id, bId),
        });
        if (!batch) continue;
        if (batch.status === "failed") {
          await db
            .update(schema.pipelineBatch)
            .set({
              status: "created",
              lastError: null,
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
        message: `Dispatched execution for ${batchIds.length} selected batch(es).`,
      };
    }

    if (action === "delete") {
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
    log.info("API", "Force-flush triggered manually");

    const startedVmJobIds = await PipelineEngineService.drainVmRemuxQueue();

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
      message: `Force flush processed: ${startedVmJobIds.length} VM remux slot(s) started, dispatched ${allDispatchIds.length} GPU batch(es) (${pendingIds.length} resumed, ${sealedBatchIds.length} new)`,
      startedVmJobIds,
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
