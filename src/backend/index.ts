import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import inngestFastify from "inngest/fastify";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import { PORT, HOST } from "./config.js";
import { inngest } from "./inngest/client.js";
import { pipelineInngestFunctions } from "./inngest/functions/index.js";
import { apiRoutes } from "./routes/api.js";
import { sseRoutes } from "./routes/sse.js";
import { PipelineEngineService } from "./engine/service.js";
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
// Look for dist/client in project root
const clientDistCandidates = [
  path.resolve(__dirname, "../client"), // When running from dist/backend/
  path.resolve(__dirname, "../../client"), // When running from dist/backend/ to root client
  path.resolve(process.cwd(), "dist/client"), // From cwd
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
      dashboardNote: "Run 'pnpm run dev' or 'pnpm run build' to launch the management UI.",
    };
  });
}

import { db, schema } from "./db/index.js";
import { eq, lt, and } from "drizzle-orm";

const start = async () => {
  try {
    await PipelineEngineService.ensureTables();

    await app.listen({ port: PORT, host: HOST });
    log.success("Server", `🚀 Pipeline Service running at http://${HOST}:${PORT}`);
    log.info("Server", `📡 Inngest App 'sh-pipeline' ready at http://${HOST}:${PORT}/api/inngest`);

    // ── Autonomous Self-Healing Background Loop (Every 60s) ───
    setInterval(async () => {
      try {
        const thirtySecsAgo = new Date(Date.now() - 30 * 1000);
        const stuckBatches = await db
          .select({ id: schema.pipelineBatch.id })
          .from(schema.pipelineBatch)
          .where(
            and(
              eq(schema.pipelineBatch.status, "created"),
              lt(schema.pipelineBatch.createdAt, thirtySecsAgo),
            ),
          );

        for (const b of stuckBatches) {
          log.info("Server", `Autonomous Heartbeat: Auto-dispatching unstarted Batch #${b.id}`);
          await inngest.send({
            name: "pipeline/batch.execute",
            id: `pipeline-batch-${b.id}-${Date.now()}`,
            data: { batchId: b.id },
          });
        }
      } catch (err: any) {
        log.warn("Server", `Autonomous background heartbeat warning: ${err?.message || err}`);
      }
    }, 60 * 1000);
  } catch (err: any) {
    log.error("Server", `Startup failed: ${err?.message || err}`);
    process.exit(1);
  }
};

start();

