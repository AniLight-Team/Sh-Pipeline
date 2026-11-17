import assert from "node:assert/strict";
import test from "node:test";
import { ReleaseFilter } from "./release-filter.js";
import type { AnimeToshoItem } from "./types.js";

const calamityTitles = [
  "Bleach: Sennen Kessen-hen - Kashin-tan",
  "Bleach: Thousand-Year Blood War - The Calamity",
];
const bilibili = {
  title: "[Doomdos] - Bleach Sennen Kessen-hen - Kashin-tan - S01E50 [1080p BILIBILI INTERNATIONAL WEB-DL] [Bleach: Thousand-Year Blood War - The Calamity]",
  seeders: 300,
};
const disney = {
  title: "[VARYG] BLEACH Thousand-Year Blood War S01E50 1080p DSNP WEB-DL AAC2.0 H.264 MULTi (Bleach: Sennen Kessen-hen - Kashin-tan S04E10)",
  seeders: 4,
};

test("watermarked Bilibili sources cannot win discovery, including when they are the only releases", () => {
  assert.equal(ReleaseFilter.hasWatermarkedSource(bilibili.title), true);
  assert.equal(ReleaseFilter.isHighQualityCandidate(bilibili, 50, "sub", calamityTitles), false);
  assert.ok(ReleaseFilter.scoreTorrent(bilibili, 50, "sub", calamityTitles) < 0);
  assert.deepEqual(ReleaseFilter.selectTopCandidates([bilibili], 10, "sub", {
    knownTitles: calamityTitles, episodeOffset: 40,
  }), []);
  for (const source of ["B-Global", "Bilibili-Global", "Bilibili.INTL", "ＢＩＬＩＢＩＬＩ＿ＩＮＴＥＲＮＡＴＩＯＮＡＬ"]) {
    assert.ok(ReleaseFilter.hasWatermarkedSource(`[Group] Example Anime - 02 [${source}]`), source);
  }
  assert.equal(ReleaseFilter.hasWatermarkedSource(disney.title), false);
});

test("a canonical Calamity alias maps the clean absolute episode 50 to requested episode 10", () => {
  assert.equal(ReleaseFilter.matchesSeriesTitle(disney.title, calamityTitles), true);
  const parsed = ReleaseFilter.parseTitle(disney.title, calamityTitles);
  assert.equal(parsed.singleEp, 50);
  assert.equal(parsed.relativeEpisode, 10);
  const bracketedAlias = disney.title.replace("(Bleach:", "[Bleach:").replace("S04E10)", "S04E10]");
  assert.equal(ReleaseFilter.parseTitle(bracketedAlias, calamityTitles).relativeEpisode, 10);
  // AnimeTosho-only fallback has no Tsukihime episode metadata or inferred cour size.
  assert.deepEqual(ReleaseFilter.selectTopCandidates([bilibili, disney], 10, "sub", {
    knownTitles: calamityTitles,
  }), [[disney, 50]]);
  assert.deepEqual(ReleaseFilter.selectTopCandidates([{
    ...disney, title: disney.title.replace("S04E10", "S04E11"),
  }], 10, "sub", { knownTitles: calamityTitles, episodeOffset: 40 }), []);
  assert.deepEqual(ReleaseFilter.selectTopCandidates([{
    ...disney, title: disney.title.replace("S01E50", "S01E10").replace("S04E10", "S04E01"),
  }], 10, "sub", { knownTitles: calamityTitles }), []);
});

test("trailing aliases require the same franchise and the full canonical cour title", () => {
  for (const title of [
    disney.title.replace("BLEACH Thousand-Year Blood War", "A Different Series"),
    disney.title.replace("Kashin-tan", "Soukoku-tan"),
    disney.title.replace("S04E10)", "S04E10 Special)"),
    disney.title.replace(/ \(.+\)$/, ""),
  ]) assert.equal(ReleaseFilter.matchesSeriesTitle(title, calamityTitles), false, title);
  assert.equal(ReleaseFilter.matchesSeriesTitle("Example Anime S03E02", ["Example Anime 2nd Season"]), false);
});

test("a split Erai-raws cour title matches all AVC qualities and prefers remux to HEVC", () => {
  const avc: AnimeToshoItem[] = ["1080p", "720p", "480p"].map((quality, index) => ({
    id: 36106 - index,
    title: `[Erai-raws] Bleach S17E50 (Sennen Kessen Hen - Kashin Tan) [${quality} DSNP WEB-DL AVC AAC][MultiSub][459C54CE]`,
    provider: "tsukihime",
    tsukihime_episode_no: 10,
    seeders: 4,
  }));
  const hevc: AnimeToshoItem = {
    id: 36117,
    title: "[Erai-raws] Bleach Sennen Kessen Hen - Kashin Tan - 10 [1080p HEVC DSNP WEB-DL AAC][MultiSub]",
    provider: "tsukihime",
    tsukihime_episode_no: 10,
    seeders: 35,
  };
  const options = { knownTitles: calamityTitles, totalExpectedEps: 10 };
  const bundles = ReleaseFilter.selectTopCandidateBundles([hevc, ...avc], 10, "sub", options);
  assert.equal(bundles[0]?.selectionTier, "h264_multi");
  assert.deepEqual(Object.entries(bundles[0]?.qualities ?? {}).map(([quality, entry]) =>
    [quality, entry.item.id, entry.effectiveEp]), [["1080p", 36106, 50], ["720p", 36105, 50], ["480p", 36104, 50]]);
  assert.equal(bundles[1]?.selectionTier, "hevc_av1_gpu");

  const unscoped: AnimeToshoItem = { ...avc[0], provider: "animetosho", tsukihime_episode_no: undefined };
  assert.equal(ReleaseFilter.matchesSeriesTitle(unscoped.title, calamityTitles), true);
  assert.deepEqual(ReleaseFilter.selectTopCandidates([unscoped], 10, "sub", options), []);
  assert.deepEqual(ReleaseFilter.selectTopCandidates([unscoped], 10, "sub", { ...options, episodeOffset: 40 }),
    [[unscoped, 50]]);
  for (const title of [
    unscoped.title.replace("Kashin Tan", "Soukoku Tan"),
    unscoped.title.replace("Kashin Tan", ""),
    unscoped.title.replace("Bleach S17E50", "Different Series S17E50"),
    unscoped.title.replace("Bleach S17E50", "Bleach S00E50"),
    unscoped.title.replace("Bleach S17E50", "Bleach S17E00"),
  ]) assert.equal(ReleaseFilter.matchesSeriesTitle(title, calamityTitles), false, title);
});

test("provider indexes and title prefixes cannot substitute a different show or episode", () => {
  const options = { knownTitles: ["Example Anime"], totalExpectedEps: 12 };
  const releases: AnimeToshoItem[] = [
    { title: "[SubsPlease] Different Anime - 03 (1080p)", seeders: 20 },
    { title: "[SubsPlease] Example Anime S02E03 (1080p)", seeders: 20 },
    { title: "[SubsPlease] Example Anime 2 S01E03 (1080p)", seeders: 20 },
    { title: "[SubsPlease] Example Anime - 04 (1080p)", seeders: 20 },
    { title: "[SubsPlease] Example Anime [1080p]", seeders: 20 },
    { title: "[SubsPlease] Example Anime - 15 (1080p)", seeders: 20 },
  ].map(item => ({ ...item, provider: "tsukihime", tsukihime_episode_no: 3 }));
  assert.deepEqual(ReleaseFilter.selectTopCandidates(releases, 3, "sub", options), []);
  assert.deepEqual(ReleaseFilter.selectTopCandidates([releases[5]], 15, "sub", options), []);
  assert.ok(ReleaseFilter.scoreTorrent(releases[0], 3, "sub", options.knownTitles) < 0);
  assert.equal(ReleaseFilter.isHighQualityCandidate(releases[0], 3, "sub", options.knownTitles), false);
  assert.deepEqual(ReleaseFilter.selectTopCandidates([
    { title: "[SubsPlease] Example Anime - 03 (1080p)", seeders: 20, provider: "tsukihime", tsukihime_episode_no: 3 },
    { title: "[SubsPlease] Example Anime Complete (01-12) [1080p]", seeders: 20, provider: "tsukihime", num_files: 12 },
  ], 3, "sub", { ...options, knownTitles: ["Example Anime 2nd Season"] }), []);
});

test("sparse later episodes and partial batches do not establish a cour offset", () => {
  const releases: AnimeToshoItem[] = [
    { title: "[Group] Example Anime 2nd Season - 49 (1080p)", seeders: 20 },
    { title: "[Group] Example Anime 2nd Season - 50 (1080p)", seeders: 20 },
    { title: "[Group] Example Anime 2nd Season (41-50) [1080p]", seeders: 20, num_files: 10 },
    { title: "[Group] Different Anime - 22 (1080p)", seeders: 20, provider: "tsukihime", tsukihime_episode_no: 10 },
  ];
  const knownTitles = ["Example Anime 2nd Season"];
  assert.deepEqual(ReleaseFilter.inferCumulativeOffsets(releases, 10, knownTitles, 10), []);
  assert.deepEqual(ReleaseFilter.selectTopCandidates(releases, 10, "sub", { knownTitles, totalExpectedEps: 10 }), []);
});

test("conflicting absolute numbers do not replace a direct episode or guess when it is unavailable", () => {
  const absolute = [50, 49].map((episode): AnimeToshoItem => ({
    title: `[Group] Example Anime 2nd Season - ${episode} (1080p)`, seeders: 20,
    provider: "tsukihime", tsukihime_episode_no: 10,
  }));
  const direct = { title: "[Group] Example Anime 2nd Season - 10 (1080p)", seeders: 2 };
  const knownTitles = ["Example Anime 2nd Season"];
  const options = { knownTitles, totalExpectedEps: 10 };
  assert.deepEqual(ReleaseFilter.inferCumulativeOffsets(absolute, 10, knownTitles, 10), []);
  assert.deepEqual(ReleaseFilter.selectTopCandidates(absolute, 10, "sub", options), []);
  assert.deepEqual(ReleaseFilter.selectTopCandidates([...absolute, direct], 10, "sub", options), [[direct, 10]]);
  assert.deepEqual(ReleaseFilter.selectTopCandidates(absolute, 10, "sub", { ...options, episodeOffset: 40 }),
    [[absolute[0], 50]]);
});

test("an explicit watermarked copy rejects the same torrent hash across providers", () => {
  const info_hash = "01ab".repeat(10);
  const marked = { ...bilibili, info_hash: info_hash.toUpperCase() };
  const alternate = { ...disney, info_hash, provider: "tsukihime" as const };
  assert.deepEqual(ReleaseFilter.selectTopCandidates([marked, alternate], 10, "sub", {
    knownTitles: calamityTitles,
  }), []);
});

test("unhashed results with equal provider-local IDs remain independent", () => {
  const torrents: AnimeToshoItem[] = [
    { id: 17, provider: "animetosho", title: "Example Anime - 02 (1080p DSNP WEB-DL)", seeders: 3 },
    { id: 17, provider: "tsukihime", title: "Example Anime - 02 (1080p CR WEB-DL)", seeders: 3 },
  ];
  assert.deepEqual(ReleaseFilter.selectTopCandidates(torrents, 2, "sub", {
    knownTitles: ["Example Anime"],
  }).map(([item]) => item.provider), ["animetosho", "tsukihime"]);
});

test("file matching skips watermarked media even when the torrent title omitted its source", () => {
  const marked = { name: "Example Anime - 02 [B-Global].mkv", length: 2000 };
  const clean = { name: "Example Anime - 02 [DSNP].mkv", length: 1000 };
  const options = { knownTitles: ["Example Anime"], targetEp: 2 };
  assert.equal(ReleaseFilter.matchFilesToEpisodes([marked], options).has(2), false);
  assert.equal(ReleaseFilter.matchFilesToEpisodes([marked, { name: "unlabelled.mkv" }], options).has(2), false);
  assert.deepEqual(ReleaseFilter.matchFilesToEpisodes([marked, clean], options).get(2), [1, clean.name]);
  const cumulativeBatch = [
    { name: "Example Anime - 41 [B-Global].mkv" },
    { name: "Example Anime - 42 [DSNP].mkv" },
    { name: "Example Anime - 43 [DSNP].mkv" },
  ];
  assert.equal(ReleaseFilter.matchFilesToEpisodes(cumulativeBatch, { ...options, targetEp: 1, effectiveEp: 41 }).has(1), false);
  const pinnedCaptionSource = ReleaseFilter.matchFilesToEpisodes([marked], { ...options, allowWatermarkedSource: true });
  assert.deepEqual(pinnedCaptionSource.get(2), [0, marked.name]);
});
