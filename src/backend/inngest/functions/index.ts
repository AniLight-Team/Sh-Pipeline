import { jobDiscoverStageFn } from "./job-discover-stage.fn.js";
import { batchCoordinatorFn } from "./batch-coordinator.fn.js";
import { batchExecuteFn } from "./batch-execute.fn.js";
import { recoveryWatchdogFn } from "./recovery-watchdog.fn.js";

export const pipelineInngestFunctions = [
  jobDiscoverStageFn,
  batchCoordinatorFn,
  batchExecuteFn,
  recoveryWatchdogFn,
];

