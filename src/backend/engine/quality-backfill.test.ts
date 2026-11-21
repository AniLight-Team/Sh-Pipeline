import assert from "node:assert/strict";
import { createHash, randomInt } from "node:crypto";
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

test("fetchMissingBackfillQualities returns ordered missing lower qualities or null when source changed", async t => {
  const { fetchMissingBackfillQualities, missingBackfillQualities } = await import("./quality-backfill.js");
  assert.deepEqual(missingBackfillQualities([{ quality: "1080p", url: sourceUrl }]), ["720p", "480p"]);
  assert.deepEqual(
    missingBackfillQualities([{ quality: "1080p", url: sourceUrl }, { quality: "720p", url: sourceUrl }]),
    ["480p"],
  );
  assert.deepEqual(
    missingBackfillQualities([
      { quality: "1080p", url: sourceUrl },
      { quality: "720p", url: sourceUrl },
      { quality: "480p", url: sourceUrl },
    ]),
    [],
  );

  let mockResponse: unknown = { status: "ready", missingQualities: ["480p", "720p"], sourceUrl };
  t.mock.method(globalThis, "fetch", async () => Response.json(mockResponse));
  const stream = { animeId: 1, anilistId: 2, anidbId: 3, episodeNumber: 4, type: "sub" as const, sourceJobId: 10, sourceUrl };

  // Returned in canonical descending order ["720p", "480p"]
  assert.deepEqual(await fetchMissingBackfillQualities(stream), ["720p", "480p"]);

  mockResponse = { status: "source_changed", missingQualities: [] };
  assert.equal(await fetchMissingBackfillQualities(stream), null);

  mockResponse = { status: "ready", missingQualities: ["480p"], sourceUrl: "https://other.test/1080p.mp4" };
  await assert.rejects(fetchMissingBackfillQualities(stream), /Invalid published quality status/);
});

test("Kaggle GPU kernel script preserves exact 1080p/720p/480p scale filters and quality labels for full and backfill encodes", async () => {
  const { VideoEncodingManager } = await import("./video.manager.js");
  const manager = new VideoEncodingManager();

  const hf = { owner: "anilight", bucket: "store", token: "hf_test" };
  const script = manager.generateBatchGpuKernelScript([
    {
      jobId: 101,
      filename: "job_101_1080p.mp4",
      mode: "transcode",
      outputQualities: ["720p", "480p"],
      animeId: 8785,
      episodeNumber: 9,
      tracks: [["sub", 0]],
      hf,
    },
    {
      jobId: 102,
      filename: "job_102_source.mkv",
      mode: "transcode",
      animeId: 8785,
      episodeNumber: 10,
      tracks: [["sub", 0], ["dub", 1]],
      hf,
    },
  ]);

  // Manifest embeds exact lower-quality targets for backfill job and omits them for full 3-quality encode
  assert.match(script, /"jobId":101.*"outputQualities":\["720p","480p"\]/);
  assert.ok(!/"jobId":102[^}]*"outputQualities"/.test(script));

  // Verify exact scaling, stream maps, NVENC targets, and quality label assignments
  assert.ok(script.includes('qualities = ("1080p", "720p", "480p")'));
  assert.ok(script.includes('qualities = tuple(q for q in ("720p", "480p") if q in requested_qualities)'));
  assert.ok(script.includes('scale=-2:720:flags={lanczos_flags},format=yuv420p,split=2[b720][s720];'));
  assert.ok(script.includes('[s720]scale=-2:480:flags={lanczos_flags},format=yuv420p[b480];'));
  assert.ok(script.includes('"-map", "[out720]", "-map", "3:a:0"] + nvenc_720'));
  assert.ok(script.includes('"-map", "[out480]", "-map", "3:a:0"] + nvenc_480'));
  assert.ok(script.includes('"-map", "[out1080]", "-map", "4:a:0"] + nvenc_1080'));
  assert.ok(script.includes('"-map", f"[out{quality[:-1]}]", "-map", "2:a:0"] + nvenc_args'));
  assert.ok(script.includes('"quality": q_name'));
  assert.ok(script.includes('remote_path = f"{f1}/{f2}/{q_name}.mp4"'));
});

test("VM release seeds one direct-to-GPU multi-quality backfill job and skips torrent searches completely", { skip: !testDb }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "kira-backfill-test-"));
  process.env.KIRA_STAGING_DIR = scratch;
  process.env.KIRA_EXECUTION_POLICY = "all";
  process.env.KAGGLE_ACCOUNTS = JSON.stringify([{ username: "test", key: "test" }]);
  const { db, schema } = await import("../db/index.js");
  const { PipelineEngineService } = await import("./service.js");
  const { AnimeToshoClient } = await import("./animetosho.client.js");
  const { TsukihimeClient } = await import("./tsukihime.client.js");
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
  const tsukiSearch = t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({ anime: null, torrents: [] }));
  const aniDbSearch = t.mock.method(AnimeToshoClient, "fetchTorrents", async () => []);
  const titleSearch = t.mock.method(AnimeToshoClient, "fetchTorrentsByTitle", async () => []);
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
  assert.equal(allJobs.length, 2, "Should create exactly one combined GPU backfill job per track");
  const backfillJob = allJobs.find(row => row.metadata?.kind === "quality_backfill")!;
  assert.equal(backfillJob.pipelineType, "kaggle_gpu");
  assert.equal(backfillJob.discoverAfter, null);
  assert.deepEqual(backfillJob.metadata?.targetQualities, ["720p", "480p"]);

  const staged = await PipelineEngineService.discoverAndStageJob(backfillJob.id);
  assert.equal(staged.status, "staged");
  assert.equal(staged.pipelineType, "kaggle_gpu");
  assert.equal(tsukiSearch.mock.callCount(), 0, "Backfill must never waste time searching Tsukihime");
  assert.equal(aniDbSearch.mock.callCount(), 0, "Backfill must never waste time searching AnimeTosho by AniDB");
  assert.equal(titleSearch.mock.callCount(), 0, "Backfill must never waste time searching AnimeTosho by title");
  assert.equal(storedDownloads, 1);

  const gpu = await db.query.pipelineJob.findFirst({ where: eq(schema.pipelineJob.id, backfillJob.id) });
  assert.equal(gpu?.qualityCount, 2);
  assert.deepEqual(gpu?.metadata?.targetQualities, ["720p", "480p"]);
  assert.deepEqual(gpu?.tracksConfig, [["sub", 0]]);
  assert.deepEqual(await fs.readFile(gpu?.stagedFilePath ?? ""), media);
  assert.deepEqual(
    (await db.query.pipelineJob.findFirst({ where: eq(schema.pipelineJob.id, parent.id) }))?.resultPayload,
    parent.resultPayload,
  );
});
