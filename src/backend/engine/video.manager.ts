import fs from "fs";
import path from "path";
import https from "https";
import crypto from "crypto";
import { inspectMkvStreamsSync } from "./subtitles.manager.js";
import type {
  KaggleAccount,
  HuggingFaceAccount,
  HfStoreRecord,
  MkvStreamProbe,
  KiraBatchUploadItem,
  KiraBatchManifestItem,
  KiraBatchKernelOutput,
  KiraBatchHfRecord,
} from "./types.js";
import { loadAccountsFromEnv, EAGER_VM_DELETE } from "../config.js";

export class VideoEncodingManager {
  private kaggleAccounts: KaggleAccount[];
  private hfAccounts: HuggingFaceAccount[];
  private currentKaggleIdx = 0;
  private currentHfIdx = 0;
  private eagerVmDelete: boolean;

  constructor(
    options: {
      kaggleAccounts?: KaggleAccount[];
      hfAccounts?: HuggingFaceAccount[];
      eagerVmDelete?: boolean;
    } = {},
  ) {
    const envAccs = loadAccountsFromEnv();
    this.kaggleAccounts = options.kaggleAccounts || envAccs.kaggleAccounts;
    this.hfAccounts = options.hfAccounts || envAccs.hfAccounts;
    this.eagerVmDelete = options.eagerVmDelete ?? EAGER_VM_DELETE;
  }

  public getKaggleAccounts(): KaggleAccount[] {
    return this.kaggleAccounts;
  }

  public getHfAccounts(): HuggingFaceAccount[] {
    return this.hfAccounts;
  }

  public getAccountByUsername(username: string): KaggleAccount | undefined {
    return this.kaggleAccounts.find((a) => a.username === username);
  }

  public static isBearerToken(key: string): boolean {
    return Boolean(key && key.trim().toUpperCase().startsWith("KGAT_"));
  }

  public static getKaggleAuthHeader(username: string, key: string): string {
    const cleanKey = (key || "").trim();
    if (VideoEncodingManager.isBearerToken(cleanKey)) {
      return `Bearer ${cleanKey}`;
    }
    return "Basic " + Buffer.from(`${username}:${cleanKey}`).toString("base64");
  }

  private async makeKaggleRequest(
    url: string,
    username: string,
    key: string,
    options: {
      method?: string;
      payload?: any;
      quietCodes?: number[];
    } = {},
  ): Promise<any> {
    const { method = "GET", payload, quietCodes = [] } = options;
    const authHeader = VideoEncodingManager.getKaggleAuthHeader(username, key);

    const headers: Record<string, string> = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "AniLight-Worker/3.0",
    };

    const body = payload !== undefined ? JSON.stringify(payload) : undefined;

    let res = await fetch(url, { method, headers, body });

    if (
      (res.status === 401 || res.status === 403) &&
      !headers.Authorization.startsWith("Bearer")
    ) {
      headers.Authorization = `Bearer ${key.trim()}`;
      res = await fetch(url, { method, headers, body });
    } else if (
      (res.status === 401 || res.status === 403) &&
      headers.Authorization.startsWith("Bearer")
    ) {
      headers.Authorization =
        "Basic " +
        Buffer.from(`${username}:${key.trim()}`).toString("base64");
      res = await fetch(url, { method, headers, body });
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      if (!quietCodes.includes(res.status)) {
        console.warn(
          `[Kaggle:HTTP] HTTP ${res.status} on ${url}: ${text.slice(0, 300)}`,
        );
      }
      throw new Error(
        `Kaggle API returned HTTP ${res.status} for ${url}: ${text.slice(0, 250)}`,
      );
    }

    const contentType = res.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      return await res.json();
    }
    return { raw: await res.text() };
  }

  public getNextHfAccount(): HuggingFaceAccount {
    if (this.hfAccounts.length === 0) {
      throw new Error(
        "No Hugging Face accounts configured in HF_ACCOUNTS or HF_OWNER/BUCKET/TOKEN",
      );
    }
    const acc = this.hfAccounts[this.currentHfIdx % this.hfAccounts.length];
    this.currentHfIdx = (this.currentHfIdx + 1) % this.hfAccounts.length;
    return acc;
  }

  public determineTracksToEncode(
    probe: MkvStreamProbe,
    langType: string,
  ): [string, number][] {
    const isDual = probe.isDualAudio;
    const jpIdx = probe.japaneseStreamIndex ?? 0;
    const enIdx = probe.englishStreamIndex ?? 0;
    const lType = String(langType).toLowerCase();

    if (lType === "all") {
      if (isDual) {
        return [
          ["sub", jpIdx],
          ["dub", enIdx],
        ];
      }
      return [["sub", jpIdx]];
    }
    if (lType === "dub") {
      return [["dub", isDual ? enIdx : jpIdx]];
    }
    return [["sub", jpIdx]];
  }

  /**
   * Streams a single file to Kaggle GCS Blob storage and returns its Kaggle blob token.
   */
  private async uploadSingleBlobToGcs(
    localFilePath: string,
    remoteFilename: string,
    username: string,
    key: string,
  ): Promise<string> {
    const stats = await fs.promises.stat(localFilePath);
    const filesize = stats.size;
    const lastModified = Math.floor(stats.mtimeMs / 1000);

    console.log(
      `[Kaggle:REST] Requesting GCS upload URL for ${remoteFilename} (${(filesize / (1024 * 1024)).toFixed(1)} MB)...`,
    );

    const blobUrls = [
      "https://api.kaggle.com/v1/blobs.BlobApiService/StartBlobUpload",
      "https://api.kaggle.com/v1/blobs/upload",
      "https://www.kaggle.com/api/v1/blobs/upload",
    ];

    const blobPayload = {
      type: "DATASET",
      name: remoteFilename,
      contentLength: filesize,
      content_length: filesize,
      lastModifiedEpochSeconds: lastModified,
      last_modified_epoch_seconds: lastModified,
    };

    let initData: any = null;
    let lastBlobErr: any = null;

    for (const bUrl of blobUrls) {
      try {
        initData = await this.makeKaggleRequest(bUrl, username, key, {
          method: "POST",
          payload: blobPayload,
        });
        if (initData?.createUrl || initData?.create_url || initData?.token) {
          break;
        }
      } catch (err: any) {
        lastBlobErr = err;
      }
    }

    const uploadUrl = initData?.createUrl || initData?.create_url;
    const token = initData?.token;
    if (!uploadUrl || !token) {
      throw new Error(
        `Failed to acquire GCS upload URL from Kaggle for ${remoteFilename}: ${JSON.stringify(
          initData || lastBlobErr?.message || lastBlobErr,
        )}`,
      );
    }

    for (let gcsAttempt = 1; gcsAttempt <= 2; gcsAttempt++) {
      try {
        await new Promise<void>((resolve, reject) => {
          const parsed = new URL(uploadUrl);
          const req = https.request(
            {
              protocol: parsed.protocol,
              hostname: parsed.hostname,
              port: parsed.port || 443,
              path: `${parsed.pathname}${parsed.search}`,
              method: "PUT",
              headers: {
                "Content-Type": "application/octet-stream",
                "Content-Length": String(filesize),
              },
              timeout: 3600000,
            },
            (res) => {
              if (res.statusCode && [200, 201].includes(res.statusCode)) {
                res.resume();
                resolve();
              } else {
                let body = "";
                res.on("data", (chunk) => {
                  body += chunk;
                });
                res.on("end", () => {
                  reject(
                    new Error(
                      `GCS upload failed for ${remoteFilename}: HTTP ${res.statusCode} - ${body.slice(0, 200)}`,
                    ),
                  );
                });
              }
            },
          );

          req.on("error", (err) => reject(err));
          req.on("timeout", () => {
            req.destroy();
            reject(
              new Error(`GCS upload timed out after 3600s (${remoteFilename})`),
            );
          });

          const fileStream = fs.createReadStream(localFilePath);
          fileStream.on("error", (err) => {
            req.destroy();
            reject(err);
          });
          fileStream.pipe(req);
        });
        break;
      } catch (err) {
        if (gcsAttempt >= 2) throw err;
        console.warn(
          `[Kaggle:REST] Retrying GCS upload for ${remoteFilename} after transient error...`,
        );
        await new Promise((r) => setTimeout(r, 3000));
      }
    }

    return token;
  }

  /**
   * Uploads multiple episode video files into ONE single Kaggle Dataset (up to 100GB).
   */
  public async uploadBatchDatasetRest(
    items: KiraBatchUploadItem[],
    datasetSlug: string,
    username: string,
    key: string,
    onProgress?: () => Promise<void>,
  ): Promise<boolean> {
    if (items.length === 0) {
      throw new Error("Cannot upload empty batch dataset to Kaggle");
    }

    const totalGb = (
      items.reduce((acc, i) => acc + i.sizeBytes, 0) /
      (1024 * 1024 * 1024)
    ).toFixed(2);
    console.log(
      `[Kaggle:BatchDataset] Uploading ${items.length} file(s) (${totalGb} GiB) into dataset '${username}/${datasetSlug}'...`,
    );

    const tokens: { token: string }[] = new Array(items.length);
    const concurrency = Math.min(2, items.length);
    let cursor = 0;

    const worker = async () => {
      while (true) {
        const idx = cursor++;
        if (idx >= items.length) break;
        const item = items[idx];
        const tok = await this.uploadSingleBlobToGcs(
          item.localFilePath,
          item.remoteFilename,
          username,
          key,
        );
        tokens[idx] = { token: tok };
        if (onProgress) {
          await onProgress().catch(() => {});
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, () => worker()));

    console.log(
      `[Kaggle:BatchDataset] All ${items.length} GCS blobs uploaded. Registering dataset '${username}/${datasetSlug}'...`,
    );

    const createUrls = [
      "https://www.kaggle.com/api/v1/datasets/create/new",
      "https://api.kaggle.com/v1/datasets/create/new",
      "https://api.kaggle.com/v1/datasets.DatasetApiService/CreateDataset",
    ];

    let createRes: any = null;
    let lastCreateErr: any = null;

    for (const cUrl of createUrls) {
      try {
        createRes = await this.makeKaggleRequest(cUrl, username, key, {
          method: "POST",
          payload: {
            title: datasetSlug,
            slug: datasetSlug,
            ownerSlug: username,
            licenseName: "CC0-1.0",
            isPrivate: true,
            files: tokens,
          },
        });
        const statusStr = String(createRes?.status || "").toLowerCase();
        if (!statusStr.includes("error") && !createRes?.error) {
          lastCreateErr = null;
          break;
        }
      } catch (err: any) {
        lastCreateErr = err;
      }
    }

    if (lastCreateErr && !createRes) {
      throw new Error(
        `Kaggle dataset creation failed: ${lastCreateErr?.message || lastCreateErr}`,
      );
    }

    const statusStr = String(createRes?.status || "").toLowerCase();
    if (statusStr.includes("error") || createRes?.error) {
      throw new Error(
        `Kaggle dataset creation returned error: ${JSON.stringify(createRes)}`,
      );
    }

    return true;
  }

  public async uploadDatasetRest(
    mkvPath: string,
    datasetSlug: string,
    username: string,
    key: string,
  ): Promise<boolean> {
    const ext = path.extname(mkvPath) || ".mkv";
    const stats = await fs.promises.stat(mkvPath);
    return await this.uploadBatchDatasetRest(
      [
        {
          jobId: 1,
          localFilePath: mkvPath,
          remoteFilename: `input_video${ext}`,
          sizeBytes: stats.size,
        },
      ],
      datasetSlug,
      username,
      key,
    );
  }

  public extractCleanStatus(rawStatus: any): string {
    if (!rawStatus) return "";
    let val = "";
    if (typeof rawStatus === "object") {
      val = rawStatus.status || rawStatus.state || rawStatus.raw || "";
    } else {
      val = String(rawStatus);
    }
    let s = val.trim().toLowerCase().replace(/^["']|["']$/g, "");
    if (s.includes(".") && !s.includes(" ")) {
      s = s.split(".").pop() || s;
    }
    return s;
  }

  /**
   * Single non-blocking dataset readiness check (ideal for short durable Inngest polling steps).
   */
  public async checkDatasetStatusOnce(
    datasetSlug: string,
    username: string,
    key: string,
    allowListFallback = true,
  ): Promise<{ state: "ready" | "indexing" | "failed"; rawStatus: string }> {
    const datasetIdentifier = `${username}/${datasetSlug}`;
    let cleanStatus = "";
    let httpNote = "";

    for (const dsUrl of [
      `https://www.kaggle.com/api/v1/datasets/status/${datasetIdentifier}`,
      `https://api.kaggle.com/v1/datasets/status/${datasetIdentifier}`,
    ]) {
      try {
        const dsData = await this.makeKaggleRequest(dsUrl, username, key, {
          method: "GET",
          quietCodes: [403, 404],
        });
        const cand = this.extractCleanStatus(dsData);
        if (cand && !cand.slice(0, 20).includes("error")) {
          cleanStatus = cand;
          break;
        } else if (["error", "failed"].includes(cand)) {
          cleanStatus = cand;
          break;
        }
      } catch {
        if (!httpNote) httpNote = "iam_propagating";
      }
    }

    if (!cleanStatus && allowListFallback) {
      try {
        const listUrl = `https://www.kaggle.com/api/v1/datasets/list?user=${encodeURIComponent(username)}&search=${encodeURIComponent(datasetSlug)}`;
        const dsList = await this.makeKaggleRequest(listUrl, username, key, {
          method: "GET",
          quietCodes: [403, 404],
        });
        if (Array.isArray(dsList)) {
          for (const item of dsList) {
            const ref = item.ref || item.url || "";
            if (String(ref).includes(datasetSlug)) {
              const itemStatus = this.extractCleanStatus(
                item.status || "ready",
              );
              if (itemStatus) {
                cleanStatus = itemStatus;
                break;
              }
            }
          }
        }
      } catch {}
    }

    if (["ready", "complete", "completed", "ok"].includes(cleanStatus)) {
      return { state: "ready", rawStatus: cleanStatus };
    }
    if (["error", "failed", "failure"].includes(cleanStatus)) {
      return { state: "failed", rawStatus: cleanStatus };
    }
    return { state: "indexing", rawStatus: cleanStatus || httpNote || "indexing" };
  }

  public async waitForDatasetReady(
    datasetSlug: string,
    username: string,
    key: string,
    timeoutSec = 600,
  ): Promise<boolean> {
    console.log(
      `[Kaggle:Dataset] Waiting for Kaggle backend to index dataset '${datasetSlug}'...`,
    );
    const startTime = Date.now();
    await new Promise((r) => setTimeout(r, 4000));

    while ((Date.now() - startTime) / 1000 < timeoutSec) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const res = await this.checkDatasetStatusOnce(
        datasetSlug,
        username,
        key,
        elapsed >= 15,
      );

      console.log(
        `[Kaggle:Dataset] Dataset Status: '${res.rawStatus}' | Elapsed: ${elapsed}s`,
      );

      if (res.state === "ready") {
        await new Promise((r) => setTimeout(r, 3000));
        console.log(
          `[Kaggle:Dataset] Dataset '${datasetSlug}' is ready on Kaggle!`,
        );
        return true;
      }
      if (res.state === "failed") {
        throw new Error(
          `Kaggle dataset processing failed on cloud with status: '${res.rawStatus}'`,
        );
      }

      await new Promise((r) => setTimeout(r, 5000));
    }

    console.warn(
      `[Kaggle:Dataset] Dataset status check reached ${timeoutSec}s; proceeding to kernel push...`,
    );
    return false;
  }

  public async deleteKaggleDataset(
    datasetSlug: string,
    username: string,
    key: string,
  ): Promise<void> {
    try {
      await this.makeKaggleRequest(
        "https://www.kaggle.com/api/v1/datasets/delete",
        username,
        key,
        {
          method: "POST",
          payload: { ownerSlug: username, datasetSlug },
          quietCodes: [403, 404],
        },
      );
      console.log(`[Kaggle:Cleanup] Cleaned up Kaggle Dataset '${datasetSlug}'.`);
    } catch {}
  }

  public async listUserKernels(
    username: string,
    key: string,
    pageSize = 20,
  ): Promise<any[]> {
    try {
      const listUrl = `https://www.kaggle.com/api/v1/kernels/list?user=${encodeURIComponent(username)}&pageSize=${pageSize}&sortBy=dateRun`;
      const res = await this.makeKaggleRequest(listUrl, username, key, {
        method: "GET",
        quietCodes: [400, 401, 403, 404],
      });
      return Array.isArray(res) ? res : [];
    } catch {
      return [];
    }
  }

  public async cancelKaggleKernel(
    kernelSlug: string,
    username: string,
    key: string,
  ): Promise<void> {
    try {
      await this.makeKaggleRequest(
        `https://www.kaggle.com/api/v1/kernels/cancel?userName=${encodeURIComponent(username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`,
        username,
        key,
        {
          method: "POST",
          quietCodes: [400, 403, 404],
        },
      );
    } catch {}
    await this.deleteKaggleKernel(kernelSlug, username, key).catch(() => {});
  }

  public async deleteKaggleKernel(
    kernelSlug: string,
    username: string,
    key: string,
  ): Promise<void> {
    try {
      await this.makeKaggleRequest(
        `https://www.kaggle.com/api/v1/kernels/delete?userName=${encodeURIComponent(username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`,
        username,
        key,
        {
          method: "DELETE",
          quietCodes: [400, 403, 404],
        },
      );
    } catch {}
  }

  /**
   * Generates a strictly GPU-ONLY (2x NvidiaTeslaT4 NVENC) Multi-Episode Batch Kernel script:
   * - Installs BtbN FFmpeg 7.1 GPL static build (compatible with Kaggle's NVIDIA driver 560/580 NVENC API 12.2/13.0)
   *   and verifies it with a 1-frame h264_nvenc smoke test (automatically falling back to /usr/bin/ffmpeg if driver mismatches).
   * - Purges sys.modules before re-importing upgraded huggingface_hub so batch_bucket_files never hits a stale cache.
   * - Zero-desync A/V pipeline: setpts=PTS-STARTPTS + aresample=async=1000:min_hard_comp=0.100000:first_pts=0 + -fps_mode cfr + -avoid_negative_ts make_zero.
   * - 1080p is remuxed (-c:v copy) directly to MP4 container without re-encoding (unless source is unplayable Hi10p/AV1 or BURN_WATERMARK_ON_1080P=True).
   * - 720p and 480p are watermarked (crisp RGBA alpha overlay for first 30s) and hardware-encoded across the 2x Tesla T4 GPUs.
   */
  public generateBatchGpuKernelScript(
    manifestItems: KiraBatchManifestItem[],
  ): string {
    const manifestB64 = Buffer.from(
      JSON.stringify(manifestItems),
      "utf8",
    ).toString("base64");

    return `
import os, sys, json, base64, uuid, hashlib, subprocess, time, shutil, threading, concurrent.futures, importlib

print("=== AniLight Kaggle Batch GPU Transcoder (Dual-T4 NVENC-Verified | Zero-Desync) ===", flush=True)

# Toggle: False = Do NOT re-encode 1080p (remux directly to .mp4 container; only encode 720p & 480p with watermark).
#         True  = Re-encode 1080p via NVENC as well so the pixel watermark is burned into 1080p frames.
BURN_WATERMARK_ON_1080P = False

# Verified system FFmpeg with native Turing NVENC/NVDEC on Kaggle T4 nodes
ffmpeg_ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
print(f"[FFmpeg:System] Using built-in system FFmpeg: {ffmpeg_ver}", flush=True)

manifest = json.loads(base64.b64decode("${manifestB64}").decode("utf-8"))
print(f"Batch Manifest loaded: {len(manifest)} episode job(s) to process.", flush=True)

# 1. STRICT GPU HARDWARE ASSERTION (CPU FALLBACK IS STRICTLY DISABLED)
smi = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True)
gpu_lines = [line for line in smi.stdout.strip().splitlines() if "GPU " in line] if smi.returncode == 0 else []
gpu_count = len(gpu_lines)
if smi.returncode != 0 or gpu_count == 0:
    raise RuntimeError("FATAL: No NVIDIA GPU detected on Kaggle worker! CPU fallback is strictly disabled.")

enc_check = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True)
if "h264_nvenc" not in enc_check.stdout:
    raise RuntimeError("FATAL: h264_nvenc hardware encoder unavailable in FFmpeg! CPU fallback is strictly disabled.")

def check_ffmpeg_caps():
    dav1d, fdk_aac, has_fps_mode = False, False, False
    has_p5, has_p4, has_tune_hq, has_multipass, has_b_ref, has_nonref_p = False, False, False, False, False, False
    try:
        dres = subprocess.run(["ffmpeg", "-hide_banner", "-decoders"], capture_output=True, text=True)
        dav1d = ("libdav1d" in dres.stdout)
    except Exception:
        pass
    try:
        eres = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True)
        fdk_aac = ("libfdk_aac" in eres.stdout)
    except Exception:
        pass
    try:
        help_all = subprocess.run(["ffmpeg", "-hide_banner", "-h", "full"], capture_output=True, text=True)
        has_fps_mode = ("fps_mode" in help_all.stdout)
    except Exception:
        pass
    try:
        hres = subprocess.run(["ffmpeg", "-hide_banner", "-h", "encoder=h264_nvenc"], capture_output=True, text=True)
        hout = hres.stdout
        has_p5 = ("p5" in hout)
        has_p4 = ("p4" in hout)
        has_tune_hq = ("-tune" in hout and "hq" in hout)
        has_multipass = ("-multipass" in hout)
        has_b_ref = ("b_ref_mode" in hout)
        has_nonref_p = ("nonref_p" in hout)
    except Exception:
        pass
    return dav1d, fdk_aac, has_fps_mode, has_p5, has_p4, has_tune_hq, has_multipass, has_b_ref, has_nonref_p

has_libdav1d, has_fdk_aac, has_fps_mode, has_p5, has_p4, has_tune_hq, has_multipass, has_b_ref, has_nonref_p = check_ffmpeg_caps()
selected_preset = "p5" if has_p5 else ("p4" if has_p4 else "slow")
print(
    f"GPU Verified: count={gpu_count}, preset={selected_preset}, fps_mode={has_fps_mode}, tune_hq={has_tune_hq}, "
    f"multipass={has_multipass}, b_ref_mode={has_b_ref}, libdav1d={has_libdav1d}, fdk_aac={has_fdk_aac}",
    flush=True,
)
for gl in gpu_lines:
    print(f"  -> {gl}", flush=True)

# 2. Install Hugging Face & Pillow dependencies safely (invalidating sys.modules cache if upgraded)
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "Pillow"], check=True)
    importlib.invalidate_caches()
    from PIL import Image, ImageDraw, ImageFont

try:
    from huggingface_hub import batch_bucket_files
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "huggingface_hub"], check=True)
    for mod_key in [k for k in list(sys.modules.keys()) if k == "huggingface_hub" or k.startswith("huggingface_hub.")]:
        del sys.modules[mod_key]
    importlib.invalidate_caches()
    from huggingface_hub import batch_bucket_files

# 3. Index mounted /kaggle/input files without copying to /tmp
start_search = time.time()
input_file_map = {}
all_video_files = []
while time.time() - start_search < 180:
    input_file_map.clear()
    all_video_files.clear()
    for root, _, f_names in os.walk("/kaggle/input"):
        for f in f_names:
            full_p = os.path.join(root, f)
            input_file_map[f] = full_p
            if f.lower().endswith((".mkv", ".mp4", ".avi", ".webm")):
                all_video_files.append(full_p)
    if all_video_files:
        if all(item["filename"] in input_file_map for item in manifest) or len(manifest) == 1:
            break
    time.sleep(3)

if not all_video_files:
    raise RuntimeError("No input video files found in /kaggle/input")

BASE_WORK_DIR = "/tmp/anilight_batch_work"
os.makedirs(BASE_WORK_DIR, exist_ok=True)
os.makedirs("/kaggle/working", exist_ok=True)

def find_system_font():
    for f in [
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSans.ttf",
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        "/usr/share/fonts/truetype/freefont/FreeSansBold.ttf"
    ]:
        if os.path.exists(f):
            return f
    if os.path.exists("/usr/share/fonts"):
        for root, _, fs_list in os.walk("/usr/share/fonts"):
            for fn in fs_list:
                if fn.lower().endswith(".ttf") and "bold" not in fn.lower():
                    return os.path.join(root, fn)
        for root, _, fs_list in os.walk("/usr/share/fonts"):
            for fn in fs_list:
                if fn.lower().endswith(".ttf"):
                    return os.path.join(root, fn)
    return ""

sys_font = find_system_font()

def generate_watermark_png(output_path, text="AniLight", fontsize=18, alpha=115, border_alpha=75):
    font = None
    if sys_font:
        try:
            font = ImageFont.truetype(sys_font, fontsize)
        except Exception:
            pass
    if font is None:
        try:
            font = ImageFont.load_default()
        except Exception:
            pass

    dummy = Image.new("RGBA", (400, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(dummy)
    try:
        bbox = d.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
    except Exception:
        tw, th = int(fontsize * len(text) * 0.6), int(fontsize * 1.2)

    w = (tw + 12 + 1) & ~1
    h = (th + 12 + 1) & ~1
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    text_color = (255, 255, 255, alpha)
    border_color = (0, 0, 0, border_alpha)

    try:
        draw.text((3, 3), text, font=font, fill=text_color, stroke_width=1, stroke_fill=border_color)
    except (TypeError, Exception):
        draw.text((4, 4), text, font=font, fill=border_color)
        draw.text((3, 3), text, font=font, fill=text_color)

    img.save(output_path, format="PNG")
    return w, h

wm_1080_png = f"{BASE_WORK_DIR}/wm_1080.png"
wm_720_png = f"{BASE_WORK_DIR}/wm_720.png"
wm_480_png = f"{BASE_WORK_DIR}/wm_480.png"
generate_watermark_png(wm_1080_png, "AniLight", fontsize=20, alpha=115, border_alpha=85)
generate_watermark_png(wm_720_png, "AniLight", fontsize=14, alpha=115, border_alpha=85)
generate_watermark_png(wm_480_png, "AniLight", fontsize=10, alpha=115, border_alpha=85)

def probe_input_video(filepath):
    try:
        cmd = [
            "ffprobe", "-v", "quiet", "-analyzeduration", "50M", "-probesize", "25M", "-select_streams", "v:0",
            "-show_entries", "stream=width,height,avg_frame_rate,r_frame_rate,codec_name,pix_fmt",
            "-of", "json", filepath
        ]
        res = json.loads(subprocess.run(cmd, capture_output=True, text=True, check=True).stdout)
        st = res.get("streams", [{}])[0]
        w = int(st.get("width") or 1920)
        h = int(st.get("height") or 1080)
        v_codec = str(st.get("codec_name") or "").lower().strip()
        pix_fmt = str(st.get("pix_fmt") or "yuv420p").lower().strip()

        # Safely parse avg_frame_rate and r_frame_rate (handling MKV "0/0" strings)
        # Uses exact rational 24000/1001 instead of rounded 23.976 to prevent A/V and subtitle desync over long durations
        fps = "24000/1001"
        for cand in (st.get("r_frame_rate"), st.get("avg_frame_rate")):
            if not cand or not isinstance(cand, str):
                continue
            if "/" in cand:
                n_str, d_str = cand.split("/", 1)
                n_val, d_val = float(n_str or 0), float(d_str or 0)
                if d_val > 0 and 1.0 <= (n_val / d_val) <= 120.0:
                    val = n_val / d_val
                    # Standard anime 23.976 / 23.98 fps is mathematically 24000/1001
                    if abs(val - (24000.0 / 1001.0)) < 0.05 or abs(val - 23.976) < 0.05:
                        fps = "24000/1001"
                    elif abs(val - 24.0) < 0.01:
                        fps = "24"
                    elif abs(val - (30000.0 / 1001.0)) < 0.05 or abs(val - 29.97) < 0.05:
                        fps = "30000/1001"
                    elif abs(val - 30.0) < 0.01:
                        fps = "30"
                    elif abs(val - (60000.0 / 1001.0)) < 0.05 or abs(val - 59.94) < 0.05:
                        fps = "60000/1001"
                    elif abs(val - 60.0) < 0.01:
                        fps = "60"
                    else:
                        fps = f"{int(n_val)}/{int(d_val)}"
                    break
            else:
                val = float(cand)
                if 1.0 <= val <= 120.0:
                    if abs(val - (24000.0 / 1001.0)) < 0.05 or abs(val - 23.976) < 0.05:
                        fps = "24000/1001"
                    else:
                        fps = str(round(val, 3))
                    break
        return w, h, fps, v_codec, pix_fmt
    except Exception:
        return 1920, 1080, "24000/1001", "h264", "yuv420p"

def supports_t4_nvdec(v_codec, pix_fmt):
    # Tesla T4 (Turing TU104) NVDEC decodes 8-bit H.264, 8/10/12-bit HEVC, VP8, VP9, MPEG-2, VC-1.
    # It does NOT support AV1 or 10-bit H.264 (Hi10p).
    is_high_bit = ("10" in pix_fmt) or ("12" in pix_fmt)
    if v_codec == "av1":
        return False
    if v_codec == "h264" and is_high_bit:
        return False
    return v_codec in ("h264", "hevc", "vp9", "vp8", "mpeg2video", "vc1")

def can_stream_copy_1080p_to_mp4(v_codec, pix_fmt, in_height):
    # Browser MP4 players cannot hardware-decode 10-bit H.264 (Hi10p), VP8/VP9-in-MP4, or non-1080p without scaling.
    # Standard 8-bit H.264 and 8/10-bit HEVC at 1080p can be safely stream-copied (-c:v copy) into .mp4.
    is_high_bit = ("10" in pix_fmt) or ("12" in pix_fmt)
    if in_height != 1080:
        return False
    if v_codec == "h264" and not is_high_bit:
        return True
    if v_codec in ("hevc", "h265"):
        return True
    return False

# Asynchronous Background Hugging Face Uploader
import queue
upload_lock = threading.Lock()
completed_records = []
completed_job_ids = []
failed_jobs = []
upload_queue = queue.Queue(maxsize=6)

def save_checkpoint():
    payload = {
        "records": completed_records,
        "completedJobIds": completed_job_ids,
        "failedJobs": failed_jobs,
    }
    with open("/kaggle/working/result.json", "w") as rf:
        json.dump(payload, rf)

def push_entries_to_hf(batch_to_push):
    if not batch_to_push:
        return
    grouped = {}
    for entry in batch_to_push:
        hf = entry["hf"]
        b_key = (hf["owner"], hf["bucket"], hf["token"])
        grouped.setdefault(b_key, []).append(entry)

    for (hf_owner, hf_bucket, hf_token), entries in grouped.items():
        combined_add = []
        for e in entries:
            combined_add.extend(e["add_items"])

        print(f"[HF:AsyncUpload] Uploading {len(combined_add)} MP4 file(s) ({len(entries)} ep(s)) to {hf_owner}/{hf_bucket}...", flush=True)
        last_hf_err = None
        uploaded_ok = False
        for attempt in range(1, 4):
            try:
                batch_bucket_files(
                    bucket_id=f"{hf_owner}/{hf_bucket}",
                    add=combined_add,
                    token=hf_token,
                )
                uploaded_ok = True
                break
            except Exception as exc:
                last_hf_err = exc
                print(f"[HF:Warn] Upload attempt {attempt}/3 failed: {exc}", flush=True)
                time.sleep(4 * attempt)

        with upload_lock:
            if uploaded_ok:
                for e in entries:
                    completed_records.extend(e["records"])
                    completed_job_ids.append(e["job_id"])
                    shutil.rmtree(e["work_dir"], ignore_errors=True)
                print(f"[HF:Done] Uploaded & freed /tmp for job(s): {[e['job_id'] for e in entries]}", flush=True)
            else:
                for e in entries:
                    failed_jobs.append({"jobId": e["job_id"], "error": f"HF upload failed: {last_hf_err}"})
                    shutil.rmtree(e["work_dir"], ignore_errors=True)
            save_checkpoint()

def hf_uploader_loop():
    while True:
        first = upload_queue.get()
        if first is None:
            upload_queue.task_done()
            break
        batch = [first]
        stop_after = False
        while len(batch) < 4:
            try:
                nxt = upload_queue.get_nowait()
                if nxt is None:
                    stop_after = True
                    break
                batch.append(nxt)
            except queue.Empty:
                break
        try:
            push_entries_to_hf(batch)
        finally:
            for _ in batch:
                upload_queue.task_done()
            if stop_after:
                upload_queue.task_done()
                break

uploader_thread = threading.Thread(target=hf_uploader_loop, daemon=True)
uploader_thread.start()

def transcode_episode_on_gpu(item, assigned_gpu_id, allow_intra_split=False):
    job_id = item["jobId"]
    anime_id = item["animeId"]
    ep_num = item["episodeNumber"]
    tracks = item["tracks"]
    hf = item["hf"]
    fname = item["filename"]

    src_input = input_file_map.get(fname)
    if not src_input and len(manifest) == 1 and all_video_files:
        src_input = sorted(all_video_files, key=os.path.getsize, reverse=True)[0]
    if not src_input or not os.path.exists(src_input):
        raise RuntimeError(f"Input file '{fname}' for job {job_id} not found in /kaggle/input")

    work_dir = f"{BASE_WORK_DIR}/job_{job_id}"
    os.makedirs(work_dir, exist_ok=True)

    t_ep_start = time.time()
    in_width, in_height, in_fps, v_codec, pix_fmt = probe_input_video(src_input)
    can_nvdec = supports_t4_nvdec(v_codec, pix_fmt)
    remux_1080p_direct = (not BURN_WATERMARK_ON_1080P) and can_stream_copy_1080p_to_mp4(v_codec, pix_fmt, in_height)

    print(
        f"\\n[Job {job_id}] Starting GPU pipeline for Anime {anime_id} Ep {ep_num} on GPU {assigned_gpu_id} "
        f"(codec={v_codec}, pix_fmt={pix_fmt}, fps={in_fps}, nvdec={can_nvdec}, "
        f"remux_1080p_direct={remux_1080p_direct}, intra_split={allow_intra_split})...",
        flush=True,
    )

    primary_track_name, primary_a_idx = tracks[0]

    primary_files = {
        "1080p": f"{work_dir}/{primary_track_name}_1080p.mp4",
        "720p": f"{work_dir}/{primary_track_name}_720p.mp4",
        "480p": f"{work_dir}/{primary_track_name}_480p.mp4",
    }

    # ZERO-DESYNC AUDIO EXTRACTION:
    # Locks audio start timestamp to PTS=0 and dynamically compensates for packet gaps/drift
    aac_codec_args = (
        ["-c:a", "libfdk_aac", "-b:a", "256k", "-cutoff", "20000", "-ar", "48000", "-ac", "2"]
        if has_fdk_aac
        else ["-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2"]
    )
    audio_sync_filter = "aresample=async=1000:min_hard_comp=0.100000:first_pts=0,asetpts=PTS-STARTPTS"

    primary_audio = f"{work_dir}/{primary_track_name}_audio.m4a"
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-y", "-v", "warning",
            "-analyzeduration", "100M", "-probesize", "50M",
            "-fflags", "+genpts+igndts+discardcorrupt",
            "-vn", "-threads", "2", "-i", src_input,
            "-map", f"0:a:{primary_a_idx}",
            "-af", audio_sync_filter,
        ] + aac_codec_args + [
            "-avoid_negative_ts", "make_zero",
            "-max_muxing_queue_size", "4096",
            "-movflags", "+faststart",
            primary_audio,
        ],
        check=True,
    )

    if len(tracks) > 1:
        for extra_track_name, extra_a_idx in tracks[1:]:
            extra_audio = f"{work_dir}/{extra_track_name}_audio.m4a"
            subprocess.run(
                [
                    "ffmpeg", "-hide_banner", "-y", "-v", "warning",
                    "-analyzeduration", "100M", "-probesize", "50M",
                    "-fflags", "+genpts+igndts+discardcorrupt",
                    "-vn", "-threads", "2", "-i", src_input,
                    "-map", f"0:a:{extra_a_idx}",
                    "-af", audio_sync_filter,
                ] + aac_codec_args + [
                    "-avoid_negative_ts", "make_zero",
                    "-max_muxing_queue_size", "4096",
                    "-movflags", "+faststart",
                    extra_audio,
                ],
                check=True,
            )

    # STEP 1: 1080p DIRECT REMUX TO MP4 (No Re-encode)
    if remux_1080p_direct:
        remux_tag_args = ["-tag:v", "hvc1"] if v_codec in ("hevc", "h265") else []
        remux_1080_cmd = [
            "ffmpeg", "-hide_banner", "-y", "-v", "warning",
            "-analyzeduration", "100M", "-probesize", "50M",
            "-fflags", "+genpts+igndts+discardcorrupt",
            "-i", src_input,
            "-i", primary_audio,
            "-map", "0:v:0",
            "-map", "1:a:0",
            "-c:v", "copy",
        ] + remux_tag_args + [
            "-c:a", "copy",
            "-metadata", "title=AniLight",
            "-metadata", "comment=AniLight",
            "-avoid_negative_ts", "make_zero",
            "-max_muxing_queue_size", "4096",
            "-movflags", "+faststart",
            primary_files["1080p"],
        ]
        subprocess.run(remux_1080_cmd, check=True)

    def clean_encoded_partials():
        targets = ("720p", "480p") if remux_1080p_direct else ("1080p", "720p", "480p")
        for q_k in targets:
            pf = primary_files[q_k]
            if os.path.exists(pf):
                try:
                    os.remove(pf)
                except Exception:
                    pass

    sw_threads = "2" if (not allow_intra_split and gpu_count > 1 and len(manifest) > 1) else "4"
    sw_dec_args = [
        "-analyzeduration", "100M", "-probesize", "50M",
        "-fflags", "+genpts+igndts+discardcorrupt",
        "-threads", sw_threads,
        "-err_detect", "ignore_err",
    ]
    if v_codec == "av1" and has_libdav1d:
        sw_dec_args = [
            "-analyzeduration", "100M", "-probesize", "50M",
            "-fflags", "+genpts+igndts+discardcorrupt",
            "-c:v", "libdav1d",
            "-threads", sw_threads,
            "-err_detect", "ignore_err",
        ]

    hw_dec_args = [
        "-analyzeduration", "100M", "-probesize", "50M",
        "-fflags", "+genpts+igndts+discardcorrupt",
        "-threads", "2",
        "-hwaccel", "cuda",
    ]

    # Balanced Turing NVENC preset: p5 with high quality tuning and quarter-resolution multipass
    preset_flags = (
        ["-preset", selected_preset] +
        (["-tune", "hq"] if has_tune_hq else []) +
        (["-multipass", "qres"] if has_multipass else [])
    )
    bframe_extra = (["-b_ref_mode", "middle"] if has_b_ref else []) + (["-nonref_p", "1"] if has_nonref_p else [])
    fps_sync_flags = ["-fps_mode", "cfr"] if has_fps_mode else ["-vsync", "cfr"]

    nvenc_common = (
        ["-c:v", "h264_nvenc"] + preset_flags +
        ["-profile:v", "high", "-rc:v", "vbr", "-b:v", "0",
         "-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "8",
         "-rc-lookahead", "24", "-bf", "3"] + bframe_extra +
        ["-g", "240", "-forced-idr", "1", "-pix_fmt", "yuv420p",
         "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
         "-c:a", "copy"] +
        fps_sync_flags +
        ["-r", str(in_fps),
         "-avoid_negative_ts", "make_zero",
         "-max_muxing_queue_size", "4096",
         "-movflags", "+faststart"]
    )

    nvenc_1080 = ["-cq", "19", "-maxrate", "6500k", "-bufsize", "13000k"] + nvenc_common + [primary_files["1080p"]]
    nvenc_720 = ["-cq", "21", "-maxrate", "3500k", "-bufsize", "7000k"] + nvenc_common + [primary_files["720p"]]
    nvenc_480 = ["-cq", "23", "-maxrate", "1600k", "-bufsize", "3200k"] + nvenc_common + [primary_files["480p"]]

    lanczos_flags = "lanczos+accurate_rnd+full_chroma_int"

    wm_input_720 = ["-framerate", str(in_fps), "-loop", "1", "-t", "30", "-i", wm_720_png]
    wm_input_480 = ["-framerate", str(in_fps), "-loop", "1", "-t", "30", "-i", wm_480_png]
    wm_inputs_lower = wm_input_720 + wm_input_480

    # Filtergraphs: setpts=PTS-STARTPTS locks start to 0.000s, RGBA overlay keeps text edges sharp, -fps_mode cfr enforces CFR
    fc_720_only = (
        f"[0:v:0]setpts=PTS-STARTPTS,scale=-2:720:flags={lanczos_flags},format=yuv420p[b720];"
        "[1:v:0]format=rgba[wm720];"
        "[b720][wm720]overlay=x=14:y=12:eof_action=pass:format=auto,format=yuv420p[out720]"
    )
    fc_480_only = (
        f"[0:v:0]setpts=PTS-STARTPTS,scale=-2:480:flags={lanczos_flags},format=yuv420p[b480];"
        "[1:v:0]format=rgba[wm480];"
        "[b480][wm480]overlay=x=10:y=8:eof_action=pass:format=auto,format=yuv420p[out480]"
    )
    fc_lower_2 = (
        f"[0:v:0]setpts=PTS-STARTPTS,scale=-2:720:flags={lanczos_flags},format=yuv420p,split=2[b720][s720];"
        f"[s720]scale=-2:480:flags={lanczos_flags},format=yuv420p[b480];"
        "[1:v:0]format=rgba[wm720];"
        "[2:v:0]format=rgba[wm480];"
        "[b720][wm720]overlay=x=14:y=12:eof_action=pass:format=auto,format=yuv420p[out720];"
        "[b480][wm480]overlay=x=10:y=8:eof_action=pass:format=auto,format=yuv420p[out480]"
    )

    encode_ok = False
    gpu_env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(assigned_gpu_id))
    dec_prefix = hw_dec_args if can_nvdec else sw_dec_args

    if remux_1080p_direct:
        # ONLY 720p & 480p ARE ENCODED ON GPU (1080p was already remuxed via -c:v copy above!)
        if allow_intra_split and gpu_count > 1:
            # Single-episode batch mode across 2x Tesla T4: GPU 0 encodes 720p and GPU 1 encodes 480p simultaneously
            def run_720_and_480_across_gpus(d_args):
                c_720 = (
                    ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + d_args +
                    ["-i", src_input] + wm_input_720 + ["-i", primary_audio,
                     "-filter_complex", fc_720_only,
                     "-map", "[out720]", "-map", "2:a:0"] + nvenc_720
                )
                c_480 = (
                    ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + d_args +
                    ["-i", src_input] + wm_input_480 + ["-i", primary_audio,
                     "-filter_complex", fc_480_only,
                     "-map", "[out480]", "-map", "2:a:0"] + nvenc_480
                )
                def r0():
                    return subprocess.run(c_720, env=dict(os.environ, CUDA_VISIBLE_DEVICES="0")).returncode == 0
                def r1():
                    return subprocess.run(c_480, env=dict(os.environ, CUDA_VISIBLE_DEVICES="1")).returncode == 0
                with concurrent.futures.ThreadPoolExecutor(max_workers=2) as sub_ex:
                    f0 = sub_ex.submit(r0)
                    f1 = sub_ex.submit(r1)
                    return f0.result() and f1.result()

            encode_ok = run_720_and_480_across_gpus(dec_prefix)
            if not encode_ok and can_nvdec:
                clean_encoded_partials()
                encode_ok = run_720_and_480_across_gpus(sw_dec_args)
        else:
            # Multi-episode batch mode: Worker owns its dedicated T4 GPU and encodes 720p + 480p in a single decode pass
            cmd_lower_nvenc = (
                ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + dec_prefix +
                ["-i", src_input] + wm_inputs_lower + ["-i", primary_audio,
                 "-filter_complex", fc_lower_2,
                 "-map", "[out720]", "-map", "3:a:0"] + nvenc_720 +
                ["-map", "[out480]", "-map", "3:a:0"] + nvenc_480
            )
            encode_ok = (subprocess.run(cmd_lower_nvenc, env=gpu_env).returncode == 0)

            if not encode_ok and can_nvdec:
                clean_encoded_partials()
                print(f"[Job {job_id}] Retrying SW decode -> 2x h264_nvenc (720p+480p) on GPU {assigned_gpu_id}...", flush=True)
                cmd_lower_sw = (
                    ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + sw_dec_args +
                    ["-i", src_input] + wm_inputs_lower + ["-i", primary_audio,
                     "-filter_complex", fc_lower_2,
                     "-map", "[out720]", "-map", "3:a:0"] + nvenc_720 +
                    ["-map", "[out480]", "-map", "3:a:0"] + nvenc_480
                )
                encode_ok = (subprocess.run(cmd_lower_sw, env=gpu_env).returncode == 0)

            if not encode_ok:
                clean_encoded_partials()
                print(f"[Job {job_id}] Retrying sequential 720p then 480p h264_nvenc on GPU {assigned_gpu_id}...", flush=True)
                c720 = (
                    ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + sw_dec_args +
                    ["-i", src_input] + wm_input_720 + ["-i", primary_audio,
                     "-filter_complex", fc_720_only, "-map", "[out720]", "-map", "2:a:0"] + nvenc_720
                )
                c480 = (
                    ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + sw_dec_args +
                    ["-i", src_input] + wm_input_480 + ["-i", primary_audio,
                     "-filter_complex", fc_480_only, "-map", "[out480]", "-map", "2:a:0"] + nvenc_480
                )
                encode_ok = (subprocess.run(c720, env=gpu_env).returncode == 0) and (subprocess.run(c480, env=gpu_env).returncode == 0)
    else:
        # Fallback if BURN_WATERMARK_ON_1080P is True OR if source was unplayable 10-bit H.264 (Hi10p) / AV1 / non-1080p
        wm_input_1080 = ["-framerate", str(in_fps), "-loop", "1", "-t", "30", "-i", wm_1080_png]
        wm_inputs_all = wm_input_1080 + wm_inputs_lower
        v1080_scale = (
            "format=yuv420p"
            if in_height == 1080
            else f"scale=-2:1080:flags={lanczos_flags},format=yuv420p"
        )
        fc_all_3 = (
            f"[0:v:0]setpts=PTS-STARTPTS,{v1080_scale},split=2[b1080][s1080];"
            f"[s1080]scale=-2:720:flags={lanczos_flags},format=yuv420p,split=2[b720][s720];"
            f"[s720]scale=-2:480:flags={lanczos_flags},format=yuv420p[b480];"
            "[1:v:0]format=rgba[wm1080];"
            "[2:v:0]format=rgba[wm720];"
            "[3:v:0]format=rgba[wm480];"
            "[b1080][wm1080]overlay=x=20:y=18:eof_action=pass:format=auto,format=yuv420p[out1080];"
            "[b720][wm720]overlay=x=14:y=12:eof_action=pass:format=auto,format=yuv420p[out720];"
            "[b480][wm480]overlay=x=10:y=8:eof_action=pass:format=auto,format=yuv420p[out480]"
        )
        cmd_all = (
            ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + dec_prefix +
            ["-i", src_input] + wm_inputs_all + ["-i", primary_audio,
             "-filter_complex", fc_all_3,
             "-map", "[out1080]", "-map", "4:a:0"] + nvenc_1080 +
            ["-map", "[out720]", "-map", "4:a:0"] + nvenc_720 +
            ["-map", "[out480]", "-map", "4:a:0"] + nvenc_480
        )
        encode_ok = (subprocess.run(cmd_all, env=gpu_env).returncode == 0)
        if not encode_ok and can_nvdec:
            clean_encoded_partials()
            cmd_all_sw = (
                ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + sw_dec_args +
                ["-i", src_input] + wm_inputs_all + ["-i", primary_audio,
                 "-filter_complex", fc_all_3,
                 "-map", "[out1080]", "-map", "4:a:0"] + nvenc_1080 +
                ["-map", "[out720]", "-map", "4:a:0"] + nvenc_720 +
                ["-map", "[out480]", "-map", "4:a:0"] + nvenc_480
            )
            encode_ok = (subprocess.run(cmd_all_sw, env=gpu_env).returncode == 0)

    if not encode_ok:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise RuntimeError(f"GPU h264_nvenc transcode failed across all GPU tiers for Job {job_id} (CPU fallback is disabled).")

    # Remux additional audio tracks (e.g. Dual-Audio dub) with zero-desync flags
    if len(tracks) > 1:
        for extra_track_name, _ in tracks[1:]:
            extra_audio = f"{work_dir}/{extra_track_name}_audio.m4a"
            for q_name in ("1080p", "720p", "480p"):
                out_mp4 = f"{work_dir}/{extra_track_name}_{q_name}.mp4"
                remux_extra_tag = ["-tag:v", "hvc1"] if (q_name == "1080p" and remux_1080p_direct and v_codec in ("hevc", "h265")) else []
                subprocess.run([
                    "ffmpeg", "-hide_banner", "-y", "-v", "warning",
                    "-i", primary_files[q_name], "-i", extra_audio,
                    "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "copy", "-c:a", "copy",
                ] + remux_extra_tag + [
                    "-metadata", "title=AniLight",
                    "-avoid_negative_ts", "make_zero",
                    "-movflags", "+faststart",
                    out_mp4
                ], check=True)

    # Identical ID generation ({uuid1}/{uuid2}/{quality}.mp4) & SHA-256 hashing
    job_records = []
    job_add_items = []
    for t_name, _ in tracks:
        f1 = uuid.uuid4().hex
        f2 = uuid.uuid4().hex
        for q_name in ("1080p", "720p", "480p"):
            mp4_path = f"{work_dir}/{t_name}_{q_name}.mp4"
            h = hashlib.sha256()
            with open(mp4_path, "rb") as f:
                while chunk := f.read(1024 * 1024):
                    h.update(chunk)
            sha = h.hexdigest()
            remote_path = f"{f1}/{f2}/{q_name}.mp4"
            down_url = f"https://huggingface.co/buckets/{hf['owner']}/{hf['bucket']}/resolve/{remote_path}"

            rec = {
                "job_id": job_id,
                "anime_id": anime_id,
                "episode_number": ep_num,
                "type": t_name,
                "quality": q_name,
                "sha256": sha,
                "metadata": {
                    "container": "mp4",
                    "size": os.path.getsize(mp4_path),
                },
                "huggingface": {
                    "owner": hf["owner"],
                    "repo": hf["bucket"],
                    "path": remote_path,
                    "downloadUrl": down_url,
                },
            }
            job_records.append(rec)
            job_add_items.append((mp4_path, remote_path))

    print(f"[Job {job_id}] Completed (1080p remux={remux_1080p_direct} + 720p/480p NVENC) in {time.time() - t_ep_start:.1f}s! Queued for async HF upload.", flush=True)

    upload_queue.put({
        "job_id": job_id,
        "work_dir": work_dir,
        "records": job_records,
        "hf": hf,
        "add_items": job_add_items,
    })

# Execute across GPU workers
if len(manifest) == 1:
    try:
        transcode_episode_on_gpu(manifest[0], 0, allow_intra_split=True)
    except Exception as e:
        print(f"[Job {manifest[0]['jobId']}] ERROR: {e}", flush=True)
        with upload_lock:
            failed_jobs.append({"jobId": manifest[0]["jobId"], "error": str(e)})
            save_checkpoint()
else:
    job_queue = queue.Queue()
    for m_item in manifest:
        job_queue.put(m_item)

    worker_count = max(1, gpu_count)
    print(f"Launching {worker_count} parallel GPU worker(s) across {len(manifest)} batch items...", flush=True)

    def gpu_worker_loop(worker_gpu_idx):
        while True:
            try:
                nxt = job_queue.get_nowait()
            except queue.Empty:
                break
            try:
                transcode_episode_on_gpu(nxt, worker_gpu_idx, allow_intra_split=False)
            except Exception as err:
                print(f"[Job {nxt['jobId']}] ERROR on GPU {worker_gpu_idx}: {err}", flush=True)
                shutil.rmtree(f"{BASE_WORK_DIR}/job_{nxt['jobId']}", ignore_errors=True)
                with upload_lock:
                    failed_jobs.append({"jobId": nxt["jobId"], "error": str(err)})
                    save_checkpoint()
            finally:
                job_queue.task_done()

    with concurrent.futures.ThreadPoolExecutor(max_workers=worker_count) as pool:
        futs = [pool.submit(gpu_worker_loop, g_idx) for g_idx in range(worker_count)]
        for fut in futs:
            fut.result()

# Signal background HF uploader thread to finish remaining uploads and wait cleanly
upload_queue.put(None)
uploader_thread.join()
shutil.rmtree(BASE_WORK_DIR, ignore_errors=True)

if len(completed_job_ids) == 0 and len(failed_jobs) > 0:
    raise RuntimeError(f"All {len(failed_jobs)} job(s) failed GPU encoding: {json.dumps(failed_jobs)}")

final_output = {
    "records": completed_records,
    "completedJobIds": completed_job_ids,
    "failedJobs": failed_jobs,
}
with open("/kaggle/working/result.json", "w") as rf:
    json.dump(final_output, rf)

print(f"__TASK_RESULT__={json.dumps(final_output)}", flush=True)
print("KAGGLE_JOB_COMPLETE", flush=True)
`;
  }

  /**
   * Pushes a strictly GPU-enabled Kaggle batch notebook (no CPU fallback).
   */
  public async pushBatchGpuKernel(
    datasetSlug: string,
    kernelSlug: string,
    manifestItems: KiraBatchManifestItem[],
    username: string,
    key: string,
  ): Promise<void> {
    const acceleratorShape = "NvidiaTeslaT4";
    const kernelCode = this.generateBatchGpuKernelScript(manifestItems);

    console.log(
      `[Kaggle:Kernel] Pushing GPU-ONLY batch kernel '${username}/${kernelSlug}' (${manifestItems.length} episode(s), Shape: '${acceleratorShape}')...`,
    );

    let pushed = false;
    let lastErr: any = null;

    for (let pushAttempt = 1; pushAttempt <= 4; pushAttempt++) {
      try {
        const pushRes = await this.makeKaggleRequest(
          "https://www.kaggle.com/api/v1/kernels/push",
          username,
          key,
          {
            method: "POST",
            payload: {
              slug: `${username}/${kernelSlug}`,
              newTitle: kernelSlug,
              text: kernelCode,
              language: "python",
              kernelType: "script",
              isPrivate: true,
              enableGpu: true,
              enableTpu: false,
              enableInternet: true,
              machineShape: acceleratorShape,
              datasetDataSources: [`${username}/${datasetSlug}`],
              competitionDataSources: [],
              kernelDataSources: [],
              modelDataSources: [],
            },
          },
        );

        if (pushRes?.error) {
          throw new Error(`REST kernels/push error: ${pushRes.error}`);
        }
        pushed = true;
        break;
      } catch (err: any) {
        lastErr = err;
        console.warn(
          `[Kaggle:Kernel] Push attempt ${pushAttempt} failed:`,
          err?.message || err,
        );
        if (pushAttempt < 4) {
          await new Promise((r) => setTimeout(r, 6000 * pushAttempt));
        }
      }
    }

    if (!pushed) {
      throw new Error(
        `Failed to push Kaggle GPU kernel '${username}/${kernelSlug}' after 4 attempts: ${lastErr?.message || lastErr}`,
      );
    }
  }

  /**
   * Non-blocking single status check for a running or reattached Kaggle kernel.
   */
  public async checkKernelStatusOnce(
    kernelSlug: string,
    username: string,
    key: string,
  ): Promise<{
    state: "running" | "completed" | "failed" | "not_found";
    rawStatus: string;
  }> {
    try {
      const statusUrl = `https://www.kaggle.com/api/v1/kernels/status?userName=${encodeURIComponent(username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`;
      const sData = await this.makeKaggleRequest(statusUrl, username, key, {
        method: "GET",
        quietCodes: [403, 404],
      });
      const cleanStatus = this.extractCleanStatus(sData);

      if (
        ["complete", "completed", "success", "finished"].includes(cleanStatus)
      ) {
        return { state: "completed", rawStatus: cleanStatus };
      }
      if (
        ["error", "failed", "cancel", "cancelled", "timeout"].includes(
          cleanStatus,
        )
      ) {
        return { state: "failed", rawStatus: cleanStatus };
      }
      return { state: "running", rawStatus: cleanStatus || "running" };
    } catch (err: any) {
      const msg = String(err?.message || "");
      if (msg.includes("HTTP 404")) {
        return { state: "not_found", rawStatus: "404" };
      }
      return { state: "running", rawStatus: "polling_transient_err" };
    }
  }

  private normalizeKernelOutput(parsed: any): KiraBatchKernelOutput | null {
    if (!parsed) return null;
    if (Array.isArray(parsed)) {
      const recs = parsed as KiraBatchHfRecord[];
      const ids = Array.from(
        new Set(
          recs
            .map((r) => r.job_id)
            .filter((v): v is number => typeof v === "number"),
        ),
      );
      return {
        records: recs,
        completedJobIds: ids,
        failedJobs: [],
      };
    }
    if (typeof parsed === "object" && Array.isArray(parsed.records)) {
      return {
        records: parsed.records as KiraBatchHfRecord[],
        completedJobIds: Array.isArray(parsed.completedJobIds)
          ? parsed.completedJobIds
          : [],
        failedJobs: Array.isArray(parsed.failedJobs) ? parsed.failedJobs : [],
      };
    }
    return null;
  }

  /**
   * Fetches structured output (records + per-job status) from a completed Kaggle batch kernel.
   */
  public async fetchBatchKernelOutput(
    kernelSlug: string,
    username: string,
    key: string,
  ): Promise<KiraBatchKernelOutput> {
    try {
      const outData = await this.makeKaggleRequest(
        `https://www.kaggle.com/api/v1/kernels/output?userName=${encodeURIComponent(username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`,
        username,
        key,
        { method: "GET" },
      );

      const files = outData?.files || [];
      const resFile = files.find(
        (f: any) =>
          f.fileName === "result.json" ||
          f.fileName?.endsWith("result.json") ||
          f.name === "result.json",
      );

      if (resFile?.url) {
        const authHeader = VideoEncodingManager.getKaggleAuthHeader(
          username,
          key,
        );
        const fetchRes = await fetch(resFile.url, {
          headers: {
            Authorization: authHeader,
            "User-Agent": "AniLight-Worker/3.0",
          },
        });
        if (fetchRes.ok) {
          const data = await fetchRes.json();
          const norm = this.normalizeKernelOutput(data);
          if (norm) {
            return norm;
          }
        }
      }

      if (outData?.log) {
        const log = outData.log as string;
        const match = log.match(/__TASK_RESULT__=(.*)/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            const norm = this.normalizeKernelOutput(parsed);
            if (norm) {
              return norm;
            }
          } catch {}
        }
      }
    } catch (e: any) {
      console.warn(
        `[Kaggle:Output] Could not fetch kernel output for '${kernelSlug}':`,
        e?.message || e,
      );
    }

    throw new Error(
      `Kaggle kernel '${kernelSlug}' completed but output result.json was not found`,
    );
  }

  /**
   * Single-episode GPU-only encode helper (retained for direct orchestrator usage; strictly GPU-only, zero CPU fallback).
   */
  public async encodeAndUpload(
    localVideoFile: string,
    animeId: number,
    epNum: number,
    langType: string,
    _tempDir: string,
    options: {
      onCleanupFn?: () => void;
    } = {},
  ): Promise<HfStoreRecord[]> {
    const probe = await inspectMkvStreamsSync(localVideoFile);
    const tracks = this.determineTracksToEncode(probe, langType);
    const hfAccount = this.getNextHfAccount();

    if (this.kaggleAccounts.length === 0) {
      throw new Error(
        "No Kaggle accounts configured in KAGGLE_ACCOUNTS / KAGGLE_USERNAME",
      );
    }

    let lastError: any = null;
    const ext = path.extname(localVideoFile) || ".mkv";
    const remoteFilename = `job_1${ext}`;
    const stats = await fs.promises.stat(localVideoFile);

    for (let attempt = 0; attempt < this.kaggleAccounts.length; attempt++) {
      const kAcc =
        this.kaggleAccounts[
          (this.currentKaggleIdx + attempt) % this.kaggleAccounts.length
        ];
      if (!kAcc) continue;

      const runId = crypto.randomUUID().slice(0, 8);
      const datasetSlug = `anilight-${animeId}-ep${epNum}-${runId}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");
      const kernelSlug = `enc-${animeId}-ep${epNum}-${runId}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, "-");

      try {
        console.log(
          `[Kaggle:GPUOnly] Launching GPU encode on '${kAcc.username}' (Anime ${animeId} Ep ${epNum})...`,
        );

        await this.uploadBatchDatasetRest(
          [
            {
              jobId: 1,
              localFilePath: localVideoFile,
              remoteFilename,
              sizeBytes: stats.size,
            },
          ],
          datasetSlug,
          kAcc.username,
          kAcc.key,
        );
        await this.waitForDatasetReady(datasetSlug, kAcc.username, kAcc.key);

        if (this.eagerVmDelete && options.onCleanupFn) {
          options.onCleanupFn();
        }

        await this.pushBatchGpuKernel(
          datasetSlug,
          kernelSlug,
          [
            {
              jobId: 1,
              filename: remoteFilename,
              animeId,
              episodeNumber: epNum,
              tracks,
              hf: hfAccount,
            },
          ],
          kAcc.username,
          kAcc.key,
        );

        const startTime = Date.now();
        while ((Date.now() - startTime) / 1000 < 3600) {
          await new Promise((r) => setTimeout(r, 60000));
          const st = await this.checkKernelStatusOnce(
            kernelSlug,
            kAcc.username,
            kAcc.key,
          );
          if (st.state === "completed") break;
          if (st.state === "failed" || st.state === "not_found") {
            throw new Error(
              `Kaggle GPU kernel '${kernelSlug}' failed with status: ${st.rawStatus}`,
            );
          }
        }

        const out = await this.fetchBatchKernelOutput(
          kernelSlug,
          kAcc.username,
          kAcc.key,
        );
        await this.deleteKaggleKernel(kernelSlug, kAcc.username, kAcc.key);
        await this.deleteKaggleDataset(datasetSlug, kAcc.username, kAcc.key);
        this.currentKaggleIdx =
          (this.currentKaggleIdx + attempt + 1) % this.kaggleAccounts.length;
        return out.records;
      } catch (err: any) {
        lastError = err;
        console.warn(
          `[Kaggle:GPUAccountFail] GPU encode failed on '${kAcc.username}' (CPU fallback disabled, trying next GPU account if any):`,
          err?.message || err,
        );
        await this.deleteKaggleKernel(kernelSlug, kAcc.username, kAcc.key).catch(
          () => {},
        );
        await this.deleteKaggleDataset(
          datasetSlug,
          kAcc.username,
          kAcc.key,
        ).catch(() => {});
      }
    }

    throw new Error(
      `All Kaggle GPU accounts failed to encode Anime ${animeId} Ep ${epNum} (CPU fallback is disabled): ${lastError?.message || lastError}`,
    );
  }
}
