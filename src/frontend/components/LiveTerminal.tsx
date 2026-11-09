import React, { useState, useEffect, useRef } from "react";
import { Terminal, Trash2, ArrowDown, Filter } from "lucide-react";
import type { LogEntry } from "../../backend/utils/logger.js";

interface LiveTerminalProps {
  logs: LogEntry[];
}

export function LiveTerminal({ logs }: LiveTerminalProps) {
  const [filter, setFilter] = useState<string>("all");
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll]);

  const filteredLogs = logs.filter((l) => {
    if (filter === "all") return true;
    return l.level === filter;
  });

  const getLogColor = (level: LogEntry["level"]) => {
    switch (level) {
      case "error":
        return "text-rose-400";
      case "warn":
        return "text-amber-300";
      case "success":
        return "text-emerald-400";
      default:
        return "text-zinc-300";
    }
  };

  return (
    <div className="rounded-xl bg-zinc-950 border border-zinc-800/80 overflow-hidden shadow-2xl">
      {/* Terminal Title Bar */}
      <div className="bg-zinc-900/90 px-4 py-2 border-b border-zinc-800 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-indigo-400" />
          <span className="font-mono text-xs font-bold text-zinc-300">
            Pipeline Live Execution Log Stream
          </span>
          <span className="text-[10px] text-zinc-500 font-mono">({filteredLogs.length} events)</span>
        </div>

        <div className="flex items-center gap-2">
          {/* Level Filter */}
          <div className="flex items-center text-[11px] bg-zinc-950 rounded border border-zinc-800 p-0.5">
            {["all", "info", "success", "warn", "error"].map((lvl) => (
              <button
                key={lvl}
                onClick={() => setFilter(lvl)}
                className={`px-2 py-0.5 rounded capitalize font-medium transition cursor-pointer ${
                  filter === lvl ? "bg-zinc-800 text-white font-bold" : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`p-1 rounded text-xs transition cursor-pointer ${
              autoScroll ? "bg-indigo-500/20 text-indigo-300 border border-indigo-500/30" : "bg-zinc-800 text-zinc-400"
            }`}
            title={autoScroll ? "Auto-scroll enabled" : "Auto-scroll paused"}
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Terminal Output Body */}
      <div className="p-4 h-64 overflow-y-auto font-mono text-xs space-y-1 bg-zinc-950">
        {filteredLogs.length === 0 ? (
          <div className="text-zinc-600 text-center py-12">Listening for pipeline events...</div>
        ) : (
          filteredLogs.map((l) => (
            <div key={l.id} className="leading-relaxed flex items-start gap-2">
              <span className="text-zinc-500 text-[10px] select-none shrink-0 pt-0.5">
                {new Date(l.timestamp).toLocaleTimeString()}
              </span>
              <span className="px-1 py-0.2 rounded text-[10px] bg-zinc-900 border border-zinc-800 text-zinc-400 font-semibold shrink-0">
                {l.tag}
              </span>
              <span className={`${getLogColor(l.level)} break-all`}>{l.message}</span>
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}

