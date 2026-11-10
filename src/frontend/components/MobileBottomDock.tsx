import React from "react";
import { LayoutDashboard, Layers, Plus, Boxes, Terminal } from "lucide-react";

interface MobileBottomDockProps {
  activeView: string;
  onSelectView: (view: string) => void;
  onOpenEnqueue: () => void;
  queuedCount: number;
  activeSlots: number;
}

export function MobileBottomDock({
  activeView,
  onSelectView,
  onOpenEnqueue,
  queuedCount,
  activeSlots,
}: MobileBottomDockProps) {
  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-[#0c0e14]/95 backdrop-blur-md border-t border-[#1e2230] px-2 py-1.5">
      <nav aria-label="Mobile Navigation" className="flex items-center justify-around max-w-md mx-auto">
        <button
          type="button"
          onClick={() => onSelectView("dashboard")}
          className={`flex-1 flex flex-col items-center justify-center py-1 px-1 rounded-lg transition-colors cursor-pointer ${
            activeView === "dashboard" ? "text-indigo-400" : "text-[#949bb0] hover:text-white"
          }`}
        >
          <LayoutDashboard className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">Overview</span>
        </button>

        <button
          type="button"
          onClick={() => onSelectView("jobs")}
          className={`flex-1 flex flex-col items-center justify-center py-1 px-1 rounded-lg transition-colors cursor-pointer ${
            activeView === "jobs" ? "text-indigo-400" : "text-[#949bb0] hover:text-white"
          }`}
        >
          <Layers className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">
            Queue{queuedCount > 0 ? ` (${queuedCount})` : ""}
          </span>
        </button>

        <div className="flex items-center justify-center px-2">
          <button
            type="button"
            onClick={onOpenEnqueue}
            aria-label="Enqueue Episode"
            className="btn-primary w-9 h-9 rounded-lg flex items-center justify-center cursor-pointer"
          >
            <Plus className="w-4 h-4 text-white" />
          </button>
        </div>

        <button
          type="button"
          onClick={() => onSelectView("batches")}
          className={`flex-1 flex flex-col items-center justify-center py-1 px-1 rounded-lg transition-colors cursor-pointer ${
            activeView === "batches" ? "text-indigo-400" : "text-[#949bb0] hover:text-white"
          }`}
        >
          <Boxes className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">
            Batches{activeSlots > 0 ? ` (${activeSlots})` : ""}
          </span>
        </button>

        <button
          type="button"
          onClick={() => onSelectView("terminal")}
          className={`flex-1 flex flex-col items-center justify-center py-1 px-1 rounded-lg transition-colors cursor-pointer ${
            activeView === "terminal" ? "text-indigo-400" : "text-[#949bb0] hover:text-white"
          }`}
        >
          <Terminal className="w-4 h-4" />
          <span className="text-[10px] font-medium mt-0.5 whitespace-nowrap">Console</span>
        </button>
      </nav>
    </div>
  );
}
