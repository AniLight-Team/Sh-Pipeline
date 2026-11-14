import type { FastifyPluginAsync } from "fastify";
import { log } from "../utils/logger.js";
import { PipelineEngineService } from "../engine/service.js";

export const sseRoutes: FastifyPluginAsync = async app => {
  app.get("/events", (req, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream", "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive", "X-Accel-Buffering": "no",
    });
    let closed = false, pending = false;
    const send = (event: string, data: unknown) => {
      if (closed || reply.raw.destroyed) return;
      if (!reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)) reply.raw.destroy();
    };
    send("init_logs", log.getRecentLogs(50));
    const unsubscribe = log.subscribe(entry => send("log", entry));
    const publishStats = async () => {
      if (closed || pending) return;
      pending = true;
      try { send("stats", await PipelineEngineService.getStats()); }
      catch { reply.raw.destroy(); }
      finally { pending = false; }
    };
    const timer = setInterval(publishStats, 5000);
    reply.raw.on("close", () => { closed = true; unsubscribe(); clearInterval(timer); });
    void publishStats();
  });
};
