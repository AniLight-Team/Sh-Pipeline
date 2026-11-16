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

  assert.deepEqual(await AnimeToshoClient.fetchTorrentsByTitle(" ---！？ ", "1080p"), []);
  assert.equal(fetchPage.mock.callCount(), 0);
});

test("title discovery preserves Japanese and paginates past unrelated episode 7 releases", async (t) => {
  const japanese = "転生ゴブリンだけど質問ある";
  const romaji = "Tensei Goblin Dakedo Shitsumon Aru";
  const expected = { id: 21, title: `[Erai-raws] ${romaji} - 07 [1080p][MultiSub]`, seeders: 20 };
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
  }), [expected]);
  assert.equal(requestUrls.length, 2);
  assert.equal(requestUrls[0].searchParams.get("q"), `${japanese} 1080p`);
});

test("AniDB discovery excludes conflicting provider IDs and retains rows without an ID", async (t) => {
  const matching = { id: 1, title: "Matching title", anidb_aid: "19942" };
  const unclassified = { id: 2, title: "Unclassified title", anidb_aid: null };
  t.mock.method(client, "fetchPage", async () => [
    matching,
    unclassified,
    { id: 3, title: witchRelease, anidb_aid: 19876 },
  ]);

  assert.deepEqual(await AnimeToshoClient.fetchTorrents(19942), [matching, unclassified]);
});
