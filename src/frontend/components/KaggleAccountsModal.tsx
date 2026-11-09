import React from "react";
import { X, Cpu, CheckCircle2, Zap } from "lucide-react";
import type { PipelineStats } from "../../backend/engine/types.js";

interface KaggleAccountsModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: PipelineStats | null;
}

export function KaggleAccountsModal({ isOpen, onClose, stats }: KaggleAccountsModalProps) {
  if (!isOpen) return null;

  const accounts = stats?.accounts?.kaggle || [];
  const activeBatches = stats?.activeBatches || [];
  const totalSlots = stats?.concurrency?.max || accounts.length * 2;
  const activeSlots = stats?.concurrency?.active || 0;

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-4">
      <div className="bg-[#161724] border border-white/[0.1] rounded-3xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between pb-4 border-b border-white/[0.08]">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-2xl bg-purple-500/10 border border-purple-500/20 flex items-center justify-center text-purple-300">
              <Cpu className="w-5 h-5" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h3 className="text-base font-bold text-white tracking-tight">
                  Kaggle GPU Cluster & Account Pool
                </h3>
                <span className="px-2.5 py-0.5 rounded-full text-[10px] font-mono font-bold bg-purple-500/10 text-purple-300 border border-purple-500/20">
                  {accounts.length} Accounts
                </span>
              </div>
              <p className="text-xs text-neutral-400 mt-0.5">
                Each Kaggle account supports up to 2 concurrent running notebooks ({totalSlots} total cluster slots).
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="button-liquid-glass w-8 h-8 rounded-full flex items-center justify-center text-neutral-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Global Cluster Meter */}
        <div className="my-5 p-4 rounded-2xl bg-[#10111a] border border-white/[0.07] flex items-center justify-between">
          <div>
            <div className="text-[11px] font-mono uppercase tracking-wider text-neutral-400">
              Active Concurrent Sessions
            </div>
            <div className="text-2xl font-bold font-mono text-white mt-1">
              {activeSlots}{" "}
              <span className="text-sm text-neutral-500 font-normal">/ {totalSlots} max slots</span>
            </div>
          </div>
          <div className="text-right">
            <span
              className={`px-3 py-1 rounded-full text-xs font-mono font-bold ${
                activeSlots >= totalSlots
                  ? "bg-rose-500/10 text-rose-300 border border-rose-500/20"
                  : activeSlots > 0
                  ? "bg-white/[0.1] text-white border border-white/20"
                  : "bg-emerald-500/10 text-emerald-300 border border-emerald-500/20"
              }`}
            >
              {activeSlots >= totalSlots
                ? "FULL CAPACITY"
                : activeSlots > 0
                ? "CLUSTER RUNNING"
                : "ALL SLOTS IDLE"}
            </span>
          </div>
        </div>

        {/* Accounts List */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-neutral-300 uppercase tracking-wider">
            Configured Kaggle Accounts ({accounts.length})
          </h4>

          {accounts.length === 0 ? (
            <div className="p-6 text-center text-neutral-500 text-xs rounded-2xl bg-[#10111a] border border-white/[0.05]">
              No Kaggle accounts found in environment (KAGGLE_ACCOUNTS).
            </div>
          ) : (
            accounts.map((acc, idx) => {
              const accountBatches = activeBatches.filter((b) => b.kaggleUsername === acc.username);

              return (
                <div
                  key={acc.username || idx}
                  className="p-4 rounded-2xl bg-[#10111a] border border-white/[0.06] hover:border-white/[0.12] transition-colors"
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-sm font-bold text-white">
                        @{acc.username}
                      </span>
                      <span className="text-[10px] font-mono px-2 py-0.5 rounded-full bg-white/[0.04] text-neutral-400 border border-white/[0.06]">
                        Account #{idx + 1}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <span className="text-[11px] font-mono text-neutral-400">
                        Load: {acc.activeTasks}/2 Slots
                      </span>
                      <div className="flex items-center gap-1">
                        <span
                          className={`w-2 h-2 rounded-full ${
                            acc.slots[0] ? "bg-emerald-400 animate-pulse" : "bg-neutral-700"
                          }`}
                          title={acc.slots[0] ? "Slot 1: Active" : "Slot 1: Idle"}
                        />
                        <span
                          className={`w-2 h-2 rounded-full ${
                            acc.slots[1] ? "bg-emerald-400 animate-pulse" : "bg-neutral-700"
                          }`}
                          title={acc.slots[1] ? "Slot 2: Active" : "Slot 2: Idle"}
                        />
                      </div>
                    </div>
                  </div>

                  {/* Dual-Slot Visual Representation */}
                  <div className="grid grid-cols-2 gap-2 mt-3">
                    <div
                      className={`p-2.5 rounded-xl border text-[11px] font-mono flex items-center justify-between ${
                        acc.slots[0]
                          ? "bg-white/[0.08] border-white/20 text-white"
                          : "bg-white/[0.02] border-white/[0.05] text-neutral-500"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Zap
                          className={`w-3.5 h-3.5 ${
                            acc.slots[0] ? "text-emerald-400" : "text-neutral-600"
                          }`}
                        />
                        <span>Slot 1: {acc.slots[0] ? "Running Notebook" : "Available"}</span>
                      </div>
                      {acc.slots[0] && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-white/20 text-white font-bold">
                          BUSY
                        </span>
                      )}
                    </div>

                    <div
                      className={`p-2.5 rounded-xl border text-[11px] font-mono flex items-center justify-between ${
                        acc.slots[1]
                          ? "bg-white/[0.08] border-white/20 text-white"
                          : "bg-white/[0.02] border-white/[0.05] text-neutral-500"
                      }`}
                    >
                      <div className="flex items-center gap-2">
                        <Zap
                          className={`w-3.5 h-3.5 ${
                            acc.slots[1] ? "text-emerald-400" : "text-neutral-600"
                          }`}
                        />
                        <span>Slot 2: {acc.slots[1] ? "Running Notebook" : "Available"}</span>
                      </div>
                      {acc.slots[1] && (
                        <span className="text-[9px] px-1.5 py-0.2 rounded bg-white/20 text-white font-bold">
                          BUSY
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Running Batches Info */}
                  {accountBatches.length > 0 && (
                    <div className="mt-3 pt-2.5 border-t border-white/[0.05] flex flex-wrap gap-2">
                      {accountBatches.map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center gap-1.5 text-[10px] font-mono px-2.5 py-1 rounded-full bg-white/[0.04] text-neutral-300 border border-white/[0.08]"
                        >
                          <CheckCircle2 className="w-3 h-3 text-emerald-400" />
                          <span>Batch #{b.id}</span>
                          <span className="text-neutral-500">({b.jobCount} files)</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-white/[0.08] flex justify-end">
          <button
            onClick={onClose}
            className="button-liquid-glass px-5 py-2 rounded-full text-xs font-semibold text-neutral-300 hover:text-white transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
