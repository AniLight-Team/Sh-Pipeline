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
});

test("Tsukihime falls back to title search when mappings fail and rejects different titles and IDs", async t => {
  const healthy = makeEntry(121, "[SubsPlease] Example Show - 07 (1080p)", { episode_no: 7 });
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
  assert.deepEqual(result.torrents.map(item => item.id), [121]);
  assert.ok(request.mock.calls.some(call => call.arguments[0].includes("audiolang=en")));
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
