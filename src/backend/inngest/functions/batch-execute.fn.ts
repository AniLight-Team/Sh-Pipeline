import { inngest } from "../client.js";
import { db, schema } from "../../db/index.js";
import { eq } from "drizzle-orm";
import { PipelineEngineService } from "../../engine/service.js";
import { getMaxConcurrentBatches } from "../../config.js";
import { log } from "../../utils/logger.js";

export const batchExecuteFn = inngest.createFunction(
  {
    id: "pipeline-batch-execute",
    name: "Pipeline Stage 3: Kaggle GPU Batch Executor (Durable Multi-Step)",
    concurrency: [
      // Allow up to (Kaggle Accounts * 2) batches to run concurrently in parallel
      { limit: Math.max(4, getMaxConcurrentBatches()) },
      // Strictly prevent the same batchId from ever executing twice concurrently
      { limit: 1, key: "event.data.batchId" },
    ],
    retries: 2,
    triggers: [{ event: "pipeline/batch.execute" }],
    onFailure: async ({ event, error }: any) => {
      const batchId = Number(event?.data?.event?.data?.batchId || event?.data?.batchId);
      if (batchId && !isNaN(batchId)) {
        await PipelineEngineService.handleBatchFailure(
          batchId,
          error?.message || "Batch execution exhausted retries",
        );
      }
    },
  },
  async ({ event, step }: any) => {
    const batchId = Number(event.data.batchId);
    log.info("BatchExecuteFn", `Starting durable multi-step GPU execution for Batch #${batchId}`);

    // Phase 1: Prepare manifest & upload dataset to Kaggle GCS (idempotent if already uploaded)
    const prep = await step.run("phase-1-upload-dataset", async () => {
      return await PipelineEngineService.prepareAndUploadBatchDataset(batchId);
    });

    if (prep.empty) {
      return { status: "empty_skipped", batchId };
    }

    // Phase 2: Wait for Kaggle to finish indexing the dataset so /kaggle/input is guaranteed ready
    await step.run("phase-2-wait-dataset-ready", async () => {
      await PipelineEngineService.waitBatchDatasetReady(batchId);
    });

    // Phase 3: Push GPU kernel to Kaggle (or re-attach if kernel is already running after a server restart)
    await step.run("phase-3-push-gpu-kernel", async () => {
      await PipelineEngineService.pushBatchKernel(batchId);
    });

    // Phase 4: Durable non-blocking polling loop (survives sh-pipeline restarts & git deployments!)
    let kernelCompleted = false;
    const maxPolls = 400; // 400 * 45s = 5 hours max kernel runtime

    for (let pollIdx = 1; pollIdx <= maxPolls; pollIdx++) {
      await step.sleep(`wait-kernel-poll-${pollIdx}`, "45s");

      const progress = await step.run(`check-kernel-poll-${pollIdx}`, async () => {
        return await PipelineEngineService.checkBatchKernelProgress(batchId);
      });

      if (progress.state === "completed") {
        kernelCompleted = true;
        break;
      }

      if (progress.state === "failed") {
        const errMsg = progress.errorDetail || `Kaggle kernel failed with status: ${progress.rawStatus}`;
        await step.run(`cleanup-failed-batch-${pollIdx}`, async () => {
          await PipelineEngineService.handleBatchFailure(batchId, errMsg);
        });
        throw new Error(errMsg);
      }
    }

    if (!kernelCompleted) {
      const timeoutMsg = "Kaggle GPU kernel timed out after 5 hours";
      await step.run("cleanup-timeout-batch", async () => {
        await PipelineEngineService.handleBatchFailure(batchId, timeoutMsg);
      });
      throw new Error(timeoutMsg);
    }

    // Phase 5: Fetch output, persist results, deliver Main Backend callbacks, and clean up Kaggle & local staging
    await step.run("phase-5-finalize-and-callbacks", async () => {
      await PipelineEngineService.finalizeCompletedBatch(batchId);
    });

    // Phase 6: Check if next available batch(es) can be sealed and dispatched into the newly freed Kaggle slot
    const nextBatches = await step.run("phase-6-drain-next-batch-slots", async () => {
      const existingCreated = await db
        .select({ id: schema.pipelineBatch.id })
        .from(schema.pipelineBatch)
        .where(eq(schema.pipelineBatch.status, "created"));

      const existingIds = existingCreated.map((b) => b.id);

      const newlySealed = await PipelineEngineService.sealAvailableBatches({
        forceFlush: false,
        triggerReason: "slot_freed_drain",
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
