import React, { useState, useEffect } from "react";
import { Search, RefreshCw, Trash2, ArrowUpRight, Check, AlertTriangle, Clock } from "lucide-react";

interface Job {
  id: number;
  anidbId: number;
  episodeNumber: number;
  types: string[];
  status: string;
  torrentTitle?: string | null;
  sizeBytes?: number | null;
  lastError?: string | null;
  createdAt: string;
  stagedAt?: string | null;
  completedAt?: string | null;
}

export function JobTable() {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");

  const fetchJobs = async () => {
    setLoading(true);
    try {
      const url = statusFilter === "all" ? "/api/jobs?limit=50" : `/api/jobs?status=${statusFilter}&limit=50`;
      const res = await fetch(url);
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch {} finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchJobs();
    const interval = setInterval(fetchJobs, 8000);
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
    const s = search.toLowerCase();
    return (
      String(j.anidbId).includes(s) ||
      String(j.episodeNumber).includes(s) ||
      (j.torrentTitle && j.torrentTitle.toLowerCase().includes(s))
    );
  });

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "completed":
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">Completed</span>;
      case "encoding":
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-indigo-500/20 text-indigo-300 border border-indigo-500/30 animate-pulse">Encoding</span>;
      case "staged":
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-cyan-500/10 text-cyan-300 border border-cyan-500/20">Staged (VM)</span>;
      case "downloading":
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-amber-500/10 text-amber-300 border border-amber-500/20 animate-pulse">Downloading</span>;
      case "queued":
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-zinc-800 text-zinc-300 border border-zinc-700">Queued</span>;
      case "failed":
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/20">Failed</span>;
      default:
        return <span className="px-2 py-0.5 rounded text-[11px] font-bold bg-zinc-800 text-zinc-400">{status}</span>;
    }
  };

  return (
    <div className="rounded-xl bg-zinc-900/60 border border-zinc-800/80 overflow-hidden">
      {/* Header Controls */}
      <div className="p-4 border-b border-zinc-800/80 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-bold text-white tracking-wide uppercase">Pipeline Encoding Jobs</h2>
          <span className="text-xs text-zinc-500 font-mono">({filteredJobs.length} shown)</span>
        </div>

        <div className="flex items-center gap-2.5">
          {/* Status Tabs */}
          <div className="flex items-center bg-zinc-950 p-1 rounded-lg border border-zinc-800 text-xs">
            {["all", "queued", "downloading", "staged", "encoding", "completed", "failed"].map((st) => (
              <button
                key={st}
                onClick={() => setStatusFilter(st)}
                className={`px-2.5 py-1 rounded-md capitalize font-medium transition-all cursor-pointer ${
                  statusFilter === st
                    ? "bg-zinc-800 text-white font-semibold shadow-sm"
                    : "text-zinc-400 hover:text-zinc-200"
                }`}
              >
                {st}
              </button>
            ))}
          </div>

          {/* Search Box */}
          <div className="relative">
            <Search className="w-3.5 h-3.5 absolute left-2.5 top-2.5 text-zinc-500" />
            <input
              type="text"
              placeholder="Search AniDB ID or Title..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="pl-8 pr-3 py-1.5 rounded-lg bg-zinc-950 border border-zinc-800 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-indigo-500 transition-all w-52"
            />
          </div>

          <button
            onClick={fetchJobs}
            className="p-1.5 rounded-lg bg-zinc-800 text-zinc-300 hover:bg-zinc-700 transition cursor-pointer"
            title="Refresh jobs"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-left text-xs">
          <thead className="bg-zinc-950/50 text-zinc-400 font-semibold border-b border-zinc-800/80">
            <tr>
              <th className="py-2.5 px-4">ID</th>
              <th className="py-2.5 px-4">AniDB</th>
              <th className="py-2.5 px-4">Episode</th>
              <th className="py-2.5 px-4">Language</th>
              <th className="py-2.5 px-4">Status</th>
              <th className="py-2.5 px-4">Torrent / File</th>
              <th className="py-2.5 px-4">Size</th>
              <th className="py-2.5 px-4 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-800/50">
            {filteredJobs.length === 0 ? (
              <tr>
                <td colSpan={8} className="py-8 text-center text-zinc-500">
                  No jobs found matching criteria.
                </td>
              </tr>
            ) : (
              filteredJobs.map((job) => (
                <tr key={job.id} className="hover:bg-zinc-800/20 transition-colors">
                  <td className="py-2.5 px-4 font-mono text-zinc-400">#{job.id}</td>
                  <td className="py-2.5 px-4 font-mono font-bold text-indigo-400">
                    {job.anidbId}
                  </td>
                  <td className="py-2.5 px-4 font-bold text-white">
                    Ep {job.episodeNumber}
                  </td>
                  <td className="py-2.5 px-4">
                    <span className="px-1.5 py-0.5 rounded bg-zinc-800 text-zinc-300 uppercase text-[10px] font-bold">
                      {job.types?.join("/") || "SUB"}
                    </span>
                  </td>
                  <td className="py-2.5 px-4">{getStatusBadge(job.status)}</td>
                  <td className="py-2.5 px-4 max-w-xs truncate text-zinc-300" title={job.torrentTitle || ""}>
                    {job.torrentTitle || (job.lastError ? (
                      <span className="text-rose-400 text-[11px] truncate block">{job.lastError}</span>
                    ) : "-")}
                  </td>
                  <td className="py-2.5 px-4 font-mono text-zinc-400">
                    {job.sizeBytes ? `${(job.sizeBytes / (1024 * 1024)).toFixed(1)} MB` : "-"}
                  </td>
                  <td className="py-2.5 px-4 text-right space-x-1.5">
                    {job.status === "failed" && (
                      <button
                        onClick={() => handleRetry(job.id)}
                        className="p-1 rounded bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition cursor-pointer"
                        title="Retry job"
                      >
                        <RefreshCw className="w-3 h-3" />
                      </button>
                    )}
                    <button
                      onClick={() => handleDelete(job.id)}
                      className="p-1 rounded bg-zinc-800 text-zinc-400 hover:text-rose-400 hover:bg-rose-500/10 transition cursor-pointer"
                      title="Delete job"
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

