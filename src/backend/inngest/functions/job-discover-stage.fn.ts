import { inngest } from "../client.js";
import { PipelineEngineService } from "../../engine/service.js";
import { KIRA_BATCH_SAFE_MAX_BYTES } from "../../config.js";

export const jobDiscoverStageFn = inngest.createFunction(
  {
    id: "pipeline-job-discover-stage",
    name: "Pipeline Stage 1: Torrent Discovery, Download & Staging",
    concurrency: [
      { limit: 4 },
      { limit: 1, key: "event.data.anidbId" },
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

      // If safe batch cap (10 GB) reached, immediately flush without waiting 30m
      if (windowStats.totalBytes >= KIRA_BATCH_SAFE_MAX_BYTES) {
        await step.sendEvent("flush-batch-on-size-cap", {
          name: "pipeline/batch.force-flush",
          data: { reason: "size_cap_10gb" },
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

