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
import { MobileBottomDock } from "./components/MobileBottomDock.js";
import { usePipelineStream } from "./hooks/usePipelineStream.js";
import { Plus } from "lucide-react";

export default function App() {
  const { stats, logs, connected } = usePipelineStream();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [activeView, setActiveView] = useState("dashboard");
  const [isEnqueueOpen, setIsEnqueueOpen] = useState(false);
  const [isKaggleOpen, setIsKaggleOpen] = useState(false);
  const [isHfOpen, setIsHfOpen] = useState(false);
  const [actionNotice, setActionNotice] = useState<string | null>(null);

  const queuedCount =
    (stats?.queue?.queued ?? 0) + (stats?.queue?.downloading ?? 0) + (stats?.queue?.staged ?? 0);
  const activeSlots = stats?.concurrency?.active ?? 0;

  const showNotice = (msg: string) => {
    setActionNotice(msg);
    setTimeout(() => setActionNotice(null), 4000);
  };

  // Keyboard shortcut listener: Cmd/Ctrl + K to open Enqueue
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
      showNotice(data.message || "Force flush event sent! Packaging batch now.");
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
    <div className="min-h-screen bg-[#12131c] text-neutral-100 flex relative overflow-x-hidden selection:bg-white/20 selection:text-white">
      {/* Subtle atmospheric ambient glow */}
      <div className="fixed top-0 left-1/2 -translate-x-1/2 w-[900px] h-[300px] bg-radial from-white/[0.03] via-transparent to-transparent pointer-events-none z-0" />

      {/* Desktop Collapsible Sidebar (Hidden on Mobile) */}
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

      {/* Main Content Pane (Adaptive: 0 offset on mobile, dynamic offset on desktop) */}
      <div
        className={`flex-1 flex flex-col min-h-screen transition-all duration-300 ease-in-out relative z-10 ${
          sidebarCollapsed ? "pl-0 md:pl-16" : "pl-0 md:pl-64"
        }`}
      >
        {/* Top Navbar */}
        <Navbar
          connected={connected}
          stats={stats}
          onOpenEnqueue={() => setIsEnqueueOpen(true)}
          onForceFlush={handleForceFlush}
          onRunRecovery={handleRunRecovery}
          sidebarCollapsed={sidebarCollapsed}
        />

        {/* Action Notification Toast */}
        {actionNotice && (
          <div className="sticky top-[57px] z-30 bg-white/[0.12] backdrop-blur-md text-white text-xs font-semibold py-2 px-4 text-center border-b border-white/20 shadow-lg transition-all">
            {actionNotice}
          </div>
        )}

        {/* Dynamic Views (Padded at bottom on mobile for the floating 5-item dock) */}
        <main className="flex-1 max-w-7xl w-full mx-auto p-4 sm:p-5 md:p-6 pb-24 md:pb-6 space-y-6">
          {activeView === "dashboard" && (
            <>
              {/* Custom Designed Charts & Widgets (12-Segment Speedometer & Spline Wave with travelling dot) */}
              <DashboardCharts
                stats={stats}
                logs={logs}
                onOpenLiveTerminal={() => setActiveView("terminal")}
                onOpenEnqueue={() => setIsEnqueueOpen(true)}
                onOpenKaggleDetails={() => setIsKaggleOpen(true)}
                onOpenHfDetails={() => setIsHfOpen(true)}
              />

              {/* Recent Kaggle Batches History */}
              <BatchViewer />

              {/* Jobs Table (AniList ID Prominently Displayed) */}
              <JobTable />
            </>
          )}

          {activeView === "jobs" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-white tracking-tight">
                    Pipeline Jobs Queue
                  </h1>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    Live tracking of episodes from AniList trigger to Kaggle GPU batch encoding.
                  </p>
                </div>
                <button
                  onClick={() => setIsEnqueueOpen(true)}
                  className="button-glow px-4 py-2 rounded-full font-bold text-xs shadow-md flex items-center gap-1.5 cursor-pointer"
                >
                  <Plus className="w-4 h-4 text-neutral-950" />
                  <span>Enqueue Anime</span>
                </button>
              </div>
              <JobTable />
            </div>
          )}

          {activeView === "terminal" && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h1 className="text-xl font-bold text-white tracking-tight">
                    Pipeline Live Execution Log Stream
                  </h1>
                  <p className="text-xs text-neutral-400 mt-0.5">
                    Real-time transmission, MKV staging, subtitle extraction, and Kaggle GPU kernel logs.
                  </p>
                </div>
              </div>
              <LiveTerminal logs={logs} />
            </div>
          )}
        </main>

        {/* Minimalist Footer */}
        <footer className="border-t border-white/[0.06] bg-[#12131c]/90 backdrop-blur-md py-4 px-6 text-xs text-neutral-500 flex flex-wrap items-center justify-between max-w-7xl mx-auto w-full mb-16 md:mb-0">
          <span>AniLight Kira Self-Hosted Pipeline Service • Production Edition</span>
          <span className="font-mono text-[11px] text-neutral-500">
            Kaggle Limit: Accounts × 2 • Batch Cap: 10 Files / 10 GB
          </span>
        </footer>
      </div>

      {/* Mobile Continuous 5-Option Dock (Matches AniLight's Mobile Floating Menu) */}
      <MobileBottomDock
        activeView={activeView}
        onSelectView={(v) => setActiveView(v)}
        onOpenEnqueue={() => setIsEnqueueOpen(true)}
        onOpenKaggleDetails={() => setIsKaggleOpen(true)}
        queuedCount={queuedCount}
        activeSlots={activeSlots}
      />

      {/* Enqueue Modal (AniList ID-first) */}
      <EnqueueModal
        isOpen={isEnqueueOpen}
        onClose={() => setIsEnqueueOpen(false)}
        onSuccess={() => showNotice("Job(s) enqueued successfully!")}
      />

      {/* Kaggle Accounts Details Modal */}
      <KaggleAccountsModal
        isOpen={isKaggleOpen}
        onClose={() => setIsKaggleOpen(false)}
        stats={stats}
      />

      {/* Hugging Face Accounts Details Modal */}
      <HuggingFaceModal
        isOpen={isHfOpen}
        onClose={() => setIsHfOpen(false)}
        stats={stats}
      />
    </div>
  );
}
