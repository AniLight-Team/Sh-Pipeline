import { inngest } from "../client.js";
import { PipelineEngineService } from "../../engine/service.js";
import {
  KIRA_BATCH_SAFE_MAX_BYTES,
  KIRA_BATCH_MAX_ITEMS,
  KIRA_BATCH_WINDOW_MS,
} from "../../config.js";

export const batchCoordinatorFn = inngest.createFunction(
  {
    id: "pipeline-batch-coordinator",
    name: "Pipeline Stage 2: 30-Minute Timer & Batch Sealer",
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
        const stats = await PipelineEngineService.getStagedWindowStats();

        if (stats.stagedCount === 0 || !stats.oldestStagedAt) {
          return { shouldSkip: true, shouldWait: false, waitSeconds: 0 };
        }

        // Limit cap reached: 10 files or 10 GB safe cap -> flush immediately, do not wait
        if (
          stats.totalBytes >= KIRA_BATCH_SAFE_MAX_BYTES ||
          stats.stagedCount >= KIRA_BATCH_MAX_ITEMS
        ) {
          return { shouldSkip: false, shouldWait: false, waitSeconds: 0 };
        }

        const elapsedMs = Date.now() - stats.oldestStagedAt.getTime();
        const remainingMs = Math.max(0, KIRA_BATCH_WINDOW_MS - elapsedMs);
        return {
          shouldSkip: false,
          shouldWait: remainingMs > 5000,
          waitSeconds: Math.ceil(remainingMs / 1000),
        };
      });

      if (waitInfo.shouldSkip) {
        return { status: "skipped", reason: "no_staged_items" };
      }

      if (waitInfo.shouldWait && waitInfo.waitSeconds > 5) {
        await step.waitForEvent("wait-30m-or-early-flush", {
          event: "pipeline/batch.force-flush",
          timeout: `${waitInfo.waitSeconds}s`,
        });
      }
    }

    const sealedBatchIds = await step.run("seal-available-batches", async () => {
      return await PipelineEngineService.sealAvailableBatches({
        forceFlush: isForceFlush,
        triggerReason: isForceFlush ? "manual" : "window_30m",
      });
    });

    for (const bId of sealedBatchIds) {
      await step.sendEvent(`dispatch-batch-${bId}`, {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${bId}-${Date.now()}`,
        data: { batchId: bId },
      });
    }

    return { sealedBatchIds, count: sealedBatchIds.length };
  },
);
