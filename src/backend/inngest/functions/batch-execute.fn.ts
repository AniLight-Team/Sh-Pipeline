import { inngest } from "../client.js";
import { db, schema } from "../../db/index.js";
import { eq, asc } from "drizzle-orm";
import { PipelineEngineService } from "../../engine/service.js";
import {
  getMaxConcurrentBatches,
  KIRA_VM_MAX_CONCURRENT_BATCHES,
  KIRA_DISCOVERY_CONCURRENCY,
} from "../../config.js";
import { log } from "../../utils/logger.js";

export const batchExecuteFn = inngest.createFunction(
  {
    id: "pipeline-batch-execute",
    name: "Pipeline Stage 3: VM Direct-Remux & Kaggle GPU Batch Executor",
    concurrency: [
      // Allow up to (Kaggle Accounts * 2 + VM Direct Remux slots) batches to run concurrently
      { limit: Math.max(6, getMaxConcurrentBatches() + KIRA_VM_MAX_CONCURRENT_BATCHES) },
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

    const batchInfo = await step.run("inspect-batch-mode", async () => {
      await PipelineEngineService.ensureTables();
      const batch = await db.query.pipelineBatch.findFirst({
        where: eq(schema.pipelineBatch.id, batchId),
      });
      if (!batch) {
        return { exists: false, isVmRemux: false, status: "not_found" };
      }
      return {
        exists: true,
        isVmRemux: PipelineEngineService.isBatchVmRemux(batch),
        status: batch.status,
      };
    });

    if (!batchInfo.exists || batchInfo.status === "completed") {
      return { status: "already_completed_or_missing", batchId };
    }

    if (batchInfo.isVmRemux) {
      log.info("BatchExecuteFn", `Starting VM Direct-Remux execution (-c:v copy) for Batch #${batchId}`);
      await step.run("execute-vm-direct-remux-batch", async () => {
        await PipelineEngineService.executeVmRemuxBatch(batchId);
      });
    } else {
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
    }

    // Phase 6: Check if next available batch(es) can be sealed and dispatched, AND wake up any queued downloads waiting on the 56 GB limit
    const drainResult = await step.run("phase-6-drain-next-batch-slots", async () => {
      const existingCreated = await db
        .select({ id: schema.pipelineBatch.id })
        .from(schema.pipelineBatch)
        .where(eq(schema.pipelineBatch.status, "created"));

      const existingIds = existingCreated.map((b) => b.id);

      const newlySealed = await PipelineEngineService.sealAvailableBatches({
        forceFlush: false,
        triggerReason: "slot_freed_drain",
      });

      const cap = await PipelineEngineService.checkStorageCapacityForDownload();
      let resumedJobs: {
        id: number;
        anilistId: number | null;
        animeId: number | null;
        anidbId: number | null;
        episodeNumber: number;
        types: ("sub" | "dub")[];
        knownTitles: string[];
      }[] = [];

      if (cap.allowed) {
        const queuedRows = await db
          .select()
          .from(schema.pipelineJob)
          .where(eq(schema.pipelineJob.status, "queued"))
          .orderBy(asc(schema.pipelineJob.id))
          .limit(KIRA_DISCOVERY_CONCURRENCY);

        resumedJobs = queuedRows.map((j) => ({
          id: j.id,
          anilistId: j.anilistId,
          animeId: j.animeId,
          anidbId: j.anidbId,
          episodeNumber: j.episodeNumber,
          types: j.types,
          knownTitles: j.knownTitles || [],
        }));
      }

      return {
        nextBatches: Array.from(new Set([...existingIds, ...newlySealed])),
        resumedJobs,
      };
    });

    for (const nextId of drainResult.nextBatches) {
      await step.sendEvent(`dispatch-next-batch-${nextId}`, {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${nextId}-${Date.now()}`,
        data: { batchId: nextId },
      });
    }

    for (const rJob of drainResult.resumedJobs) {
      await step.sendEvent(`resume-queued-job-${rJob.id}`, {
        name: "pipeline/job.discover",
        id: `pipe-job-${rJob.id}-freed-${Date.now()}`,
        data: {
          jobId: rJob.id,
          anilistId: rJob.anilistId,
          animeId: rJob.animeId,
          anidbId: rJob.anidbId,
          episodeNumber: rJob.episodeNumber,
          types: rJob.types,
          knownTitles: rJob.knownTitles,
        },
      });
    }

    return {
      status: "completed",
      batchId,
      mode: batchInfo.isVmRemux ? "vm_remux" : "kaggle_gpu",
      triggeredNextCount: drainResult.nextBatches.length,
      resumedJobsCount: drainResult.resumedJobs.length,
    };
  },
);
