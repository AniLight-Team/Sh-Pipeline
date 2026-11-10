import { inngest } from "../client.js";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { PipelineEngineService } from "../../engine/service.js";
import {
  KIRA_DISCOVERY_CONCURRENCY,
  KIRA_DISCOVERY_PER_ANIME_CONCURRENCY,
} from "../../config.js";
import { log } from "../../utils/logger.js";

export const jobDiscoverStageFn = inngest.createFunction(
  {
    id: "pipeline-job-discover-stage",
    name: "Pipeline Stage 1: High-Concurrency Torrent Discovery, Download & Staging",
    concurrency: [
      { limit: KIRA_DISCOVERY_CONCURRENCY },
      {
        limit: KIRA_DISCOVERY_PER_ANIME_CONCURRENCY,
        key: "event.data.anilistId || event.data.anidbId || event.data.jobId",
      },
    ],
    retries: 2,
    triggers: [{ event: "pipeline/job.discover" }],
  },
  async ({ event, step }: any) => {
    const { jobId } = event.data;

    const res = await step.run("discover-download-and-stage", async () => {
      return await PipelineEngineService.discoverAndStageJob(Number(jobId));
    });

    if (res.status === "download_paused") {
      // Flush any ready or created batches so SSD staging space (< 56 GB) is cleared
      const flushedBatchIds = await step.run("flush-batches-on-storage-cap", async () => {
        const pendingCreated = await db
          .select({ id: schema.pipelineBatch.id })
          .from(schema.pipelineBatch)
          .where(eq(schema.pipelineBatch.status, "created"));

        const sealedIds = await PipelineEngineService.sealAvailableBatches({
          forceFlush: true,
          triggerReason: "storage_limit_56gb",
        });

        return Array.from(new Set([...pendingCreated.map((b) => b.id), ...sealedIds]));
      });

      for (const bId of flushedBatchIds) {
        await step.sendEvent(`dispatch-cap-batch-${bId}`, {
          name: "pipeline/batch.execute",
          id: `pipeline-batch-${bId}-cap-${Date.now()}`,
          data: { batchId: bId },
        });
      }

      // Wait 45s and re-queue discovery event so the job resumes once staging space drops below 56 GB
      await step.sleep("wait-storage-capacity-56gb", "45s");
      await step.sendEvent("retry-discover-after-cap-wait", {
        name: "pipeline/job.discover",
        id: `pipe-job-${jobId}-cap-retry-${Date.now()}`,
        data: event.data,
      });

      return res;
    }

    if (res.status === "staged") {
      const sealCheck = await step.run("evaluate-and-seal-ready-batches", async () => {
        const readiness = await PipelineEngineService.evaluateBatchSealReadiness(false);
        if (readiness.shouldSeal) {
          const sealedBatchIds = await PipelineEngineService.sealAvailableBatches({
            forceFlush: false,
            triggerReason: readiness.reason,
          });
          return {
            shouldSeal: true,
            reason: readiness.reason,
            sealedBatchIds,
            stagedCount: readiness.stats.stagedCount,
          };
        }
        return {
          shouldSeal: false,
          reason: readiness.reason,
          sealedBatchIds: [] as number[],
          stagedCount: readiness.stats.stagedCount,
        };
      });

      for (const bId of sealCheck.sealedBatchIds) {
        await step.sendEvent(`dispatch-sealed-batch-${bId}`, {
          name: "pipeline/batch.execute",
          id: `pipeline-batch-${bId}-exec-${Date.now()}`,
          data: { batchId: bId },
        });
        log.info("JobDiscoverStageFn", `Dispatched Batch #${bId} (${sealCheck.reason})`);
      }

      // Arm the coordinator timer if any staged GPU episodes remain waiting for a batch window or queue drain
      if (sealCheck.stagedCount > 0) {
        await step.sendEvent("arm-batch-timer", {
          name: "pipeline/batch.arm-timer",
          data: { reason: "new_staged_episode", jobId: Number(jobId) },
        });
      }
    }

    return res;
  },
);
