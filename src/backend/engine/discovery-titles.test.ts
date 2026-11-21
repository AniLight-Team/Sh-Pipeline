import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalDiscoveryTitles } from "./discovery-titles.js";

test("discovery includes romaji, English, native titles across all languages, and safe synonyms", () => {
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
    "Tengobu",
    "เกิดใหม่เป็นก็อบลินแล้วไง มีคำถามอะไรไหม?",
  ]);
});

test("discovery deduplicates titles, allows non-Japanese native titles, and rejects unsafe noise tokens", () => {
  assert.deepEqual(canonicalDiscoveryTitles({
    titleRomaji: " Dandadan ",
    titleEnglish: "DANDADAN",
    titleNative: "ダンダダン",
  }), ["Dandadan", "ダンダダン"]);
  assert.deepEqual(canonicalDiscoveryTitles({
    titleRomaji: "Ling Cage",
    titleNative: "灵笼",
    countryOfOrigin: "CN",
  }), ["Ling Cage", "灵笼"]);
  assert.deepEqual(canonicalDiscoveryTitles({ titleNative: "灵笼" }), ["灵笼"]);
  assert.deepEqual(canonicalDiscoveryTitles({ titleNative: "나 혼자만 레벨업", countryOfOrigin: "KR" }), ["나 혼자만 레벨업"]);
  assert.deepEqual(canonicalDiscoveryTitles({ titleNative: "呪術廻戦", countryOfOrigin: "JP" }), ["呪術廻戦"]);
  assert.deepEqual(canonicalDiscoveryTitles({
    titleRomaji: " ",
    titleEnglish: "?!",
    titleNative: "เกิดใหม่เป็นก็อบลินแล้วไง มีคำถามอะไรไหม?",
    synonyms: ["1080p", "S02", "Season 2", "TR", "OP", "a", "---", "Douluo Dalu II"],
  }), ["เกิดใหม่เป็นก็อบลินแล้วไง มีคำถามอะไรไหม?", "Douluo Dalu II"]);
});
