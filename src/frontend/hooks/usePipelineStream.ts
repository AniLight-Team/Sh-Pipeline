import { useState, useEffect } from "react";
import type { PipelineStats } from "../../backend/engine/types.js";
import type { LogEntry } from "../../backend/utils/logger.js";
import { api } from "../api.js";

export function usePipelineStream() {
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  useEffect(() => {
    let disposed = false, receivedStats = false;
    const controller = new AbortController();
    const es = new EventSource("/api/sse/events");
    es.onerror = () => setConnected(false);
    es.addEventListener("init_logs", e => {
      try { const data = JSON.parse(e.data); if (Array.isArray(data)) setLogs(data.slice(-250)); } catch {}
    });
    es.addEventListener("log", e => {
      try { const entry = JSON.parse(e.data); setLogs(prev => [...prev.slice(-249), entry]); } catch {}
    });
    es.addEventListener("stats", e => {
      try {
        const data = JSON.parse(e.data);
        if (!data?.queue || !data?.engine) return;
        receivedStats = true; setStats(data); setConnected(true); setLastUpdated(new Date());
      } catch {}
    });
    api<PipelineStats>("/api/stats", { signal: controller.signal }).then(data => {
      if (!disposed && !receivedStats && data?.queue) { setStats(data); setLastUpdated(new Date()); }
    }).catch(() => {});
    return () => { disposed = true; controller.abort(); es.close(); };
  }, []);
  return { stats, logs, connected, lastUpdated, setStats };
}
