import { inngest } from "../client.js";
import { PipelineEngineService } from "../../engine/service.js";
import { KIRA_BATCH_WINDOW_MS, KIRA_QUEUE_IDLE_SETTLE_MS } from "../../config.js";
import { log } from "../../utils/logger.js";

export const batchCoordinatorFn = inngest.createFunction(
  {
    id: "pipeline-batch-coordinator",
    name: "Pipeline Stage 2: Smart Window & Queue-Drain Batch Sealer",
    concurrency: {
      limit: 1,
    },
    retries: 1,
    triggers: [
      { event: "pipeline/batch.force-flush" },
      { event: "pipeline/batch.arm-timer" },
    ],
  },
  async ({ event, step }: any) => {
    const isForceFlush = event.name === "pipeline/batch.force-flush";

    if (!isForceFlush) {
      const waitInfo = await step.run("inspect-staged-window", async () => {
        const readiness = await PipelineEngineService.evaluateBatchSealReadiness(false);
        const { stats } = readiness;

        if (stats.stagedCount === 0 || !stats.oldestStagedAt) {
          return { shouldSkip: true, shouldWait: false, waitSeconds: 0, reason: "no_staged_items" };
        }

        if (readiness.shouldSeal) {
          return { shouldSkip: false, shouldWait: false, waitSeconds: 0, reason: readiness.reason };
        }

        // If all downloads have finished (0 queued, 0 downloading), only wait for the brief idle settle window (e.g. 30s)
        const newestRef = stats.newestGpuStagedAt || stats.newestStagedAt;
        if (stats.activeDownloadsOrQueued === 0 && newestRef) {
          const idleElapsedMs = Date.now() - newestRef.getTime();
          const idleRemainingMs = Math.max(5000, KIRA_QUEUE_IDLE_SETTLE_MS - idleElapsedMs + 2000);
          return {
            shouldSkip: false,
            shouldWait: true,
            waitSeconds: Math.ceil(idleRemainingMs / 1000),
            reason: "queue_drained",
          };
        }

        const oldestRef = stats.oldestGpuStagedAt || stats.oldestStagedAt;
        const elapsedMs = Date.now() - oldestRef.getTime();
        const remainingMs = Math.max(0, KIRA_BATCH_WINDOW_MS - elapsedMs);
        return {
          shouldSkip: false,
          shouldWait: remainingMs > 5000,
          waitSeconds: Math.ceil(remainingMs / 1000),
          reason: "window_30m",
        };
      });

      if (waitInfo.shouldSkip) {
        return { status: "skipped", reason: "no_staged_items" };
      }

      if (waitInfo.shouldWait && waitInfo.waitSeconds > 0) {
        await step.waitForEvent("wait-window-or-early-flush", {
          event: "pipeline/batch.force-flush",
          timeout: `${waitInfo.waitSeconds}s`,
        });
      }
    }

    const sealedBatchIds = await step.run("seal-available-batches", async () => {
      return await PipelineEngineService.sealAvailableBatches({
        forceFlush: isForceFlush,
        triggerReason: isForceFlush ? "manual_flush" : undefined,
      });
    });

    for (const bId of sealedBatchIds) {
      await step.sendEvent(`dispatch-batch-${bId}`, {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${bId}-exec-${Date.now()}`,
        data: { batchId: bId },
      });
      log.info("BatchCoordinatorFn", `Dispatched Batch #${bId} to batch executor`);
    }

    return { sealedBatchIds, count: sealedBatchIds.length };
  },
);
