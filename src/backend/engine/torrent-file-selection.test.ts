import assert from "node:assert/strict";
import test from "node:test";
import { ReleaseFilter } from "./release-filter.js";

const target = { knownTitles: ["Example Anime"], targetEp: 4, effectiveEp: 4 };
const torrentTitle = "[Group] Example Anime - 04 (1080p)";
const files = (...names: string[]) => names.map(name => ({ name, length: 1000 }));

test("a single video still needs a matching episode and series", () => {
  for (const invalid of [
    "Unrelated Anime - 04.mkv",
    "Example Anime - 05.mkv",
    "Example Anime - 04 Sample.mkv",
    "Example Anime - 04-05.mkv",
    "video.mkv",
  ]) {
    assert.equal(ReleaseFilter.matchFilesToEpisodes(files(invalid), { ...target, torrentTitle }).size, 0, invalid);
  }
  const verified = "Example Anime - 04.mkv";
  assert.deepEqual(ReleaseFilter.matchFilesToEpisodes(files(verified), target).get(4), [0, verified]);
});

test("selection uses a confirmed absolute episode without guessing a batch's starting offset", () => {
  const knownTitles = ["Bleach: Sennen Kessen-hen - Kashin-tan", "Bleach: Thousand-Year Blood War - The Calamity"];
  const title = "[Erai-raws] Bleach S17E50 (Sennen Kessen Hen - Kashin Tan) [1080p DSNP WEB-DL AVC AAC]";
  const expectedFile = title + ".mkv";
  const options = { knownTitles, targetEp: 10, effectiveEp: 50, torrentTitle: title };
  assert.deepEqual(ReleaseFilter.matchFilesToEpisodes(files(expectedFile), options).get(10), [0, expectedFile]);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files(expectedFile.replace("E50", "E49")), options).size, 0);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files(
    "Example Anime - 41.mkv", "Example Anime - 42.mkv", "Example Anime - 43.mkv",
  ), { knownTitles: ["Example Anime"], targetEp: 2 }).size, 0);
});

test("unlabelled, duplicate, and bonus files do not win selection by size or position", () => {
  const duplicates = [
    { name: "Example Anime - 04 (1080p).mkv", length: 100 },
    { name: "Example Anime - 04 (720p).mkv", length: 1000 },
  ];
  assert.equal(ReleaseFilter.matchFilesToEpisodes(duplicates, target).size, 0);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files("video.mkv", "Example Anime - NCOP.mkv"), target).size, 0);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files("video.mkv", "video2.mkv"), {
    ...target, targetEp: "all",
  }).size, 0);
});

test("an episode-only filename needs a verified torrent and a compatible season label", () => {
  const named = {
    knownTitles: ["Example Anime 2nd Season"], targetEp: 4,
    torrentTitle: "[Group] Example Anime S02E04 [1080p]",
  };
  const generic = "Example Anime S02/S02E04 [1080p].mkv";
  assert.deepEqual(ReleaseFilter.matchFilesToEpisodes(files(generic), named).get(4), [0, generic]);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files(generic), { ...named, torrentTitle: "Other Anime S02E04" }).size, 0);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files(generic.replace("S02E04", "S03E04")), named).size, 0);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files("Other Anime/S02E04.mkv"), named).size, 0);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files("[Group] [Other Anime] S02E04.mkv"), named).size, 0);
});

test("unsafe file paths cannot become episode selections", () => {
  for (const name of [
    "../Example Anime - 04.mkv", "/Example Anime - 04.mkv",
    "C:/Example Anime - 04.mkv", "Example Anime\\..\\Example Anime - 04.mkv",
    "Example Anime/samples/Example Anime - 04.mkv",
  ]) assert.equal(ReleaseFilter.matchFilesToEpisodes(files(name), target).size, 0, name);
});

test("verified standalone titles may omit the episode number from the only named video", () => {
  const name = "[Group] Example Movie (1080p).mkv";
  const options = { knownTitles: ["Example Movie"], targetEp: 1, torrentTitle: name, totalExpectedEps: 1 };
  assert.deepEqual(ReleaseFilter.matchFilesToEpisodes(files(name, "notes.txt"), options).get(1), [0, name]);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files(name), { ...options, totalExpectedEps: 2 }).size, 0);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files("video.mkv"), options).size, 0);
  assert.equal(ReleaseFilter.matchFilesToEpisodes(files(name, "video.mkv"), options).size, 0);
});
