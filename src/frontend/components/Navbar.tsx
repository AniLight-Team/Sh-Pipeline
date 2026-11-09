import React from "react";
import { Activity, Flame, RotateCw, Plus, Cpu } from "lucide-react";

interface NavbarProps {
  connected: boolean;
  onOpenEnqueue: () => void;
  onForceFlush: () => void;
  onRunRecovery: () => void;
}

export function Navbar({
  connected,
  onOpenEnqueue,
  onForceFlush,
  onRunRecovery,
}: NavbarProps) {
  return (
    <header className="border-b border-zinc-800 bg-zinc-950/80 backdrop-blur sticky top-0 z-50 px-6 py-3.5">
      <div className="max-w-7xl mx-auto flex items-center justify-between">
        {/* Logo and Status */}
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-tr from-cyan-600 via-indigo-600 to-violet-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Cpu className="w-5 h-5 text-white" />
          </div>
          <div>
            <div className="flex items-center gap-2">
              <span className="font-extrabold text-lg text-white tracking-tight">
                AniLight
              </span>
              <span className="px-2 py-0.5 text-xs font-semibold rounded-md bg-indigo-500/10 text-indigo-400 border border-indigo-500/20">
                SH Pipeline
              </span>
            </div>
            <p className="text-xs text-zinc-400">Kira Self-Hosted Operations & GPU Batch Manager</p>
          </div>

          <div className="ml-4 flex items-center gap-2 px-2.5 py-1 rounded-full bg-zinc-900 border border-zinc-800 text-xs font-medium">
            <span
              className={`w-2 h-2 rounded-full ${
                connected ? "bg-emerald-400 animate-pulse" : "bg-rose-400"
              }`}
            />
            <span className={connected ? "text-zinc-300" : "text-rose-400"}>
              {connected ? "Live Stream Connected" : "Reconnecting..."}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2.5">
          <button
            onClick={onForceFlush}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-500/10 text-amber-300 hover:bg-amber-500/20 border border-amber-500/30 transition-all cursor-pointer"
            title="Immediately pack and seal staged episodes into a GPU batch"
          >
            <Flame className="w-3.5 h-3.5 text-amber-400" />
            Force Flush Batch
          </button>

          <button
            onClick={onRunRecovery}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-zinc-900 text-zinc-300 hover:bg-zinc-800 border border-zinc-700/60 transition-all cursor-pointer"
            title="Run crash recovery watchdog to reconcile queues and heartbeats"
          >
            <RotateCw className="w-3.5 h-3.5 text-zinc-400" />
            Watchdog Reconcile
          </button>

          <button
            onClick={onOpenEnqueue}
            className="flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 text-white hover:bg-indigo-500 shadow-md shadow-indigo-600/30 transition-all cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            Enqueue AniDB Job
          </button>
        </div>
      </div>
    </header>
  );
}

