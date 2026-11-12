import test from "node:test";
import assert from "node:assert/strict";
import { VideoEncodingManager } from "./video.manager.js";
import { SubtitleManager } from "./subtitles.manager.js";
import { ReleaseFilter } from "./release-filter.js";
import { TsukihimeClient } from "./tsukihime.client.js";
import {
  KIRA_MAX_STAGING_BYTES,
  KIRA_VM_MAX_CONCURRENT_BATCHES,
  KIRA_VM_FFMPEG_THREADS,
  KIRA_DISCOVERY_CONCURRENCY,
  KIRA_DISCOVERY_PER_ANIME_CONCURRENCY,
} from "../config.js";
import type { MkvStreamProbe } from "./types.js";

test("VideoEncodingManager.generateBatchGpuKernelScript always encodes 1080p, 720p, and 480p with AniLight watermark", () => {
  const vm = new VideoEncodingManager({
    kaggleAccounts: [{ username: "test_user", key: "KGAT_123456" }],
    hfAccounts: [{ owner: "anilight", bucket: "streams", token: "hf_123" }],
  });

  const script = vm.generateBatchGpuKernelScript([
    {
      jobId: 42,
      filename: "input_42.mkv",
      animeId: 101,
      anilistId: 16498,
      anidbId: 9541,
      episodeNumber: 5,
      tracks: [
        ["sub", 0],
        ["dub", 1],
      ],
      hf: { owner: "anilight", bucket: "streams", token: "hf_123" },
    },
  ]);

  // Verify old 1080p remux bypass code is completely removed
  assert.equal(script.includes("BURN_WATERMARK_ON_1080P"), false);
  assert.equal(script.includes("remux_1080p_direct"), false);
  assert.equal(script.includes("can_stream_copy_1080p_to_mp4"), false);

  // Verify all 3 watermark PNGs (1080p, 720p, 480p) with "AniLight" are generated and overlaid
  assert.equal(script.includes('generate_watermark_png(wm_1080_png, "AniLight"'), true);
  assert.equal(script.includes('generate_watermark_png(wm_720_png, "AniLight"'), true);
  assert.equal(script.includes('generate_watermark_png(wm_480_png, "AniLight"'), true);
  assert.equal(script.includes("[b1080][wm1080]overlay="), true);
  assert.equal(script.includes("[b720][wm720]overlay="), true);
  assert.equal(script.includes("[b480][wm480]overlay="), true);

  // Verify all 3 NVENC quality outputs are configured
  assert.equal(script.includes('primary_files["1080p"]'), true);
  assert.equal(script.includes('primary_files["720p"]'), true);
  assert.equal(script.includes('primary_files["480p"]'), true);
});

test("VideoEncodingManager.determineTracksToEncode maps sub, dub, and dual-audio tracks accurately", () => {
  const vm = new VideoEncodingManager();

  const dualProbe: MkvStreamProbe = {
    video: [{}],
    audio: [{}, {}],
    subtitles: [],
    isDualAudio: true,
    classifiedAudio: [],
    japaneseStreamIndex: 0,
    englishStreamIndex: 1,
  };

  assert.deepEqual(vm.determineTracksToEncode(dualProbe, "all"), [
    ["sub", 0],
    ["dub", 1],
  ]);
  assert.deepEqual(vm.determineTracksToEncode(dualProbe, "dub"), [["dub", 1]]);
  assert.deepEqual(vm.determineTracksToEncode(dualProbe, "sub"), [["sub", 0]]);
});

test("SubtitleManager.formatForCallback sets default flags for sub (dialogue) vs dub (signs)", () => {
  const r2Records = [
    {
      anime_id: 101,
      episode_number: 1,
      type: "sub" as const,
      language: "en",
      path: "captions/101/1/sub/en.vtt",
      role: "dialogue",
      label: "English (Full)",
      url: "https://cdn.anilight.live/captions/101/1/sub/en.vtt",
      default_sub: true,
      default_dub: false,
    },
    {
      anime_id: 101,
      episode_number: 1,
      type: "dub" as const,
      language: "en-signs",
      path: "captions/101/1/dub/en-signs.vtt",
      role: "signs",
      label: "English (Signs & Songs)",
      url: "https://cdn.anilight.live/captions/101/1/dub/en-signs.vtt",
      default_sub: false,
      default_dub: true,
    },
  ];

  const subFormatted = SubtitleManager.formatForCallback(r2Records, "sub");
  assert.equal(subFormatted[0].isDefault, true);
  assert.equal(subFormatted[1].isDefault, false);

  const dubFormatted = SubtitleManager.formatForCallback(r2Records, "dub");
  assert.equal(dubFormatted[0].isDefault, false);
  assert.equal(dubFormatted[1].isDefault, true);
});

test("ReleaseFilter parses dual-audio and single episode releases accurately", () => {
  const parsed = ReleaseFilter.parseTitle(
    "[SubsPlease] Solo Leveling - 08 (1080p) [ABCD1234].mkv",
    ["Solo Leveling"],
  );
  assert.equal(parsed.singleEp, 8);
  assert.equal(parsed.is1080p, true);
  assert.equal(parsed.isH264, true);
  assert.equal(parsed.resolution, "1080p");
});

test("ReleaseFilter infers cumulative cour offsets (+26 and +40) even when relative episodes exist in the same feed", () => {
  const mockFeed18220 = [
    {
      id: 1,
      title: "Bleach.Thousand-Year.Blood.War.S04E01.Dub.GOD.OF.THUNDER.1080p.DSNP.WEB-DL.AAC2.0.H.264-STRiKES [English Dub]",
      seeders: 74,
      num_files: 1,
    },
    {
      id: 2,
      title: "[NeoLX] Bleach - Sennen Kessen Hen - Soukoku Tan - 14 [END][1080p x264 10bits AAC][Multiple Subtitles].mkv",
      seeders: 12,
      num_files: 1,
    },
    {
      id: 3,
      title: "BLEACH.Thousand.Year.Blood.War.S01E27.A.1080p.DSNP.WEB-DL.AAC2.0.H.264.DUAL-VARYG.mkv",
      seeders: 67,
      num_files: 1,
    },
    {
      id: 4,
      title: "BLEACH.Thousand.Year.Blood.War.S01E40.MY.LAST.WORDS.1080p.DSNP.WEB-DL.AAC2.0.H.264.DUAL-VARYG.mkv",
      seeders: 32,
      num_files: 1,
    },
    {
      id: 5,
      title: "BLEACH.Thousand.Year.Blood.War.S01E27-E40.1080p.DSNP.WEB-DL.AAC2.0.H.264.DUAL-VARYG",
      seeders: 50,
      num_files: 14,
    },
  ];

  // Ep 1 with "all" (sub+dub) should select S01E27 DUAL-VARYG (effectiveEp = 27) over Dub-only S04E01
  const topEp1 = ReleaseFilter.selectTopCandidates(mockFeed18220 as any, 1, "all", {
    maxCandidates: 3,
  });
  assert.equal(topEp1.length > 0, true);
  assert.equal(topEp1[0][1], 27);
  assert.equal(topEp1[0][0].id, 3);

  // Ep 1 with "sub" should also match S01E27 DUAL-VARYG (and reject Dub-only S04E01)
  const topEp1Sub = ReleaseFilter.selectTopCandidates(mockFeed18220 as any, 1, "sub", {
    maxCandidates: 3,
  });
  assert.equal(topEp1Sub.length > 0, true);
  assert.equal(topEp1Sub[0][1], 27);
  assert.equal(topEp1Sub[0][0].id, 3);
});

test("TsukihimeClient & ReleaseFilter accurately match relative episode_no and audiolangs for BLEACH The Calamity (id 9403)", () => {
  const varygEp10 = TsukihimeClient.toAnimeToshoItem({
    id: 28448,
    btih: "a5a98b0993a835a3aa87d1a4c5617fb63a622e35",
    name: "[VARYG] BLEACH Thousand-Year Blood War S01E50 1080p DSNP WEB-DL AAC2.0 H.264 MULTi (Bleach: Sennen Kessen-hen - Kashin-tan S04E10)",
    totalsize: 1384776242,
    filecount: 1,
    audiolangs: ["ja", "en", "de", "es", "fr", "pt"],
    sublangs: ["en", "de", "es", "fr", "pt"],
    episode_no: 10,
    group: { id: 12, name: "VARYG" },
  });

  const omarArabicDual = TsukihimeClient.toAnimeToshoItem({
    id: 28449,
    btih: "b5a98b0993a835a3aa87d1a4c5617fb63a622e36",
    name: "[Omar] Bleach Sennen Kessen-hen S01E50 1080p Shahid WEB-DL AAC2.0 H.264 DUAL.mkv",
    totalsize: 950000000,
    filecount: 1,
    audiolangs: ["ar", "ja"],
    sublangs: ["ar"],
    episode_no: 10,
    group: { id: 99, name: "Omar" },
  });

  assert.ok(varygEp10);
  assert.ok(omarArabicDual);

  // VARYG has ["ja", "en", ...] audio and ["en", ...] subs -> true Dual-Audio
  const parsedVaryg = ReleaseFilter.parseTitle(varygEp10.title, [], varygEp10);
  assert.equal(parsedVaryg.isDualAudio, true);
  assert.equal(parsedVaryg.isEnglishDub, true);
  assert.equal(parsedVaryg.isForeign, false);

  // Omar has ["ar", "ja"] audio and ["ar"] subs -> NOT English dub/dual-audio, marked foreign
  const parsedOmar = ReleaseFilter.parseTitle(omarArabicDual.title, [], omarArabicDual);
  assert.equal(parsedOmar.isDualAudio, false);
  assert.equal(parsedOmar.isEnglishDub, false);
  assert.equal(parsedOmar.isForeign, true);

  // Querying Episode 10 should select VARYG and reject Omar Arabic-only subs
  const topEp10 = ReleaseFilter.selectTopCandidates([omarArabicDual, varygEp10], 10, "all", {
    totalExpectedEps: 10,
    maxCandidates: 3,
  });
  assert.equal(topEp10.length, 1);
  assert.equal(topEp10[0][0].tsukihime_id, 28448);
});

test("Waterfall Tier 1 (h264_multi): If first 1080p H.264 group lacks 720p/480p, goes back and picks another H.264 group that HAS 720p and 480p", () => {
  const torrents = [
    // Group A (VARYG): Has 1080p H.264 with high seeders (300), but NO 720p or 480p
    {
      id: 10,
      title: "[VARYG] Dandadan - 04 (1080p WEB-DL H.264 AAC).mkv",
      seeders: 300,
      num_files: 1,
    },
    // Group B (SubsPlease): Has 1080p H.264 (90 seeders) AND also has 720p + 480p
    {
      id: 20,
      title: "[SubsPlease] Dandadan - 04 (1080p) [1111AAAA].mkv",
      seeders: 90,
      num_files: 1,
    },
    {
      id: 21,
      title: "[SubsPlease] Dandadan - 04 (720p) [2222BBBB].mkv",
      seeders: 45,
      num_files: 1,
    },
    {
      id: 22,
      title: "[SubsPlease] Dandadan - 04 (480p) [3333CCCC].mkv",
      seeders: 25,
      num_files: 1,
    },
    // Group C (EMBER): HEVC 1080p
    {
      id: 30,
      title: "[EMBER] Dandadan - 04 [1080p] [HEVC WEBRip 10bits].mkv",
      seeders: 400,
      num_files: 1,
    },
  ];

  const bundles = ReleaseFilter.selectTopCandidateBundles(torrents as any, 4, "sub", {
    knownTitles: ["Dandadan"],
    maxBundles: 5,
  });

  // #1 bundle must be SubsPlease (Tier 1: h264_multi) because it has 720p & 480p
  assert.equal(bundles[0].groupLower, "subsplease");
  assert.equal(bundles[0].selectionTier, "h264_multi");
  assert.equal(bundles[0].pipelineType, "vm_remux");
  assert.equal(bundles[0].isSolo, true);
  assert.equal(bundles[0].qualities["1080p"]?.item.id, 20);
  assert.equal(bundles[0].qualities["720p"]?.item.id, 21);
  assert.equal(bundles[0].qualities["480p"]?.item.id, 22);

  // #2 bundle must be VARYG (Tier 2: h264_single_1080p) with strictly 1 quality (1080p)
  assert.equal(bundles[1].groupLower, "varyg");
  assert.equal(bundles[1].selectionTier, "h264_single_1080p");
  assert.equal(bundles[1].pipelineType, "vm_remux");
  assert.deepEqual(Object.keys(bundles[1].qualities), ["1080p"]);

  // #3 bundle must be EMBER (Tier 3: hevc_av1_gpu) routed to Pipeline 2 (kaggle_gpu)
  assert.equal(bundles[2].groupLower, "ember");
  assert.equal(bundles[2].selectionTier, "hevc_av1_gpu");
  assert.equal(bundles[2].pipelineType, "kaggle_gpu");
});

test("Waterfall Tier 2 (h264_single_1080p): When no H.264 group has lower qualities, picks best 1080p H.264 and processes strictly 1 quality on VM Remux", () => {
  const torrents = [
    {
      id: 401,
      title: "[ToonsHub] Dandadan - 04 (1080p AMZN WEB-DL H.264 AAC).mkv",
      seeders: 85,
      num_files: 1,
    },
    {
      id: 402,
      title: "[Judas] Dandadan - S01E04 [1080p][HEVC x265 10bit].mkv",
      seeders: 220,
      num_files: 1,
    },
  ];

  const bundles = ReleaseFilter.selectTopCandidateBundles(torrents as any, 4, "sub", {
    knownTitles: ["Dandadan"],
    maxBundles: 3,
  });

  assert.equal(bundles[0].primaryEntry.item.id, 401);
  assert.equal(bundles[0].selectionTier, "h264_single_1080p");
  assert.equal(bundles[0].pipelineType, "vm_remux");
  assert.deepEqual(Object.keys(bundles[0].qualities), ["1080p"]);
});

test("Waterfall Tier 3 (hevc_av1_gpu): Falls back to HEVC/AV1 and routes to Kaggle GPU only when no viable H.264 release exists", () => {
  const hevcOnlyTorrents = [
    {
      id: 501,
      title: "[Judas] Dandadan - S01E04 [1080p][HEVC x265 10bit][Multi-Subs].mkv",
      seeders: 90,
      num_files: 1,
    },
    {
      id: 502,
      title: "[ASW] Dandadan - 04 [1080p HEVC x265 10Bit][AAC].mkv",
      seeders: 75,
      num_files: 1,
    },
  ];

  const bundles = ReleaseFilter.selectTopCandidateBundles(hevcOnlyTorrents as any, 4, "sub", {
    knownTitles: ["Dandadan"],
    maxBundles: 3,
  });

  assert.equal(bundles.length, 2);
  assert.equal(bundles[0].isH264, false);
  assert.equal(bundles[0].selectionTier, "hevc_av1_gpu");
  assert.equal(bundles[0].pipelineType, "kaggle_gpu");
  assert.equal(bundles[0].primaryEntry.quality, "1080p");
});

test("Strict Solo-Over-Batch Preference & Single-Episode Batch File Isolation (never downloads whole batch)", () => {
  const soloVsBatchTorrents = [
    // Multi-file batch torrent with huge seeders
    {
      id: 601,
      title: "[SubsPlease] Dandadan (01-12) (1080p) [Batch]",
      seeders: 500,
      num_files: 12,
    },
    // Monolithic 1-file batch archive (must be completely rejected!)
    {
      id: 602,
      title: "[BadPack] Dandadan Season 1 Complete Batch (01-12) (1080p).mkv",
      seeders: 900,
      num_files: 1,
    },
    // Solo single-episode release with moderate seeders
    {
      id: 603,
      title: "[Erai-raws] Dandadan - 04 [1080p H.264][Multiple Subtitle].mkv",
      seeders: 35,
      num_files: 1,
    },
  ];

  const bundles = ReleaseFilter.selectTopCandidateBundles(soloVsBatchTorrents as any, 4, "sub", {
    knownTitles: ["Dandadan"],
    maxBundles: 5,
  });

  // Monolithic 1-file batch (602) must be rejected completely
  assert.equal(bundles.some((b) => b.primaryEntry.item.id === 602), false);

  // Solo release (603) MUST rank #1 ahead of multi-file batch (601) despite 35 vs 500 seeders
  assert.equal(bundles[0].primaryEntry.item.id, 603);
  assert.equal(bundles[0].isSolo, true);

  // Multi-file batch (601) is kept only as a lower-priority fallback with isSolo = false
  assert.equal(bundles[1].primaryEntry.item.id, 601);
  assert.equal(bundles[1].isSolo, false);

  // Verify matchFilesToEpisodes isolates ONLY Episode 4 from a multi-file batch torrent
  const batchFiles = [
    { name: "Dandadan/[SubsPlease] Dandadan - 01 (1080p).mkv", length: 1_200_000_000 },
    { name: "Dandadan/[SubsPlease] Dandadan - 02 (1080p).mkv", length: 1_200_000_000 },
    { name: "Dandadan/[SubsPlease] Dandadan - 03 (1080p).mkv", length: 1_200_000_000 },
    { name: "Dandadan/[SubsPlease] Dandadan - 04 (1080p).mkv", length: 1_250_000_000 },
    { name: "Dandadan/[SubsPlease] Dandadan - 05 (1080p).mkv", length: 1_200_000_000 },
  ];

  const matched = ReleaseFilter.matchFilesToEpisodes(batchFiles, {
    targetEp: 4,
    effectiveEp: 4,
    knownTitles: ["Dandadan"],
  });
  assert.equal(matched.has(4), true);
  assert.equal(matched.get(4)?.[0], 3); // File index 3 is Episode 04

  // Verify monolithic 1-file batch torrent is rejected by matchFilesToEpisodes when targeting a single episode
  const monolithicBatchFile = [
    { name: "Dandadan Complete Season 1 (01-12).mkv", length: 14_000_000_000 },
  ];
  const rejectedMonolithic = ReleaseFilter.matchFilesToEpisodes(monolithicBatchFile, {
    targetEp: 4,
    effectiveEp: 4,
    knownTitles: ["Dandadan"],
  });
  assert.equal(rejectedMonolithic.size, 0);
});

test("High-concurrency Stage 1 discovery and 56 GB staging guardrails are configured", () => {
  assert.equal(KIRA_MAX_STAGING_BYTES, 56 * 1024 * 1024 * 1024);
  assert.equal(KIRA_DISCOVERY_CONCURRENCY, 16);
  assert.equal(KIRA_DISCOVERY_PER_ANIME_CONCURRENCY, 8);
  assert.equal(KIRA_VM_MAX_CONCURRENT_BATCHES, 2);
  assert.equal(KIRA_VM_FFMPEG_THREADS, 2);
});

test("Dead 0-seeder solo releases do not receive the +10000 solo priority bonus over seeded batch releases", () => {
  const torrents = [
    {
      id: 701,
      title: "[DeadGroup] Orange - 08 [1080p H.264 Dual Audio].mkv",
      seeders: 0,
      num_files: 1,
    },
    {
      id: 702,
      title: "[CRUCiBLE] Orange Season 1 (01-13) (BD 1080p H.264 Dual Audio)",
      seeders: 18,
      num_files: 13,
    },
  ];

  const bundles = ReleaseFilter.selectTopCandidateBundles(torrents as any, 8, "all", {
    knownTitles: ["Orange"],
    minSeeders: 0,
    maxBundles: 4,
  });

  // Because 701 has 0 seeders, seeded batch 702 (18 seeders) ranks ahead of dead 701
  assert.equal(bundles[0].primaryEntry.item.id, 702);
});

test("Pipeline 1 (vm_remux) 2-slot unbatched worker and Kaggle status normalization", async () => {
  const { PipelineEngineService } = await import("./service.js");
  const vm = new VideoEncodingManager();

  // Verify Pipeline 1 (vm_remux) jobs are classified accurately vs Pipeline 2 (kaggle_gpu)
  assert.equal(
    PipelineEngineService.isJobVmRemux({
      pipelineType: "vm_remux",
      metadata: { processingMode: "vm_remux" },
    }),
    true,
  );
  assert.equal(
    PipelineEngineService.isJobVmRemux({
      pipelineType: "kaggle_gpu",
      metadata: { processingMode: "kaggle_gpu" },
    }),
    false,
  );

  // Verify VM Remux 2-at-a-time concurrency limit is 2
  assert.equal(KIRA_VM_MAX_CONCURRENT_BATCHES, 2);
  assert.equal(PipelineEngineService.getActiveVmRemuxCount(), 0);

  // Verify Kaggle status extraction handles nested objects, dotted enum strings, and gRPC prefix strings
  assert.equal(vm.extractCleanStatus({ status: "KernelWorkerStatus.COMPLETE" }), "complete");
  assert.equal(vm.extractCleanStatus({ status: "KERNEL_WORKER_STATUS_ERROR" }), "error");
  assert.equal(vm.extractCleanStatus({ status: "KERNEL_WORKER_STATUS_RUNNING" }), "running");
  assert.equal(vm.extractCleanStatus({ state: "DATASET_STATUS_READY" }), "ready");
});

test("PipelineEngineService.filterCandidateBundlesByPolicy skips incompatible anime under Pipeline 1 Only or Pipeline 2 Only", async () => {
  const { PipelineEngineService } = await import("./service.js");

  const mixedFeed = [
    {
      id: 801,
      title: "[SubsPlease] Solo Leveling - 01 (1080p) [1111AAAA].mkv",
      seeders: 120,
      num_files: 1,
    },
    {
      id: 802,
      title: "[Judas] Solo Leveling - S01E01 [1080p][HEVC x265 10bit].mkv",
      seeders: 150,
      num_files: 1,
    },
  ];

  const hevcOnlyFeed = [
    {
      id: 901,
      title: "[Judas] Frieren - S01E01 [1080p][HEVC x265 10bit].mkv",
      seeders: 200,
      num_files: 1,
    },
  ];

  const h264OnlyFeed = [
    {
      id: 902,
      title: "[SubsPlease] Frieren - 01 (1080p) [2222BBBB].mkv",
      seeders: 180,
      num_files: 1,
    },
  ];

  const mixedBundles = ReleaseFilter.selectTopCandidateBundles(mixedFeed as any, 1, "sub", {
    knownTitles: ["Solo Leveling"],
  });
  const hevcBundles = ReleaseFilter.selectTopCandidateBundles(hevcOnlyFeed as any, 1, "sub", {
    knownTitles: ["Frieren"],
  });
  const h264Bundles = ReleaseFilter.selectTopCandidateBundles(h264OnlyFeed as any, 1, "sub", {
    knownTitles: ["Frieren"],
  });

  // 1. Under Pipeline 1 Only (vm_remux_only), HEVC-only anime has 0 compatible bundles -> marked skipped
  const p1OnHevc = PipelineEngineService.filterCandidateBundlesByPolicy(
    hevcBundles,
    "vm_remux_only",
  );
  assert.equal(p1OnHevc.allowedBundles.length, 0);
  assert.equal(p1OnHevc.skippedReason?.includes("Pipeline 1 Only"), true);

  // 2. Under Pipeline 1 Only (vm_remux_only), mixed feed keeps only H.264 (vm_remux) bundles
  const p1OnMixed = PipelineEngineService.filterCandidateBundlesByPolicy(
    mixedBundles,
    "vm_remux_only",
  );
  assert.equal(p1OnMixed.allowedBundles.length, 1);
  assert.equal(p1OnMixed.allowedBundles[0].pipelineType, "vm_remux");
  assert.equal(p1OnMixed.skippedReason, null);

  // 3. Under Pipeline 2 Only (kaggle_gpu_only), H.264-only anime has 0 compatible bundles -> marked skipped
  const p2OnH264 = PipelineEngineService.filterCandidateBundlesByPolicy(
    h264Bundles,
    "kaggle_gpu_only",
  );
  assert.equal(p2OnH264.allowedBundles.length, 0);
  assert.equal(p2OnH264.skippedReason?.includes("Pipeline 2 Only"), true);

  // 4. Under Pipeline 2 Only (kaggle_gpu_only), HEVC-only anime (Pipeline 2 compatible) is allowed
  const p2OnHevc = PipelineEngineService.filterCandidateBundlesByPolicy(
    hevcBundles,
    "kaggle_gpu_only",
  );
  assert.equal(p2OnHevc.allowedBundles.length, 1);
  assert.equal(p2OnHevc.allowedBundles[0].pipelineType, "kaggle_gpu");
  assert.equal(p2OnHevc.skippedReason, null);

  // 5. Under Pipeline 2 Only (kaggle_gpu_only), mixed feed (which has H.264 Pipeline 1) is skipped unless forced to kaggle_gpu
  const p2OnMixedDefault = PipelineEngineService.filterCandidateBundlesByPolicy(
    mixedBundles,
    "kaggle_gpu_only",
  );
  assert.equal(p2OnMixedDefault.allowedBundles.length, 0);
  assert.equal(p2OnMixedDefault.skippedReason?.includes("Pipeline 2 Only"), true);

  const p2OnMixedForced = PipelineEngineService.filterCandidateBundlesByPolicy(
    mixedBundles,
    "kaggle_gpu_only",
    "kaggle_gpu",
  );
  assert.equal(p2OnMixedForced.allowedBundles.length, 1);
  assert.equal(p2OnMixedForced.allowedBundles[0].pipelineType, "kaggle_gpu");
  assert.equal(p2OnMixedForced.skippedReason, null);
});


