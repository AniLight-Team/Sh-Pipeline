import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalDiscoveryTitles } from "./discovery-titles.js";

test("discovery uses canonical romaji, English, and Japanese titles", () => {
  const titles = {
    titleRomaji: "Tensei Goblin Dakedo Shitsumon Aru?",
    titleEnglish: "So What's Wrong with Getting Reborn as a Goblin?",
    titleNative: "転生ゴブリンだけど質問ある？",
    synonyms: ["Tengobu", "เกิดใหม่เป็นก็อบลินแล้วไง มีคำถามอะไรไหม?"],
  };
  assert.deepEqual(canonicalDiscoveryTitles(titles), [
    titles.titleRomaji,
    titles.titleEnglish,
    titles.titleNative,
  ]);
});

test("discovery deduplicates titles and excludes non-Japanese native entries", () => {
  assert.deepEqual(canonicalDiscoveryTitles({
    titleRomaji: " Dandadan ",
    titleEnglish: "DANDADAN",
    titleNative: "ダンダダン",
  }), ["Dandadan", "ダンダダン"]);
  assert.deepEqual(canonicalDiscoveryTitles({
    titleRomaji: "Ling Cage",
    titleNative: "灵笼",
    countryOfOrigin: "CN",
  }), ["Ling Cage"]);
  assert.deepEqual(canonicalDiscoveryTitles({ titleNative: "灵笼" }), []);
  assert.deepEqual(canonicalDiscoveryTitles({ titleNative: "呪術廻戦", countryOfOrigin: "JP" }), ["呪術廻戦"]);
  assert.deepEqual(canonicalDiscoveryTitles({
    titleRomaji: " ",
    titleEnglish: "?!",
    titleNative: "เกิดใหม่เป็นก็อบลินแล้วไง มีคำถามอะไรไหม?",
  }), []);
});
