import assert from "node:assert/strict";
import test from "node:test";
import {
  DUB_DISCOVERY_DELAYS_MS,
  FAILED_RELEASE_REOPEN_COOLDOWN_MS,
  QUALITY_BACKFILL_SEARCH_DELAYS_MS,
  RELEASE_DISCOVERY_DELAYS_MS,
  SUB_DISCOVERY_DELAYS_MS,
  discoveryRetryDelaysForJob,
  resetRetryMetadata,
} from "./job-scheduling.js";

test("discovery retry schedules give sub ~2 days and dub ~4 days while keeping manual refreshes fail-fast", () => {
  const sumHours = (delays: readonly number[]) => delays.reduce((acc, ms) => acc + ms, 0) / 3_600_000;

  assert.deepEqual(discoveryRetryDelaysForJob(["sub"], "release"), SUB_DISCOVERY_DELAYS_MS);
  assert.deepEqual(discoveryRetryDelaysForJob(["dub"], "release"), DUB_DISCOVERY_DELAYS_MS);
  assert.deepEqual(discoveryRetryDelaysForJob(["sub", "dub"], "release"), DUB_DISCOVERY_DELAYS_MS);
  assert.deepEqual(discoveryRetryDelaysForJob(["sub"], "stream_refresh"), []);
  assert.deepEqual(discoveryRetryDelaysForJob(["dub"], "caption_refresh"), []);
  assert.deepEqual(discoveryRetryDelaysForJob(["sub"], undefined), []);

  assert.equal(RELEASE_DISCOVERY_DELAYS_MS, SUB_DISCOVERY_DELAYS_MS);
  assert.ok(sumHours(SUB_DISCOVERY_DELAYS_MS) >= 40, "Sub release retries should span at least 40 hours");
  assert.ok(sumHours(DUB_DISCOVERY_DELAYS_MS) >= 90, "Dub release retries should span at least 90 hours");
  assert.ok(sumHours(QUALITY_BACKFILL_SEARCH_DELAYS_MS) <= 10, "Backfill torrent search should hand off to GPU within 10 hours");
  assert.ok(FAILED_RELEASE_REOPEN_COOLDOWN_MS >= 15 * 60_000);
});

test("resetRetryMetadata clears exhausted discovery and backfill retry counters while preserving job context", () => {
  const releaseReset = resetRetryMetadata(
    { kind: "release", primaryTitle: "Tokyo Revengers", discoveryRetries: 12, tsukihimeId: 8785 },
    { reopenCount: 1 },
  );
  assert.equal(releaseReset.discoveryRetries, 0);
  assert.equal(releaseReset.primaryTitle, "Tokyo Revengers");
  assert.equal(releaseReset.tsukihimeId, 8785);
  assert.equal(releaseReset.reopenCount, 1);
  assert.equal("qualitySearchAttempts" in releaseReset, false);

  const backfillReset = resetRetryMetadata({
    kind: "quality_backfill",
    targetQuality: "480p",
    discoveryRetries: 3,
    qualitySearchAttempts: 6,
  });
  assert.equal(backfillReset.discoveryRetries, 0);
  assert.equal(backfillReset.qualitySearchAttempts, 0);
  assert.equal(backfillReset.targetQuality, "480p");
});
