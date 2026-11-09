import React, { useState, useEffect, useRef } from "react";
import { Terminal, ArrowDown, Search, Copy, Check, Minimize2, Maximize2 } from "lucide-react";
import type { LogEntry } from "../../backend/utils/logger.js";

interface LiveTerminalProps {
  logs: LogEntry[];
}

export function LiveTerminal({ logs }: LiveTerminalProps) {
  const [filter, setFilter] = useState<string>("all");
  const [search, setSearch] = useState<string>("");
  const [autoScroll, setAutoScroll] = useState(true);
  const [copied, setCopied] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (autoScroll && !collapsed) {
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, autoScroll, collapsed]);

  const filteredLogs = logs.filter((l) => {
    if (filter !== "all" && l.level !== filter) return false;
    if (search) {
      const s = search.toLowerCase();
      return l.message.toLowerCase().includes(s) || l.tag.toLowerCase().includes(s);
    }
    return true;
  });

  const handleCopyLogs = () => {
    const text = filteredLogs
      .map((l) => `[${new Date(l.timestamp).toLocaleTimeString()}] [${l.tag}] ${l.message}`)
      .join("\n");
    navigator.clipboard.writeText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const getLogColor = (level: LogEntry["level"]) => {
    switch (level) {
      case "error":
        return "text-rose-400";
      case "warn":
        return "text-sky-300";
      case "success":
        return "text-emerald-400";
      default:
        return "text-neutral-300";
    }
  };

  return (
    <div className="rounded-3xl bg-[#10111a] border border-white/[0.08] overflow-hidden shadow-2xl">
      {/* Title Bar */}
      <div className="bg-[#161723] px-5 py-3 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-white" />
          <span className="font-mono text-xs font-bold text-white">Pipeline Live Console</span>
          <span className="text-[10px] text-neutral-500 font-mono">
            ({filteredLogs.length} events)
          </span>
        </div>

        <div className="flex items-center gap-2">
          {/* Level Filter */}
          <div className="flex items-center text-[10px] font-mono bg-[#10111a] rounded-full border border-white/[0.06] p-0.5">
            {["all", "info", "success", "warn", "error"].map((lvl) => (
              <button
                key={lvl}
                onClick={() => setFilter(lvl)}
                className={`px-2.5 py-0.5 rounded-full capitalize font-medium transition cursor-pointer ${
                  filter === lvl
                    ? "bg-white/[0.12] text-white font-bold border border-white/15"
                    : "text-neutral-400 hover:text-white"
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          {/* Quick Search in Logs */}
          <div className="relative hidden md:block">
            <Search className="w-3 h-3 absolute left-3 top-2 text-neutral-500" />
            <input
              type="text"
              placeholder="Filter logs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-2.5 py-1 rounded-full bg-[#10111a] border border-white/[0.06] text-[11px] text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-white/40 w-36 font-mono"
            />
          </div>

          {/* Auto Scroll Toggle */}
          <button
            onClick={() => setAutoScroll(!autoScroll)}
            className={`button-liquid-glass p-1.5 rounded-full transition-colors cursor-pointer ${
              autoScroll ? "text-white" : "text-neutral-500"
            }`}
            title={autoScroll ? "Auto-scroll ON" : "Auto-scroll OFF"}
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>

          {/* Copy Logs */}
          <button
            onClick={handleCopyLogs}
            className="button-liquid-glass p-1.5 rounded-full text-neutral-400 hover:text-white transition-colors cursor-pointer"
            title="Copy logs to clipboard"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-emerald-400" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>

          {/* Collapse/Expand Panel */}
          <button
            onClick={() => setCollapsed(!collapsed)}
            className="button-liquid-glass p-1.5 rounded-full text-neutral-400 hover:text-white transition-colors cursor-pointer"
          >
            {collapsed ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Terminal Output */}
      {!collapsed && (
        <div className="p-4 font-mono text-xs max-h-[420px] overflow-y-auto space-y-1 select-text bg-[#0e0f17]">
          {filteredLogs.length === 0 ? (
            <div className="text-neutral-600 text-center py-10 font-sans text-xs">
              Waiting for live pipeline events...
            </div>
          ) : (
            filteredLogs.map((l, idx) => (
              <div
                key={l.id || idx}
                className="flex items-start gap-2.5 hover:bg-white/[0.02] px-2 py-0.5 rounded leading-relaxed"
              >
                <span className="text-neutral-500 text-[10px] shrink-0 select-none">
                  {new Date(l.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span className="px-1.5 py-0.2 rounded text-[10px] font-bold uppercase bg-white/[0.04] text-neutral-400 border border-white/[0.06] shrink-0">
                  {l.tag}
                </span>
                <span className={`break-all ${getLogColor(l.level)}`}>{l.message}</span>
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      )}
    </div>
  );
}
