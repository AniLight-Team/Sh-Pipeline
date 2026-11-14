import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "kira-pipeline-tests-"));
try {
  const result = spawnSync(process.execPath, ["--import", "tsx", "--test", "src/backend/engine/pipeline.test.ts", "src/backend/engine/hf-upload.test.ts"], {
    stdio: "inherit",
    env: { ...process.env, DATABASE_URL: "", DEFAULT_DOWNLOAD_DIR: temp, KIRA_STAGING_DIR: path.join(temp, "staging"),
      DOTENV_CONFIG_QUIET: "true", KIRA_MAX_STAGING_GB: "56", KIRA_BATCH_MAX_GB: "10",
      KIRA_DISCOVERY_CONCURRENCY: "16", KIRA_DISCOVERY_PER_ANIME_CONCURRENCY: "8", KIRA_VM_MAX_CONCURRENT_BATCHES: "2", KIRA_VM_FFMPEG_THREADS: "2" },
  });
  process.exitCode = result.status ?? 1;
} finally { fs.rmSync(temp, { recursive: true, force: true }); }
