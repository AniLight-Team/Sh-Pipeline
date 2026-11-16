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
    if (path === "/animes/5/episodes/7") return { results: [wrongTorrent, rightTorrent] };
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
