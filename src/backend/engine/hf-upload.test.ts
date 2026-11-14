import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runUploadProcess, cleanUploadDiagnostic, HF_UPLOAD_FUNCTION } from "./hf-upload.js";
import { VideoEncodingManager } from "./video.manager.js";

test("transfer output above the previous 10MB limit does not terminate a successful upload", async () => {
  const output = await runUploadProcess(process.execPath, ["-e",
    'process.stderr.write("x".repeat(12*1024*1024), () => console.log("HF_UPLOAD_OK"))'
  ]);
  assert.match(output, /HF_UPLOAD_OK/);
});

test("failure diagnostics retain the actual error tail and redact tokens and ANSI sequences", async () => {
  await assert.rejects(runUploadProcess(process.execPath, ["-e",
    'process.stderr.write("progress".repeat(10000) + "\\n\\x1b[31mFINAL_ERROR hf_testSecret123\\x1b[0m", () => { process.exitCode=1; })'
  ]), error => {
    assert.match(String(error), /FINAL_ERROR \[redacted\]/);
    assert.doesNotMatch(String(error), /hf_testSecret123|\x1b/);
    return true;
  });
  assert.equal(cleanUploadDiagnostic("\x1b[1A20%|xxx\rPermission denied"), "Permission denied");
});

test("hung transfer is killed and reports timeout rather than progress as the cause", async () => {
  await assert.rejects(runUploadProcess(process.execPath, ["-e", "setInterval(()=>{},1000)"], { timeoutMs: 150 }), /timed out/);
});

test("upload payload is supplied on stdin instead of command-line arguments", async () => {
  const result = await runUploadProcess(process.execPath, ["-e",
    'let s="";process.stdin.on("data",x=>s+=x);process.stdin.on("end",()=>console.log(s))'
  ], { input: JSON.stringify({ token: "test-secret" }) });
  assert.equal(JSON.parse(result).token, "test-secret");
});

test("an upload failure retains the remux checkpoint; retry reuses the same file and destination", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kira-checkpoint-test-"));
  try {
    const source = path.join(dir, "source.mkv");
    await fs.writeFile(source, "test source");
    const stat = await fs.stat(source);
    const hf = { owner: "test", bucket: "test", token: "unused" };
    const tracks: [string, number][] = [["sub", 0]];
    const identity = crypto.createHash("sha256").update(JSON.stringify({
      sourceIdentity: [["1080p", path.resolve(source), stat.size, stat.mtimeMs]],
      tracks, animeId: 10, episodeNumber: 22, bucket: "test/test", version: 1,
    })).digest("hex").slice(0, 20);
    const work = path.join(dir, `vm_remux_3977_${identity}`);
    await fs.mkdir(work);
    const output = path.join(work, "sub_1080p.mp4");
    const bytes = Buffer.alloc(12_000, 7);
    await fs.writeFile(output, bytes);
    const record = { job_id: 3977, anime_id: 10, episode_number: 22, type: "sub", quality: "1080p",
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      metadata: { size: bytes.length }, huggingface: { owner: "test", repo: "test", path: "stable/1080p.mp4", downloadUrl: "https://example.invalid/video" } };
    await fs.writeFile(path.join(work, "checkpoint.json"), JSON.stringify([record]));
    const vm = new VideoEncodingManager({ kaggleAccounts: [], hfAccounts: [hf] });
    let calls = 0;
    vm.uploadFilesToHfBucket = async (_hf, items) => {
      calls++; assert.deepEqual(items, [[output, "stable/1080p.mp4"]]);
      if (calls === 1) throw new Error("simulated interrupted upload");
    };
    const args = { jobId: 3977, animeId: 10, episodeNumber: 22, stagedQualities: { "1080p": source }, tracks, hf, workBaseDir: dir };
    await assert.rejects(vm.remuxAndUploadJobOnVm(args), /simulated interrupted/);
    assert.equal((await fs.stat(output)).size, bytes.length);
    assert.deepEqual(await vm.remuxAndUploadJobOnVm(args), [record]);
    assert.equal(calls, 2);
    // Retain until completion is durably recorded by the service.
    assert.equal((await fs.stat(output)).size, bytes.length);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("Hugging Face account rotation spans worker instances", () => {
  const hfAccounts = [{ owner: "one", bucket: "bucket", token: "fake" }, { owner: "two", bucket: "bucket", token: "fake" }];
  const one = new VideoEncodingManager({ kaggleAccounts: [], hfAccounts }).getNextHfAccount();
  const two = new VideoEncodingManager({ kaggleAccounts: [], hfAccounts }).getNextHfAccount();
  assert.notEqual(one.owner, two.owner);
});

test("Python bucket verification resumes partial uploads and rejects absent or wrong-sized results", { skip: !process.env.KIRA_TEST_PYTHON }, async () => {
  const script = `import os, sys, types
from types import SimpleNamespace
files = {"a": 10}
uploaded = []
def info(bucket, paths, token):
    return [SimpleNamespace(path=p, size=files[p]) for p in paths if p in files]
def batch(bucket_id, add, token):
    uploaded.extend(add)
    for local, remote in add:
        files[remote] = os.path.getsize(local)
sys.modules["huggingface_hub"] = SimpleNamespace(batch_bucket_files=batch, get_bucket_paths_info=info)
os.path.getsize = lambda local: {"local-a": 10, "local-b": 20}[local]
${HF_UPLOAD_FUNCTION}
pairs = [("local-a", "a"), ("local-b", "b")]
upload_verified("test/bucket", pairs, "fake")
assert uploaded == [("local-b", "b")], uploaded
uploaded.clear()
upload_verified("test/bucket", pairs, "fake")
assert uploaded == []
files["b"] = 1
sys.modules["huggingface_hub"].batch_bucket_files = lambda **kwargs: None
try:
    upload_verified("test/bucket", pairs, "fake")
    raise AssertionError("unverified upload was accepted")
except RuntimeError as exc:
    assert "verification failed" in str(exc)
print("VERIFIED")
`;
  assert.match(await runUploadProcess(process.env.KIRA_TEST_PYTHON!, ["-c", script]), /VERIFIED/);
});

test("saved bucket selection survives account order changes and dynamically falls back when target is removed", () => {
  const accounts = [{ owner: "one", bucket: "bucket", token: "rotated-token" }, { owner: "two", bucket: "bucket", token: "fake" }];
  const vm = new VideoEncodingManager({ kaggleAccounts: [], hfAccounts: accounts.reverse() });
  assert.equal(vm.getHfAccountForTarget({ owner: "one", bucket: "bucket" }).token, "rotated-token");
  const fallback = vm.getHfAccountForTarget({ owner: "missing", bucket: "bucket" });
  assert.ok(fallback.owner === "one" || fallback.owner === "two");
});

test("staging validation requires every declared quality and rejects empty files", async () => {
  const { PipelineEngineService } = await import("./service.js");
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kira-staged-test-"));
  try {
    const primary = path.join(dir, "primary.mkv");
    const secondary = path.join(dir, "secondary.mkv");
    await fs.writeFile(primary, "video");
    assert.equal(PipelineEngineService.hasValidStagedFiles({ stagedQualities: { "1080p": primary } }), true);
    const job = { stagedFilePath: primary, stagedQualities: { "1080p": primary, "720p": secondary } };
    assert.equal(PipelineEngineService.hasValidStagedFiles(job), false);
    await fs.writeFile(secondary, "");
    assert.equal(PipelineEngineService.hasValidStagedFiles(job), false);
    await fs.writeFile(secondary, "video");
    assert.equal(PipelineEngineService.hasValidStagedFiles(job), true);
  } finally { await fs.rm(dir, { recursive: true, force: true }); }
});

test("completion persists callback intent atomically and does not requeue on callback failure", async t => {
  const { PipelineEngineService } = await import("./service.js");
  const { db } = await import("../db/index.js");
  const writes: any[] = [];
  t.mock.method(db, "update", () => ({ set: (values: any) => {
    writes.push(values); return { where: async () => {} };
  } }) as any);
  t.mock.method(PipelineEngineService as any, "deliverCallbackPayload", async () => { throw new Error("simulated callback outage"); });
  t.mock.method(PipelineEngineService, "cleanupJobStagedFiles", async () => {});
  await (PipelineEngineService as any).persistAndDeliverJobCompletion({
    id: 123, types: ["sub"], episodeNumber: 1, metadata: { callbackDelivered: true },
  }, [{ type: "sub", quality: "1080p", sha256: "test", metadata: { size: 100 }, huggingface: { downloadUrl: "https://example.invalid/video" } }]);
  assert.equal(writes[0].status, "completed");
  assert.equal(writes[0].metadata.callbackDelivered, false);
  assert.equal(writes.some(w => w.status === "failed" || w.status === "staged"), false);
});

test("generated Kaggle worker remains valid Python", { skip: !process.env.KIRA_TEST_PYTHON }, async () => {
  const vm = new VideoEncodingManager({ kaggleAccounts: [], hfAccounts: [] });
  const script = vm.generateBatchGpuKernelScript([]);
  assert.match(await runUploadProcess(process.env.KIRA_TEST_PYTHON!, ["-c", "import sys; compile(sys.stdin.read(), 'worker.py', 'exec'); print('VALID')"], { input: script }), /VALID/);
});

test("API refuses to retry or delete active jobs and reports database failures honestly", async t => {
  const { default: Fastify } = await import("fastify");
  const { apiRoutes } = await import("../routes/api.js");
  const { db } = await import("../db/index.js");
  const { PipelineEngineService } = await import("./service.js");
  t.mock.method(PipelineEngineService, "ensureTables", async () => {});
  t.mock.method(db.query.pipelineJob, "findFirst", async () => ({ id: 1, status: "encoding", batchId: null }) as any);
  t.mock.method(db, "select", () => { throw new Error("simulated database outage"); });
  const app = Fastify();
  try {
    await app.register(apiRoutes, { prefix: "/api" });
    assert.equal((await app.inject({ method: "POST", url: "/api/jobs/1/retry" })).statusCode, 409);
    assert.equal((await app.inject({ method: "POST", url: "/api/jobs/1/delete" })).statusCode, 409);
    const unavailable = await app.inject({ method: "GET", url: "/api/jobs?limit=invalid" });
    assert.equal(unavailable.statusCode, 500);
    assert.equal(unavailable.json().jobs, undefined);
  } finally { await app.close(); }
});

test("orphan cleanup refuses to run without verified database ownership", async () => {
  const { PipelineEngineService } = await import("./service.js");
  await assert.rejects(PipelineEngineService.cleanupOrphanedStagedFiles(), /Database connection is required/);
});
