export interface LogEntry {
  id: string;
  timestamp: string;
  level: "info" | "warn" | "error" | "success";
  tag: string;
  message: string;
}

type LogListener = (entry: LogEntry) => void;

class PipelineLogger {
  private buffer: LogEntry[] = [];
  private maxBufferSize = 300;
  private listeners: Set<LogListener> = new Set();

  private push(level: LogEntry["level"], tag: string, message: string) {
    const entry: LogEntry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: new Date().toISOString(),
      level,
      tag,
      message,
    };

    this.buffer.push(entry);
    if (this.buffer.length > this.maxBufferSize) {
      this.buffer.shift();
    }

    // Format console output
    const timeStr = new Date().toLocaleTimeString();
    if (level === "error") {
      console.error(`[${timeStr}] [${tag}] ✖ ${message}`);
    } else if (level === "warn") {
      console.warn(`[${timeStr}] [${tag}] ⚠ ${message}`);
    } else if (level === "success") {
      console.log(`[${timeStr}] [${tag}] ✓ ${message}`);
    } else {
      console.log(`[${timeStr}] [${tag}] ${message}`);
    }

    // Broadcast to SSE listeners
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch {
        // Ignore subscriber delivery issues
      }
    }
  }

  public info(tag: string, message: string) {
    this.push("info", tag, message);
  }

  public warn(tag: string, message: string) {
    this.push("warn", tag, message);
  }

  public error(tag: string, message: string) {
    this.push("error", tag, message);
  }

  public success(tag: string, message: string) {
    this.push("success", tag, message);
  }

  public getRecentLogs(limit = 100): LogEntry[] {
    return this.buffer.slice(-limit);
  }

  public subscribe(listener: LogListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export const log = new PipelineLogger();

