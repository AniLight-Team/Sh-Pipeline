import { inngest } from "../client.js";
import { PipelineEngineService } from "../../engine/service.js";

export const batchExecuteFn = inngest.createFunction(
  {
    id: "pipeline-batch-execute",
    name: "Pipeline Stage 3: Kaggle GPU Batch Executor",
    idempotency: "event.data.batchId",
    concurrency: {
      limit: 1,
    },
    retries: 2,
    triggers: [{ event: "pipeline/batch.execute" }],
  },
  async ({ event, step }: any) => {
    const batchId = Number(event.data.batchId);

    await step.run("execute-gpu-batch", async () => {
      await PipelineEngineService.executeBatch(batchId);
    });

    // Check if next batch can be sealed
    const nextBatch = await step.run("check-next-batch-slot", async () => {
      return await PipelineEngineService.sealStagedBatch({
        forceFlush: false,
        triggerReason: "drain",
      });
    });

    if (nextBatch.batchId) {
      await step.sendEvent("dispatch-next-batch", {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${nextBatch.batchId}`,
        data: { batchId: nextBatch.batchId },
      });
    }

    return { status: "completed", batchId };
  },
);

