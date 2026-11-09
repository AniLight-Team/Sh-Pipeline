import { inngest } from "../client.js";
import { PipelineEngineService } from "../../engine/service.js";
import { getMaxConcurrentBatches } from "../../config.js";

export const batchExecuteFn = inngest.createFunction(
  {
    id: "pipeline-batch-execute",
    name: "Pipeline Stage 3: Kaggle GPU Batch Executor",
    idempotency: "event.data.batchId",
    concurrency: {
      // Dynamic concurrency limit = total number of kaggle accounts * 2
      limit: Math.max(2, getMaxConcurrentBatches()),
    },
    retries: 2,
    triggers: [{ event: "pipeline/batch.execute" }],
  },
  async ({ event, step }: any) => {
    const batchId = Number(event.data.batchId);

    await step.run("execute-gpu-batch", async () => {
      await PipelineEngineService.executeBatch(batchId);
    });

    // Check if next available batch(es) can be sealed and dispatched to newly freed slot(s)
    const nextBatches = await step.run("check-next-batch-slots", async () => {
      return await PipelineEngineService.sealAvailableBatches({
        forceFlush: false,
        triggerReason: "drain",
      });
    });

    for (const nextId of nextBatches) {
      await step.sendEvent(`dispatch-next-batch-${nextId}`, {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${nextId}`,
        data: { batchId: nextId },
      });
    }

    return { status: "completed", batchId, triggeredNextCount: nextBatches.length };
  },
);

