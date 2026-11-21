import assert from "node:assert/strict";
import test from "node:test";
import { TsukihimeClient, type TsukihimeTorrentEntry } from "./tsukihime.client.js";

const client = TsukihimeClient as unknown as { requestJson(path: string): Promise<unknown> };

test("Tsukihime prefers the requested AniList ID over a conflicting cached fallback", async (t) => {
  const unrelated = { id: 1, anilist: 101, mal: 201, anidb: 301, title: "Unrelated Show" };
  const expected = { id: 2, anilist: 102, mal: 202, anidb: 302, title: "Expected Show" };
  const request = t.mock.method(client, "requestJson", async (path: string) => {
    if (path === "/animes/anilist/101") return unrelated;
    if (path === "/animes/anilist/102") return expected;
    return null;
  });

  await TsukihimeClient.resolveAnime({ anilistId: 101 });
  assert.equal(await TsukihimeClient.resolveAnime({
    anilistId: 102, tsukihimeId: 1, malId: 201, anidbId: 301,
  }), expected);
  assert.deepEqual(request.mock.calls.map(({ arguments: [path] }) => path), [
    "/animes/anilist/101",
    "/animes/anilist/102",
  ]);
});

test("Tsukihime skips returned mappings with a conflicting AniList ID", async (t) => {
  const unrelated = { id: 3, anilist: 103, mal: 203, title: "Unrelated Show" };
  const expected = { id: 4, anilist: 104, anidb: 304, title: "Expected Show" };
  t.mock.method(client, "requestJson", async (path: string) => {
    if (path === "/animes/anilist/104" || path === "/animes/mal/203") return unrelated;
    if (path === "/animes/anidb/304") return expected;
    return null;
  });

  assert.equal(await TsukihimeClient.resolveAnime({ anilistId: 104, malId: 203, anidbId: 304 }), expected);
});

test("Tsukihime alternate ID lookup needs independent identity when AniList is missing", async t => {
  const expected = { id: 25, mal: 224, title: "Example Show, Season 2" };
  const wrong = { id: 26, mal: 225, title: "Example Show" };
  const missing = { id: 27, title: "Example Show, Season 2" };
  t.mock.method(client, "requestJson", async (path: string) => {
    if (path === "/animes/mal/224") return expected;
    if (path === "/animes/mal/225") return wrong;
    if (path === "/animes/anilist/214") return missing;
    return null;
  });
  const knownTitles = ["Example Show: Season 2"];
  const signal = AbortSignal.timeout(3_000);
  assert.equal(await TsukihimeClient.resolveAnime({ anilistId: 214 }), null);
  assert.equal(await TsukihimeClient.resolveAnime({ anilistId: 214, malId: 224 }), null);
  assert.equal(await TsukihimeClient.resolveAnime({ anilistId: 214, malId: 225 }, false, signal, knownTitles), null);
  assert.equal(await TsukihimeClient.resolveAnime({ anilistId: 214, malId: 224 }, false, signal, knownTitles), expected);
});

test("Tsukihime rejects a conflicting release title even within an ID-scoped feed", async (t) => {
  const expected = { id: 5, anilist: 105, title: "Incorrect Provider Title" };
  const wrongTorrent = {
    id: 6, name: "[Erai-raws] Incorrect Provider Title - 07 [1080p]", btih: "a".repeat(40), episode_no: 7,
  };
  const rightTorrent = {
    id: 7, name: "[Erai-raws] Expected Show - 07 [1080p]", btih: "b".repeat(40), episode_no: 7,
  };
  t.mock.method(client, "requestJson", async (path: string) => {
    if (path === "/animes/anilist/105") return expected;
    if (path.startsWith("/animes/5/episodes/7?")) return { results: [wrongTorrent, rightTorrent] };
    return null;
  });

  const { torrents } = await TsukihimeClient.fetchTorrents(
    { anilistId: 105 },
    { targetEp: 7, langType: "sub", knownTitles: ["Expected Show"] },
  );
  assert.deepEqual(torrents.map(({ id }) => id), [7]);
});

test("Tsukihime hydration preserves the selected torrent identity", async (t) => {
  const original: TsukihimeTorrentEntry = {
    id: 8, name: "Expected Show - 07", btih: "c".repeat(40), episode_no: 7,
  };
  const item = TsukihimeClient.toAnimeToshoItem(original);
  let detail = { ...original, name: "Changed Title - 08", btih: "d".repeat(40), episode_no: 8 };
  t.mock.method(client, "requestJson", async () => detail);

  const [[unchanged]] = await TsukihimeClient.hydrateCandidates([[item, 7]]);
  assert.equal(unchanged, item);
  detail = { ...detail, btih: original.btih.toUpperCase() };
  const [[hydrated]] = await TsukihimeClient.hydrateCandidates([[item, 7]]);
  assert.equal(hydrated.title, item.title);
  assert.equal(hydrated.tsukihime_episode_no, 7);
});

const makeEntry = (id: number, name: string, fields: Partial<TsukihimeTorrentEntry> = {}): TsukihimeTorrentEntry =>
  ({ id, name, btih: id.toString(16).padStart(40, "0"), ...fields });

test("Tsukihime paginates episode buckets and aggregates relative and absolute episode releases", async t => {
  const romaji = "BLEACH: Sennen Kessen-hen - Kashin-tan";
  const english = "BLEACH: Thousand-Year Blood War - The Calamity";
  const anime = { id: 9403, anilist: 185874, anidb: 19079, title: romaji, english_title: english, total_episodes: 10 };
  const first = makeEntry(101, "[SubsPlease] BLEACH Sennen Kessen-hen Kashin-tan - 10 (1080p)", { episode_no: 10 });
  const absolute = makeEntry(102, "[VARYG] BLEACH Sennen Kessen-hen S01E50 (1080p DSNP WEB-DL) (BLEACH Sennen Kessen-hen - Kashin-tan S04E10)", { episode_no: 10 });
  const sibling = makeEntry(103, "[VARYG] BLEACH Sennen Kessen-hen S01E50 (720p DSNP WEB-DL) (BLEACH Sennen Kessen-hen - Kashin-tan S04E10)", { episode_no: 50 });
  const request = t.mock.method(client, "requestJson", async (path: string) => {
    const url = new URL(path, "https://test.invalid");
    if (url.pathname === "/animes/anilist/185874") return anime;
    if (url.pathname === "/animes/9403/episodes/10") {
      const offset = Number(url.searchParams.get("offset"));
      return { anime, total: 2, start: offset, limit: 1, results: [offset === 0 ? first : absolute] };
    }
    if (url.pathname === "/animes/9403/episodes/50") return { anime, results: [absolute, sibling] };
    return null;
  });

  const result = await TsukihimeClient.fetchTorrents({ anilistId: 185874 }, {
    targetEp: 10, episodeAliases: [50], knownTitles: [romaji, english], maxPages: 2,
  });
  assert.deepEqual(result.torrents.map(item => item.id).sort(), [101, 102, 103]);
  const paths = request.mock.calls.map(call => call.arguments[0]);
  assert.ok(paths.includes("/animes/9403/episodes/10?limit=50&offset=1"));
  assert.ok(paths.includes("/animes/9403/episodes/50?limit=50&offset=0"));
});

test("Tsukihime tries language and group filters and then includes releases with sparse metadata", async t => {
  const anime = { id: 110, mal: 211, title: "Example Show" };
  const primary = makeEntry(111, "[Erai-raws] Example Show - 03 [1080p]", { group: { id: 19, name: "Erai-raws" } });
  const sibling = makeEntry(112, "[Erai-raws] Example Show - 03 [720p]");
  const request = t.mock.method(client, "requestJson", async (path: string) => {
    const url = new URL(path, "https://test.invalid");
    if (url.pathname === "/animes/mal/211") return anime;
    if (url.pathname === "/animes/110/episodes/3") return { results: [primary] };
    if (url.pathname === "/torrents" && url.searchParams.get("anime_id") === "110") {
      if (url.searchParams.has("group_id")) return { results: [primary] };
      return { results: [primary, sibling] };
    }
    return null;
  });
  const result = await TsukihimeClient.fetchTorrents({ malId: 211 }, {
    targetEp: 3, quality: "720p", langType: "sub", groupName: "Erai-raws",
  });
  assert.deepEqual(result.torrents.map(item => item.id), [111, 112]);
  const [filtered, unfiltered] = request.mock.calls.map(call => new URL(call.arguments[0], "https://test.invalid"))
    .filter(url => url.pathname === "/torrents").map(url => url.searchParams);
  assert.equal(filtered.get("audiolang"), "ja");
  assert.equal(filtered.get("sublang"), "en");
  assert.equal(filtered.get("group_id"), "19");
  assert.equal(unfiltered.get("is_adult"), "0");
  assert.equal(unfiltered.get("sort_by"), "source_date");
  assert.equal(unfiltered.get("order"), "desc");
  assert.equal(unfiltered.has("audiolang"), false);
  assert.equal(unfiltered.has("sublang"), false);
});

test("Tsukihime falls back to title search when mappings fail and rejects different titles and IDs", async t => {
  const healthy = makeEntry(121, "[SubsPlease] Example Show - 07 (1080p)", { anime: { id: 949, anilist: 119 }, episode_no: 7 });
  const conflicting = makeEntry(122, healthy.name, { anime: { id: 950, anilist: 999 }, episode_no: 7 });
  const wrongTitle = makeEntry(123, "[SubsPlease] Another Show - 07 (1080p)");
  const request = t.mock.method(client, "requestJson", async (path: string) => {
    const { pathname, searchParams } = new URL(path, "https://test.invalid");
    if (pathname === "/animes/anilist/119") throw new Error("Mapping temporarily unavailable");
    if (pathname !== "/search/torrents") return null;
    assert.equal(searchParams.get("q"), "Example Show | Example Romaji");
    return { results: searchParams.has("audiolang") ? [] : [healthy, conflicting, wrongTitle] };
  });
  const result = await TsukihimeClient.fetchTorrents({ anilistId: 119 }, {
    targetEp: 7, langType: "dub", knownTitles: ["Example Show", "Example Romaji"], reportErrors: true,
  });
  assert.equal(result.anime, null);
  assert.deepEqual(result.torrents.map(item => [item.id, item.tsukihime_episode_no]), [[121, 7]]);
  assert.ok(request.mock.calls.some(call => call.arguments[0].includes("audiolang=en")));
});

test("Tsukihime unscoped title fallback cannot borrow an episode mapping from a stale alternate ID", async t => {
  const base = "[SubsPlease] Example Saga";
  const unmarked = makeEntry(161, base + " - 02 [1080p]", { anime: { id: 165, mal: 728 }, episode_no: 2 });
  const conflicting = makeEntry(162, base + " Season 2 - 02 [1080p]", {
    anime: { id: 166, anilist: 900, anidb: 599 }, episode_no: 2,
  });
  const verified = makeEntry(163, base + " - 02 [1080p]", { anime: { id: 167, anilist: 900 }, episode_no: 2 });
  const strict = makeEntry(164, base + " Season 2 - 04 [1080p]", { episode_no: 2 });
  t.mock.method(client, "requestJson", async (path: string) => {
    if (path.startsWith("/search/torrents?")) return { results: [unmarked, conflicting, verified, strict] };
    return null;
  });
  const { torrents } = await TsukihimeClient.fetchTorrents({ anilistId: 900, malId: 728, anidbId: 500 }, {
    targetEp: 2, knownTitles: ["Example Saga Season 2"],
  });
  assert.deepEqual(torrents.map(item => [item.id, item.tsukihime_episode_no]), [[163, 2]]);
});

test("Tsukihime rejects conflicting row metadata within a verified show page", async t => {
  const anime = { id: 170, anilist: 910, mal: 259, anidb: 607, title: "Example Saga Season 2" };
  const title = "[SubsPlease] Example Saga - 02 [1080p]";
  const verifiedByPage = makeEntry(171, title, { episode_no: 2 });
  const wrongRow = makeEntry(172, title, { anime: { id: 170, anilist: 911 }, episode_no: 2 });
  const wronglyScoped = makeEntry(173, title, { anime: { id: 175, anilist: 910 }, episode_no: 2 });
  const strict = makeEntry(176, "[SubsPlease] Example Saga Season 2 - 02 [1080p]", { episode_no: 5 });
  const conflictingEpisode = makeEntry(177, title, { episode_no: 3 });
  const wrongEpisodePage = makeEntry(178, title, { episode_no: 4 });
  t.mock.method(client, "requestJson", async (path: string) => {
    if (path === "/animes/anilist/910") return anime;
    if (path.startsWith("/animes/170/episodes/2?")) {
      return { anime, episode: { anime_id: 170, episode_num: 2 }, results: [verifiedByPage, wrongRow, wronglyScoped, conflictingEpisode] };
    }
    if (path.startsWith("/animes/170/episodes/3?")) {
      return { anime, episode: { anime_id: 170, episode_num: 4 }, results: [wrongEpisodePage] };
    }
    // A request parameter alone cannot verify a row without associated show metadata.
    if (path.startsWith("/torrents?")) return { results: [makeEntry(174, title, { episode_no: 2 }), strict] };
    if (path === "/torrents/176") return { ...strict, anime };
    return null;
  });
  const { torrents } = await TsukihimeClient.fetchTorrents({ anilistId: 910 }, {
    targetEp: 2, episodeAliases: [3], knownTitles: [anime.title],
  });
  assert.deepEqual(torrents.map(item => [item.id, item.tsukihime_episode_no]), [[171, 2], [177, null], [176, null]]);
  const [[hydrated]] = await TsukihimeClient.hydrateCandidates([[torrents[2], 2]]);
  assert.equal(hydrated.tsukihime_episode_no, null);
});

test("Tsukihime resolves and validates an uncached stored internal ID", async t => {
  const expected = { id: 130, title: "Example Show", anilist: 129 };
  const request = t.mock.method(client, "requestJson", async (path: string) => {
    if (path.startsWith("/animes/130?")) return { anime: expected, results: [], limit: 1 };
    return null;
  });
  assert.equal(await TsukihimeClient.resolveAnime({ anilistId: 129, tsukihimeId: 130 }), expected);
  assert.equal(await TsukihimeClient.resolveAnime({ anilistId: 128, tsukihimeId: 130 }), null);
  assert.ok(request.mock.calls.some(call => call.arguments[0] === "/animes/130?limit=1&offset=0"));
});

test("a HEVC result does not suppress the remux search, including a sparse filtered search page", async t => {
  const anime = { id: 301, anilist: 300, title: "Test Hero" };
  const hevc = makeEntry(302, "[Erai-raws] Test Hero - 03 [1080p HEVC] [MultiSub]", { episode_no: 3 });
  const avc = makeEntry(303, "[SubsPlease] Test Hero - 03 [1080p AVC]", { anime, episode_no: 3 });
  const request = t.mock.method(client, "requestJson", async (path: string) => {
    const { pathname, searchParams } = new URL(path, "https://test.invalid");
    if (pathname === "/animes/anilist/300") return anime;
    if (pathname === "/animes/301/episodes/3" || pathname === "/torrents") return { results: [hevc] };
    if (pathname === "/search/torrents") {
      const offset = Number(searchParams.get("offset"));
      return { total: 100, start: offset, limit: 50, results: offset === 50 ? [avc] : [] };
    }
    return null;
  });
  const target = { anilistId: 300 };
  const episode = { targetEp: 3, langType: "sub", knownTitles: ["Test Hero"] };
  const result = await TsukihimeClient.fetchTorrents(target, episode);
  assert.deepEqual(result.torrents.map(item => item.id), [302, 303]);
  assert.ok(request.mock.calls.some(call => call.arguments[0].startsWith("/search/torrents?") &&
    call.arguments[0].includes("sublang=en") && call.arguments[0].includes("offset=50")));
  const priorCalls = request.mock.callCount();
  const gpu = await TsukihimeClient.fetchTorrents(target, { ...episode, preferredPipeline: "kaggle_gpu" });
  assert.deepEqual(gpu.torrents.map(item => item.id), [302]);
  assert.ok(request.mock.calls.slice(priorCalls).every(call => !call.arguments[0].startsWith("/search/torrents?")));
});

test("Tsukihime retains a verified show ID when every release endpoint fails", async t => {
  const anime = { id: 311, anilist: 310, title: "Test Hero" };
  t.mock.method(client, "requestJson", async (path: string) => {
    if (path === "/animes/anilist/310") return anime;
    throw new Error("HTTP 503");
  });
  const result = await TsukihimeClient.fetchTorrents({ anilistId: 310 }, {
    knownTitles: ["Test Hero"], targetEp: 3, reportErrors: true,
  });
  assert.deepEqual(result, { anime, torrents: [], releaseSearchFailed: true });
});

test("Tsukihime uses the info hash fallback when a torrent detail ID is unavailable", async t => {
  const original = makeEntry(141, "Example Show - 07", { episode_no: 7 });
  const item = TsukihimeClient.toAnimeToshoItem(original);
  const request = t.mock.method(client, "requestJson", async (path: string) =>
    path.startsWith("/torrents/btih/") ? { ...original, id: 142, episode_no: 8,
      trackers: [{ seeders: 2, url: "udp://tracker.example:1337/announce" }, { seeders: 100, error: 1 }] } : null);
  const [[hydrated]] = await TsukihimeClient.hydrateCandidates([[item, 7]]);
  assert.equal(hydrated.tsukihime_id, 141);
  assert.equal(hydrated.tsukihime_episode_no, 7);
  assert.equal(hydrated.seeders, 2);
  assert.match(hydrated.magnet_uri ?? "", /tracker.example/);
  assert.deepEqual(request.mock.calls.map(call => call.arguments[0]), ["/torrents/141", "/torrents/btih/" + original.btih]);
});

test("Tsukihime retries a rate-limited request and returns the API response", async t => {
  const expected = { id: 151, title: "Example Show", anilist: 150 };
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (url: string) => {
    assert.equal(url, "https://api.tsukihime.org/v1/animes/anilist/150");
    calls++;
    return calls === 1 ? new Response(null, { status: 429, headers: { "Retry-After": "0" } }) : Response.json(expected);
  });
  assert.deepEqual(await TsukihimeClient.resolveAnime({ anilistId: 150 }), expected);
  assert.equal(calls, 2);
});

test("Tsukihime retains verified S04 dual-audio releases, donghua releases, and never queries bare quality tokens", async t => {
  const anime = {
    id: 8785,
    anilist: 178083,
    anidb: 18693,
    title: "Tokyo Revengers: Santen Sensou-hen",
    english_title: "Tokyo Revengers: War of the Three Titans Arc",
  };
  const toonsHub = makeEntry(40996, "[ToonsHub] Tokyo Revengers S04E08 1080p UNCENSORED DSNP WEB-DL DUAL AAC2.0 H.264 (Dual-Audio, Multi-Subs)", {
    anime, episode_no: 8, audiolangs: ["ja", "en"], sublangs: ["en"], group: { id: 1, name: "ToonsHub" },
  });
  const erai1080 = makeEntry(41003, "[Erai-raws] Tokyo Revengers S04E08 (Santen Sensou Hen) [1080p DSNP WEB-DL AVC AAC][MultiSub][B4344441]", {
    anime, episode_no: 8, audiolangs: ["ja"], sublangs: ["en"], group: { id: 3, name: "Erai-raws" },
  });
  const wrongShow = makeEntry(99999, "[SubsPlease] Totally Different Show - 08 [1080p]", {
    anime, episode_no: 8, audiolangs: ["ja", "en"], sublangs: ["en"],
  });
  t.mock.method(client, "requestJson", async (path: string) => {
    const { pathname } = new URL(path, "https://test.invalid");
    if (pathname === "/animes/anilist/178083") return anime;
    if (pathname === "/animes/8785/episodes/8") return { anime, results: [toonsHub, erai1080, wrongShow] };
    return { anime, results: [] };
  });

  const dubRes = await TsukihimeClient.fetchTorrents({ anilistId: 178083 }, {
    targetEp: 8,
    langType: "dub",
    knownTitles: [anime.title, anime.english_title],
  });
  assert.deepEqual(dubRes.torrents.map(item => item.tsukihime_id).sort(), [40996, 41003]);

  // Punctuation-only or resolution-only titles must never trigger a "/search/torrents?q=1080p" query
  const searchCalls: string[] = [];
  t.mock.method(client, "requestJson", async (path: string) => {
    searchCalls.push(path);
    return null;
  });
  await TsukihimeClient.fetchTorrents({ anilistId: 555555 }, {
    targetEp: 1,
    quality: "1080p",
    knownTitles: [" ---！？ ", "1080p"],
  });
  assert.equal(searchCalls.some(path => path.startsWith("/search/torrents")), false);
});

test("TsukihimeClient.fetchTorrentById resolves direct manual torrent payloads and rejects adult/invalid entries", async t => {
  const entry41031: TsukihimeTorrentEntry = {
    id: 41031,
    state: "completed",
    name: "[DKB] Tokyo Revengers: Santen Sensou-hen - S04E08 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs][weekly]",
    btih: "3cffee3862053a9ee95159131fd2396a912da2b8",
    is_adult: 0,
    totalsize: 496117380,
    filecount: 1,
    audiolangs: ["ja", "en"],
    sublangs: ["en", "ja", "ar"],
    episode_no: 8,
    anime: {
      id: 8785,
      title: "Tokyo Revengers: Santen Sensou-hen",
      english_title: "Tokyo Revengers: War of the Three Titans Arc",
      anilist: 178083,
      mal: 59088,
      anidb: 18693,
      total_episodes: 13,
    },
    group: { id: 5, name: "DKB", is_fansub: 0 },
    files: [{
      id: 64293,
      filename: "[DKB] Tokyo Revengers Santen Sensou-hen - S04E08 [1080p][HEVC x265 10bit][Dual-Audio][Multi-Subs][9E264CB9].mkv",
      size: 496117380,
    }],
    trackers: [
      { tier: 0, seeders: 70, leechers: 29, error: 0, url: "http://nyaa.tracker.wf:7777/announce" },
      { tier: 17, seeders: 10, leechers: 15, error: 1, url: "http://tracker.vanitycore.co:6969/announce" },
    ],
  };

  t.mock.method(client, "requestJson", async (path: string) => {
    if (path === "/torrents/41031") return entry41031;
    if (path === "/torrents/99999") return { ...entry41031, id: 99999, is_adult: 1 };
    return null;
  });

  const fetched = await TsukihimeClient.fetchTorrentById(41031);
  assert.equal(fetched?.id, 41031);
  assert.equal(fetched?.anime?.anilist, 178083);
  const item = TsukihimeClient.toAnimeToshoItem(fetched!);
  assert.equal(item.seeders, 70);
  assert.equal(item.tsukihime_id, 41031);
  assert.match(item.magnet_uri ?? "", /3cffee3862053a9ee95159131fd2396a912da2b8/);
  assert.match(item.magnet_uri ?? "", /nyaa\.tracker\.wf/);

  assert.equal(await TsukihimeClient.fetchTorrentById(1234567), null);
  await assert.rejects(() => TsukihimeClient.fetchTorrentById(99999), /adult/i);
});
