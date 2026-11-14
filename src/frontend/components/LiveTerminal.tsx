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
        return "text-[#ad4a3e]";
      case "warn":
        return "text-[#92703e]";
      case "success":
        return "text-[#52734c]";
      default:
        return "text-[#5b554a]";
    }
  };

  return (
    <div className="surface-panel rounded-xl overflow-hidden">
      {/* Console Header */}
      <div className="bg-[#fffefa] px-5 py-3.5 border-b border-[#e6e3db] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Terminal className="w-4 h-4 text-[#9a563b]" />
          <span className="font-mono text-xs font-semibold text-[#302e2a]">
            Pipeline Telemetry Stream
          </span>
          <span className="text-xs text-[#817a70] font-mono tabular-nums">
            · {filteredLogs.length} events
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {/* Segmented Log Level Filter */}
          <div className="flex items-center text-xs bg-[#f5f3ed] rounded-lg border border-[#e6e3db] p-1">
            {["all", "info", "success", "warn", "error"].map((lvl) => (
              <button
                key={lvl}
                type="button"
                onClick={() => setFilter(lvl)}
                className={`px-2.5 py-1 rounded-md capitalize font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  filter === lvl
                    ? "bg-[#ebe7df] text-[#302e2a]"
                    : "text-[#716c63] hover:text-[#302e2a]"
                }`}
              >
                {lvl}
              </button>
            ))}
          </div>

          {/* Search Logs */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2 text-[#817a70]" />
            <input
              type="text"
              aria-label="Filter console logs"
              placeholder="Filter logs..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-2.5 py-1 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] text-xs text-[#302e2a] placeholder-[#817a70] focus:outline-none focus:border-indigo-500 w-40 font-mono"
            />
          </div>

          <button
            type="button"
            onClick={() => setAutoScroll(!autoScroll)}
            aria-label={autoScroll ? "Disable auto-scroll" : "Enable auto-scroll"}
            className={`btn-secondary p-1.5 rounded-lg cursor-pointer ${
              autoScroll ? "text-[#9a563b]" : "text-[#817a70]"
            }`}
            title={autoScroll ? "Auto-scroll enabled" : "Auto-scroll paused"}
          >
            <ArrowDown className="w-3.5 h-3.5" />
          </button>

          <button
            type="button"
            onClick={handleCopyLogs}
            aria-label="Copy logs to clipboard"
            className="btn-secondary p-1.5 rounded-lg text-[#716c63] hover:text-[#302e2a] cursor-pointer"
            title="Copy logs to clipboard"
          >
            {copied ? (
              <Check className="w-3.5 h-3.5 text-[#52734c]" />
            ) : (
              <Copy className="w-3.5 h-3.5" />
            )}
          </button>

          <button
            type="button"
            onClick={() => setCollapsed(!collapsed)}
            aria-label={collapsed ? "Expand console" : "Collapse console"}
            className="btn-secondary p-1.5 rounded-lg text-[#716c63] hover:text-[#302e2a] cursor-pointer"
          >
            {collapsed ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Console Log Stream */}
      {!collapsed && (
        <div className="p-4 font-mono text-xs max-h-[520px] overflow-y-auto space-y-1 select-text bg-[#faf9f6]">
          {filteredLogs.length === 0 ? (
            <div className="text-[#817a70] text-center py-12 font-sans text-xs">
              Waiting for pipeline log events...
            </div>
          ) : (
            filteredLogs.map((l, idx) => (
              <div
                key={l.id || idx}
                className="flex items-start gap-3 hover:bg-[#fffefa] px-2.5 py-1 rounded leading-relaxed"
              >
                <span className="text-[#817a70] text-[11px] tabular-nums shrink-0 select-none">
                  {new Date(l.timestamp).toLocaleTimeString([], {
                    hour: "2-digit",
                    minute: "2-digit",
                    second: "2-digit",
                  })}
                </span>
                <span className="text-[11px] font-semibold text-[#716c63] shrink-0 min-w-[110px]">
                  [{l.tag}]
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
