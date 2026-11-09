import { inngest } from "../client.js";
import { PipelineEngineService } from "../../engine/service.js";
import {
  KIRA_BATCH_SAFE_MAX_BYTES,
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
          return { shouldWait: false, waitSeconds: 0 };
        }

        if (stats.totalBytes >= KIRA_BATCH_SAFE_MAX_BYTES) {
          return { shouldWait: false, waitSeconds: 0 };
        }

        const elapsedMs = Date.now() - stats.oldestStagedAt.getTime();
        const remainingMs = Math.max(0, KIRA_BATCH_WINDOW_MS - elapsedMs);
        return {
          shouldWait: true,
          waitSeconds: Math.ceil(remainingMs / 1000),
        };
      });

      if (!waitInfo.shouldWait) {
        return { status: "skipped" };
      }

      if (waitInfo.waitSeconds > 5) {
        await step.waitForEvent("wait-30m-or-early-flush", {
          event: "pipeline/batch.force-flush",
          timeout: `${waitInfo.waitSeconds}s`,
        });
      }
    }

    const sealResult = await step.run("seal-batch", async () => {
      return await PipelineEngineService.sealStagedBatch({
        forceFlush: isForceFlush,
        triggerReason: isForceFlush ? "manual" : "window_30m",
      });
    });

    if (sealResult.batchId) {
      await step.sendEvent("dispatch-batch-execute", {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${sealResult.batchId}`,
        data: { batchId: sealResult.batchId },
      });
    }

    return sealResult;
  },
);

