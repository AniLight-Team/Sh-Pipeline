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
