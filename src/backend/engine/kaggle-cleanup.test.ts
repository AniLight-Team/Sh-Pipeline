import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { VideoEncodingManager } from "./video.manager.js";
import { PipelineEngineService } from "./service.js";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

test("deleteKaggleDataset calls official DeleteDataset RPC, never downgrades KGAT_ to Basic, and handles 403 accurately", async () => {
  const vm = new VideoEncodingManager({
    kaggleAccounts: [{ username: "alice", key: "KGAT_secret_token" }],
    hfAccounts: [],
  });

  const calls: { url: string; method: string; auth: string; body: any }[] = [];
  const origFetch = globalThis.fetch;

  try {
    // Case 1: Successful delete on official kagglesdk RPC endpoint
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers || {}) as Record<string, string>;
      calls.push({
        url,
        method: String(init?.method || "GET"),
        auth: headers.Authorization || "",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({});
    }) as typeof fetch;

    const ok1 = await vm.deleteKaggleDataset("alice/kira-batch-475-062266", "alice", "KGAT_secret_token");
    assert.equal(ok1, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.kaggle.com/v1/datasets.DatasetApiService/DeleteDataset");
    assert.equal(calls[0].method, "POST");
    assert.equal(calls[0].auth, "Bearer KGAT_secret_token");
    assert.deepEqual(calls[0].body, {
      ownerSlug: "alice",
      datasetSlug: "kira-batch-475-062266",
    });

    // Case 2: 403 PERMISSION_DENIED when dataset is already gone -> returns true, never tries Basic auth
    calls.length = 0;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      const headers = (init?.headers || {}) as Record<string, string>;
      calls.push({
        url,
        method: String(init?.method || "GET"),
        auth: headers.Authorization || "",
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      if (url.includes("DeleteDataset")) {
        return jsonResponse({ error: { code: 403, message: "Permission 'datasets.delete' was denied" } }, 403);
      }
      return jsonResponse({ message: "Not found" }, 404);
    }) as typeof fetch;

    const ok2 = await vm.deleteKaggleDataset("kira-batch-475-062266", "alice", "KGAT_secret_token");
    assert.equal(ok2, true);
    assert.equal(calls.every((c) => c.auth.startsWith("Bearer ")), true);

    // Case 3: 403 PERMISSION_DENIED when dataset STILL EXISTS -> returns false
    calls.length = 0;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("DeleteDataset")) {
        return jsonResponse({ error: { code: 403, message: "Permission 'datasets.delete' was denied" } }, 403);
      }
      return jsonResponse({ id: 13614735, ref: "alice/kira-batch-475-062266" }, 200);
    }) as typeof fetch;

    const ok3 = await vm.deleteKaggleDataset("kira-batch-475-062266", "alice", "KGAT_secret_token");
    assert.equal(ok3, false);

    // Case 4: HTTP 200 with inline RPC error string -> returns false
    globalThis.fetch = (async () => jsonResponse({ error: "Cannot delete dataset" }, 200)) as typeof fetch;
    const ok4 = await vm.deleteKaggleDataset("kira-batch-475-062266", "alice", "KGAT_secret_token");
    assert.equal(ok4, false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("deleteKaggleKernel and cancelKaggleKernel use official DeleteKernel RPC and cleanup deletes notebook before dataset", async () => {
  const vm = new VideoEncodingManager({
    kaggleAccounts: [{ username: "alice", key: "KGAT_secret_token" }],
    hfAccounts: [],
  });

  const order: { url: string; body: any }[] = [];
  const origFetch = globalThis.fetch;

  try {
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      order.push({
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : undefined,
      });
      return jsonResponse({});
    }) as typeof fetch;

    const res = await PipelineEngineService.cleanupKaggleBatchResources(
      vm,
      { username: "alice", key: "KGAT_secret_token" },
      { datasetSlug: "kira-batch-475-062266", kernelSlug: "enc-batch-475-7a6c9d" },
      "unit test completed",
    );

    assert.deepEqual(res, { kernelDeleted: true, datasetDeleted: true });
    assert.equal(order.length, 2);
    assert.equal(order[0].url, "https://api.kaggle.com/v1/kernels.KernelsApiService/DeleteKernel");
    assert.deepEqual(order[0].body, { userName: "alice", kernelSlug: "enc-batch-475-7a6c9d" });
    assert.equal(order[1].url, "https://api.kaggle.com/v1/datasets.DatasetApiService/DeleteDataset");
    assert.deepEqual(order[1].body, { ownerSlug: "alice", datasetSlug: "kira-batch-475-062266" });

    // cancelKaggleKernel also routes through DeleteKernel RPC
    order.length = 0;
    const cancelled = await vm.cancelKaggleKernel("enc-batch-475-7a6c9d", "alice", "KGAT_secret_token");
    assert.equal(cancelled, true);
    assert.equal(order.length, 1);
    assert.equal(order[0].url, "https://api.kaggle.com/v1/kernels.KernelsApiService/DeleteKernel");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("uploadBatchDatasetRest recovers from 'title already in use' without re-uploading GCS blobs", async () => {
  const vm = new VideoEncodingManager({
    kaggleAccounts: [{ username: "alice", key: "KGAT_secret_token" }],
    hfAccounts: [],
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "kira-ds-collision-"));
  const sampleFile = path.join(tmpDir, "input_4712.mp4");
  fs.writeFileSync(sampleFile, Buffer.alloc(1024, 1));

  let blobUploadCalls = 0;
  const createPayloads: { title: string; slug: string; files: { token: string }[] }[] = [];
  const origFetch = globalThis.fetch;

  try {
    // Stub GCS blob upload to verify blobs are uploaded strictly ONCE even on title collision
    (vm as any).uploadSingleBlobToGcs = async () => {
      blobUploadCalls++;
      return "gcs-blob-token-123";
    };

    globalThis.fetch = (async (_input: any, init?: RequestInit) => {
      const payload = JSON.parse(String(init?.body || "{}"));
      createPayloads.push(payload);
      if (createPayloads.length === 1) {
        return jsonResponse({
          ref: "",
          url: "https://www.kaggle.com/",
          status: "Error",
          error: 'The requested title "kira-batch-475-062266" is already in use by a dataset. Please choose another title.',
        });
      }
      return jsonResponse({
        ref: `alice/${payload.slug}`,
        url: `https://www.kaggle.com/datasets/alice/${payload.slug}`,
        status: "ok",
      });
    }) as typeof fetch;

    const registeredSlug = await vm.uploadBatchDatasetRest(
      [{ jobId: 4712, localFilePath: sampleFile, remoteFilename: "input_4712.mp4", sizeBytes: 1024 }],
      "kira-batch-475-062266",
      "alice",
      "KGAT_secret_token",
    );

    assert.equal(blobUploadCalls, 1, "GCS blobs must not be re-uploaded on title collision");
    assert.equal(createPayloads.length, 2);
    assert.equal(createPayloads[0].title, "kira-batch-475-062266");
    assert.notEqual(registeredSlug, "kira-batch-475-062266");
    assert.match(registeredSlug, /^kira-batch-475-[a-f0-9]{8}$/);
    assert.deepEqual(createPayloads[1].files, [{ token: "gcs-blob-token-123" }]);
  } finally {
    globalThis.fetch = origFetch;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("selectOrphanedKaggleResources only selects stale inactive pipeline batch resources and protects active & personal assets", () => {
  const nowMs = Date.parse("2026-11-24T01:00:00Z");
  const oldIso = "2026-11-23T18:00:00Z"; // 7 hours old
  const freshIso = "2026-11-24T00:52:00Z"; // 8 minutes old (< 20m grace window)

  const plan = PipelineEngineService.selectOrphanedKaggleResources({
    datasets: [
      { slug: "kira-batch-475-062266", totalBytes: 4_000_000_000, lastUpdated: oldIso }, // orphan -> DELETE
      { slug: "kira-batch-476-aabbcc", totalBytes: 2_000_000_000, lastUpdated: oldIso }, // active batchId -> KEEP
      { slug: "kira-batch-477-ddeeff", totalBytes: 1_000_000_000, lastUpdated: freshIso }, // too fresh -> KEEP
      { slug: "my-personal-anime-dataset", totalBytes: 9_000_000_000, lastUpdated: oldIso }, // non-pipeline -> KEEP
      { slug: "kira-batch-470-ce5bf5", totalBytes: 900_000_000, lastUpdated: oldIso }, // orphan -> DELETE
    ],
    kernels: [
      { slug: "enc-batch-475-7a6c9d", lastRunTime: oldIso }, // orphan -> DELETE
      { slug: "enc-batch-476-112233", lastRunTime: oldIso }, // active batchId -> KEEP
      { slug: "enc-batch-478-445566", lastRunTime: oldIso }, // active kernelSlug -> KEEP
      { slug: "enc-batch-479-778899", lastRunTime: freshIso }, // too fresh -> KEEP
      { slug: "my-personal-notebook", lastRunTime: oldIso }, // non-pipeline -> KEEP
    ],
    activeBatchIds: new Set([476]),
    activeDatasetSlugs: new Set(["kira-batch-480-999999"]),
    activeKernelSlugs: new Set(["enc-batch-478-445566"]),
    nowMs,
    minAgeMs: 20 * 60 * 1000,
    maxDeletes: 10,
  });

  assert.deepEqual(
    plan.datasetsToDelete.map((d) => d.slug),
    ["kira-batch-475-062266", "kira-batch-470-ce5bf5"],
  );
  assert.deepEqual(
    plan.kernelsToDelete.map((k) => k.slug),
    ["enc-batch-475-7a6c9d"],
  );

  // If a batch's dataset is old (>20m) but its notebook ran recently (<20m), BOTH are protected
  const planWithFreshNotebook = PipelineEngineService.selectOrphanedKaggleResources({
    datasets: [
      { slug: "kira-batch-500-aaa111", totalBytes: 3_000_000_000, lastUpdated: oldIso },
      { slug: "kira-batch-501-bbb222", totalBytes: 3_000_000_000, lastUpdated: oldIso },
    ],
    kernels: [
      { slug: "enc-batch-500-ccc333", lastRunTime: freshIso }, // fresh -> protects batch 500 dataset too!
      { slug: "enc-batch-501-ddd444", lastRunTime: oldIso },
    ],
    activeBatchIds: new Set(),
    activeDatasetSlugs: new Set(),
    activeKernelSlugs: new Set(),
    nowMs,
    minAgeMs: 20 * 60 * 1000,
    maxDeletes: 10,
  });
  assert.deepEqual(planWithFreshNotebook.kernelsToDelete.map((k) => k.slug), ["enc-batch-501-ddd444"]);
  assert.deepEqual(planWithFreshNotebook.datasetsToDelete.map((d) => d.slug), ["kira-batch-501-bbb222"]);
});

test("executeKaggleCleanupPlanForAccount checks live Kaggle status and refuses to delete running notebooks or their datasets", async () => {
  const vm = new VideoEncodingManager({
    kaggleAccounts: [{ username: "alice", key: "KGAT_secret_token" }],
    hfAccounts: [],
  });

  const deletedKernels: string[] = [];
  const deletedDatasets: string[] = [];

  vm.checkKernelStatusOnce = async (slug: string) => {
    if (slug === "enc-batch-600-live1111") {
      return { state: "running", rawStatus: "running" };
    }
    return { state: "completed", rawStatus: "complete" };
  };
  vm.deleteKaggleKernel = async (slug: string) => {
    deletedKernels.push(slug);
    return true;
  };
  vm.deleteKaggleDataset = async (slug: string) => {
    deletedDatasets.push(slug);
    return true;
  };

  const result = await PipelineEngineService.executeKaggleCleanupPlanForAccount(
    vm,
    { username: "alice", key: "KGAT_secret_token" },
    {
      kernelsToDelete: [
        { slug: "enc-batch-600-live1111", batchId: 600 },
        { slug: "enc-batch-601-done2222", batchId: 601 },
      ],
      datasetsToDelete: [
        { slug: "kira-batch-600-aaaa1111", batchId: 600, totalBytes: 5_000_000_000 },
        { slug: "kira-batch-601-bbbb2222", batchId: 601, totalBytes: 2_000_000_000 },
      ],
    },
  );

  // Batch 600 is live-running on Kaggle -> neither its notebook nor its dataset may be deleted!
  assert.deepEqual(deletedKernels, ["enc-batch-601-done2222"]);
  assert.deepEqual(deletedDatasets, ["kira-batch-601-bbbb2222"]);
  assert.equal(result.deletedKernels, 1);
  assert.equal(result.deletedDatasets, 1);
  assert.equal(result.freedBytes, 2_000_000_000);
  assert.equal(result.skippedLiveRunning, 2);
});

test("inspectStagedFilesOnDisk protects hyphenated subs_<uuid> dirs, active discovering jobs, and folders with recently-written nested files", async () => {
  const { getKiraStagingDir } = await import("../config.js");
  const stagingDir = getKiraStagingDir();
  fs.mkdirSync(stagingDir, { recursive: true });

  const recentUuidSubs = path.join(stagingDir, "subs_550e8400-e29b-41d4-a716-446655440000");
  const oldUuidSubs = path.join(stagingDir, "subs_11111111-2222-3333-4444-555555555555");
  const nestedActiveDir = path.join(stagingDir, "orphan_dir_with_fresh_file");
  const nestedFreshFile = path.join(nestedActiveDir, "sub_1080p.mp4");
  const discoveringJobFile = path.join(stagingDir, "job_888777_ep3_1080p_deadbeef.mkv");

  const activeDiscoverSet = (PipelineEngineService as any).activeDiscoveringJobIds as Set<number>;

  try {
    fs.mkdirSync(recentUuidSubs, { recursive: true });
    fs.mkdirSync(oldUuidSubs, { recursive: true });
    fs.mkdirSync(nestedActiveDir, { recursive: true });
    fs.writeFileSync(nestedFreshFile, "fresh-bytes");
    fs.writeFileSync(discoveringJobFile, "downloading-bytes");

    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);
    // Age oldUuidSubs AND age the parent directory of nestedActiveDir (simulating FFmpeg writing into an existing dir)
    fs.utimesSync(oldUuidSubs, thirtyMinsAgo, thirtyMinsAgo);
    fs.utimesSync(nestedActiveDir, thirtyMinsAgo, thirtyMinsAgo);
    fs.utimesSync(discoveringJobFile, thirtyMinsAgo, thirtyMinsAgo);

    activeDiscoverSet.add(888777);
    const reportWhileDiscovering = await PipelineEngineService.inspectStagedFilesOnDisk();
    const byName1 = new Map(reportWhileDiscovering.files.map((f) => [f.filename, f]));

    // Hyphenated subs_<uuid> is protected while recent OR while any discovery runs
    assert.equal(byName1.get("subs_550e8400-e29b-41d4-a716-446655440000")?.isOrphan, false);
    assert.equal(byName1.get("subs_11111111-2222-3333-4444-555555555555")?.isOrphan, false);
    // In-process discovering job file is protected even without DB row
    assert.equal(byName1.get("job_888777_ep3_1080p_deadbeef.mkv")?.isOrphan, false);
    // Parent dir had 30m-old mtime, but nested file was written right now -> modifiedAt must reflect the fresh nested file!
    const nestedEntry = byName1.get("orphan_dir_with_fresh_file");
    assert.ok(nestedEntry);
    assert.equal(Date.now() - new Date(nestedEntry.modifiedAt).getTime() < 60_000, true);
    assert.equal(nestedEntry.sizeBytes, Buffer.byteLength("fresh-bytes"));

    activeDiscoverSet.delete(888777);
    const reportIdle = await PipelineEngineService.inspectStagedFilesOnDisk();
    const byName2 = new Map(reportIdle.files.map((f) => [f.filename, f]));

    assert.equal(byName2.get("subs_550e8400-e29b-41d4-a716-446655440000")?.isOrphan, false);
    assert.equal(byName2.get("subs_11111111-2222-3333-4444-555555555555")?.isOrphan, true);
  } finally {
    activeDiscoverSet.delete(888777);
    fs.rmSync(recentUuidSubs, { recursive: true, force: true });
    fs.rmSync(oldUuidSubs, { recursive: true, force: true });
    fs.rmSync(nestedActiveDir, { recursive: true, force: true });
    fs.rmSync(discoveringJobFile, { force: true });
  }
});
