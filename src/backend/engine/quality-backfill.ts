import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { INTERNAL_SECRET, loadAccountsFromEnv, MAIN_BACKEND_URL } from "../config.js";
import type { PipelineEncodedSource, PipelineEpisodeResult } from "./types.js";

export const BACKFILL_QUALITIES = ["720p", "480p"] as const;
export type BackfillQuality = typeof BACKFILL_QUALITIES[number];

export function missingBackfillQualities(sources: PipelineEncodedSource[]) {
  return BACKFILL_QUALITIES.filter(quality => !sources.some(source => source.quality === quality));
}

export async function isBackfillQualityMissing(
  stream: Pick<PipelineEpisodeResult, "animeId" | "anilistId" | "anidbId" | "episodeNumber" | "type" | "sourceJobId" | "sourceUrl">,
  quality: BackfillQuality,
) {
  const response = await fetch(`${MAIN_BACKEND_URL}/api/internal/pipeline/quality-backfill/status`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-internal-secret": INTERNAL_SECRET },
    body: JSON.stringify(stream),
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Could not check published qualities (HTTP ${response.status})`);
  const result = await response.json() as { status?: string; missingQualities?: BackfillQuality[]; sourceUrl?: string };
  if (result.status === "source_changed") return false;
  if (result.status !== "ready" || result.sourceUrl !== stream.sourceUrl || !Array.isArray(result.missingQualities)) {
    throw new Error("Invalid published quality status from Main API");
  }
  return result.missingQualities.includes(quality);
}

export async function stageStored1080p(
  source: { url: string; sha256?: string; sizeBytes?: number },
  destination: string,
  maxBytes: number,
): Promise<number> {
  // VM remux stores a stable bucket URL. Send credentials only to its configured bucket origin.
  const url = new URL(source.url);
  const bucket = url.pathname.match(/^\/buckets\/([^/]+)\/([^/]+)\/resolve\/[^/].*\.mp4$/i);
  if (url.origin !== "https://huggingface.co" || url.username || url.password || !bucket) {
    throw new Error("Expected a stored Hugging Face VM remux source");
  }
  const { hfAccounts } = loadAccountsFromEnv();
  const account = hfAccounts.find(item => item.owner === bucket[1] && item.bucket === bucket[2]);
  const signal = AbortSignal.timeout(20 * 60_000);
  const response = await fetch(url, {
    headers: account ? { Authorization: `Bearer ${account.token}` } : undefined,
    signal,
  });
  const contentLength = Number(response.headers.get("content-length")) || undefined;
  if (!response.ok || !response.body || (contentLength && contentLength > maxBytes)) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Stored 1080p download unavailable or exceeds staging capacity (HTTP ${response.status})`);
  }

  const sha = createHash("sha256");
  let bytes = 0;
  const verify = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      if (bytes > maxBytes) return done(new Error("Stored 1080p exceeds remaining staging capacity"));
      sha.update(chunk);
      done(null, chunk);
    },
  });
  await pipeline(Readable.from(response.body), verify, createWriteStream(destination, { flags: "wx" }), { signal });
  if (bytes < 10_240 || (source.sizeBytes && bytes !== source.sizeBytes) ||
      (source.sha256 && sha.digest("hex") !== source.sha256)) {
    throw new Error("Stored 1080p failed size or checksum verification");
  }
  return bytes;
}
