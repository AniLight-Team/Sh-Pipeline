import React, { useState } from "react";
import { Navbar } from "./components/Navbar.js";
import { StatsOverview } from "./components/StatsOverview.js";
import { JobTable } from "./components/JobTable.js";
import { BatchViewer } from "./components/BatchViewer.js";
import { LiveTerminal } from "./components/LiveTerminal.js";
import { EnqueueModal } from "./components/EnqueueModal.js";
import { usePipelineStream } from "./hooks/usePipelineStream.js";

export default function App() {
  const { stats, logs, connected } = usePipelineStream();
  const [isEnqueueOpen, setIsEnqueueOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const showNotice = (msg: string) => {
    setActionNotice(msg);
    setTimeout(() => setActionNotice(null), 4000);
  };

  const handleForceFlush = async () => {
    try {
      await fetch("/api/batches/flush", { method: "POST" });
      showNotice("Force flush event sent! Packaging batch now.");
    } catch {
      showNotice("Failed to trigger force flush.");
    }
  };

  const handleRunRecovery = async () => {
    try {
      await fetch("/api/system/recovery", { method: "POST" });
      showNotice("Recovery watchdog event sent!");
    } catch {
      showNotice("Failed to trigger recovery.");
    }
  };

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 flex flex-col">
      <Navbar
        connected={connected}
        onOpenEnqueue={() => setIsEnqueueOpen(true)}
        onForceFlush={handleForceFlush}
        onRunRecovery={handleRunRecovery}
      />

      {/* Floating Notice Bar */}
      {actionNotice && (
        <div className="bg-indigo-600/90 text-white text-xs font-semibold py-2 px-4 text-center border-b border-indigo-500/50 transition-all">
          {actionNotice}
        </div>
      )}

      <main className="flex-1 max-w-7xl w-full mx-auto p-6 space-y-6">
        {/* Metric Cards */}
        <StatsOverview stats={stats} />

        {/* Live Terminal */}
        <LiveTerminal logs={logs} />

        {/* Recent Kaggle Batches */}
        <BatchViewer />

        {/* Jobs Table */}
        <JobTable />
      </main>

      <footer className="border-t border-zinc-900 bg-zinc-950 py-4 px-6 text-center text-xs text-zinc-600">
        AniLight Standalone Kira Pipeline Service • Dual-App Inngest System • 2026 Production Edition
      </footer>

      {/* Manual Enqueue Modal */}
      <EnqueueModal
        isOpen={isEnqueueOpen}
        onClose={() => setIsEnqueueOpen(false)}
        onSuccess={() => showNotice("Job(s) enqueued successfully!")}
      />
    </div>
  );
}

