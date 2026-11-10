import React, { useState, useEffect } from "react";
import {
  Search,
  RefreshCw,
  Trash2,
  ExternalLink,
  Info,
  AlertCircle,
  CheckCircle2,
  Clock,
  Loader2,
  HardDrive,
  Plus,
} from "lucide-react";
import { JobDetailsModal } from "./JobDetailsModal.js";

interface Job {
  id: number;
  anilistId?: number | null;
  animeId?: number | null;
  anidbId?: number | null;
  episodeNumber: number;
  types: string[];
  status: string;
  torrentTitle?: string | null;
  sizeBytes?: number | null;
  lastError?: string | null;
  metadata?: any;
  knownTitles?: string[];
  createdAt: string;
  stagedAt?: string | null;
  completedAt?: string | null;
}

interface JobTableProps {
  onOpenEnqueue?: () => void;
}

export function JobTable({ onOpenEnqueue }: JobTableProps) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const url =
        statusFilter === "all"
          ? "/api/jobs?limit=75"
          : `/api/jobs?status=${statusFilter}&limit=75`;
      const res = await fetch(url);
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {
      // Ignore transient errors
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 6000);
    return () => clearInterval(interval);
  }, [statusFilter]);

  const handleRetry = async (jobId: number) => {
    try {
      await fetch(`/api/jobs/${jobId}/retry`, { method: "POST" });
      fetchJobs();
    } catch {}
  };

  const handleDelete = async (jobId: number) => {
    try {
      await fetch(`/api/jobs/${jobId}/delete`, { method: "POST" });
      setConfirmDeleteId(null);
      fetchJobs();
    } catch {}
  };

  const filteredJobs = jobs.filter((j) => {
    if (!search) return true;
    const s = search.toLowerCase().trim();
    return (
      (j.anilistId && String(j.anilistId).includes(s)) ||
      (j.anidbId && String(j.anidbId).includes(s)) ||
      (j.animeId && String(j.animeId).includes(s)) ||
      (j.metadata?.tsukihimeId && String(j.metadata.tsukihimeId).includes(s)) ||
      String(j.episodeNumber).includes(s) ||
      (j.metadata?.primaryTitle && j.metadata.primaryTitle.toLowerCase().includes(s)) ||
      (j.torrentTitle && j.torrentTitle.toLowerCase().includes(s)) ||
      (j.knownTitles && j.knownTitles.some((t: string) => t.toLowerCase().includes(s)))
    );
  });

  const renderStatus = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" />
            <span>Completed</span>
          </span>
        );
      case "encoding":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-violet-300">
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
            <span>Encoding GPU</span>
          </span>
        );
      case "staged":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-indigo-300">
            <HardDrive className="w-3.5 h-3.5 shrink-0" />
            <span>Staged SSD</span>
          </span>
        );
      case "downloading":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-sky-400">
            <Loader2 className="w-3.5 h-3.5 shrink-0 animate-spin" />
            <span>Downloading</span>
          </span>
        );
      case "queued":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-amber-300">
            <Clock className="w-3.5 h-3.5 shrink-0" />
            <span>Queued</span>
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-1.5 text-xs font-mono text-rose-400">
            <AlertCircle className="w-3.5 h-3.5 shrink-0" />
            <span>Failed</span>
          </span>
        );
      default:
        return (
          <span className="text-xs font-mono text-[#949bb0] capitalize">
            {status}
          </span>
        );
    }
  };

  const filterTabs = [
    { id: "all", label: "All" },
    { id: "queued", label: "Queued" },
    { id: "downloading", label: "Downloading" },
    { id: "staged", label: "Staged" },
    { id: "encoding", label: "Encoding" },
    { id: "completed", label: "Completed" },
    { id: "failed", label: "Failed" },
  ];

  return (
    <div className="surface-panel rounded-xl overflow-hidden">
      {/* Control Header */}
      <div className="px-5 py-4 border-b border-[#1e2230] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-semibold text-[#f3f4f8]">
            Pipeline Encoding Jobs
          </h2>
          <span className="text-xs text-[#636b82] font-mono tabular-nums">
            · {filteredJobs.length} {filteredJobs.length === 1 ? "entry" : "entries"}
          </span>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          {/* Interactive Segmented Filter Controls */}
          <div className="hidden xl:flex items-center bg-[#0c0e14] p-1 rounded-lg border border-[#1e2230] text-xs">
            {filterTabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setStatusFilter(tab.id)}
                className={`px-2.5 py-1 rounded-md font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  statusFilter === tab.id
                    ? "bg-[#1c202e] text-white"
                    : "text-[#949bb0] hover:text-white"
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Mobile/Tablet Status Select */}
          <select
            aria-label="Filter jobs by status"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
            className="xl:hidden bg-[#0c0e14] border border-[#1e2230] rounded-lg px-2.5 py-1.5 text-xs text-[#f3f4f8] focus:outline-none focus:border-indigo-500"
          >
            {filterTabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                Status: {tab.label}
              </option>
            ))}
          </select>

          {/* Search Input */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3 top-2.5 text-[#636b82]" />
            <input
              type="text"
              aria-label="Search jobs by AniList ID, Tsukihime ID, or title"
              placeholder="Search ID, title, release..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 rounded-lg bg-[#0c0e14] border border-[#1e2230] text-xs text-[#f3f4f8] placeholder-[#636b82] focus:outline-none focus:border-indigo-500/60 transition-colors w-48 sm:w-60"
            />
          </div>

          <button
            type="button"
            onClick={fetchJobs}
            aria-label="Refresh jobs table"
            className="btn-secondary p-1.5 rounded-lg text-[#949bb0] hover:text-white cursor-pointer"
            title="Refresh jobs table"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Table Body */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-[#0c0e14] text-[#636b82] font-medium border-b border-[#1e2230]">
            <tr>
              <th className="py-2.5 px-4 font-mono">Job</th>
              <th className="py-2.5 px-4">Anime & AniList ID</th>
              <th className="py-2.5 px-4 font-mono">Provider IDs</th>
              <th className="py-2.5 px-4">Episode</th>
              <th className="py-2.5 px-4">Status</th>
              <th className="py-2.5 px-4">Release / Diagnostic</th>
              <th className="py-2.5 px-4 text-right font-mono">Size</th>
              <th className="py-2.5 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[#1e2230]">
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 px-6 text-center">
                  <p className="text-xs font-medium text-[#f3f4f8]">
                    No encoding jobs match the current filter
                  </p>
                  <p className="text-xs text-[#636b82] mt-1">
                    Enqueue an anime episode by AniList ID to initiate Tsukihime & AnimeTosho discovery.
                  </p>
                  {onOpenEnqueue && (
                    <button
                      type="button"
                      onClick={onOpenEnqueue}
                      className="btn-primary mt-3 px-3.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      <span>Enqueue First Episode</span>
                    </button>
                  )}
                </td>
              </tr>
            ) : (
              filteredJobs.map((job) => {
                const animeTitle =
                  job.metadata?.primaryTitle ||
                  (job.knownTitles && job.knownTitles[0]) ||
                  `AniList #${job.anilistId || job.id}`;
                const tsukihimeId = job.metadata?.tsukihimeId;

                return (
                  <tr
                    key={job.id}
                    className="hover:bg-[#151822]/70 transition-colors cursor-pointer"
                    onClick={() => setSelectedJob(job)}
                  >
                    <td className="py-3 px-4 font-mono tabular-nums text-[#949bb0] font-semibold">
                      #{job.id}
                    </td>

                    <td className="py-3 px-4">
                      <div className="flex flex-col">
                        <span className="text-xs font-medium text-[#f3f4f8] truncate max-w-xs">
                          {animeTitle}
                        </span>
                        <div className="flex items-center gap-2 mt-0.5 text-[11px] font-mono tabular-nums text-[#636b82]">
                          {job.anilistId ? (
                            <a
                              href={`https://anilist.co/anime/${job.anilistId}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="text-indigo-400 hover:underline inline-flex items-center gap-1"
                            >
                              <span>AniList #{job.anilistId}</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          ) : (
                            <span>AniList —</span>
                          )}
                        </div>
                      </div>
                    </td>

                    <td className="py-3 px-4 font-mono tabular-nums text-[11px] text-[#949bb0]">
                      <div className="flex flex-col">
                        <span>
                          AniDB: <strong className="text-[#d5d9e6]">{job.anidbId || "—"}</strong>
                          {tsukihimeId ? ` · Tsuki: #${tsukihimeId}` : ""}
                        </span>
                        {job.animeId && (
                          <span className="text-[#636b82]">Main DB: #{job.animeId}</span>
                        )}
                      </div>
                    </td>

                    <td className="py-3 px-4 font-mono tabular-nums">
                      <span className="font-semibold text-[#f3f4f8]">Ep {job.episodeNumber}</span>
                      <span className="text-[#636b82] mx-1.5">·</span>
                      <span className="text-[11px] text-[#949bb0] uppercase">
                        {job.types?.join("/") || "SUB"}
                      </span>
                    </td>

                    <td className="py-3 px-4">{renderStatus(job.status)}</td>

                    <td
                      className="py-3 px-4 max-w-xs truncate"
                      title={job.torrentTitle || job.lastError || ""}
                    >
                      {job.torrentTitle ? (
                        <span className="text-[#d5d9e6] truncate block text-[11px] font-mono">
                          {job.torrentTitle}
                        </span>
                      ) : job.lastError ? (
                        <span className="text-rose-400 text-[11px] truncate flex items-center gap-1 font-mono">
                          <AlertCircle className="w-3 h-3 shrink-0" />
                          <span className="truncate">{job.lastError}</span>
                        </span>
                      ) : (
                        <span className="text-[#636b82] text-[11px]">Awaiting candidate selection</span>
                      )}
                    </td>

                    <td className="py-3 px-4 text-right font-mono tabular-nums text-[#949bb0]">
                      {job.sizeBytes ? `${(job.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : "—"}
                    </td>

                    <td
                      className="py-3 px-4 text-right whitespace-nowrap"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {confirmDeleteId === job.id ? (
                        <div className="inline-flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleDelete(job.id)}
                            className="px-2 py-1 rounded bg-rose-500/20 text-rose-300 border border-rose-500/30 text-[11px] font-medium hover:bg-rose-500/30 cursor-pointer"
                          >
                            Confirm
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2 py-1 rounded bg-[#151822] text-[#949bb0] text-[11px] hover:text-white cursor-pointer"
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <div className="inline-flex items-center gap-1">
                          {job.status === "failed" && (
                            <button
                              type="button"
                              onClick={() => handleRetry(job.id)}
                              className="btn-secondary p-1.5 rounded-md text-[#d5d9e6] hover:text-white cursor-pointer"
                              title={`Retry Job #${job.id}`}
                              aria-label={`Retry Job #${job.id}`}
                            >
                              <RefreshCw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => setSelectedJob(job)}
                            className="btn-secondary p-1.5 rounded-md text-[#949bb0] hover:text-white cursor-pointer"
                            title={`Inspect Job #${job.id}`}
                            aria-label={`Inspect Job #${job.id}`}
                          >
                            <Info className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDeleteId(job.id)}
                            className="btn-secondary p-1.5 rounded-md text-[#949bb0] hover:text-rose-400 cursor-pointer"
                            title={`Delete Job #${job.id}`}
                            aria-label={`Delete Job #${job.id}`}
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {selectedJob && (
        <JobDetailsModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  );
}
