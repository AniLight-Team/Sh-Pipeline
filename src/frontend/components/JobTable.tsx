import React, { useState, useEffect } from "react";
import { Search, RefreshCw, Trash2, ExternalLink, Info, AlertCircle } from "lucide-react";
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

export function JobTable() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const url =
        statusFilter === "all"
          ? "/api/jobs?limit=50"
          : `/api/jobs?status=${statusFilter}&limit=50`;
      const res = await fetch(url);
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {} finally {
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
    if (!confirm(`Delete Job #${jobId}?`)) return;
    try {
      await fetch(`/api/jobs/${jobId}/delete`, { method: "POST" });
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
      String(j.episodeNumber).includes(s) ||
      (j.metadata?.primaryTitle && j.metadata.primaryTitle.toLowerCase().includes(s)) ||
      (j.torrentTitle && j.torrentTitle.toLowerCase().includes(s)) ||
      (j.knownTitles && j.knownTitles.some((t: string) => t.toLowerCase().includes(s)))
    );
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-emerald-500/10 text-emerald-300 border border-emerald-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
            COMPLETED
          </span>
        );
      case "encoding":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-sky-500/15 text-sky-300 border border-sky-500/30">
            <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-ping" />
            ENCODING (GPU)
          </span>
        );
      case "staged":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-cyan-400" />
            STAGED (SSD)
          </span>
        );
      case "downloading":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-purple-500/10 text-purple-300 border border-purple-500/20">
            <span className="w-1.5 h-1.5 rounded-full bg-purple-400 animate-pulse" />
            DOWNLOADING
          </span>
        );
      case "queued":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-white/[0.05] text-neutral-400 border border-white/[0.08]">
            <span className="w-1.5 h-1.5 rounded-full bg-neutral-500" />
            QUEUED
          </span>
        );
      case "failed":
        return (
          <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[10px] font-bold font-mono bg-rose-500/10 text-rose-300 border border-rose-500/25">
            <span className="w-1.5 h-1.5 rounded-full bg-rose-400" />
            FAILED
          </span>
        );
      default:
        return (
          <span className="px-2 py-0.5 rounded-full text-[10px] font-mono bg-white/[0.05] text-neutral-400">
            {status.toUpperCase()}
          </span>
        );
    }
  };

  return (
    <div className="rounded-3xl bg-[#161723] overflow-hidden border border-white/[0.08] shadow-2xl">
      {/* Control Header */}
      <div className="p-4 sm:p-5 border-b border-white/[0.06] flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-bold text-white tracking-wide uppercase font-sans">
            Pipeline Encoding Jobs
          </h2>
          <span className="text-xs text-neutral-500 font-mono">
            ({filteredJobs.length} {filteredJobs.length === 1 ? "job" : "jobs"})
          </span>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Status Tab Pills */}
          <div className="hidden lg:flex items-center bg-[#10111a] p-1 rounded-full border border-white/[0.06] text-xs">
            {["all", "queued", "downloading", "staged", "encoding", "completed", "failed"].map(
              (st) => (
                <button
                  key={st}
                  onClick={() => setStatusFilter(st)}
                  className={`px-3 py-1 rounded-full capitalize font-medium transition-all duration-200 cursor-pointer ${
                    statusFilter === st
                      ? "bg-white/[0.12] text-white font-bold shadow-sm border border-white/15"
                      : "text-neutral-400 hover:text-white"
                  }`}
                >
                  {st}
                </button>
              )
            )}
          </div>

          {/* Quick Search */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-3.5 top-2.5 text-neutral-500" />
            <input
              type="text"
              placeholder="Search AniList ID, Title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-9 pr-3 py-1.5 rounded-full bg-[#10111a] border border-white/[0.08] text-xs text-neutral-200 placeholder-neutral-500 focus:outline-none focus:border-white/40 transition-all w-52 sm:w-60"
            />
          </div>

          <button
            onClick={fetchJobs}
            className="button-liquid-glass p-2 rounded-full text-neutral-300 hover:text-white transition-colors cursor-pointer"
            title="Refresh jobs table"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Table Body */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-[#10111a]/80 text-neutral-400 font-semibold border-b border-white/[0.06] tracking-wider uppercase text-[10px]">
            <tr>
              <th className="py-3.5 px-4 sm:px-5 font-mono">Job ID</th>
              <th className="py-3.5 px-4 sm:px-5">AniList ID / Title</th>
              <th className="py-3.5 px-4 sm:px-5 font-mono">Internal IDs</th>
              <th className="py-3.5 px-4 sm:px-5">Episode</th>
              <th className="py-3.5 px-4 sm:px-5">Status</th>
              <th className="py-3.5 px-4 sm:px-5">Torrent / Release Title</th>
              <th className="py-3.5 px-4 sm:px-5 font-mono">Size</th>
              <th className="py-3.5 px-4 sm:px-5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.04]">
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-12 text-center text-neutral-500">
                  No encoding jobs match the selected filter.
                </td>
              </tr>
            ) : (
              filteredJobs.map((job) => {
                const animeTitle =
                  job.metadata?.primaryTitle ||
                  (job.knownTitles && job.knownTitles[0]) ||
                  "Anime";

                return (
                  <tr
                    key={job.id}
                    className="hover:bg-white/[0.02] transition-colors group cursor-pointer"
                    onClick={() => setSelectedJob(job)}
                  >
                    {/* Job ID */}
                    <td className="py-3 px-4 sm:px-5 font-mono text-neutral-400 font-semibold">
                      #{job.id}
                    </td>

                    {/* AniList ID & Title (Prominently displayed) */}
                    <td className="py-3 px-4 sm:px-5">
                      <div className="flex flex-col">
                        <div className="flex items-center gap-1.5">
                          {job.anilistId ? (
                            <a
                              href={`https://anilist.co/anime/${job.anilistId}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 font-mono font-bold text-white hover:text-neutral-300 hover:underline"
                            >
                              AniList #{job.anilistId}
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          ) : (
                            <span className="font-mono text-neutral-500">AniList -</span>
                          )}
                        </div>
                        <span className="text-[11px] text-neutral-200 font-medium truncate max-w-xs block mt-0.5">
                          {animeTitle}
                        </span>
                      </div>
                    </td>

                    {/* Internal IDs (AniDB & AnimeId) */}
                    <td className="py-3 px-4 sm:px-5 font-mono">
                      <div className="flex flex-col gap-0.5 text-[11px]">
                        <span
                          className="text-neutral-400"
                          title="AniDB ID used internally for torrent queries"
                        >
                          AniDB: <strong className="text-neutral-300">{job.anidbId || "-"}</strong>
                        </span>
                        {job.animeId && (
                          <span className="text-neutral-500 text-[10px]">
                            MainId: #{job.animeId}
                          </span>
                        )}
                      </div>
                    </td>

                    {/* Episode & Audio Types */}
                    <td className="py-3 px-4 sm:px-5">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-white font-mono">
                          Ep {job.episodeNumber}
                        </span>
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-mono font-bold uppercase bg-white/[0.05] text-neutral-300 border border-white/[0.06]">
                          {job.types?.join("/") || "SUB"}
                        </span>
                      </div>
                    </td>

                    {/* Status Badge */}
                    <td className="py-3 px-4 sm:px-5">{getStatusBadge(job.status)}</td>

                    {/* Torrent / Error */}
                    <td
                      className="py-3 px-4 sm:px-5 max-w-xs truncate text-neutral-300"
                      title={job.torrentTitle || job.lastError || ""}
                    >
                      {job.torrentTitle ? (
                        <span className="text-neutral-300 truncate block text-[11px]">
                          {job.torrentTitle}
                        </span>
                      ) : job.lastError ? (
                        <span className="text-rose-400 text-[11px] truncate flex items-center gap-1">
                          <AlertCircle className="w-3 h-3 shrink-0" />
                          {job.lastError}
                        </span>
                      ) : (
                        <span className="text-neutral-600">-</span>
                      )}
                    </td>

                    {/* File Size */}
                    <td className="py-3 px-4 sm:px-5 font-mono text-neutral-400">
                      {job.sizeBytes ? `${(job.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : "-"}
                    </td>

                    {/* Actions */}
                    <td
                      className="py-3 px-4 sm:px-5 text-right space-x-1.5"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {job.status === "failed" && (
                        <button
                          onClick={() => handleRetry(job.id)}
                          className="button-liquid-glass p-1.5 rounded-full text-white hover:text-neutral-300 transition-colors cursor-pointer"
                          title="Retry failed job"
                        >
                          <RefreshCw className="w-3 h-3" />
                        </button>
                      )}
                      <button
                        onClick={() => setSelectedJob(job)}
                        className="button-liquid-glass p-1.5 rounded-full text-neutral-400 hover:text-white transition-colors cursor-pointer"
                        title="View job details"
                      >
                        <Info className="w-3 h-3" />
                      </button>
                      <button
                        onClick={() => handleDelete(job.id)}
                        className="button-liquid-glass p-1.5 rounded-full text-neutral-400 hover:text-rose-400 transition-colors cursor-pointer"
                        title="Delete job from pipeline"
                      >
                        <Trash2 className="w-3 h-3" />
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Job Details Modal */}
      {selectedJob && (
        <JobDetailsModal job={selectedJob} onClose={() => setSelectedJob(null)} />
      )}
    </div>
  );
}
