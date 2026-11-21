import assert from "node:assert/strict";
import test from "node:test";
import { AnimeToshoClient } from "./animetosho.client.js";
import { findBackfillTorrents } from "./quality-backfill-discovery.js";
import { TsukihimeClient, type TsukihimeTorrentEntry } from "./tsukihime.client.js";
import type { AnimeToshoItem } from "./types.js";

const job = {
  anidbId: 921,
  episodeNumber: 4,
  type: "sub" as const,
  knownTitles: ["Example Anime 2nd Season"],
  torrentTitle: "[Group] Example Anime 2nd Season - 16 [1080p CR WEB-DL AVC] [1234ABCD].mkv",
  releaseGroup: "Group",
  quality: "720p" as const,
};

const originalSibling = "[Group] Example Anime 2nd Season - 16 [720p CR WEB-DL H.264] [1234ABCE].mkv";

function torrent(id: number, title: string, extra: Partial<AnimeToshoItem> = {}): AnimeToshoItem {
  return { id, title, seeders: 10, info_hash: id.toString(16).padStart(40, "0"), ...extra };
}

test("backfill discovers only the requested release edition with the original episode numbering", async (t) => {
  const viable = torrent(1, originalSibling, { tsukihime_episode_no: 4 });
  const alternatives = [
    torrent(2, originalSibling.replace("Group", "Other")),
    torrent(3, originalSibling.replace("16 [", "17 [")),
    torrent(4, originalSibling.replace("16 [", "16v2 [")),
    torrent(5, originalSibling.replace("CR WEB-DL", "BD")),
    torrent(6, originalSibling.replace("720p", "1080p")),
    torrent(7, originalSibling, { tsukihime_episode_no: 5 }),
    torrent(8, originalSibling.replace("H.264", "HEVC")),
    torrent(9, originalSibling, { sublangs: [] }),
  ];
  t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({
    anime: { id: 1, title: job.knownTitles[0] }, torrents: [viable],
  }));
  const aniDbSearch = t.mock.method(AnimeToshoClient, "fetchTorrents", async () => [...alternatives, viable]);
  const titleSearch = t.mock.method(AnimeToshoClient, "fetchTorrentsByTitle", async () => []);

  const candidates = await findBackfillTorrents(job);
  assert.deepEqual(candidates.map(({ item, effectiveEp }) => [item.id, effectiveEp]), [[1, 16]]);
  assert.equal(aniDbSearch.mock.calls[0].arguments[1], "720p");
  assert.equal(titleSearch.mock.callCount(), 0);
});

test("backfill queries by title for the missing 480p release", async (t) => {
  const tooSmall = torrent(1, originalSibling.replace("720p", "360p"));
  const viable = torrent(2, originalSibling.replace("720p", "480p"));
  t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({ anime: null, torrents: [] }));
  t.mock.method(AnimeToshoClient, "fetchTorrents", async () => [tooSmall]);
  const titleSearch = t.mock.method(AnimeToshoClient, "fetchTorrentsByTitle", async () => [viable]);

  const candidates = await findBackfillTorrents({ ...job, quality: "480p" });
  assert.deepEqual(candidates.map(({ item, quality }) => [item.id, quality]), [[2, "480p"]]);
  assert.deepEqual(titleSearch.mock.calls[0].arguments.slice(0, 2), [job.knownTitles[0], "480p"]);
});

test("backfill distinguishes an unavailable search from a completed search with no matches", async (t) => {
  const unavailable = async () => { throw new Error("connection unavailable"); };
  t.mock.method(TsukihimeClient, "fetchTorrents", unavailable);
  t.mock.method(AnimeToshoClient, "fetchTorrents", unavailable);
  let titleSearchIsUp = false;
  t.mock.method(AnimeToshoClient, "fetchTorrentsByTitle", async () => {
    if (!titleSearchIsUp) return unavailable();
    return [];
  });

  await assert.rejects(findBackfillTorrents(job), { message: "Torrent providers unavailable for 720p discovery" });
  titleSearchIsUp = true;
  assert.deepEqual(await findBackfillTorrents(job), []);
});

test("backfill paginates Tsukihime beyond strong 1080p releases", async (t) => {
  const client = TsukihimeClient as unknown as { requestJson(path: string): Promise<unknown> };
  function entry(id: number, name: string): TsukihimeTorrentEntry {
    return { id, name, btih: id.toString(16).padStart(40, "0"), episode_no: 4, trackers: [{ seeders: 100 }] };
  }

  t.mock.method(client, "requestJson", async (path: string) => {
    if (path === "/animes/anidb/921") return { id: 921, title: job.knownTitles[0], anidb: 921 };
    if (path.startsWith("/animes/921/episodes/")) return { results: [
      entry(2, job.torrentTitle.replace("Group", "First")),
      entry(3, job.torrentTitle.replace("Group", "Second")),
    ] };
    const url = new URL(path, "https://test.invalid");
    if (url.pathname === "/torrents" && !url.searchParams.has("sublang")) {
      const offset = Number(url.searchParams.get("offset"));
      return { total: 2, start: offset, limit: 1, results: [
        offset === 0 ? entry(2, job.torrentTitle.replace("Group", "First")) : entry(1, originalSibling),
      ] };
    }
    return null;
  });
  t.mock.method(AnimeToshoClient, "fetchTorrents", async () => []);

  const candidates = await findBackfillTorrents(job);
  assert.deepEqual(candidates.map(({ item }) => item.tsukihime_id), [1]);
});

test("backfill paginates AnimeTosho beyond other release groups", async (t) => {
  const client = AnimeToshoClient as unknown as { fetchPage(url: string): Promise<AnimeToshoItem[]> };
  const viable = torrent(99, originalSibling);
  const otherGroups = Array.from({ length: 20 }, (_, index) =>
    torrent(index + 1, originalSibling.replace("Group", `Other${index}`), { is_seadex: true }));
  t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({ anime: null, torrents: [] }));
  const pages = t.mock.method(client, "fetchPage", async (url: string) =>
    new URL(url).searchParams.get("page") === "2" ? [viable] : otherGroups);

  const candidates = await findBackfillTorrents({ ...job, episodeNumber: 16 });
  assert.deepEqual(candidates.map(({ item }) => item.id), [99]);
  assert.equal(pages.mock.callCount(), 2);
});

test("backfill rejects a watermarked hash even when the other provider omits the label", async t => {
  const cleanLabel = torrent(201, originalSibling);
  const marked = { ...cleanLabel, title: originalSibling.replace("CR WEB-DL", "BILIBILI INTERNATIONAL WEB-DL") };
  t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({
    anime: { id: 921, anidb: 921, title: job.knownTitles[0] }, torrents: [marked],
  }));
  t.mock.method(AnimeToshoClient, "fetchTorrents", async () => [cleanLabel]);
  t.mock.method(AnimeToshoClient, "fetchTorrentsByTitle", async () => []);
  assert.deepEqual(await findBackfillTorrents(job), []);
});

test("backfill accepts title-search results and rejects a watermarked alias of the same info hash", async (t) => {
  const infoHash = Buffer.from("abcdefghijklmnopqrst").toString("hex");
  const renamed = torrent(1, originalSibling, { info_hash: infoHash.toUpperCase() });
  const viable = torrent(2, originalSibling);
  const watermarked = torrent(3, originalSibling.replace("CR WEB-DL", "B-Global WEB-DL"), {
    info_hash: undefined,
    magnet_uri: "magnet:?xt=urn:btih:MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U",
  });
  const tsukihime = t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({
    anime: null, torrents: [renamed, viable],
  }));
  t.mock.method(AnimeToshoClient, "fetchTorrents", async () => [watermarked]);

  const candidates = await findBackfillTorrents(job);
  assert.deepEqual(candidates.map(({ item }) => item.id), [2]);
  const [, options] = tsukihime.mock.calls[0].arguments;
  assert.deepEqual(options?.episodeAliases, [16]);
  assert.equal(options?.quality, "720p");
  assert.equal(options?.groupName, "Group");
});

test("backfill matches NekoBT split-cour 480p against Nyaa 1080p while rejecting revision and source changes", async t => {
  const knownTitles = [
    "Tokyo Revengers: Santen Sensou-hen",
    "Tokyo Revengers: War of the Three Titans Arc",
  ];
  const nyaa1080 = "[Erai-raws] Tokyo Revengers: Santen Sensou Hen - 08 [1080p DSNP WEB-DL AVC AAC][MultiSub][B4344441]";
  const nekobt480 = torrent(41001, "[Erai-raws] Tokyo Revengers S04E08 (Santen Sensou Hen) [480p DSNP WEB-DL AVC AAC][MultiSub][87B9BF41]", {
    provider: "tsukihime", tsukihime_id: 41001, tsukihime_episode_no: 8, audiolangs: ["ja"], sublangs: ["en"],
  });
  const revV2 = torrent(41099, "[Erai-raws] Tokyo Revengers S04E08v2 (Santen Sensou Hen) [480p DSNP WEB-DL AVC AAC][MultiSub][11111111]", {
    provider: "tsukihime", tsukihime_id: 41099, tsukihime_episode_no: 8, audiolangs: ["ja"], sublangs: ["en"],
  });
  const wrongSource = torrent(41098, "[Erai-raws] Tokyo Revengers S04E08 (Santen Sensou Hen) [480p CR WEB-DL AVC AAC][MultiSub][22222222]", {
    provider: "tsukihime", tsukihime_id: 41098, tsukihime_episode_no: 8, audiolangs: ["ja"], sublangs: ["en"],
  });
  t.mock.method(TsukihimeClient, "fetchTorrents", async () => ({
    anime: { id: 8785, anilist: 178083, anidb: 18693, title: knownTitles[0], english_title: knownTitles[1] },
    torrents: [revV2, wrongSource, nekobt480],
  }));
  t.mock.method(TsukihimeClient, "hydrateCandidates", async (entries: Parameters<typeof TsukihimeClient.hydrateCandidates>[0]) => entries);
  t.mock.method(AnimeToshoClient, "fetchTorrents", async () => []);

  const candidates = await findBackfillTorrents({
    anilistId: 178083,
    anidbId: 18693,
    episodeNumber: 8,
    type: "sub",
    quality: "480p",
    knownTitles,
    releaseGroup: "Erai-raws",
    torrentTitle: nyaa1080,
  });
  assert.deepEqual(candidates.map(c => c.item.tsukihime_id), [41001]);
});
