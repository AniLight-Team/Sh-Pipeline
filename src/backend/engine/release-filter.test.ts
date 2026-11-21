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

test("colon-subtitled sequel arcs match Erai-raws split-cour AVC and verified ToonsHub/VARYG/DKB/Judas S04 releases", () => {
  const knownTitles = [
    "Tokyo Revengers: Santen Sensou-hen",
    "Tokyo Revengers: War of the Three Titans Arc",
    "東京リベンジャーズ 三天戦争編",
  ];
  const make = (id: number, title: string, extra: Partial<AnimeToshoItem> = {}): AnimeToshoItem => ({
    id,
    title,
    info_hash: id.toString(16).padStart(40, "0"),
    provider: "tsukihime",
    tsukihime_id: id,
    tsukihime_episode_no: 8,
    num_files: 1,
    seeders: 15,
    audiolangs: ["ja"],
    sublangs: ["en"],
    ...extra,
  });

  const releases: AnimeToshoItem[] = [
    make(41031, "[DKB] Tokyo Revengers: Santen Sensou-hen - S04E08 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs][weekly]", { audiolangs: ["ja", "en"], group_name: "DKB" }),
    make(41020, "[Erai-raws] Tokyo Revengers: Santen Sensou Hen - 08 [1080p DSNP WEBRip HEVC AAC][MultiSub][03B5F73E]", { group_name: "Erai-raws" }),
    make(41014, "[Onalrie] Tokyo Revengers S04E08 (Santen Sensou Hen -) [1080p WEBRip AV1]", { group_name: "Onalrie" }),
    make(41003, "[Erai-raws] Tokyo Revengers S04E08 (Santen Sensou Hen) [1080p DSNP WEB-DL AVC AAC][MultiSub][B4344441]", { group_name: "Erai-raws" }),
    make(41002, "[Erai-raws] Tokyo Revengers S04E08 (Santen Sensou Hen) [720p DSNP WEB-DL AVC AAC][MultiSub][D5C812F9]", { group_name: "Erai-raws" }),
    make(41001, "[Erai-raws] Tokyo Revengers S04E08 (Santen Sensou Hen) [480p DSNP WEB-DL AVC AAC][MultiSub][87B9BF41]", { group_name: "Erai-raws" }),
    make(41000, "[ToonsHub] Tokyo Revengers S04E08 1080p UNCENSORED DSNP WEB-DL MULTi AAC2.0 H.264 (Multi-Audio, Multi-Subs)", { audiolangs: ["ja", "en", "fr", "de"], group_name: "ToonsHub" }),
    make(40998, "[VARYG] Tokyo Revengers S04E08 1080p DSNP WEB-DL MULTi AAC2.0 H.264 (Multi-Subs)", { audiolangs: ["ja", "en", "de"], group_name: "VARYG" }),
    make(40996, "[ToonsHub] Tokyo Revengers S04E08 1080p UNCENSORED DSNP WEB-DL DUAL AAC2.0 H.264 (Dual-Audio, Multi-Subs)", { audiolangs: ["ja", "en"], group_name: "ToonsHub" }),
    make(40995, "[VARYG] Tokyo Revengers S04E08 1080p DSNP WEB-DL DUAL AAC2.0 H.264 (Multi-Subs)", { audiolangs: ["ja", "en"], group_name: "VARYG" }),
  ];

  // SUB selects Erai-raws AVC h264_multi with ALL 3 qualities (1080p, 720p, 480p)
  const subBundles = ReleaseFilter.selectTopCandidateBundles(releases, 8, "sub", { knownTitles, maxBundles: 10 });
  assert.equal(subBundles[0]?.groupLower, "erai-raws");
  assert.equal(subBundles[0]?.selectionTier, "h264_multi");
  assert.equal(subBundles[0]?.pipelineType, "vm_remux");
  assert.deepEqual(Object.keys(subBundles[0]?.qualities ?? {}).sort(), ["1080p", "480p", "720p"]);

  // DUB selects H.264 ToonsHub/VARYG (vm_remux) ahead of HEVC DKB (kaggle_gpu)
  const dubBundles = ReleaseFilter.selectTopCandidateBundles(releases, 8, "dub", { knownTitles, maxBundles: 10 });
  assert.ok(dubBundles.length >= 3);
  assert.equal(dubBundles[0]?.pipelineType, "vm_remux");
  assert.ok(["toonshub", "varyg"].includes(dubBundles[0]?.groupLower));
  assert.ok(dubBundles.some(b => b.groupLower === "dkb" && b.pipelineType === "kaggle_gpu"));

  // Strict guardrails: unscoped franchise-only S04, Season 1 S01, and conflicting arc parens remain rejected
  assert.equal(ReleaseFilter.matchesSeriesTitle(releases[8].title, knownTitles), false);
  assert.equal(ReleaseFilter.matchesSeriesTitle("[ToonsHub] Tokyo Revengers S01E08 1080p DUAL H.264", knownTitles, { allowVerifiedSeason: true }), false);
  assert.equal(ReleaseFilter.matchesSeriesTitle("[Erai-raws] Tokyo Revengers S03E08 (Tenjiku Hen) [1080p AVC]", knownTitles, { allowVerifiedSeason: true }), false);
  assert.equal(ReleaseFilter.matchesSeriesTitle("[Group] Kaguya-sama: Love Is War S02E03 [1080p]", ["Kaguya-sama: Love Is War"]), false);
  assert.equal(ReleaseFilter.matchesSeriesTitle("[SubsPlease] Example Anime S02E03 (1080p)", ["Example Anime"], { allowVerifiedSeason: true }), false);
});

test("donghua dual-title Roman sequel releases parse single episodes cleanly and support non-Japanese original audio", () => {
  const knownTitles = [
    "Douluo Dalu 2: Jueshi Tangmen",
    "Soul Land 2: The Peerless Tang Clan",
  ];
  const fsp178: AnimeToshoItem = {
    id: 39768,
    title: "[FSP] Douluo Dalu II - Soul Land 2 - 178 [1080p]",
    info_hash: "7772f2ae217c68eb30141b67e5149468e09c3f2f",
    provider: "tsukihime",
    tsukihime_id: 39768,
    tsukihime_episode_no: 178,
    num_files: 1,
    seeders: 10,
    audiolangs: [],
    sublangs: ["en"],
    group_name: "FSP",
  };

  const parsed = ReleaseFilter.parseTitle(fsp178.title, knownTitles, fsp178);
  assert.equal(parsed.singleEp, 178);
  assert.equal(parsed.epRange, null);
  assert.equal(parsed.isBatch, false);
  assert.equal(parsed.isForeign, false);
  assert.equal(parsed.lacksSubtitles, false);

  // Even without knownTitles stripping, "Soul Land 2 - 178" must not misparse as batch range [2, 178]
  const parsedNoTitles = ReleaseFilter.parseTitle(fsp178.title, [], fsp178);
  assert.equal(parsedNoTitles.singleEp, 178);
  assert.equal(parsedNoTitles.epRange, null);
  assert.equal(parsedNoTitles.isBatch, false);

  const subBundles = ReleaseFilter.selectTopCandidateBundles([fsp178], 178, "sub", { knownTitles });
  assert.equal(subBundles.length, 1);
  assert.equal(subBundles[0].groupLower, "fsp");
  assert.equal(subBundles[0].pipelineType, "vm_remux");
  assert.deepEqual(ReleaseFilter.selectTopCandidateBundles([fsp178], 178, "dub", { knownTitles }), []);

  // Season 1 and Season 3 must NOT match Season 2
  assert.equal(ReleaseFilter.matchesSeriesTitle("[FSP] Douluo Dalu - 178 [1080p]", knownTitles, { allowVerifiedSeason: true }), false);
  assert.equal(ReleaseFilter.matchesSeriesTitle("[FSP] Douluo Dalu III - Soul Land 3 - 01 [1080p]", knownTitles, { allowVerifiedSeason: true }), false);

  // Strict audio/subtitle language rules:
  // - SUB requires original audio + English subtitles (rejects missing/non-English subs even on dual audio)
  // - DUB accepts English audio with or without English subtitles
  // - Foreign-only / unsupported audio (fr, yue, und) is rejected
  const jaEnSub = { ...fsp178, audiolangs: ["ja"], sublangs: ["en"] };
  assert.equal(ReleaseFilter.selectTopCandidateBundles([jaEnSub], 178, "sub", { knownTitles }).length, 1);
  assert.equal(ReleaseFilter.selectTopCandidateBundles([jaEnSub], 178, "dub", { knownTitles }).length, 0);

  const jaNoSub = { ...fsp178, audiolangs: ["ja"], sublangs: [] };
  assert.equal(ReleaseFilter.selectTopCandidateBundles([jaNoSub], 178, "sub", { knownTitles }).length, 0);

  const dualArabicSubOnly = { ...fsp178, audiolangs: ["ja", "en"], sublangs: ["ar"] };
  assert.equal(ReleaseFilter.selectTopCandidateBundles([dualArabicSubOnly], 178, "sub", { knownTitles }).length, 0);
  assert.equal(ReleaseFilter.selectTopCandidateBundles([dualArabicSubOnly], 178, "dub", { knownTitles }).length, 1);

  const engDubNoSubs = { ...fsp178, audiolangs: ["en"], sublangs: [] };
  assert.equal(ReleaseFilter.selectTopCandidateBundles([engDubNoSubs], 178, "sub", { knownTitles }).length, 0);
  assert.equal(ReleaseFilter.selectTopCandidateBundles([engDubNoSubs], 178, "dub", { knownTitles }).length, 1);

  for (const badAudio of [["fr"], ["yue"], ["und"]]) {
    const item = { ...fsp178, audiolangs: badAudio, sublangs: ["en"] };
    assert.equal(ReleaseFilter.parseTitle(item.title, knownTitles, item).isForeign, true, JSON.stringify(badAudio));
    assert.equal(ReleaseFilter.selectTopCandidateBundles([item], 178, "sub", { knownTitles }).length, 0, JSON.stringify(badAudio));
    assert.equal(ReleaseFilter.selectTopCandidateBundles([item], 178, "dub", { knownTitles }).length, 0, JSON.stringify(badAudio));
  }
});

test("manualTorrent file matching selects single MKVs directly and isolates target episodes in batches safely", () => {
  const unusualSingle = [
    { name: "[CustomFansub] Unrelated Weird Name S04E08 [1080p].mkv", length: 500_000_000 },
  ];
  assert.equal(ReleaseFilter.matchFilesToEpisodes(unusualSingle, {
    knownTitles: ["Tokyo Revengers: Santen Sensou-hen"],
    targetEp: 8,
  }).size, 0);
  assert.deepEqual(ReleaseFilter.matchFilesToEpisodes(unusualSingle, {
    knownTitles: ["Tokyo Revengers: Santen Sensou-hen"],
    targetEp: 8,
    manualTorrent: true,
  }).get(8), [0, unusualSingle[0].name]);

  // Multi-file manual batch isolates ONLY the requested episode and blocks extras/traversal
  const unusualBatch = [
    { name: "Extras/NCOP 08.mkv", length: 100_000_000 },
    { name: "../escape - 08.mkv", length: 400_000_000 },
    { name: "[CustomFansub] Weird Pack - 07.mkv", length: 450_000_000 },
    { name: "[CustomFansub] Weird Pack - 08.mkv", length: 460_000_000 },
  ];
  assert.deepEqual(ReleaseFilter.matchFilesToEpisodes(unusualBatch, {
    knownTitles: ["Tokyo Revengers: Santen Sensou-hen"],
    targetEp: 8,
    manualTorrent: true,
  }).get(8), [3, "[CustomFansub] Weird Pack - 08.mkv"]);
});
