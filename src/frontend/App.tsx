import React, { useState, useEffect } from "react";
import { Sidebar } from "./components/Sidebar.js";
import { Navbar } from "./components/Navbar.js";
import { DashboardCharts } from "./components/DashboardCharts.js";
import { JobTable } from "./components/JobTable.js";
import { BatchViewer } from "./components/BatchViewer.js";
import { LiveTerminal } from "./components/LiveTerminal.js";
import { EnqueueModal } from "./components/EnqueueModal.js";
import { KaggleAccountsModal } from "./components/KaggleAccountsModal.js";
import { HuggingFaceModal } from "./components/HuggingFaceModal.js";
import { StagingExplorerModal } from "./components/StagingExplorerModal.js";
import { MobileBottomDock } from "./components/MobileBottomDock.js";
import { usePipelineStream } from "./hooks/usePipelineStream.js";
import type { PipelineExecutionPolicy } from "../backend/engine/types.js";
import { Plus, Cpu, Cloud, CheckCircle2, HardDrive } from "lucide-react";

export default function App() {
  const { stats, logs, connected } = usePipelineStream();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeView, setActiveView] = useState("dashboard");
  const [isEnqueueOpen, setIsEnqueueOpen] = useState(false);
  const [isKaggleOpen, setIsKaggleOpen] = useState(false);
  const [isHfOpen, setIsHfOpen] = useState(false);
  const [isStagingOpen, setIsStagingOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);
  const [externalJobStatusFilter, setExternalJobStatusFilter] =
    useState<string>("all");

  const queuedCount =
    (stats?.queue?.queued ?? 0) +
    (stats?.queue?.downloading ?? 0) +
    (stats?.queue?.staged ?? 0) +
    (stats?.queue?.encoding ?? 0);
  const activeSlots = stats?.concurrency?.active ?? 0;
  const stagedCount = stats?.storage?.stagedCount ?? 0;

  const showNotice = (msg: string) => {
    setActionNotice(msg);
    setTimeout(() => setActionNotice(null), 4500);
  };

  // Keyboard shortcut: Cmd/Ctrl + K to toggle Enqueue modal
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setIsEnqueueOpen((prev) => !prev);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handleForceFlush = async () => {
    try {
      const res = await fetch("/api/batches/flush", { method: "POST" });
      const data = await res.json();
      showNotice(data.message || "Force flush event dispatched.");
    } catch {
      showNotice("Failed to trigger force flush.");
    }
  };

  const handleRunRecovery = async () => {
    try {
      const res = await fetch("/api/system/recovery", { method: "POST" });
      const data = await res.json();
      showNotice(data.message || "Recovery reconciliation triggered.");
    } catch {
      showNotice("Failed to trigger recovery.");
    }
  };

  const handleSyncEncoding = async () => {
    try {
      const res = await fetch("/api/system/sync-encoding", { method: "POST" });
      const data = await res.json();
      showNotice(
        data.message || "Verified live Kaggle GPU status and reconciled encoding jobs.",
      );
    } catch {
      showNotice("Failed to verify live encoding states.");
    }
  };

  const handleChangePolicy = async (policy: PipelineExecutionPolicy) => {
    try {
      const res = await fetch("/api/pipeline/policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          policy,
          requeueSkipped: policy === "all",
        }),
      });
      const data = await res.json();
      showNotice(data.message || `Updated pipeline execution policy to ${policy}.`);
    } catch {
      showNotice("Failed to update pipeline execution policy.");
    }
  };

  const handleRequeueSkipped = async () => {
    try {
      const res = await fetch("/api/jobs/requeue-skipped", { method: "POST" });
      const data = await res.json();
      showNotice(data.message || "Re-queued skipped jobs for discovery.");
    } catch {
      showNotice("Failed to re-queue skipped jobs.");
    }
  };

  return (
    <div className="min-h-screen bg-[#090a0f] text-[#f3f4f8] flex relative overflow-x-hidden">
      {/* Desktop Sidebar */}
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggleCollapse={() => setSidebarCollapsed(!sidebarCollapsed)}
        activeView={activeView}
        onSelectView={(v) => setActiveView(v)}
        stats={stats}
        onOpenEnqueue={() => setIsEnqueueOpen(true)}
        onOpenKaggleDetails={() => setIsKaggleOpen(true)}
        onOpenHfDetails={() => setIsHfOpen(true)}
      />

      {/* Main Content Container */}
      <div
        className={`flex-1 min-w-0 flex flex-col min-h-screen transition-all duration-200 ${
          sidebarCollapsed ? "md:ml-16" : "md:ml-60"
        }`}
      >
        <Navbar
          connected={connected}
          stats={stats}
          activeView={activeView}
          onSelectView={(v) => setActiveView(v)}
          onOpenEnqueue={() => setIsEnqueueOpen(true)}
          onForceFlush={handleForceFlush}
          onRunRecovery={handleRunRecovery}
          onSyncEncoding={handleSyncEncoding}
          onOpenStagingExplorer={() => setIsStagingOpen(true)}
          onChangePolicy={handleChangePolicy}
        />

        {/* Operational Notification Banner */}
        {actionNotice && (
          <div className="sticky top-14 z-30 bg-indigo-500/15 backdrop-blur-md text-indigo-200 text-xs font-medium py-2 px-6 border-b border-indigo-500/30 flex items-center justify-between">
            <span>{actionNotice}</span>
            <button
              type="button"
              onClick={() => setActionNotice(null)}
              className="text-indigo-300 hover:text-white text-[11px] font-mono cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        {/* Primary Viewport */}
        <main className="flex-1 max-w-[1400px] w-full mx-auto p-4 sm:p-6 pb-20 md:pb-8 space-y-6">
          {activeView === "dashboard" && (
            <>
              <DashboardCharts
                stats={stats}
                logs={logs}
                onOpenLiveTerminal={() => setActiveView("terminal")}
                onOpenEnqueue={() => setIsEnqueueOpen(true)}
                onOpenKaggleDetails={() => setIsKaggleOpen(true)}
                onOpenHfDetails={() => setIsHfOpen(true)}
                onOpenStagingExplorer={() => setIsStagingOpen(true)}
                onForceFlush={handleForceFlush}
                onSyncEncoding={handleSyncEncoding}
                onChangePolicy={handleChangePolicy}
                onRequeueSkipped={handleRequeueSkipped}
                onSelectStatusFilter={(status) => {
                  setExternalJobStatusFilter(status);
                  showNotice(`Filtered multimedia jobs by status: ${status}`);
                }}
              />

              <BatchViewer
                onForceFlush={handleForceFlush}
                stagedCount={stagedCount}
                onNotice={showNotice}
              />

              <JobTable
                onOpenEnqueue={() => setIsEnqueueOpen(true)}
                externalStatusFilter={externalJobStatusFilter}
                onNotice={showNotice}
              />
            </>
          )}

          {activeView === "jobs" && (
            <div className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-lg font-bold text-[#f3f4f8] tracking-tight">
                    Multimedia Pipeline Manager
                  </h1>
                  <p className="text-xs text-[#636b82] mt-0.5">
                    Multi-select batch controls, stream previewing, same-group H.264 VM Remux (-c:v copy), and Kaggle GPU batches
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setIsEnqueueOpen(true)}
                  className="btn-primary px-3.5 py-2 rounded-lg font-semibold text-xs flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-4 h-4" />
                  <span>Enqueue Episode</span>
                </button>
              </div>
              <JobTable
                onOpenEnqueue={() => setIsEnqueueOpen(true)}
                externalStatusFilter={externalJobStatusFilter}
                onNotice={showNotice}
              />
            </div>
          )}

          {activeView === "batches" && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h1 className="text-lg font-bold text-[#f3f4f8] tracking-tight">
                    VM Direct-Remux & GPU Batches
                  </h1>
                  <p className="text-xs text-[#636b82] mt-0.5">
                    Local VM Direct-Remux (-c:v copy, concurrency 1) and Kaggle Dual-T4 GPU notebook execution history
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setIsKaggleOpen(true)}
                    className="btn-secondary px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                  >
                    <Cpu className="w-3.5 h-3.5 text-indigo-400" />
                    <span>Inspect Cluster</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsHfOpen(true)}
                    className="btn-secondary px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 cursor-pointer"
                  >
                    <Cloud className="w-3.5 h-3.5 text-sky-400" />
                    <span>Storage Targets</span>
                  </button>
                </div>
              </div>

              {/* Inline Cluster & Storage Summary Grid */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                <div className="surface-panel rounded-xl p-5">
                  <div className="flex items-center justify-between pb-3 border-b border-[#1e2230]">
                    <div className="flex items-center gap-2">
                      <Cpu className="w-4 h-4 text-indigo-400" />
                      <h2 className="text-sm font-semibold text-[#f3f4f8]">
                        Kaggle GPU Account Pool
                      </h2>
                    </div>
                    <span className="text-xs font-mono tabular-nums text-[#949bb0]">
                      {stats?.concurrency?.active ?? 0} /{" "}
                      {stats?.concurrency?.max ?? 2} slots active
                    </span>
                  </div>
                  <div className="mt-3 space-y-2">
                    {(stats?.accounts?.kaggle || []).length === 0 ? (
                      <div className="text-xs text-[#636b82] py-4 text-center">
                        No Kaggle accounts configured in KAGGLE_ACCOUNTS.
                      </div>
                    ) : (
                      (stats?.accounts?.kaggle || []).map((acc, i) => (
                        <div
                          key={acc.username || i}
                          className="p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230] flex items-center justify-between text-xs font-mono"
                        >
                          <span className="text-[#f3f4f8] font-medium">
                            @{acc.username}
                          </span>
                          <div className="flex items-center gap-3 text-[#949bb0] tabular-nums">
                            <span>
                              Slot 1: {acc.slots?.[0] ? "Running" : "Idle"}
                            </span>
                            <span>·</span>
                            <span>
                              Slot 2: {acc.slots?.[1] ? "Running" : "Idle"}
                            </span>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="surface-panel rounded-xl p-5">
                  <div className="flex items-center justify-between pb-3 border-b border-[#1e2230]">
                    <div className="flex items-center gap-2">
                      <Cloud className="w-4 h-4 text-sky-400" />
                      <h2 className="text-sm font-semibold text-[#f3f4f8]">
                        Hugging Face & Cloudflare R2 Targets
                      </h2>
                    </div>
                    <span className="text-xs font-mono text-[#949bb0]">
                      1080p · 720p · 480p MP4
                    </span>
                  </div>
                  <div className="mt-3 space-y-2">
                    {(stats?.accounts?.huggingFace || []).length === 0 ? (
                      <div className="text-xs text-[#636b82] py-4 text-center">
                        No Hugging Face accounts configured in HF_ACCOUNTS.
                      </div>
                    ) : (
                      (stats?.accounts?.huggingFace || []).map((hf, i) => (
                        <div
                          key={i}
                          className="p-3 rounded-lg bg-[#0c0e14] border border-[#1e2230] flex items-center justify-between text-xs font-mono"
                        >
                          <div className="flex items-center gap-2">
                            <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400" />
                            <span className="text-[#f3f4f8] font-medium">
                              {hf.owner}
                            </span>
                          </div>
                          <span className="text-[#949bb0]">
                            datasets/{hf.owner}/{hf.bucket}
                          </span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              <BatchViewer
                onForceFlush={handleForceFlush}
                stagedCount={stagedCount}
                onNotice={showNotice}
              />
            </div>
          )}

          {activeView === "terminal" && (
            <div className="space-y-4">
              <div>
                <h1 className="text-lg font-bold text-[#f3f4f8] tracking-tight">
                  Live Telemetry Console
                </h1>
                <p className="text-xs text-[#636b82] mt-0.5">
                  Real-time SSE event log stream from Tsukihime, AnimeTosho, Transmission, R2 Subtitles, VM Remux, and Kaggle GPU kernels
                </p>
              </div>
              <LiveTerminal logs={logs} />
            </div>
          )}
        </main>

        {/* Quiet Footer */}
        <footer className="border-t border-[#1e2230] py-4 px-6 text-xs text-[#636b82] flex flex-wrap items-center justify-between max-w-[1400px] mx-auto w-full mb-12 md:mb-0">
          <span>AniLight Kira Pipeline Operations Console</span>
          <span className="font-mono text-[11px] tabular-nums">
            Providers: Tsukihime v1 · AnimeTosho · VM Direct-Remux (-c:v copy) · Kaggle Dual-GPU · Cloudflare R2
          </span>
        </footer>
      </div>

      {/* Mobile Navigation Dock */}
      <MobileBottomDock
        activeView={activeView}
        onSelectView={(v) => setActiveView(v)}
        onOpenEnqueue={() => setIsEnqueueOpen(true)}
        queuedCount={queuedCount}
        activeSlots={activeSlots}
      />

      {/* Modals */}
      <EnqueueModal
        isOpen={isEnqueueOpen}
        onClose={() => setIsEnqueueOpen(false)}
        onSuccess={() =>
          showNotice(
            "Episode(s) enqueued for Tsukihime & AnimeTosho discovery.",
          )
        }
      />

      <KaggleAccountsModal
        isOpen={isKaggleOpen}
        onClose={() => setIsKaggleOpen(false)}
        stats={stats}
      />

      <HuggingFaceModal
        isOpen={isHfOpen}
        onClose={() => setIsHfOpen(false)}
        stats={stats}
      />

      <StagingExplorerModal
        isOpen={isStagingOpen}
        onClose={() => setIsStagingOpen(false)}
        onNotice={showNotice}
      />
    </div>
  );
}
