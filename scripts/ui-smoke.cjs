const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
let browser;
(async () => {
 browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || "msedge" });
 const page = await browser.newPage({ viewport: { width: 1440, height: 1060 } });
 const errors = [];
 page.on("pageerror", error => errors.push(String(error)));
 const jobs = Array.from({ length: 31 }, (_, i) => ({
   id: 3977 + i, episodeNumber: 22 + i, types: ["sub"], knownTitles: ["In Search of Gods"],
   status: ["failed", "encoding", "staged", "completed", "downloading", "queued"][i % 6],
   pipelineType: i % 3 ? "vm_remux" : "kaggle_gpu", batchId: null,
   metadata: { primaryTitle: ["In Search of Gods", "Frieren: Beyond Journey's End", "Dandadan", "Solo Leveling", "The Apothecary Diaries", "Blue Box"][i % 6] },
   torrentTitle: "[Doomdos] - In Search of Gods - 22 [1080p IQ WEB-DL]",
   stagedQualities: { "1080p": "/test/staged.mkv" }, createdAt: new Date().toISOString(),
   lastError: i === 0 ? "VM Hugging Face upload failed (4/4 attempts): HTTP 503 Service Unavailable. Converted files retained for retry." : null,
 }));
 const stats = { executionPolicy: "all", activeBatches: [], activeBatch: null,
   concurrency: { active: 2, max: 4, vmActive: 1, vmMax: 2, accountsCount: 2, maxPerAccount: 2 },
   queue: { queued: 18, downloading: 4, staged: 12, encoding: 3, completed: 128, failed: 2, paused: 0, skipped: 1, total: 168 },
   storage: { stagedBytes: 19.4*1024**3, stagedCount: 12, maxStagingBytes: 56*1024**3, maxBatchItems: 10, minFreeBytes: 12*1024**3 },
   accounts: { kaggle: [], huggingFace: [{ owner: "anilight", bucket: "episodes" }] },
   engine: { isRunning: true, isPaused: false, uptimeSeconds: 3600, lastWatchdogRun: new Date().toISOString(), pendingCallbacks: 0 } };
 const logs = [{ id: "a", timestamp: new Date().toISOString(), level: "success", tag: "Pipeline", message: "Episode 21 uploaded and verified. Delivery complete." }, { id: "b", timestamp: new Date().toISOString(), level: "info", tag: "VM", message: "Episode 22: recovered converted output from checkpoint." }, { id: "c", timestamp: new Date().toISOString(), level: "warn", tag: "Upload", message: "Hugging Face temporarily unavailable. Retry scheduled; local files retained." }];
 let requests = [];
 await page.route("**/api/**", async route => {
   const url = new URL(route.request().url());
   requests.push(url.pathname + url.search);
   if (url.pathname === "/api/sse/events") return route.fulfill({ contentType: "text/event-stream", body: `retry: 60000\nevent: init_logs\ndata: ${JSON.stringify(logs)}\n\nevent: stats\ndata: ${JSON.stringify(stats)}\n\n` });
   if (url.pathname === "/api/stats") return route.fulfill({ json: stats });
   if (url.pathname === "/api/jobs" && route.request().method() === "GET") {
     const status = url.searchParams.get("status"), query = url.searchParams.get("search")?.toLowerCase(), mode = url.searchParams.get("mode");
     let filtered = jobs.filter(j => (!status || status === "all" || j.status === status || status === "active" && ["encoding","downloading"].includes(j.status)) && (!query || j.metadata.primaryTitle.toLowerCase().includes(query)) && (!mode || mode === "all" || j.pipelineType === mode));
     return route.fulfill({ json: { jobs: filtered.slice(Number(url.searchParams.get("offset") || 0), Number(url.searchParams.get("offset") || 0) + Number(url.searchParams.get("limit") || 25)), total: filtered.length } });
   }
   if (url.pathname === "/api/jobs/bulk") return route.fulfill({ status: 409, json: { error: "This job is already processing. Refresh and try again." } });
   if (url.pathname === "/api/batches") return route.fulfill({ json: { batches: [] } });
   return route.fulfill({ json: { ok: true, message: "Recovery requested." } });
 });
 await page.goto("http://127.0.0.1:3000");
 await page.getByText("Latest episodes", { exact: true }).waitFor();
 await page.getByRole("button", { name: "View job 3977", exact: true }).waitFor();
 await page.screenshot({ path: "artifacts/dashboard-desktop.png", fullPage: true });
 await page.getByRole("button", { name: "View queue", exact: true }).click();
 await page.getByRole("textbox", { name: "Search all episodes" }).fill("Frieren");
 await page.waitForFunction(() => document.querySelector(".queue-caption")?.textContent === "5 episodes");
 assert.equal(await page.locator(".episode-table tbody tr").count(), 5);
 await page.getByRole("textbox", { name: "Search all episodes" }).fill("");
 await page.waitForFunction(() => document.querySelector(".queue-caption")?.textContent === "31 episodes");
 await page.getByRole("button", { name: "Next page", exact: true }).click();
 await page.waitForFunction(() => document.querySelector(".queue-pagination")?.textContent?.includes("Page 2"));
 assert.equal(await page.locator(".episode-table tbody tr").count(), 6);
 await page.getByRole("button", { name: "Previous page", exact: true }).click();
 await page.getByRole("checkbox", { name: "Select job 3977", exact: true }).check();
 await page.getByRole("button", { name: "Retry", exact: true }).click();
 await page.getByRole("status").filter({ hasText: "already processing" }).waitFor();
 assert.equal(await page.getByRole("checkbox", { name: "Select job 3977", exact: true }).isChecked(), true);
 await page.getByRole("button", { name: "View job 3977", exact: true }).click();
 await page.getByRole("dialog").waitFor();
 await page.screenshot({ path: "artifacts/job-diagnostic.png", fullPage: true });
 await page.getByRole("button", { name: /Close/ }).last().click();
 await page.getByRole("button", { name: "Operations", exact: true }).click();
 await page.getByLabel("Execution policy").waitFor();
 await page.screenshot({ path: "artifacts/operations.png", fullPage: true });
 await page.getByRole("button", { name: "Overview", exact: true }).click();
 await page.setViewportSize({ width: 390, height: 844 });
 await page.screenshot({ path: "artifacts/dashboard-mobile.png", fullPage: true });
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "mobile layout overflows");
 await page.getByRole("button", { name: "Episode queue", exact: true }).click();
 await page.getByRole("textbox", { name: "Search all episodes" }).waitFor();
 await page.screenshot({ path: "artifacts/queue-mobile.png", fullPage: true });
 assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true, "queue overflows");
 assert.deepEqual(errors, []);
 console.log("UI smoke passed: desktop/mobile, search, pagination, rejected action, diagnostic dialog, operations.");
 await browser.close();
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { if (browser) await browser.close(); });
