import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HuggingFaceAccount } from "./types.js";
import { log } from "../utils/logger.js";

/** Drain both pipes continuously: progress output must never kill a transfer via maxBuffer. */
export function runUploadProcess(command: string, args: string[], options: {
  input?: string; timeoutMs?: number; env?: NodeJS.ProcessEnv;
} = {}): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, env: options.env ?? process.env, stdio: "pipe" });
    let stdout = "", stderr = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, options.timeoutMs ?? 3_600_000);
    child.stdout.on("data", chunk => { stdout = (stdout + chunk.toString()).slice(-32_768); });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-32_768); });
    child.on("error", err => { clearTimeout(timer); reject(err); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0 && !timedOut) return resolve(stdout);
      const detail = cleanUploadDiagnostic(stderr || stdout);
      reject(new Error(`${timedOut ? "Upload process timed out" : `Process exited ${code ?? signal}`}\n${detail}`));
    });
    child.stdin.on("error", () => {}); // A failed import can close stdin before the payload is consumed.
    child.stdin.end(options.input ?? "");
  });
}

export function cleanUploadDiagnostic(value: string): string {
  return value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/hf_[A-Za-z0-9]+/g, "[redacted]")
    .replace(/\r/g, "\n").split("\n")
    .filter(line => line.trim() && !/\d+%\|/.test(line)).join("\n").slice(-4000);
}

// Also embedded into the Kaggle worker so both upload paths verify partial batches.
export const HF_UPLOAD_FUNCTION = String.raw`
def upload_verified(bucket_id, pairs, token):
    from huggingface_hub import batch_bucket_files, get_bucket_paths_info
    # Bucket batches are not atomic. Inspect before every attempt and only send missing files.
    expected = {remote: os.path.getsize(local) for local, remote in pairs}
    present = {f.path: f.size for f in get_bucket_paths_info(bucket_id, list(expected), token=token)}
    pending = [(local, remote) for local, remote in pairs if present.get(remote) != expected[remote]]
    if pending:
        batch_bucket_files(bucket_id=bucket_id, add=pending, token=token)
    present = {f.path: f.size for f in get_bucket_paths_info(bucket_id, list(expected), token=token)}
    missing = [remote for remote, size in expected.items() if present.get(remote) != size]
    if missing:
        raise RuntimeError("HF upload verification failed for: " + ", ".join(missing))
`;

const UPLOAD_SCRIPT = `import sys, json, os, traceback\n${HF_UPLOAD_FUNCTION}\ntry:
    data = json.load(sys.stdin)
    upload_verified(data["bucketId"], data["addItems"], data["token"])
    print("HF_UPLOAD_OK", flush=True)
except Exception:
    traceback.print_exc()
    sys.exit(1)
`;

let pythonReady: Promise<string> | undefined;
function ensurePython(): Promise<string> {
  if (!pythonReady) pythonReady = (async () => {
    const dir = path.join(os.tmpdir(), "kira-hf-venv");
    const py = path.join(dir, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
    const systemPy = process.env.KIRA_PYTHON || (process.platform === "win32" ? "python" : "python3");
    const probe = ["-c", "from huggingface_hub import batch_bucket_files, get_bucket_paths_info"];
    if (!fs.existsSync(py)) {
      try { await runUploadProcess(systemPy, probe, { timeoutMs: 30_000 }); return systemPy; } catch {}
      await runUploadProcess(systemPy, ["-m", "venv", dir], { timeoutMs: 120_000 });
    }
    try { await runUploadProcess(py, probe, { timeoutMs: 30_000 }); }
    catch {
      await runUploadProcess(py, ["-m", "pip", "install", "--disable-pip-version-check", "--upgrade", "huggingface_hub"], { timeoutMs: 300_000 });
      await runUploadProcess(py, probe, { timeoutMs: 30_000 });
    }
    return py;
  })().catch(err => { pythonReady = undefined; throw err; });
  return pythonReady;
}

export async function uploadHfFiles(hf: HuggingFaceAccount, addItems: [string, string][]): Promise<void> {
  if (!addItems.length) throw new Error("Cannot upload an empty file list");
  for (const [local] of addItems) {
    if (!(await fs.promises.stat(local)).size) throw new Error(`Empty upload file: ${local}`);
  }
  const python = await ensurePython();
  const input = JSON.stringify({ bucketId: `${hf.owner}/${hf.bucket}`, token: hf.token, addItems });
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const output = await runUploadProcess(python, ["-u", "-c", UPLOAD_SCRIPT], {
        input,
        env: { ...process.env, HF_HUB_DISABLE_PROGRESS_BARS: "1", HF_XET_HIGH_PERFORMANCE: "0", PYTHONUNBUFFERED: "1" },
      });
      if (!output.split(/\r?\n/).includes("HF_UPLOAD_OK")) throw new Error("Upload exited without a verified completion acknowledgement");
      return;
    } catch (err) {
      const detail = cleanUploadDiagnostic(String(err));
      const permanent = /(?:401|403|404) Client Error|Unauthorized|Forbidden|BucketNotFound|PermissionError|No space left on device/i.test(detail);
      if (permanent || attempt === 4) throw new Error(`VM Hugging Face upload failed (${attempt}/4 attempts): ${detail}`);
      const delay = Math.min(60_000, 5000 * 2 ** (attempt - 1)) + Math.floor(Math.random() * 1000);
      log.warn("HF:Upload", `Attempt ${attempt}/4 failed; retrying in ${Math.ceil(delay / 1000)}s. ${detail}`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  throw new Error("HF upload exhausted retries without verification");
}
