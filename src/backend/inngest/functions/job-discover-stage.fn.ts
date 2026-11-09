import { inngest } from "../client.js";
import { PipelineEngineService } from "../../engine/service.js";
import { log } from "../../utils/logger.js";

export const jobDiscoverStageFn = inngest.createFunction(
  {
    id: "pipeline-job-discover-stage",
    name: "Pipeline Stage 1: Torrent Discovery, Download & Staging",
    concurrency: [
      { limit: 6 },
      { limit: 2, key: "event.data.anilistId || event.data.anidbId || event.data.jobId" },
    ],
    retries: 2,
    triggers: [{ event: "pipeline/job.discover" }],
  },
  async ({ event, step }: any) => {
    const { jobId } = event.data;

    const res = await step.run("discover-download-and-stage", async () => {
      return await PipelineEngineService.discoverAndStageJob(Number(jobId));
    });

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
          id: `pipeline-batch-${bId}-exec`,
          data: { batchId: bId },
        });
        log.info("JobDiscoverStageFn", `Dispatched Batch #${bId} (${sealCheck.reason})`);
      }

      // Always arm the coordinator timer if any staged episodes remain waiting for a batch window or queue drain
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
