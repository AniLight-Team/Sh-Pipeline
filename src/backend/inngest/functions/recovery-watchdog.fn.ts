import { inngest } from "../client.js";
import { db, schema } from "../../db/index.js";
import { eq, inArray, lt, and } from "drizzle-orm";
import { PipelineEngineService } from "../../engine/service.js";
import { log } from "../../utils/logger.js";

export const recoveryWatchdogFn = inngest.createFunction(
  {
    id: "pipeline-recovery-watchdog",
    name: "Pipeline Stage 4: Self-Healing & Recovery Watchdog",
    concurrency: {
      limit: 1,
    },
    retries: 1,
    triggers: [
      { cron: "*/2 * * * *" },
      { event: "pipeline/recovery.run" },
    ],
  },
  async ({ event, step }: any) => {
    const plan = await step.run("reconcile-pipeline-state", async () => {
      await PipelineEngineService.ensureTables();

      // 1. Recover hung batches (no heartbeat in >15m while running or uploading)
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
      const hungBatches = await db
        .select()
        .from(schema.pipelineBatch)
        .where(
          and(
            inArray(schema.pipelineBatch.status, ["uploading", "waiting_dataset", "kernel_running"]),
            lt(schema.pipelineBatch.heartbeatAt, fifteenMinsAgo),
          ),
        );

      for (const hb of hungBatches) {
        log.warn("Watchdog", `Recovering hung batch #${hb.id} (status: ${hb.status}, last heartbeat > 15m)`);
        await db
          .update(schema.pipelineBatch)
          .set({
            status: "failed",
            lastError: "Batch timed out: watchdog recovery detected hung heartbeat",
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineBatch.id, hb.id));

        await db
          .update(schema.pipelineJob)
          .set({
            status: "failed",
            lastError: `Batch #${hb.id} timed out on watchdog`,
            updatedAt: new Date(),
          })
          .where(eq(schema.pipelineJob.batchId, hb.id));
      }

      // 2. Find any batches currently in "created" status that need to be dispatched
      const pendingCreatedBatches = await db
        .select({ id: schema.pipelineBatch.id })
        .from(schema.pipelineBatch)
        .where(eq(schema.pipelineBatch.status, "created"));

      const pendingBatchIds = pendingCreatedBatches.map((b) => b.id);

      // 3. Check staged window and seal available batches if capacity permits
      const windowStats = await PipelineEngineService.getStagedWindowStats();
      let newlySealedIds: number[] = [];
      if (windowStats.stagedCount > 0) {
        newlySealedIds = await PipelineEngineService.sealAvailableBatches({
          forceFlush: false,
          triggerReason: "watchdog_drain",
        });
      }

      // 4. Combine all un-executed batch IDs
      const allBatchIdsToDispatch = Array.from(new Set([...pendingBatchIds, ...newlySealedIds]));

      return {
        hungBatchCount: hungBatches.length,
        stagedCount: windowStats.stagedCount,
        dispatchedBatchIds: allBatchIdsToDispatch,
      };
    });

    // 5. Reliably send pipeline/batch.execute events for all unstarted batches
    for (const bId of plan.dispatchedBatchIds) {
      await step.sendEvent(`dispatch-watchdog-batch-${bId}`, {
        name: "pipeline/batch.execute",
        id: `pipeline-batch-${bId}-${Date.now()}`,
        data: { batchId: bId },
      });
      log.info("Watchdog", `Dispatched execution event for batch #${bId}`);
    }

    log.info("Watchdog", `Watchdog heartbeat check complete: ${JSON.stringify(plan)}`);
    return { status: "reconciled", plan };
  },
);
