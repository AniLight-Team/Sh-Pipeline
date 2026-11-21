import assert from "node:assert/strict";
import test from "node:test";
import {
  detectVerifiedEpisodeOffset,
  normalizeEpisodeSubTitle,
  type LocalEpisodeScheduleInfo,
  type PrequelOffsetContext,
} from "./episode-offset.js";
import { ReleaseFilter } from "./release-filter.js";
import { TsukihimeClient, type TsukihimeTorrentEntry } from "./tsukihime.client.js";
import type { AnimeToshoItem } from "./types.js";

const HOUR = 3600;
const DAY = 86_400;
const WEEK = 7 * DAY;

// Anchor timestamps for realistic JoJo Steel Ball Run schedule
const STAGE1_AIR = Math.floor(Date.parse("2026-03-19T12:00:00Z") / 1000);
const STAGE2_EP1_AIR = Math.floor(Date.parse("2026-05-21T12:00:00Z") / 1000);

const SBR_ANILIST_TITLES = [
  "STEEL BALL RUN JoJo's Bizarre Adventure 2nd - 3rd STAGE",
  "STEEL BALL RUN JoJo no Kimyou na Bouken 2nd - 3rd STAGE",
];

const SBR_VERIFIED_TITLES = [
  ...SBR_ANILIST_TITLES,
  "JoJo no Kimyou na Bouken: Steel Ball Run",
  "Steel Ball Run: JoJo's Bizarre Adventure",
];

function makeTorrent(
  id: number,
  title: string,
  extra: Partial<AnimeToshoItem> = {},
): AnimeToshoItem {
  return {
    id,
    title,
    seeders: 25,
    info_hash: id.toString(16).padStart(40, "0"),
    provider: "tsukihime",
    tsukihime_id: id,
    audiolangs: ["ja"],
    sublangs: ["en"],
    ...extra,
  };
}

function makeWeeklySchedule(
  count: number,
  startSec: number,
  titles?: Record<number, string>,
): LocalEpisodeScheduleInfo[] {
  return Array.from({ length: count }, (_, idx) => ({
    episodeNumber: idx + 1,
    airedAtSec: startSec + idx * WEEK,
    title: titles?.[idx + 1] ?? null,
  }));
}

// ============================================================================
// 1. STEEL BALL RUN (AniList #210482 / Tsuki #9388) TITLE & RELEASE MATCHING
// ============================================================================

test("Steel Ball Run 2nd - 3rd STAGE matches all major release group naming styles", () => {
  const releases = [
    "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 10 [1080p NF WEB-DL AVC AAC][MultiSub][11223344]",
    "[DKB] Steel Ball Run: JoJo no Kimyou na Bouken - S06E10 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs][weekly]",
    "[ToonsHub] JoJos Bizarre Adventure S06E10 1080p NF WEB-DL DUAL AAC2.0 H.264 (JoJo no Kimyou na Bouken: Steel Ball Run, Dual-Audio, Multi-Subs)",
    "[VARYG] JoJos Bizarre Adventure S06E10 Frightening Monsters Part 2 1080p NF WEB-DL DUAL AAC2.0 H.264",
    "[SubsPlease] STEEL BALL RUN JoJo's Bizarre Adventure - 10 (1080p) [ABCDEF12].mkv",
    "[SubsPlease] STEEL BALL RUN JoJo's Bizarre Adventure 2nd - 3rd STAGE - 09 (1080p) [99887766].mkv",
  ];

  for (const title of releases) {
    assert.equal(
      ReleaseFilter.matchesSeriesTitle(title, SBR_VERIFIED_TITLES, {
        allowUnmarkedSeason: true,
        allowVerifiedSeason: true,
      }),
      true,
      `Expected verified Steel Ball Run release to match: ${title}`,
    );
  }

  // Unverified AnimeTosho release without "2nd - 3rd STAGE" must NOT match the bare AniList 2nd-3rd STAGE title
  assert.equal(
    ReleaseFilter.matchesSeriesTitle(
      "[SubsPlease] STEEL BALL RUN JoJo's Bizarre Adventure - 01 (1080p) [12345678].mkv",
      SBR_ANILIST_TITLES,
      { allowUnmarkedSeason: false, allowVerifiedSeason: false },
    ),
    false,
    "Unverified Stage 1 release must not match Stage 2-3 title without verified scope",
  );

  // Completely different JoJo season must NEVER match Steel Ball Run even with verified scope
  assert.equal(
    ReleaseFilter.matchesSeriesTitle(
      "[Erai-raws] JoJo no Kimyou na Bouken: Stone Ocean - 10 [1080p][MultiSub]",
      SBR_VERIFIED_TITLES,
      { allowUnmarkedSeason: true, allowVerifiedSeason: true },
    ),
    false,
    "Stone Ocean must never match Steel Ball Run",
  );
});

test("strict episode offset +1 selects Torrent 10 for Ep 9 and NEVER falls back to Torrent 09", () => {
  const torrents: AnimeToshoItem[] = [
    makeTorrent(9001, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 09 [1080p NF WEB-DL AVC AAC][MultiSub][11111111]", {
      tsukihime_episode_no: 9,
      date: STAGE2_EP1_AIR + 7 * WEEK + 2 * HOUR,
    }),
    makeTorrent(9002, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 10 [1080p NF WEB-DL AVC AAC][MultiSub][22222222]", {
      tsukihime_episode_no: 10,
      date: STAGE2_EP1_AIR + 8 * WEEK + 2 * HOUR,
    }),
    makeTorrent(9003, "[ToonsHub] JoJos Bizarre Adventure S06E09 1080p NF WEB-DL DUAL AAC2.0 H.264 (JoJo no Kimyou na Bouken: Steel Ball Run, Dual-Audio, Multi-Subs)", {
      audiolangs: ["ja", "en"],
      sublangs: ["en"],
      tsukihime_episode_no: 9,
      date: STAGE2_EP1_AIR + 7 * WEEK + 3 * HOUR,
    }),
    makeTorrent(9004, "[ToonsHub] JoJos Bizarre Adventure S06E10 1080p NF WEB-DL DUAL AAC2.0 H.264 (JoJo no Kimyou na Bouken: Steel Ball Run, Dual-Audio, Multi-Subs)", {
      audiolangs: ["ja", "en"],
      sublangs: ["en"],
      tsukihime_episode_no: 10,
      date: STAGE2_EP1_AIR + 8 * WEEK + 3 * HOUR,
    }),
  ];

  // With both 09 and 10 present, SUB picks 10 only
  const subBundles = ReleaseFilter.selectTopCandidateBundles(torrents, 9, "sub", {
    knownTitles: SBR_VERIFIED_TITLES,
    episodeOffset: 1,
    strictEpisodeOffset: true,
  });
  assert.ok(subBundles.length >= 1);
  for (const bundle of subBundles) {
    assert.equal(bundle.primaryEntry.effectiveEp, 10, `Expected Torrent 10, got ${bundle.primaryEntry.item.title}`);
  }

  // With both 09 and 10 present, DUB picks Dual-Audio S06E10 only
  const dubBundles = ReleaseFilter.selectTopCandidateBundles(torrents, 9, "dub", {
    knownTitles: SBR_VERIFIED_TITLES,
    episodeOffset: 1,
    strictEpisodeOffset: true,
  });
  assert.ok(dubBundles.length >= 1);
  for (const bundle of dubBundles) {
    assert.equal(bundle.primaryEntry.effectiveEp, 10, `Expected DUB Torrent 10, got ${bundle.primaryEntry.item.title}`);
  }

  // BEFORE Torrent 10 is uploaded (only Torrent 09 exists), strict offset +1 MUST return [] and wait!
  const beforeUpload = torrents.filter(t => t.id === 9001 || t.id === 9003);
  assert.deepEqual(
    ReleaseFilter.selectTopCandidateBundles(beforeUpload, 9, "sub", {
      knownTitles: SBR_VERIFIED_TITLES,
      episodeOffset: 1,
      strictEpisodeOffset: true,
    }),
    [],
    "Strict offset +1 must wait instead of grabbing Torrent 09 (real Ep 8)",
  );
  assert.deepEqual(
    ReleaseFilter.selectTopCandidateBundles(beforeUpload, 9, "dub", {
      knownTitles: SBR_VERIFIED_TITLES,
      episodeOffset: 1,
      strictEpisodeOffset: true,
    }),
    [],
    "Strict offset +1 DUB must wait instead of grabbing Torrent 09",
  );
});

test("TsukihimeClient merges trusted or overlapping Tsukihime titles while rejecting unrelated ones", async (t) => {
  const client = TsukihimeClient as unknown as { requestJson(path: string): Promise<unknown> };
  const entry = (id: number, name: string, ep: number): TsukihimeTorrentEntry => ({
    id,
    name,
    btih: id.toString(16).padStart(40, "0"),
    episode_no: ep,
    audiolangs: ["ja", "en"],
    sublangs: ["en"],
    source_date: STAGE2_EP1_AIR + (ep - 2) * WEEK + HOUR,
    trackers: [{ seeders: 40 }],
  });

  t.mock.method(client, "requestJson", async (reqPath: string) => {
    if (reqPath.startsWith("/animes/9388?")) {
      return {
        anime: {
          id: 9388,
          title: "JoJo no Kimyou na Bouken: Steel Ball Run",
          english_title: "Steel Ball Run: JoJo's Bizarre Adventure",
          anilist: 210482,
        },
        results: [],
      };
    }
    if (reqPath.startsWith("/animes/9388/episodes/9")) {
      return { results: [entry(5001, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 09 [1080p]", 9)] };
    }
    if (reqPath.startsWith("/torrents?anime_id=9388")) {
      return {
        total: 2,
        start: 0,
        limit: 50,
        results: [
          entry(5002, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 10 [1080p]", 10),
          entry(5001, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 09 [1080p]", 9),
        ],
      };
    }
    return null;
  });

  const result = await TsukihimeClient.fetchTorrents(
    {
      anilistId: 210482,
      trustedSourceTsukihimeId: 9388,
    },
    {
      targetEp: 9,
      langType: "sub",
      knownTitles: SBR_ANILIST_TITLES,
      probeRecentTorrents: true,
    },
  );

  assert.equal(result.anime?.id, 9388);
  assert.ok(result.torrents.some(item => item.tsukihime_id === 5002), "probeRecentTorrents should fetch Torrent 10 even when /episodes/9 returned Torrent 09");
});

// ============================================================================
// 2. AUTO-DETECTION POSITIVE PROOFS (INCLUDING DELAYS, HIATUSES & BATCH DROPS)
// ============================================================================

test("detectVerifiedEpisodeOffset proves +1 on Steel Ball Run 2nd-3rd STAGE (both before and after Torrent 10 uploads)", () => {
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [STAGE1_AIR],
    localEpisodes: makeWeeklySchedule(9, STAGE2_EP1_AIR),
  };

  // Torrents 01 (Stage 1) + 02..10 (Stage 2-3 Ep 1..9)
  const torrents: AnimeToshoItem[] = [
    makeTorrent(1, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 01 [1080p NF WEB-DL AVC AAC][MultiSub]", {
      date: STAGE1_AIR + 2 * HOUR,
    }),
    ...Array.from({ length: 9 }, (_, idx) =>
      makeTorrent(idx + 2, `[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - ${String(idx + 2).padStart(2, "0")} [1080p NF WEB-DL AVC AAC][MultiSub]`, {
        date: STAGE2_EP1_AIR + idx * WEEK + 2 * HOUR,
      }),
    ),
  ];

  // After Torrent 10 uploads
  const resFull = detectVerifiedEpisodeOffset({
    torrents,
    knownTitles: SBR_VERIFIED_TITLES,
    targetEp: 9,
    context,
  });
  assert.equal(resFull.offset, 1);
  assert.equal(resFull.strict, true);
  assert.equal(resFull.reason, "air_date_verified");

  // BEFORE Torrent 10 uploads (only Torrents 01..09 exist) -> STILL detects +1 strictly so Ep 9 waits!
  const beforeEp9Upload = torrents.slice(0, -1);
  const resBefore = detectVerifiedEpisodeOffset({
    torrents: beforeEp9Upload,
    knownTitles: SBR_VERIFIED_TITLES,
    targetEp: 9,
    context,
  });
  assert.equal(resBefore.offset, 1);
  assert.equal(resBefore.strict, true);
  assert.equal(resBefore.reason, "air_date_verified");

  const pickedBefore = ReleaseFilter.selectTopCandidateBundles(beforeEp9Upload, 9, "sub", {
    knownTitles: SBR_VERIFIED_TITLES,
    episodeOffset: resBefore.offset,
    strictEpisodeOffset: resBefore.strict,
  });
  assert.deepEqual(pickedBefore, [], "Must wait for Torrent 10 instead of picking Torrent 09");
});

test("mid-season 1-week broadcast delay on stale DB air dates STILL proves offset +1 cleanly", () => {
  // DB schedule has stale un-delayed dates for Ep 6..9, while the real show paused 1 week before Ep 6!
  // Under offset=0, delayed Torrent 07..09 coincidentally align with stale airedAt(7..9)!
  // Asymmetric early-violation detection catches that offset=0 had early violations on Ep 1..6.
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [STAGE1_AIR],
    localEpisodes: makeWeeklySchedule(9, STAGE2_EP1_AIR),
  };

  const torrents: AnimeToshoItem[] = [
    makeTorrent(1, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 01 [1080p]", {
      date: STAGE1_AIR + 2 * HOUR,
    }),
    // Ep 1..5 on time (Torrents 02..06)
    ...Array.from({ length: 5 }, (_, idx) =>
      makeTorrent(idx + 2, `[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - ${String(idx + 2).padStart(2, "0")} [1080p]`, {
        date: STAGE2_EP1_AIR + idx * WEEK + 2 * HOUR,
      }),
    ),
    // Ep 6..9 delayed by 1 full week (Torrents 07..10)
    ...Array.from({ length: 4 }, (_, idx) =>
      makeTorrent(idx + 7, `[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - ${String(idx + 7).padStart(2, "0")} [1080p]`, {
        date: STAGE2_EP1_AIR + (idx + 5 + 1) * WEEK + 2 * HOUR,
      }),
    ),
  ];

  const res = detectVerifiedEpisodeOffset({
    torrents,
    knownTitles: SBR_VERIFIED_TITLES,
    targetEp: 9,
    context,
  });
  assert.equal(res.offset, 1);
  assert.equal(res.strict, true);
  assert.equal(res.reason, "air_date_verified");
  assert.equal(res.evidence?.earlyViolations, 0);
  assert.ok((res.evidence?.zeroEarlyViolations ?? 0) >= 5);
});

test("2-week hiatus + 5-day late fansub re-uploads STILL prove offset +1 using earliest release timestamp", () => {
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [STAGE1_AIR],
    localEpisodes: makeWeeklySchedule(9, STAGE2_EP1_AIR),
  };

  const torrents: AnimeToshoItem[] = [
    makeTorrent(1, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 01 [1080p]", { date: STAGE1_AIR + HOUR }),
  ];
  for (let ep = 1; ep <= 9; ep++) {
    const tEp = ep + 1;
    const delay = ep >= 5 ? 2 * WEEK : 0; // 2-week hiatus starting at Ep 5
    const fastDate = STAGE2_EP1_AIR + (ep - 1) * WEEK + delay + 2 * HOUR;
    torrents.push(
      makeTorrent(tEp * 10, `[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - ${String(tEp).padStart(2, "0")} [1080p]`, {
        date: fastDate,
      }),
      // Late fansub 5 days later for the same episode
      makeTorrent(tEp * 10 + 1, `[Fansub] JoJo no Kimyou na Bouken: Steel Ball Run - ${String(tEp).padStart(2, "0")} [1080p]`, {
        date: fastDate + 5 * DAY,
      }),
    );
  }

  const res = detectVerifiedEpisodeOffset({
    torrents,
    knownTitles: SBR_VERIFIED_TITLES,
    targetEp: 9,
    context,
  });
  assert.equal(res.offset, 1);
  assert.equal(res.strict, true);
  assert.equal(res.reason, "air_date_verified");
});

test("premiere-day falsification rejects Stage 1 Torrent 01 when Stage 2 Ep 1 airs before Torrent 02 drops", () => {
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [STAGE1_AIR],
    localEpisodes: [{ episodeNumber: 1, airedAtSec: STAGE2_EP1_AIR, title: "First Step" }],
  };

  const onlyStage1Torrent = [
    makeTorrent(1, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 01 [1080p]", {
      date: STAGE1_AIR + 2 * HOUR,
    }),
  ];

  const res = detectVerifiedEpisodeOffset({
    torrents: onlyStage1Torrent,
    knownTitles: SBR_VERIFIED_TITLES,
    targetEp: 1,
    context,
  });
  assert.equal(res.offset, 1);
  assert.equal(res.strict, true);
  assert.equal(res.reason, "prequel_premiere_falsified_zero");

  // With strict offset +1, Ep 1 refuses Torrent 01 and waits for Torrent 02!
  const bundles = ReleaseFilter.selectTopCandidateBundles(onlyStage1Torrent, 1, "sub", {
    knownTitles: SBR_VERIFIED_TITLES,
    episodeOffset: res.offset,
    strictEpisodeOffset: res.strict,
  });
  assert.deepEqual(bundles, []);
});

test("same-day Netflix batch drop proves offset +1 via episode title correlation (VARYG)", () => {
  // All 9 episodes share the exact same air date -> air-date alignment is disabled (batch drop),
  // but VARYG includes episode titles in filenames!
  const batchLocalEpisodes: LocalEpisodeScheduleInfo[] = Array.from({ length: 9 }, (_, idx) => ({
    episodeNumber: idx + 1,
    airedAtSec: STAGE2_EP1_AIR,
    title: idx + 1 === 9 ? "Frightening Monsters, Part 2" : `Episode ${idx + 1}`,
  }));
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [STAGE1_AIR],
    localEpisodes: batchLocalEpisodes,
  };

  const torrents = [
    makeTorrent(100, "[VARYG] JoJos Bizarre Adventure S06E09 Frightening Monsters Part 1 1080p NF WEB-DL DUAL AAC2.0 H.264", {
      date: STAGE2_EP1_AIR + 3 * HOUR,
      audiolangs: ["ja", "en"],
    }),
    makeTorrent(101, "[VARYG] JoJos Bizarre Adventure S06E10 Frightening Monsters Part 2 1080p NF WEB-DL DUAL AAC2.0 H.264", {
      date: STAGE2_EP1_AIR + 3 * HOUR,
      audiolangs: ["ja", "en"],
    }),
  ];

  const res = detectVerifiedEpisodeOffset({
    torrents,
    knownTitles: SBR_VERIFIED_TITLES,
    targetEp: 9,
    context,
  });
  assert.equal(res.offset, 1);
  assert.equal(res.strict, true);
  assert.equal(res.reason, "episode_title_verified");
});

test("multi-cour prequel chain selects exact cumulative offset (+26 over +13 and 0)", () => {
  const start = Math.floor(Date.parse("2025-10-05T14:00:00Z") / 1000);
  const titles = ["Bleach: Sennen Kessen-hen - Soukoku-tan", "Bleach: Thousand-Year Blood War - The Conflict"];
  const context: PrequelOffsetContext = {
    candidateOffsets: [13, 26],
    prequelStartDates: [start - 365 * DAY, start - 730 * DAY],
    localEpisodes: makeWeeklySchedule(6, start),
  };

  const torrents = Array.from({ length: 6 }, (_, idx) =>
    makeTorrent(idx + 1, `[SubsPlease] Bleach - Sennen Kessen-hen - Soukoku-tan - ${27 + idx} (1080p) [ABCDEF0${idx}].mkv`, {
      date: start + idx * WEEK + HOUR,
    }),
  );

  const res = detectVerifiedEpisodeOffset({
    torrents,
    knownTitles: titles,
    targetEp: 6,
    context,
  });
  assert.equal(res.offset, 26);
  assert.equal(res.strict, true);
  assert.equal(res.reason, "air_date_verified");
});

test("prequel-verified unanimous Tsukihime episode_no mapping proves offset +1 when air dates are missing", () => {
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [],
    localEpisodes: [{ episodeNumber: 9, title: null, airedAtSec: null }],
  };

  const torrents = [
    makeTorrent(6001, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 10 [1080p]", {
      tsukihime_episode_no: 9,
      date: undefined,
    }),
  ];

  const res = detectVerifiedEpisodeOffset({
    torrents,
    knownTitles: SBR_VERIFIED_TITLES,
    targetEp: 9,
    context,
  });
  assert.equal(res.offset, 1);
  assert.equal(res.strict, true);
  assert.equal(res.reason, "tsukihime_prequel_verified");
});

// ============================================================================
// 3. ZERO-REGRESSION GUARDS (NORMAL ANIME MUST ALWAYS STAY OFFSET = 0)
// ============================================================================

test("normal Season 4 anime (Tokyo Revengers S4 with prequel chain [13, 26, 50]) stays offset 0", () => {
  const start = Math.floor(Date.parse("2026-04-07T15:00:00Z") / 1000);
  const titles = ["Tokyo Revengers: Santen Sensou-hen", "Tokyo Revengers: War of the Three Titans Arc"];
  const context: PrequelOffsetContext = {
    candidateOffsets: [13, 26, 50],
    prequelStartDates: [start - 700 * DAY],
    localEpisodes: makeWeeklySchedule(8, start),
  };
  const torrents = Array.from({ length: 8 }, (_, idx) =>
    makeTorrent(idx + 1, `[Erai-raws] Tokyo Revengers: Santen Sensou Hen - ${String(idx + 1).padStart(2, "0")} [1080p][MultiSub]`, {
      tsukihime_episode_no: idx + 1,
      date: start + idx * WEEK + 2 * HOUR,
    }),
  );

  const res = detectVerifiedEpisodeOffset({ torrents, knownTitles: titles, targetEp: 8, context });
  assert.equal(res.offset, 0);
  assert.equal(res.strict, false);
});

test("normal anime with 1-ep OVA prequel (K = 1) stays offset 0 across normal, delayed, hiatus, late fansub, and early drop schedules", () => {
  const start = Math.floor(Date.parse("2026-04-10T12:00:00Z") / 1000);
  const titles = ["Example Fantasy Adventures"];
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [start - 90 * DAY],
    localEpisodes: makeWeeklySchedule(8, start),
  };

  // Case A: Normal on-time weekly airing (Torrents 01..08)
  const onTime = Array.from({ length: 8 }, (_, idx) =>
    makeTorrent(idx + 1, `[SubsPlease] Example Fantasy Adventures - ${String(idx + 1).padStart(2, "0")} (1080p)`, {
      date: start + idx * WEEK + 2 * HOUR,
    }),
  );
  assert.equal(detectVerifiedEpisodeOffset({ torrents: onTime, knownTitles: titles, targetEp: 8, context }).offset, 0);

  // Case B: Mid-season 1-week broadcast delay on Ep 5..8 (stale DB dates!) -> MUST STAY 0!
  const midDelay = Array.from({ length: 8 }, (_, idx) =>
    makeTorrent(idx + 1, `[SubsPlease] Example Fantasy Adventures - ${String(idx + 1).padStart(2, "0")} (1080p)`, {
      date: start + (idx + (idx >= 4 ? 1 : 0)) * WEEK + 2 * HOUR,
    }),
  );
  assert.equal(detectVerifiedEpisodeOffset({ torrents: midDelay, knownTitles: titles, targetEp: 8, context }).offset, 0);

  // Case C: Ep 1 delayed 1 week (entire season shifted +7d late vs stale DB dates) -> MUST STAY 0!
  const ep1Delayed = Array.from({ length: 8 }, (_, idx) =>
    makeTorrent(idx + 1, `[SubsPlease] Example Fantasy Adventures - ${String(idx + 1).padStart(2, "0")} (1080p)`, {
      date: start + (idx + 1) * WEEK + 2 * HOUR,
    }),
  );
  assert.equal(detectVerifiedEpisodeOffset({ torrents: ep1Delayed, knownTitles: titles, targetEp: 8, context }).offset, 0);

  // Case D: 7-day-late fansub releases -> MUST STAY 0!
  const lateFansub = Array.from({ length: 8 }, (_, idx) =>
    makeTorrent(idx + 1, `[SlowSub] Example Fantasy Adventures - ${String(idx + 1).padStart(2, "0")} [1080p]`, {
      date: start + idx * WEEK + 7 * DAY,
    }),
  );
  assert.equal(detectVerifiedEpisodeOffset({ torrents: lateFansub, knownTitles: titles, targetEp: 8, context }).offset, 0);

  // Case E: Early web premiere 24h before broadcast -> MUST STAY 0!
  const earlyWeb = Array.from({ length: 8 }, (_, idx) =>
    makeTorrent(idx + 1, `[SubsPlease] Example Fantasy Adventures - ${String(idx + 1).padStart(2, "0")} (1080p)`, {
      date: start + idx * WEEK - 24 * HOUR,
    }),
  );
  assert.equal(detectVerifiedEpisodeOffset({ torrents: earlyWeb, knownTitles: titles, targetEp: 8, context }).offset, 0);

  // Case F: 2-year-old archive / BD re-upload -> MUST STAY 0!
  const bdReupload = Array.from({ length: 8 }, (_, idx) =>
    makeTorrent(idx + 1, `[BDGroup] Example Fantasy Adventures - ${String(idx + 1).padStart(2, "0")} [1080p BD]`, {
      date: start + 730 * DAY + idx * HOUR,
    }),
  );
  assert.equal(detectVerifiedEpisodeOffset({ torrents: bdReupload, knownTitles: titles, targetEp: 8, context }).offset, 0);
});

test("normal anime with 2-episode same-day premiere + 1-ep prequel stays offset 0", () => {
  const start = Math.floor(Date.parse("2026-04-12T12:00:00Z") / 1000);
  const titles = ["Double Premiere Chronicles"];
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [start - 180 * DAY],
    localEpisodes: [
      { episodeNumber: 1, airedAtSec: start },
      { episodeNumber: 2, airedAtSec: start + HOUR },
      { episodeNumber: 3, airedAtSec: start + WEEK },
      { episodeNumber: 4, airedAtSec: start + 2 * WEEK },
    ],
  };

  const torrents = [
    makeTorrent(1, "[SubsPlease] Double Premiere Chronicles - 01 (1080p)", { date: start + 2 * HOUR }),
    makeTorrent(2, "[SubsPlease] Double Premiere Chronicles - 02 (1080p)", { date: start + 2 * HOUR }),
    makeTorrent(3, "[SubsPlease] Double Premiere Chronicles - 03 (1080p)", { date: start + WEEK + 2 * HOUR }),
    makeTorrent(4, "[SubsPlease] Double Premiere Chronicles - 04 (1080p)", { date: start + 2 * WEEK + 2 * HOUR }),
  ];

  const res = detectVerifiedEpisodeOffset({ torrents, knownTitles: titles, targetEp: 4, context });
  assert.equal(res.offset, 0);
  assert.equal(res.strict, false);
});

test("same-day Netflix batch drop without matching episode titles stays offset 0 even with prequel", () => {
  const start = Math.floor(Date.parse("2026-06-01T08:00:00Z") / 1000);
  const titles = ["Batch Drop Original 2nd Season"];
  const context: PrequelOffsetContext = {
    candidateOffsets: [12],
    prequelStartDates: [start - 365 * DAY],
    localEpisodes: Array.from({ length: 12 }, (_, idx) => ({
      episodeNumber: idx + 1,
      airedAtSec: start,
      title: `Episode ${idx + 1}`,
    })),
  };

  const torrents = Array.from({ length: 12 }, (_, idx) =>
    makeTorrent(idx + 1, `[Erai-raws] Batch Drop Original 2nd Season - ${String(idx + 1).padStart(2, "0")} [1080p]`, {
      date: start + 2 * HOUR,
    }),
  );

  const res = detectVerifiedEpisodeOffset({ torrents, knownTitles: titles, targetEp: 5, context });
  assert.equal(res.offset, 0);
  assert.equal(res.strict, false);
});

test("generic episode titles and conflicting Tsukihime deltas never trigger false offsets", () => {
  assert.equal(normalizeEpisodeSubTitle("Episode 9"), "");
  assert.equal(normalizeEpisodeSubTitle("Ep. 10"), "");
  assert.equal(normalizeEpisodeSubTitle("Part 2"), "");
  assert.equal(normalizeEpisodeSubTitle("Frightening Monsters, Part 2"), "frightening monsters part 2");

  // Conflicting Tsukihime deltas (one torrent says delta=0, another says delta=1) must stay offset 0
  const context: PrequelOffsetContext = {
    candidateOffsets: [1],
    prequelStartDates: [],
    localEpisodes: [{ episodeNumber: 9, title: "Episode 9", airedAtSec: null }],
  };
  const conflicting = [
    makeTorrent(1, "[Erai-raws] JoJo no Kimyou na Bouken: Steel Ball Run - 09 [1080p]", { tsukihime_episode_no: 9 }),
    makeTorrent(2, "[DKB] Steel Ball Run: JoJo no Kimyou na Bouken - S06E10 [1080p]", { tsukihime_episode_no: 9 }),
  ];
  const res = detectVerifiedEpisodeOffset({
    torrents: conflicting,
    knownTitles: SBR_VERIFIED_TITLES,
    targetEp: 9,
    context,
  });
  assert.equal(res.offset, 0);
  assert.equal(res.strict, false);
});
