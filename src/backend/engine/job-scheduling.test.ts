import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { and, eq } from "drizzle-orm";
import type { ExtractedSubtitleTrack } from "./subtitles.manager.js";
import type { AnimeToshoItem } from "./types.js";

const testDb = process.env.KIRA_TEST_DATABASE_URL;
test("Kira discovery persists release backoff and completes caption repairs without staging an encode", { skip: !testDb }, async t => {
  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "kira-discovery-test-"));
  process.env.DATABASE_URL = testDb;
  process.env.KIRA_STAGING_DIR = scratch;
  const { db, schema } = await import("../db/index.js");
  const { PipelineEngineService } = await import("./service.js");
  const { TsukihimeClient } = await import("./tsukihime.client.js");
  const { AnimeToshoClient } = await import("./animetosho.client.js");
  const { AnimeMetadataResolver } = await import("./metadata-resolver.js");
  const { RELEASE_DISCOVERY_DELAYS_MS, queuedDiscoveryCondition } = await import("./job-scheduling.js");
  const { SubtitleManager } = await import("./subtitles.manager.js");

  const animeId = 2147483600;
  t.after(async () => {
    await db.delete(schema.pipelineJob).where(eq(schema.pipelineJob.animeId, animeId));
    await db.$client.end();
    await fs.rm(scratch, { recursive: true, force: true });
  });
  await PipelineEngineService.ensureTables();
  const resolveTitles = t.mock.method(AnimeMetadataResolver, "resolveDiscoveryTitles", async () => ["Example Anime"]);
  const request = {
    animeId, anilistId: animeId, anidbId: animeId,
    requestId: randomUUID(), knownTitles: ["Example Anime"],
    episodes: [{ episodeNumber: 2, types: ["sub", "dub"] as ("sub" | "dub")[] }],
    kind: "release" as const,
  };
  const release = await PipelineEngineService.enqueue(request);
  assert.deepEqual(release.queuedJobs.map(job => job.types), [["sub"], ["dub"]]);
  assert.equal((await PipelineEngineService.enqueue(request)).skippedExisting, 2);
  assert.equal((await PipelineEngineService.enqueue({ ...request, requestId: randomUUID() })).skippedExisting, 2);
  const manual = await PipelineEngineService.enqueue({
    ...request, requestId: randomUUID(), kind: "stream_refresh", episodes: [{ episodeNumber: 2, types: ["sub"] }],
  });
  assert.equal(manual.queuedJobs.length, 1);

  t.mock.method(PipelineEngineService, "checkStorageCapacityForDownload", async () => ({
    allowed: true, usedBytes: 0, freeBytes: 64 * 1024 ** 3,
  }));
  const discovery = t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({ anime: null, torrents: [] }));
  const scopedSearch = t.mock.method(AnimeToshoClient, "fetchTorrents", async (): Promise<AnimeToshoItem[]> => []);
  t.mock.method(AnimeToshoClient, "fetchTorrentsByTitle", async () => []);
  t.mock.method(AnimeMetadataResolver, "resolveAnimapAnidbId", async () => null);

  const id = release.queuedJobs[0].id;
  const job = (jobId: number) => db.query.pipelineJob.findFirst({ where: eq(schema.pipelineJob.id, jobId) });
  assert.equal((await PipelineEngineService.discoverAndStageJob(id)).status, "retry_scheduled");
  const delayed = await job(id);
  assert.equal(delayed?.status, "queued");
  assert.ok(delayed?.discoverAfter && delayed.discoverAfter.getTime() - Date.now() > 4 * 60_000);
  assert.equal(await db.query.pipelineJob.findFirst({ where: and(eq(schema.pipelineJob.id, id), queuedDiscoveryCondition()) }), undefined);
  assert.equal((await PipelineEngineService.discoverAndStageJob(id)).status, "skipped");
  assert.equal(discovery.mock.callCount(), 1);

  await db.update(schema.pipelineJob).set({
    discoverAfter: new Date(Date.now() - 1000),
    metadata: { ...delayed?.metadata, discoveryRetries: RELEASE_DISCOVERY_DELAYS_MS.length },
  }).where(eq(schema.pipelineJob.id, id));
  assert.equal((await PipelineEngineService.discoverAndStageJob(id)).status, "failed");
  assert.equal((await job(id))?.discoverAfter, null);
  assert.equal((await PipelineEngineService.discoverAndStageJob(manual.queuedJobs[0].id)).status, "failed");

  const fixture = path.join(scratch, "source.mkv");
  const srt = path.join(scratch, "track.srt");
  await fs.writeFile(srt, "1\n00:00:00,100 --> 00:00:01,900\nExample full English caption\n");
  execFileSync("ffmpeg", ["-nostdin", "-v", "error", "-f", "lavfi", "-i", "color=s=128x72:d=2",
    "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-i", srt, "-map", "0:v", "-map", "1:a",
    "-map", "2:s", "-metadata:s:a:0", "language=jpn", "-metadata:s:s:0", "language=eng", "-c:v", "libx264", "-c:s", "srt", fixture]);

  await db.update(schema.pipelineJob).set({
    status: "completed", torrentTitle: "[Group] Example Anime - 02 (1080p).mkv",
    torrentMagnet: "magnet:?xt=urn:btih:1111111111111111111111111111111111111111",
  }).where(eq(schema.pipelineJob.id, id));
  const [repair] = (await PipelineEngineService.enqueue({
    ...request, requestId: randomUUID(), kind: "caption_refresh",
    episodes: [{ episodeNumber: 2, types: ["sub"], sourceJobId: id }],
  })).queuedJobs;
  const transfer = t.mock.method(PipelineEngineService as any, "downloadCandidateEpisodeToStaging", async (_request: {
    jobId: number; effectiveEp: number; candidate: AnimeToshoItem;
  }) => {
    const stagedPath = path.join(scratch, `job_${repair.id}_fixture.mkv`);
    await fs.copyFile(fixture, stagedPath);
    return { ok: true, stagedPath, sizeBytes: 1000, magnetUri: "test", isBatchExtracted: false, fileIndex: 0 };
  });
  const upload = t.mock.method(SubtitleManager.prototype, "uploadSubtitles", async (tracks: ExtractedSubtitleTrack[], animeId: number, episodeNumber: number, type: string) => {
    assert.equal(tracks[0].role, "dialogue");
    const key = `captions/${animeId}/${episodeNumber}/${type}/en.vtt`;
    return [{ anime_id: animeId, episode_number: episodeNumber, type, language: "en", path: key,
      url: key, role: "dialogue", label: "English", default_sub: true, default_dub: false }];
  });
  const callback = t.mock.method(PipelineEngineService, "retryJobCallback", async () => false);
  assert.equal((await PipelineEngineService.discoverAndStageJob(repair.id)).status, "completed");
  const finished = await job(repair.id);
  assert.equal(finished?.status, "completed");
  assert.deepEqual(finished?.resultPayload.sources, []);
  assert.equal(finished?.resultPayload.sourceJobId, id);
  assert.equal(finished?.resultPayload.subtitles.length, 1);
  assert.equal(finished?.batchId, null);
  assert.equal(transfer.mock.callCount(), 1);
  assert.equal(upload.mock.callCount(), 1);
  assert.equal(callback.mock.callCount(), 1);

  const knownTitles = ["Bleach: Sennen Kessen-hen - Kashin-tan", "Bleach: Thousand-Year Blood War - The Calamity"];
  const marked = "[Doomdos] - Bleach Sennen Kessen-hen - Kashin-tan - S01E50 [1080p BILIBILI INTERNATIONAL WEB-DL] [Bleach: Thousand-Year Blood War - The Calamity]";
  const clean = "[VARYG] BLEACH Thousand-Year Blood War S01E50 1080p DSNP WEB-DL AAC2.0 H.264 MULTi (Bleach: Sennen Kessen-hen - Kashin-tan S04E10)";
  const rejectedFile = path.join(scratch, "old-source.mkv");
  await fs.copyFile(fixture, rejectedFile);
  const [previous] = await db.insert(schema.pipelineJob).values({
    animeId, anilistId: animeId, anidbId: animeId, episodeNumber: 10, types: ["sub"], status: "staged",
    torrentTitle: marked, stagedFilePath: rejectedFile,
    stagedQualities: { "1080p": rejectedFile }, qualitiesPayload: { "1080p": { title: marked, effectiveEp: 50 } },
    metadata: { kind: "release", totalEpisodes: 10, executionPolicy: "all" },
  }).returning();
  resolveTitles.mock.mockImplementation(async () => knownTitles);
  discovery.mock.mockImplementation(async () => { throw new Error("Tsukihime unavailable"); });
  scopedSearch.mock.mockImplementation(async () => [
    { title: marked, seeders: 300, info_hash: "b".repeat(40) },
    { title: clean, seeders: 4, info_hash: "c".repeat(40) },
  ]);
  t.mock.method(PipelineEngineService, "drainVmRemuxQueue", async () => []);
  transfer.mock.mockImplementation(async (request: { jobId: number; effectiveEp: number; candidate: AnimeToshoItem }) => {
    assert.equal(request.jobId, previous.id);
    assert.equal(request.candidate.title, clean);
    assert.equal(request.effectiveEp, 50);
    const stagedPath = path.join(scratch, `job_${previous.id}_fixture.mkv`);
    await fs.copyFile(fixture, stagedPath);
    return { ok: true, stagedPath, sizeBytes: (await fs.stat(stagedPath)).size, magnetUri: "clean-magnet", isBatchExtracted: false, fileIndex: 0 };
  });
  assert.equal((await PipelineEngineService.discoverAndStageJob(previous.id)).status, "staged");
  assert.equal((await job(previous.id))?.torrentTitle, clean);
  await assert.rejects(fs.access(rejectedFile), { code: "ENOENT" });
});
