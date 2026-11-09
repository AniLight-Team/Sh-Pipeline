import { useState, useEffect } from "react";
import type { PipelineStats } from "../backend/engine/types.js";
import type { LogEntry } from "../backend/utils/logger.js";

export function usePipelineStream() {
  const [stats, setStats] = useState<PipelineStats | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let es: EventSource | null = null;
    let reconnectTimeout: any = null;

    function connect() {
      es = new EventSource("/api/sse/events");

      es.onopen = () => {
        setConnected(true);
      };

      es.addEventListener("init_logs", (e) => {
        try {
          const data = JSON.parse(e.data);
          setLogs(data);
        } catch {}
      });

      es.addEventListener("log", (e) => {
        try {
          const entry = JSON.parse(e.data);
          setLogs((prev) => [...prev.slice(-250), entry]);
        } catch {}
      });

      es.addEventListener("stats", (e) => {
        try {
          const data = JSON.parse(e.data);
          setStats(data);
        } catch {}
      });

      es.onerror = () => {
        setConnected(false);
        es?.close();
        reconnectTimeout = setTimeout(connect, 3000);
      };
    }

    connect();

    // Initial fetch of stats
    fetch("/api/stats")
      .then((r) => r.json())
      .then((s) => setStats(s))
      .catch(() => {});

    return () => {
      es?.close();
      clearTimeout(reconnectTimeout);
    };
  }, []);

  return { stats, logs, connected, setStats };
}

