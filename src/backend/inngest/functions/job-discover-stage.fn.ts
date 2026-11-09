import { inngest } from "../client.js";
import { PipelineEngineService } from "../../engine/service.js";
import { KIRA_BATCH_SAFE_MAX_BYTES, KIRA_BATCH_MAX_ITEMS } from "../../config.js";

export const jobDiscoverStageFn = inngest.createFunction(
  {
    id: "pipeline-job-discover-stage",
    name: "Pipeline Stage 1: Torrent Discovery, Download & Staging",
    concurrency: [
      { limit: 6 },
      { limit: 1, key: "event.data.anilistId || event.data.anidbId || event.data.jobId" },
    ],
    retries: 2,
    triggers: [{ event: "pipeline/job.discover" }],
  },
  async ({ event, step }: any) => {
    const { jobId } = event.data;

    const res = await step.run("discover-download-and-stage", async () => {
      return await PipelineEngineService.discoverAndStageJob(Number(jobId));
    });

    if (res.status === "staged") {
      const windowStats = await step.run("inspect-staged-stats", async () => {
        return await PipelineEngineService.getStagedWindowStats();
      });

      // If safe batch cap (10 GB) OR file limit (10 items) reached, immediately flush without waiting 30m
      if (windowStats.totalBytes >= KIRA_BATCH_SAFE_MAX_BYTES || windowStats.stagedCount >= KIRA_BATCH_MAX_ITEMS) {
        await step.sendEvent("flush-batch-on-limit-cap", {
          name: "pipeline/batch.force-flush",
          data: {
            reason: windowStats.stagedCount >= KIRA_BATCH_MAX_ITEMS ? "file_limit_10" : "size_cap_10gb",
          },
        });
      } else {
        // Arm the 30-minute coordinator timer
        await step.sendEvent("arm-batch-timer", {
          name: "pipeline/batch.arm-timer",
          data: { reason: "new_staged_episode" },
        });
      }
    }

    return res;
  },
);

