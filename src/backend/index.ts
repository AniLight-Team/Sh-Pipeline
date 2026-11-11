import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import inngestFastify from "inngest/fastify";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  PORT,
  HOST,
  INNGEST_BASE_URL,
  DATABASE_URL,
  KIRA_DISCOVERY_CONCURRENCY,
} from "./config.js";
import { inngest } from "./inngest/client.js";
import { pipelineInngestFunctions } from "./inngest/functions/index.js";
import { apiRoutes } from "./routes/api.js";
import { sseRoutes } from "./routes/sse.js";
import { PipelineEngineService } from "./engine/service.js";
import { db, schema } from "./db/index.js";
import { eq, lt, and, inArray } from "drizzle-orm";
import { log } from "./utils/logger.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({
  logger: false,
  trustProxy: true,
});

await app.register(cors, {
  origin: true,
  methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
});

// ── Inngest Route (Exposes second Inngest App "sh-pipeline") ──
await app.register(inngestFastify, {
  client: inngest,
  functions: pipelineInngestFunctions,
  options: {
    servePath: "/api/inngest",
  },
});

// ── REST API & Realtime SSE Routes ───────────────────────────
await app.register(apiRoutes, { prefix: "/api" });
await app.register(sseRoutes, { prefix: "/api/sse" });

// ── Static Frontend Serving (Vite Build) ─────────────────────
const clientDistCandidates = [
  path.resolve(__dirname, "../client"),
  path.resolve(__dirname, "../../client"),
  path.resolve(process.cwd(), "dist/client"),
];

let clientDistPath: string | null = null;
for (const cand of clientDistCandidates) {
  if (fs.existsSync(cand) && fs.existsSync(path.join(cand, "index.html"))) {
    clientDistPath = cand;
    break;
  }
}

if (clientDistPath) {
  await app.register(fastifyStatic, {
    root: clientDistPath,
    prefix: "/",
  });

  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith("/api") || req.url.startsWith("/api/inngest")) {
      return reply.status(404).send({ error: "API route not found" });
    }
    return reply.sendFile("index.html", clientDistPath!);
  });
  log.success("Server", `Serving dashboard UI from ${clientDistPath}`);
} else {
  app.get("/", async () => {
    return {
      service: "AniLight Kira Pipeline Service",
      status: "online",
      port: PORT,
      inngestApp: "sh-pipeline",
      inngestEndpoint: "/api/inngest",
      dashboardNote: "Run 'npm run dev' or 'npm run build' to launch the management UI.",
    };
  });
}

/**
 * Registers / syncs this standalone pipeline's Inngest functions with the local Inngest Server (localhost:8288)
 * automatically whenever the service starts or restarts after a deployment.
 */
async function registerWithInngestServer() {
  const localAppInngestUrl = `http://127.0.0.1:${PORT}/api/inngest`;
  try {
    await fetch(localAppInngestUrl, { method: "PUT" });
    await fetch(`${INNGEST_BASE_URL}/fn/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: localAppInngestUrl }),
    }).catch(() => {});
    log.success("Server", `Synced Inngest functions with ${INNGEST_BASE_URL} (${localAppInngestUrl})`);
  } catch (err: any) {
    log.warn("Server", `Inngest auto-registration note (${INNGEST_BASE_URL}): ${err?.message || err}`);
  }
}

/**
 * Autonomous self-healing reconciliation tick (runs on startup and every 45s).
 * Ensures restarts of sh-pipeline (:4050) or Main Backend (:4000) never stall jobs, batches, or callbacks.
 */
async function runAutonomousReconciliationTick() {
  if (!DATABASE_URL) return;
  try {
    await PipelineEngineService.ensureTables();

    // 0. Drain Pipeline 1 (continuous 2-at-a-time VM Direct-Remux queue — no batching)
    await PipelineEngineService.drainVmRemuxQueue().catch(() => {});

    // 1. Retry any pending callbacks to Main Backend (localhost:4000)
    await PipelineEngineService.retryPendingCallbacks().catch(() => {});

    // 2. Seal any staged GPU jobs that have met the 10-item cap, 10GB cap, 30m window, 90s GPU idle settle, or queue-drain settle
    const newlySealed = await PipelineEngineService.sealAvailableBatches({
      forceFlush: false,
    });

    // 3. Find any batches in "created" for >20s or active batches with stale heartbeats (>8m)
    const twentySecsAgo = new Date(Date.now() - 20 * 1000);
    const eightMinsAgo = new Date(Date.now() - 8 * 60 * 1000);

    const [createdBatches, staleActiveBatches] = await Promise.all([
      db
        .select({ id: schema.pipelineBatch.id })
        .from(schema.pipelineBatch)
        .where(
          and(
            eq(schema.pipelineBatch.status, "created"),
            lt(schema.pipelineBatch.createdAt, twentySecsAgo),
          ),
        ),
      db
        .select({ id: schema.pipelineBatch.id })
        .from(schema.pipelineBatch)
        .where(
          and(
            inArray(schema.pipelineBatch.status, ["uploading", "waiting_dataset", "kernel_running"]),
            lt(schema.pipelineBatch.heartbeatAt, eightMinsAgo),
          ),
        ),
    ]);

    const batchIdsToDispatch = Array.from(
      new Set([
        ...newlySealed,
        ...createdBatches
          .map((b) => b.id)
          .filter((id) => !PipelineEngineService.isBatchCurrentlyExecutingInProcess(id)),
        ...staleActiveBatches
          .map((b) => b.id)
          .filter((id) => !PipelineEngineService.isBatchCurrentlyExecutingInProcess(id)),
      ]),
    );

    for (const bId of batchIdsToDispatch) {
      log.info("Server", `Autonomous Heartbeat: Dispatching / resuming Batch #${bId}`);
      await db
        .update(schema.pipelineBatch)
        .set({ heartbeatAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.pipelineBatch.id, bId))
        .catch(() => {});
      await inngest
        .send({
          name: "pipeline/batch.execute",
          id: `pipeline-batch-${bId}-${Date.now()}`,
          data: { batchId: bId },
        })
        .catch(() => {
          PipelineEngineService.executeBatch(bId).catch(() => {});
        });
    }

    // 4. Find any orphaned "queued" jobs (>90s old) and dispatch them ONLY if staging capacity (<56 GB) allows
    const cap = await PipelineEngineService.checkStorageCapacityForDownload();
    if (cap.allowed) {
      const ninetySecsAgo = new Date(Date.now() - 90 * 1000);
      const stuckQueuedJobs = await db
        .select()
        .from(schema.pipelineJob)
        .where(
          and(
            eq(schema.pipelineJob.status, "queued"),
            lt(schema.pipelineJob.updatedAt, ninetySecsAgo),
          ),
        )
        .limit(KIRA_DISCOVERY_CONCURRENCY);

      for (const j of stuckQueuedJobs) {
        await db
          .update(schema.pipelineJob)
          .set({ updatedAt: new Date() })
          .where(eq(schema.pipelineJob.id, j.id));
        await inngest
          .send({
            name: "pipeline/job.discover",
            id: `pipe-job-${j.id}-auto-${Date.now()}`,
            data: {
              jobId: j.id,
              anilistId: j.anilistId,
              animeId: j.animeId,
              anidbId: j.anidbId,
              episodeNumber: j.episodeNumber,
              types: j.types,
              knownTitles: j.knownTitles || [],
            },
          })
          .catch(() => {
            PipelineEngineService.stage1DiscoveryQueue
              .add(async () => {
                await PipelineEngineService.discoverAndStageJob(j.id).catch(() => {});
              })
              .catch(() => {});
          });
      }
    } else {
      // If at 56 GB capacity, ensure any staged jobs are flushed into batches to free disk space
      const capSealed = await PipelineEngineService.sealAvailableBatches({
        forceFlush: true,
        triggerReason: "storage_limit_56gb",
      });
      for (const bId of capSealed) {
        await inngest
          .send({
            name: "pipeline/batch.execute",
            id: `pipeline-batch-${bId}-cap-${Date.now()}`,
            data: { batchId: bId },
          })
          .catch(() => {
            PipelineEngineService.executeBatch(bId).catch(() => {});
          });
      }
    }
  } catch (err: any) {
    log.warn("Server", `Autonomous background heartbeat warning: ${err?.message || err}`);
  }
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

const start = async () => {
  try {
    await PipelineEngineService.ensureTables();

    await app.listen({ port: PORT, host: HOST });
    log.success("Server", `🚀 Pipeline Service running at http://${HOST}:${PORT}`);
    log.info("Server", `📡 Inngest App 'sh-pipeline' ready at http://${HOST}:${PORT}/api/inngest`);

    // Auto-register with Inngest Server (localhost:8288) and run initial recovery pass 2s after boot
    setTimeout(async () => {
      await registerWithInngestServer();
      await runAutonomousReconciliationTick();
    }, 2000);

    // Autonomous Self-Healing Background Loop (Every 45s)
    heartbeatTimer = setInterval(runAutonomousReconciliationTick, 45 * 1000);
  } catch (err: any) {
    log.error("Server", `Startup failed: ${err?.message || err}`);
    process.exit(1);
  }
};

const gracefulShutdown = async (signal: string) => {
  log.info("Server", `Received ${signal}, shutting down gracefully...`);
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  await app.close().catch(() => {});
  process.exit(0);
};

process.on("SIGINT", () => gracefulShutdown("SIGINT"));
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

start();
