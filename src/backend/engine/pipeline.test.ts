import test from "node:test";
import assert from "node:assert/strict";
import { VideoEncodingManager } from "./video.manager.js";
import { SubtitleManager } from "./subtitles.manager.js";
import { ReleaseFilter } from "./release-filter.js";
import { TsukihimeClient } from "./tsukihime.client.js";
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
    "[SubsPlease] Solo Leveling - 08 (1080p) [Dual Audio] [ABCD1234].mkv",
    ["Solo Leveling"],
  );
  assert.equal(parsed.singleEp, 8);
  assert.equal(parsed.isDualAudio, true);
  assert.equal(parsed.is1080p, true);
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


