import { useDialog } from "../hooks/useDialog.js";
import React from "react";
import { X, Cpu, CheckCircle2, Zap } from "lucide-react";
import type { PipelineStats } from "../../backend/engine/types.js";

interface KaggleAccountsModalProps {
  isOpen: boolean;
  onClose: () => void;
  stats: PipelineStats | null;
}

export function KaggleAccountsModal({ isOpen, onClose, stats }: KaggleAccountsModalProps) {
  useDialog(isOpen, onClose);
  if (!isOpen) return null;

  const accounts = stats?.accounts?.kaggle || [];
  const activeBatches = stats?.activeBatches || [];
  const totalSlots = stats?.concurrency?.max || Math.max(2, accounts.length * 2);
  const activeSlots = stats?.concurrency?.active || 0;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kaggle-modal-title"
      className="fixed inset-0 z-50 bg-[#302e2a]/35 backdrop-blur-sm flex items-center justify-center p-4"
    >
      <div className="surface-panel rounded-xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] overflow-y-auto">
        <div className="flex items-start justify-between pb-4 border-b border-[#e6e3db]">
          <div className="flex items-center gap-3 pr-8">
            <div className="w-9 h-9 rounded-lg bg-indigo-500/15 border border-indigo-500/30 flex items-center justify-center text-[#9a563b] shrink-0">
              <Cpu className="w-4 h-4" />
            </div>
            <div>
              <h3 id="kaggle-modal-title" className="text-base font-bold text-[#302e2a]">
                Kaggle GPU Cluster & Account Pool
              </h3>
              <p className="text-xs text-[#817a70] mt-0.5">
                {accounts.length} configured {accounts.length === 1 ? "account" : "accounts"} · 2 concurrent T4×2 GPU notebook slots per account ({totalSlots} total slots)
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            aria-label="Close Kaggle cluster modal"
            className="btn-secondary w-8 h-8 rounded-lg flex items-center justify-center text-[#716c63] hover:text-[#302e2a] cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Cluster Summary Bar */}
        <div className="my-4 p-4 rounded-lg bg-[#f5f3ed] border border-[#e6e3db] flex items-center justify-between">
          <div>
            <div className="text-xs text-[#716c63]">Active Concurrent GPU Sessions</div>
            <div className="text-xl font-bold font-mono tabular-nums text-[#302e2a] mt-0.5">
              {activeSlots}{" "}
              <span className="text-xs text-[#817a70] font-normal">/ {totalSlots} max slots</span>
            </div>
          </div>
          <div className="text-xs font-mono">
            {activeSlots >= totalSlots ? (
              <span className="text-[#92703e]">Cluster at Full Capacity</span>
            ) : activeSlots > 0 ? (
              <span className="text-[#9a563b]">Active Encoding ({activeSlots} running)</span>
            ) : (
              <span className="text-[#52734c]">All Slots Available</span>
            )}
          </div>
        </div>

        {/* Account Cards */}
        <div className="space-y-3">
          <h4 className="text-xs font-semibold text-[#716c63]">
            Account Slot Allocation
          </h4>

          {accounts.length === 0 ? (
            <div className="p-6 text-center text-[#817a70] text-xs rounded-lg bg-[#f5f3ed] border border-[#e6e3db]">
              No Kaggle accounts found in environment (KAGGLE_ACCOUNTS).
            </div>
          ) : (
            accounts.map((acc, idx) => {
              const accountBatches = activeBatches.filter((b) => b.kaggleUsername === acc.username);

              return (
                <div
                  key={acc.username || idx}
                  className="p-4 rounded-lg bg-[#f5f3ed] border border-[#e6e3db]"
                >
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <span className="font-semibold text-[#302e2a]">@{acc.username}</span>
                      <span className="text-[#817a70]">· Account #{idx + 1}</span>
                    </div>
                    <span className="text-xs font-mono tabular-nums text-[#716c63]">
                      {acc.activeTasks} / 2 slots active
                    </span>
                  </div>

                  <div className="grid grid-cols-2 gap-2.5">
                    {[0, 1].map((slotIdx) => {
                      const isOccupied = Boolean(acc.slots?.[slotIdx]);
                      return (
                        <div
                          key={slotIdx}
                          className={`p-2.5 rounded-lg border text-xs font-mono flex items-center justify-between ${
                            isOccupied
                              ? "bg-indigo-500/10 border-indigo-500/30 text-[#302e2a]"
                              : "bg-[#fffefa] border-[#e6e3db] text-[#817a70]"
                          }`}
                        >
                          <div className="flex items-center gap-2">
                            <Zap
                              className={`w-3.5 h-3.5 ${
                                isOccupied ? "text-[#9a563b]" : "text-[#817a70]"
                              }`}
                            />
                            <span>Slot {slotIdx + 1}</span>
                          </div>
                          <span>{isOccupied ? "Running" : "Idle"}</span>
                        </div>
                      );
                    })}
                  </div>

                  {accountBatches.length > 0 && (
                    <div className="mt-3 pt-2.5 border-t border-[#e6e3db] flex flex-wrap gap-3">
                      {accountBatches.map((b) => (
                        <div
                          key={b.id}
                          className="flex items-center gap-1.5 text-xs font-mono text-[#5b554a]"
                        >
                          <CheckCircle2 className="w-3.5 h-3.5 text-[#52734c]" />
                          <span>Batch #{b.id} ({b.jobCount} files)</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>

        <div className="mt-5 pt-4 border-t border-[#e6e3db] flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="btn-secondary px-4 py-2 rounded-lg text-xs font-medium cursor-pointer"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
