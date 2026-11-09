import test from "node:test";
import assert from "node:assert/strict";
import { VideoEncodingManager } from "./video.manager.js";
import { SubtitleManager } from "./subtitles.manager.js";
import { ReleaseFilter } from "./release-filter.js";
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
