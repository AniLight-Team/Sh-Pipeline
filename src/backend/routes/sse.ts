import { FastifyInstance, FastifyPluginAsync } from "fastify";
import { log, type LogEntry } from "../utils/logger.js";
import { PipelineEngineService } from "../engine/service.js";

export const sseRoutes: FastifyPluginAsync = async (app: FastifyInstance) => {
  app.get("/events", (req, reply) => {
    reply.raw.setHeader("Content-Type", "text/event-stream");
    reply.raw.setHeader("Cache-Control", "no-cache");
    reply.raw.setHeader("Connection", "keep-alive");
    reply.raw.setHeader("Access-Control-Allow-Origin", "*");
    reply.raw.flushHeaders();

    // 1. Send initial recent logs
    const recentLogs = log.getRecentLogs(50);
    reply.raw.write(`event: init_logs\ndata: ${JSON.stringify(recentLogs)}\n\n`);

    // 2. Stream new logs in real-time
    const unsubscribe = log.subscribe((entry: LogEntry) => {
      try {
        reply.raw.write(`event: log\ndata: ${JSON.stringify(entry)}\n\n`);
      } catch {
        // Disconnected
      }
    });

    // 3. Heartbeat & periodic stats every 5s
    const statsTimer = setInterval(async () => {
      try {
        const stats = await PipelineEngineService.getStats();
        reply.raw.write(`event: stats\ndata: ${JSON.stringify(stats)}\n\n`);
      } catch {
        // Disconnected
      }
    }, 5000);

    req.raw.on("close", () => {
      unsubscribe();
      clearInterval(statsTimer);
    });
  });
};

