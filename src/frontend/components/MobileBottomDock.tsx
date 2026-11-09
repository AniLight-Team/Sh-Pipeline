import React from "react";
import { LayoutDashboard, Layers, Plus, Cpu, Terminal } from "lucide-react";

interface MobileBottomDockProps {
  activeView: string;
  onSelectView: (view: string) => void;
  onOpenEnqueue: () => void;
  onOpenKaggleDetails: () => void;
  queuedCount: number;
  activeSlots: number;
}

export function MobileBottomDock({
  activeView,
  onSelectView,
  onOpenEnqueue,
  onOpenKaggleDetails,
  queuedCount,
  activeSlots,
}: MobileBottomDockProps) {
  return (
    <div className="md:hidden fixed bottom-4 left-1/2 -translate-x-1/2 z-50 w-[calc(100%-24px)] max-w-md">
      <nav className="anilight-dock rounded-full px-2 py-1.5 flex items-center justify-between shadow-2xl">
        {/* 1. Dashboard */}
        <button
          onClick={() => onSelectView("dashboard")}
          className={`flex-1 flex flex-col items-center justify-center py-1.5 px-1 rounded-full transition-all duration-200 cursor-pointer ${
            activeView === "dashboard"
              ? "bg-white/[0.12] text-white"
              : "text-neutral-400 hover:text-white"
          }`}
          title="Dashboard"
        >
          <LayoutDashboard className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 leading-none">Home</span>
        </button>

        {/* 2. Jobs Queue */}
        <button
          onClick={() => onSelectView("jobs")}
          className={`flex-1 flex flex-col items-center justify-center py-1.5 px-1 rounded-full transition-all duration-200 cursor-pointer relative ${
            activeView === "jobs"
              ? "bg-white/[0.12] text-white"
              : "text-neutral-400 hover:text-white"
          }`}
          title="Jobs Queue"
        >
          <Layers className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 leading-none">Queue</span>
          {queuedCount > 0 && (
            <span className="absolute top-1 right-2 px-1 rounded-full text-[8px] font-mono bg-cyan-500 text-black font-bold leading-tight">
              {queuedCount}
            </span>
          )}
        </button>

        {/* 3. Center Action: + Enqueue */}
        <div className="flex-1 flex items-center justify-center px-1">
          <button
            onClick={onOpenEnqueue}
            className="button-glow w-10 h-10 rounded-full flex items-center justify-center shadow-lg transition-transform active:scale-95 cursor-pointer"
            title="Enqueue Anime"
          >
            <Plus className="w-5 h-5 text-neutral-950 font-bold" />
          </button>
        </div>

        {/* 4. Kaggle GPU Modal */}
        <button
          onClick={onOpenKaggleDetails}
          className="flex-1 flex flex-col items-center justify-center py-1.5 px-1 rounded-full transition-all duration-200 cursor-pointer text-neutral-400 hover:text-white relative"
          title="Kaggle GPU"
        >
          <Cpu className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 leading-none">GPU</span>
          {activeSlots > 0 && (
            <span className="absolute top-1 right-2 w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
          )}
        </button>

        {/* 5. Terminal Console */}
        <button
          onClick={() => onSelectView("terminal")}
          className={`flex-1 flex flex-col items-center justify-center py-1.5 px-1 rounded-full transition-all duration-200 cursor-pointer ${
            activeView === "terminal"
              ? "bg-white/[0.12] text-white"
              : "text-neutral-400 hover:text-white"
          }`}
          title="Live Console"
        >
          <Terminal className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 leading-none">Console</span>
        </button>
      </nav>
    </div>
  );
}

