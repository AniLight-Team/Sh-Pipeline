import { inngest } from "../client.js";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { PipelineEngineService } from "../../engine/service.js";
import { getMaxConcurrentBatches } from "../../config.js";
import { log } from "../../utils/logger.js";

export const batchExecuteFn = inngest.createFunction(
  {
    id: "pipeline-batch-execute",
    name: "Pipeline Stage 3: Kaggle GPU Batch Executor",
    concurrency: {
      // Dynamic concurrency limit = total number of kaggle accounts * 2
      limit: Math.max(2, getMaxConcurrentBatches()),
    },
    retries: 2,
    triggers: [{ event: "pipeline/batch.execute" }],
  },
  async ({ event, step }: any) => {
    const batchId = Number(event.data.batchId);
    log.info("BatchExecuteFn", `Received execution trigger for Batch #${batchId}`);

    await step.run("execute-gpu-batch", async () => {
      await PipelineEngineService.executeBatch(batchId);
    });

    // Check if next available batch(es) can be sealed and dispatched to newly freed slot(s)
    const nextBatches = await step.run("check-next-batch-slots", async () => {
      // First check if any existing created batches are waiting for execution
      const existingCreated = await db
        .select({ id: schema.pipelineBatch.id })
        .from(schema.pipelineBatch)
        .where(eq(schema.pipelineBatch.status, "created"));

      const existingIds = existingCreated.map((b) => b.id);

      const newlySealed = await PipelineEngineService.sealAvailableBatches({
        forceFlush: false,
        triggerReason: "drain",
      });

      return Array.from(new Set([...existingIds, ...newlySealed]));
    });

    for (const nextId of nextBatches) {
      await step.sendEvent(`dispatch-next-batch-${nextId}`, {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${nextId}-${Date.now()}`,
        data: { batchId: nextId },
      });
    }

    return { status: "completed", batchId, triggeredNextCount: nextBatches.length };
  },
);

