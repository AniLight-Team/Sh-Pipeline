import assert from "node:assert/strict";
import test from "node:test";
import { AnimeToshoClient } from "./animetosho.client.js";
import type { AnimeToshoItem } from "./types.js";

const witchRelease = "[Erai-raws] Doumo, Suki na Hito ni Horegusuri wo Irai sareta Majo desu - 07 [1080p CR WEB-DL AVC AAC][MultiSub][6136ACFF]";
const client = AnimeToshoClient as unknown as {
  fetchPage(url: string): Promise<AnimeToshoItem[]>;
};

test("title discovery skips punctuation-only titles even when a quality was requested", async (t) => {
  const fetchPage = t.mock.method(client, "fetchPage", async () => []);

  assert.deepEqual(await AnimeToshoClient.fetchTorrentsByTitle(" ---！？ ", "1080p", { expectedAnidbId: 19942 }), []);
  assert.equal(fetchPage.mock.callCount(), 0);
});

test("title discovery preserves Japanese and paginates past unrelated episode 7 releases", async (t) => {
  const japanese = "転生ゴブリンだけど質問ある";
  const romaji = "Tensei Goblin Dakedo Shitsumon Aru";
  const expected = { id: 21, title: `[Erai-raws] ${romaji} - 07 [1080p][MultiSub]`, seeders: 20, anidb_aid: 19942 };
  const unrelated = Array.from({ length: 20 }, (_, id) => ({ id: id + 1, title: witchRelease, seeders: 50 }));
  const requestUrls: URL[] = [];
  t.mock.method(client, "fetchPage", async (url: string) => {
    const request = new URL(url);
    requestUrls.push(request);
    return request.searchParams.get("page") === "2" ? [expected] : unrelated;
  });

  assert.deepEqual(await AnimeToshoClient.fetchTorrentsByTitle(`${japanese}？`, "1080p", {
    targetEp: 7,
    langType: "sub",
    knownTitles: [japanese, romaji],
    expectedAnidbId: 19942,
  }), [expected]);
  assert.equal(requestUrls.length, 2);
  assert.equal(requestUrls[0].searchParams.get("q"), `${japanese} 1080p`);
});

test("AniDB discovery requires the exact provider ID or a strict title match", async (t) => {
  const matching = { id: 1, title: "Matching title", anidb_aid: "19942" };
  const unclassified = { id: 2, title: "Matching title - 02", anidb_aid: null };
  t.mock.method(client, "fetchPage", async () => [
    matching,
    unclassified,
    { id: 3, title: "Matching title - 02", anidb_aid: 19876 },
    { id: 4, title: witchRelease, anidb_aid: null },
  ]);

  assert.deepEqual(await AnimeToshoClient.fetchTorrents(19942), [matching]);
  assert.deepEqual(await AnimeToshoClient.fetchTorrents(19942, "", { knownTitles: ["Matching title"] }), [matching, unclassified]);
});

test("AnimeTosho title fallback excludes conflicting AniDB IDs and malformed rows", async t => {
  const exact = { id: 1, title: "[SubsPlease] Example Show Season 2 - 02 [1080p]", anidb_aid: 19942 };
  t.mock.method(client, "fetchPage", async () => [
    null,
    { id: 2, title: 3 },
    { ...exact, id: 3, anidb_aid: "19876" },
    { ...exact, id: 4, title: "[SubsPlease] Example Show - 02 [1080p]", anidb_aid: null },
    { ...exact, id: 5, anidb_aid: null },
    exact,
  ]);
  assert.deepEqual(await AnimeToshoClient.fetchTorrentsByTitle("Example Show Season 2", "", { expectedAnidbId: 19942 }), [exact]);
});

test("AnimeTosho skips unverified title-only search", async t => {
  const fetchPage = t.mock.method(client, "fetchPage", async () => []);
  assert.deepEqual(await AnimeToshoClient.fetchTorrentsByTitle("Example Show", "1080p"), []);
  assert.equal(fetchPage.mock.callCount(), 0);
});

test("AnimeTosho never strips non-Latin scripts into a bare 1080p query", async t => {
  const urls: string[] = [];
  t.mock.method(client, "fetchPage", async (url: string) => {
    urls.push(url);
    return [];
  });
  assert.deepEqual(await AnimeToshoClient.fetchTorrentsByTitle("1080p", "1080p", { expectedAnidbId: 19942 }), []);
  assert.deepEqual(await AnimeToshoClient.fetchTorrentsByTitle("a", "1080p", { expectedAnidbId: 19942 }), []);
  assert.equal(urls.length, 0);

  await AnimeToshoClient.fetchTorrentsByTitle("เกิดใหม่เป็นก็อบลินแล้วไง", "1080p", { expectedAnidbId: 19942 });
  assert.equal(urls.length, 1);
  assert.equal(new URL(urls[0]).searchParams.get("q"), "เกิดใหม่เป็นก็อบลินแล้วไง 1080p");
});
