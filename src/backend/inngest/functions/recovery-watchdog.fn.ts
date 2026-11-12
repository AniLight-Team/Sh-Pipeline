import { inngest } from "../client.js";
import { db, schema } from "../../db/index.js";
import { eq, inArray, lt, and } from "drizzle-orm";
import { PipelineEngineService } from "../../engine/service.js";
import {
  MAX_JOB_ATTEMPTS,
  MAX_BATCH_ATTEMPTS,
  KIRA_DISCOVERY_CONCURRENCY,
} from "../../config.js";
import { log } from "../../utils/logger.js";

export const recoveryWatchdogFn = inngest.createFunction(
  {
    id: "pipeline-recovery-watchdog",
    name: "Pipeline Stage 4: Self-Healing, Re-Attachment & Callback Watchdog",
    concurrency: {
      limit: 1,
    },
    retries: 1,
    triggers: [
      { cron: "*/2 * * * *" },
      { event: "pipeline/recovery.run" },
    ],
  },
  async ({ step }: any) => {
    const plan = await step.run("reconcile-pipeline-state", async () => {
      await PipelineEngineService.ensureTables();
      PipelineEngineService.markWatchdogRun();

      const now = Date.now();
      const twoMinsAgo = new Date(now - 2 * 60 * 1000);
      const eightMinsAgo = new Date(now - 8 * 60 * 1000);
      const tenMinsAgo = new Date(now - 10 * 60 * 1000);
      const sixHoursMs = 6 * 3600 * 1000;

      // 0. Reconcile any stuck 'encoding' jobs/batches (including live Kaggle status check for stale batches)
      // and drain Pipeline 1 (2-at-a-time VM Direct-Remux queue — no batching)
      await PipelineEngineService.reconcileStuckEncodingStates({ liveKaggleCheck: false });
      await PipelineEngineService.drainVmRemuxQueue();

      // 1. Recover orphaned "queued" jobs that haven't transitioned to downloading after >2m
      const orphanedQueuedJobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(
          and(
            eq(schema.pipelineJob.status, "queued"),
            lt(schema.pipelineJob.updatedAt, twoMinsAgo),
          ),
        );

      // 2. Recover hung "downloading" jobs (no heartbeat for >10m, e.g. after service restart)
      const hungDownloadingJobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(
          and(
            eq(schema.pipelineJob.status, "downloading"),
            lt(schema.pipelineJob.heartbeatAt, tenMinsAgo),
          ),
        );

      const jobsToRediscover: typeof orphanedQueuedJobs = [...orphanedQueuedJobs];

      for (const hj of hungDownloadingJobs) {
        if (hj.attempt < MAX_JOB_ATTEMPTS) {
          log.warn(
            "Watchdog",
            `Recovering hung downloading Job #${hj.id} (attempt ${hj.attempt + 1}/${MAX_JOB_ATTEMPTS})`,
          );
          const [resetJob] = await db
            .update(schema.pipelineJob)
            .set({
              status: "queued",
              attempt: hj.attempt + 1,
              heartbeatAt: new Date(),
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, hj.id))
            .returning();
          if (resetJob) jobsToRediscover.push(resetJob);
        } else {
          await db
            .update(schema.pipelineJob)
            .set({
              status: "failed",
              lastError: "Download timed out on watchdog after max attempts",
              updatedAt: new Date(),
            })
            .where(eq(schema.pipelineJob.id, hj.id));
        }
      }

      // 3. Inspect active batches with stale heartbeats (>8m) and not currently executing in-process
      const staleBatches = await db
        .select()
        .from(schema.pipelineBatch)
        .where(
          and(
            inArray(schema.pipelineBatch.status, ["uploading", "waiting_dataset", "kernel_running"]),
            lt(schema.pipelineBatch.heartbeatAt, eightMinsAgo),
          ),
        );

      const batchesToResume: number[] = [];
      let expiredBatchCount = 0;

      for (const sb of staleBatches) {
        if (PipelineEngineService.isBatchCurrentlyExecutingInProcess(sb.id)) {
          continue;
        }
        const runtimeMs = sb.startedAt ? now - sb.startedAt.getTime() : 0;
        if (runtimeMs < sixHoursMs && sb.attempt <= MAX_BATCH_ATTEMPTS) {
          log.info(
            "Watchdog",
            `Re-attaching stale Batch #${sb.id} (status: ${sb.status}, kernel: ${sb.kernelSlug || "none"})`,
          );
          await db
            .update(schema.pipelineBatch)
            .set({ heartbeatAt: new Date(), updatedAt: new Date() })
            .where(eq(schema.pipelineBatch.id, sb.id));
          batchesToResume.push(sb.id);
        } else {
          expiredBatchCount++;
          await PipelineEngineService.handleBatchFailure(
            sb.id,
            "Batch timed out (>6h max runtime) on watchdog reconciliation",
          );
        }
      }

      // 4. Find any batches in "created" status waiting for execution
      const pendingCreatedBatches = await db
        .select({ id: schema.pipelineBatch.id })
        .from(schema.pipelineBatch)
        .where(eq(schema.pipelineBatch.status, "created"));

      const pendingBatchIds = pendingCreatedBatches
        .map((b) => b.id)
        .filter((id) => !PipelineEngineService.isBatchCurrentlyExecutingInProcess(id));

      // 5. Seal eligible staged GPU jobs (respecting 10-item cap / 10GB cap / 30m window / 90s GPU idle settle)
      const newlySealedIds = await PipelineEngineService.sealAvailableBatches({
        forceFlush: false,
      });

      // 6. Retry any completed job callbacks that failed while Main Backend (localhost:4000) was restarting
      const redeliveredCallbacks = await PipelineEngineService.retryPendingCallbacks();

      // 7. Only dispatch queued jobs if staging buffer is below the 56 GB limit
      const cap = await PipelineEngineService.checkStorageCapacityForDownload();
      const jobsAllowedToDispatch = cap.allowed
        ? jobsToRediscover.slice(0, KIRA_DISCOVERY_CONCURRENCY)
        : [];

      const allBatchIdsToDispatch = Array.from(
        new Set([...batchesToResume, ...pendingBatchIds, ...newlySealedIds]),
      );

      return {
        rediscoveredJobs: jobsAllowedToDispatch.map((j) => ({
          id: j.id,
          anilistId: j.anilistId,
          animeId: j.animeId,
          anidbId: j.anidbId,
          episodeNumber: j.episodeNumber,
          types: j.types,
          knownTitles: j.knownTitles || [],
        })),
        reattachedBatchCount: batchesToResume.length,
        expiredBatchCount,
        dispatchedBatchIds: allBatchIdsToDispatch,
        redeliveredCallbacks,
      };
    });

    // Dispatch rediscovered jobs
    for (const j of plan.rediscoveredJobs) {
      await step.sendEvent(`watchdog-discover-job-${j.id}`, {
        name: "pipeline/job.discover",
        id: `pipe-job-${j.id}-watchdog-${Date.now()}`,
        data: {
          jobId: j.id,
          anilistId: j.anilistId,
          animeId: j.animeId,
          anidbId: j.anidbId,
          episodeNumber: j.episodeNumber,
          types: j.types,
          knownTitles: j.knownTitles,
        },
      });
    }

    // Dispatch created / re-attached / newly sealed batches
    for (const bId of plan.dispatchedBatchIds) {
      await step.sendEvent(`dispatch-watchdog-batch-${bId}`, {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${bId}-watchdog-${Date.now()}`,
        data: { batchId: bId },
      });
      log.info("Watchdog", `Dispatched execution / re-attachment event for Batch #${bId}`);
    }

    log.info(
      "Watchdog",
      `Reconciliation complete: jobs=${plan.rediscoveredJobs.length}, batches=${plan.dispatchedBatchIds.length}, callbacks=${plan.redeliveredCallbacks}`,
    );
    return { status: "reconciled", plan };
  },
);
