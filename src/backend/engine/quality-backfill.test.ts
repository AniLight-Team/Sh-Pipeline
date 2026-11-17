import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { eq } from "drizzle-orm";

const sourceUrl = "https://huggingface.co/buckets/test/store/resolve/original/1080p.mp4";
const media = Buffer.alloc(10_240, 42);
const sha256 = createHash("sha256").update(media).digest("hex");
const testDb = process.env.KIRA_TEST_DATABASE_URL;
if (testDb) process.env.DATABASE_URL = testDb;

test("stored source staging checks checksum and transfer size", async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "kira-source-test-"));
  t.after(() => fs.rm(scratch, { recursive: true, force: true }));
  const { stageStored1080p } = await import("./quality-backfill.js");
  t.mock.method(globalThis, "fetch", async () => new Response(media));
  const source = { url: sourceUrl, sha256, sizeBytes: media.length };
  const valid = path.join(scratch, "valid.mp4");
  assert.equal(await stageStored1080p(source, valid, media.length), media.length);
  assert.deepEqual(await fs.readFile(valid), media);
  await assert.rejects(stageStored1080p({ ...source, sha256: "0".repeat(64) }, path.join(scratch, "bad-hash.mp4"), media.length), /checksum/);
  await assert.rejects(stageStored1080p(source, path.join(scratch, "over-limit.mp4"), media.length - 1), /capacity/);
  await assert.rejects(stageStored1080p({ ...source, url: "https://example.test/1080p.mp4" }, path.join(scratch, "external.mp4"), media.length), /Hugging Face/);
});

test("VM release seeds independent quality retries once and reuses stored 1080p when searches expire", { skip: !testDb }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "kira-backfill-test-"));
  process.env.KIRA_STAGING_DIR = scratch;
  process.env.KIRA_EXECUTION_POLICY = "all";
  process.env.KAGGLE_ACCOUNTS = JSON.stringify([{ username: "test", key: "test" }]);
  const { db, schema } = await import("../db/index.js");
  const { PipelineEngineService } = await import("./service.js");
  const { AnimeToshoClient } = await import("./animetosho.client.js");
  const { TsukihimeClient } = await import("./tsukihime.client.js");
  const { QUALITY_BACKFILL_SEARCH_DELAYS_MS } = await import("./job-scheduling.js");
  const animeId = randomInt(100_000_000, 2_000_000_000);
  t.after(async () => {
    try { await db.delete(schema.pipelineJob).where(eq(schema.pipelineJob.animeId, animeId)); }
    finally {
      await db.$client.end();
      await fs.rm(scratch, { recursive: true, force: true });
    }
  });
  await PipelineEngineService.ensureTables();
  t.mock.method(PipelineEngineService, "deliverCallbackPayload", async () => true);
  t.mock.method(PipelineEngineService, "drainVmRemuxQueue", async () => []);
  t.mock.method(PipelineEngineService, "checkStorageCapacityForDownload", async () => ({
    allowed: true, usedBytes: 0, reservedBytes: 0, freeDiskBytes: 64 * 1024 ** 3,
  }));
  t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({ anime: null, torrents: [] }));
  t.mock.method(TsukihimeClient, "hydrateCandidates", async (entries: Parameters<typeof TsukihimeClient.hydrateCandidates>[0]) => entries);
  let torrentAvailable = false;
  const lowerTitle = "[SubsPlease] Example Anime - 02 (720p) [ABCDEF01].mkv";
  const search = t.mock.method(AnimeToshoClient, "fetchTorrents", async (_aid: number, quality: string) =>
    quality === "720p" && torrentAvailable ? [{ title: lowerTitle, seeders: 10, info_hash: "1".repeat(40) }] : []);
  t.mock.method(AnimeToshoClient, "fetchTorrentsByTitle", async () => []);
  let storedDownloads = 0;
  t.mock.method(globalThis, "fetch", async (request: Parameters<typeof fetch>[0]) => {
    const url = String(request);
    if (url === sourceUrl) {
      storedDownloads++;
      return new Response(media);
    }
    assert.ok(url.endsWith("/api/internal/pipeline/quality-backfill/status"));
    return Response.json({ status: "ready", missingQualities: ["720p", "480p"], sourceUrl });
  });

  const [parent] = await db.insert(schema.pipelineJob).values({
    animeId, anidbId: animeId, episodeNumber: 2, types: ["sub"], status: "completed", pipelineType: "vm_remux",
    releaseGroup: "SubsPlease", knownTitles: ["Example Anime"],
    torrentTitle: "[SubsPlease] Example Anime - 02 (1080p) [ABCDEF02].mkv",
    qualitiesPayload: { "1080p": { effectiveEp: 2, durationSeconds: 1 } },
    metadata: { kind: "release", callbackDelivered: false },
    resultPayload: { type: "sub", kind: "release", sources: [{ quality: "1080p", url: sourceUrl, sha256, sizeBytes: media.length }] },
  }).returning();
  assert.equal(await PipelineEngineService.retryJobCallback(parent.id), true);
  assert.equal(await PipelineEngineService.retryJobCallback(parent.id, true), true);
  const allJobs = await db.query.pipelineJob.findMany({ where: eq(schema.pipelineJob.animeId, animeId) });
  assert.equal(allJobs.length, 3);
  const children = allJobs.filter(row => row.metadata?.kind === "quality_backfill");
  const lower720 = children.find(row => row.metadata?.targetQuality === "720p")!;
  const lower480 = children.find(row => row.metadata?.targetQuality === "480p")!;
  const lookup = (id: number) => db.query.pipelineJob.findFirst({ where: eq(schema.pipelineJob.id, id) });
  const makeDue = (id: number) => db.update(schema.pipelineJob).set({ discoverAfter: new Date(0) }).where(eq(schema.pipelineJob.id, id));
  assert.ok(lower720.discoverAfter && lower720.discoverAfter > new Date());
  assert.equal((await PipelineEngineService.discoverAndStageJob(lower720.id)).status, "skipped");
  assert.equal(search.mock.callCount(), 0);
  await makeDue(lower720.id);
  assert.equal((await PipelineEngineService.discoverAndStageJob(lower720.id)).status, "retry_scheduled");
  assert.equal((await lookup(lower720.id))?.metadata?.qualitySearchAttempts, 1);

  const fixture = path.join(scratch, "720p.mkv");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=s=1280x720:d=1", "-f", "lavfi", "-i",
    "sine=frequency=440:duration=1", "-c:v", "libx264", "-c:a", "aac", "-metadata:s:a:0", "language=jpn", fixture]);
  torrentAvailable = true;
  const transfer = t.mock.method(PipelineEngineService as any, "downloadCandidateEpisodeToStaging", async () => ({
    ok: true, stagedPath: fixture, sizeBytes: (await fs.stat(fixture)).size, magnetUri: "fixture",
  }));
  await makeDue(lower720.id);
  assert.equal((await PipelineEngineService.discoverAndStageJob(lower720.id)).pipelineType, "vm_remux");
  assert.deepEqual((await lookup(lower720.id))?.stagedQualities, { "720p": fixture });
  assert.equal(transfer.mock.callCount(), 1);
  assert.equal(storedDownloads, 0);

  for (let round = 0; round < QUALITY_BACKFILL_SEARCH_DELAYS_MS.length; round++) {
    await makeDue(lower480.id);
    const result = await PipelineEngineService.discoverAndStageJob(lower480.id);
    if (round + 1 < QUALITY_BACKFILL_SEARCH_DELAYS_MS.length) {
      assert.equal(result.status, "retry_scheduled");
      assert.equal(storedDownloads, 0);
    } else {
      assert.equal(result.pipelineType, "kaggle_gpu");
    }
    assert.equal((await lookup(lower480.id))?.metadata?.qualitySearchAttempts, round + 1);
  }
  const gpu = await lookup(lower480.id);
  assert.equal(storedDownloads, 1);
  assert.deepEqual(gpu?.tracksConfig, [["sub", 0]]);
  assert.deepEqual(await fs.readFile(gpu?.stagedFilePath ?? ""), media);
  assert.deepEqual((await lookup(parent.id))?.resultPayload, parent.resultPayload);
});
