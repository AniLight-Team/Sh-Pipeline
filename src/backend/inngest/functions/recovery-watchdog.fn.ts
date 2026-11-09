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

      // Check hung batches (heartbeat older than 15m)
      const fifteenMinsAgo = new Date(Date.now() - 15 * 60 * 1000);
      const hungBatches = await db
        .select()
        .from(schema.pipelineBatch)
        .where(
          and(
            inArray(schema.pipelineBatch.status, ["created", "uploading", "waiting_dataset", "kernel_running"]),
            lt(schema.pipelineBatch.heartbeatAt, fifteenMinsAgo),
          ),
        );

      // Check if staged batch is ready to seal
      const windowStats = await PipelineEngineService.getStagedWindowStats();

      let sealedCount = 0;
      if (windowStats.stagedCount > 0) {
        const sealed = await PipelineEngineService.sealAvailableBatches({
          forceFlush: false,
          triggerReason: "watchdog_drain",
        });
        sealedCount = sealed.length;
      }

      return {
        hungBatchCount: hungBatches.length,
        stagedCount: windowStats.stagedCount,
        sealedBatchesCount: sealedCount,
      };
    });

    log.info("Watchdog", `Watchdog heartbeat check: ${JSON.stringify(plan)}`);
    return { status: "reconciled", plan };
  },
);
