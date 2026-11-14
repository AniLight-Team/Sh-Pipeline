import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import https from "https";
import { execFile } from "child_process";
import { promisify } from "util";
import type {
  KaggleAccount,
  HuggingFaceAccount,
  MkvStreamProbe,
  KiraBatchUploadItem,
  KiraBatchManifestItem,
  KiraBatchKernelOutput,
  KiraBatchHfRecord,
  VideoResolutionQuality,
} from "./types.js";
import { inspectMkvStreamsSync } from "./subtitles.manager.js";
import { loadAccountsFromEnv, KIRA_VM_FFMPEG_THREADS } from "../config.js";
import { log } from "../utils/logger.js";
import { uploadHfFiles, HF_UPLOAD_FUNCTION } from "./hf-upload.js";

const execFileAsync = promisify(execFile);

export class VideoEncodingManager {
  private kaggleAccounts: KaggleAccount[];
  private hfAccounts: HuggingFaceAccount[];
  private static currentHfIdx = 0;

  constructor(
    options: {
      kaggleAccounts?: KaggleAccount[];
      hfAccounts?: HuggingFaceAccount[];
    } = {},
  ) {
    const envAccs = loadAccountsFromEnv();
    this.kaggleAccounts = options.kaggleAccounts || envAccs.kaggleAccounts;
    this.hfAccounts = options.hfAccounts || envAccs.hfAccounts;
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

  private static kagglePacerChain: Promise<void> = Promise.resolve();
  private static lastKaggleRequestAt = 0;
  private static kaggleRateLimitCooldownUntil = 0;
  private static readonly MIN_KAGGLE_REQUEST_INTERVAL_MS = 1800;

  /**
   * Serializes and paces all Kaggle REST API requests across the entire process
   * and pauses requests globally whenever any endpoint receives HTTP 429 Too Many Requests.
   */
  private static async acquireKaggleRequestSlot(): Promise<void> {
    const next = VideoEncodingManager.kagglePacerChain.then(async () => {
      const now = Date.now();
      if (now < VideoEncodingManager.kaggleRateLimitCooldownUntil) {
        const cooldownWait = VideoEncodingManager.kaggleRateLimitCooldownUntil - now;
        await new Promise((r) => setTimeout(r, cooldownWait));
      }
      const elapsed = Date.now() - VideoEncodingManager.lastKaggleRequestAt;
      if (elapsed < VideoEncodingManager.MIN_KAGGLE_REQUEST_INTERVAL_MS) {
        await new Promise((r) =>
          setTimeout(r, VideoEncodingManager.MIN_KAGGLE_REQUEST_INTERVAL_MS - elapsed),
        );
      }
      VideoEncodingManager.lastKaggleRequestAt = Date.now();
    });
    VideoEncodingManager.kagglePacerChain = next.catch(() => {});
    await next;
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
      maxRetries?: number;
    } = {},
  ): Promise<any> {
    const { method = "GET", payload, quietCodes = [], maxRetries = 6 } = options;
    const authHeader = VideoEncodingManager.getKaggleAuthHeader(username, key);

    const headers: Record<string, string> = {
      Authorization: authHeader,
      "Content-Type": "application/json",
      Accept: "application/json",
      "User-Agent": "AniLight-Worker/3.0",
    };

    const body = payload !== undefined ? JSON.stringify(payload) : undefined;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      await VideoEncodingManager.acquireKaggleRequestSlot();

      let res: Response;
      try {
        res = await fetch(url, { method, headers, body });
      } catch (netErr: any) {
        if (attempt < maxRetries) {
          const waitMs = 5000 * attempt;
          log.warn(
            "Kaggle:HTTP",
            `Network error on ${url} (${netErr?.message || netErr}). Retrying in ${(waitMs / 1000).toFixed(1)}s (${attempt}/${maxRetries})...`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
        throw netErr;
      }

      if (
        (res.status === 401 || res.status === 403) &&
        !headers.Authorization.startsWith("Bearer")
      ) {
        headers.Authorization = `Bearer ${key.trim()}`;
        await VideoEncodingManager.acquireKaggleRequestSlot();
        res = await fetch(url, { method, headers, body });
      } else if (
        (res.status === 401 || res.status === 403) &&
        headers.Authorization.startsWith("Bearer")
      ) {
        headers.Authorization =
          "Basic " +
          Buffer.from(`${username}:${key.trim()}`).toString("base64");
        await VideoEncodingManager.acquireKaggleRequestSlot();
        res = await fetch(url, { method, headers, body });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        const lowerText = text.toLowerCase();
        const isRateLimit =
          res.status === 429 ||
          (res.status === 403 &&
            (lowerText.includes("too many requests") ||
              lowerText.includes("rate limit") ||
              lowerText.includes("throttl")));
        const isTransientServer = [500, 502, 503, 504, 520, 522, 524].includes(res.status);

        if ((isRateLimit || isTransientServer) && attempt < maxRetries) {
          const retryAfterRaw = res.headers.get("retry-after");
          let retryAfterMs = 0;
          if (retryAfterRaw) {
            const parsedSec = parseInt(retryAfterRaw, 10);
            if (!isNaN(parsedSec) && parsedSec > 0) {
              retryAfterMs = parsedSec * 1000;
            }
          }

          const baseBackoffMs = isRateLimit
            ? Math.min(180_000, Math.round(15_000 * Math.pow(1.85, attempt - 1)))
            : Math.min(60_000, 8_000 * attempt);
          const jitterMs = Math.floor(Math.random() * 4000);
          const waitMs = Math.max(retryAfterMs, baseBackoffMs + jitterMs);

          if (isRateLimit) {
            VideoEncodingManager.kaggleRateLimitCooldownUntil = Math.max(
              VideoEncodingManager.kaggleRateLimitCooldownUntil,
              Date.now() + waitMs,
            );
          }

          log.warn(
            "Kaggle:HTTP",
            `HTTP ${res.status} (${isRateLimit ? "429 Rate-Limit" : "Transient Server"}) on ${url} [user=${username}]. Cooling down & backing off ${(waitMs / 1000).toFixed(1)}s (attempt ${attempt}/${maxRetries})...`,
          );
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }

        if (!quietCodes.includes(res.status)) {
          log.warn(
            "Kaggle:HTTP",
            `HTTP ${res.status} on ${url}: ${text.slice(0, 300)}`,
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

    throw new Error(`Kaggle API exhausted ${maxRetries} retries for ${url}`);
  }

  public getNextHfAccount(): HuggingFaceAccount {
    if (this.hfAccounts.length === 0) {
      throw new Error(
        "No Hugging Face accounts configured in HF_ACCOUNTS or HF_OWNER/BUCKET/TOKEN",
      );
    }
    const acc = this.hfAccounts[VideoEncodingManager.currentHfIdx % this.hfAccounts.length];
    VideoEncodingManager.currentHfIdx = (VideoEncodingManager.currentHfIdx + 1) % this.hfAccounts.length;
    return acc;
  }

  public getHfAccountForTarget(target?: { owner: string; bucket: string }): HuggingFaceAccount {
    if (!target) return this.getNextHfAccount();
    const account = this.hfAccounts.find(a => a.owner === target.owner && a.bucket === target.bucket);
    if (!account) {
      const fallback = this.getNextHfAccount();
      log.warn(
        "HF:Account",
        `Saved Hugging Face target ${target.owner}/${target.bucket} is no longer in HF_ACCOUNTS; dynamically falling back to ${fallback.owner}/${fallback.bucket}.`,
      );
      return fallback;
    }
    return account;
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
      if (
        probe.englishStreamIndex !== null &&
        probe.englishStreamIndex !== undefined &&
        probe.japaneseStreamIndex === probe.englishStreamIndex
      ) {
        return [["dub", probe.englishStreamIndex]];
      }
      return [["sub", jpIdx]];
    }
    if (lType === "dub") {
      return [["dub", probe.englishStreamIndex ?? (isDual ? enIdx : jpIdx)]];
    }
    return [["sub", jpIdx]];
  }

  private async computeFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash("sha256");
      const stream = fs.createReadStream(filePath);
      stream.on("data", (chunk) => hash.update(chunk));
      stream.on("end", () => resolve(hash.digest("hex")));
      stream.on("error", (err) => reject(err));
    });
  }

  /**
   * Uploads local MP4 files directly from the VM to a Hugging Face Storage Bucket
   * using huggingface_hub.batch_bucket_files (auto-provisioning a cached Python venv if needed).
   */
  public async uploadFilesToHfBucket(
    hf: HuggingFaceAccount,
    addItems: [string, string][],
  ): Promise<void> {
    await uploadHfFiles(hf, addItems);
  }

  /**
   * Direct Container & Audio Conversion on the VM (ZERO video re-encoding!).
   * - Copies H.264 video stream losslessly (-c:v copy) into faststart MP4 container.
   * - Copies audio (-c:a copy) if already stereo AAC, or converts ONLY audio (-c:a aac -b:a 192k -ar 48000 -ac 2).
   * - Strictly throttled to KIRA_VM_FFMPEG_THREADS (default 2 threads) and nice priority so VM resources are protected.
   */
  public async remuxAndUploadJobOnVm(params: {
    jobId: number;
    animeId: number;
    episodeNumber: number;
    stagedQualities: Partial<Record<VideoResolutionQuality, string>>;
    tracks: [string, number][];
    hf: HuggingFaceAccount;
    workBaseDir: string;
    onProgress?: () => Promise<void>;
  }): Promise<KiraBatchHfRecord[]> {
    const {
      jobId,
      animeId,
      episodeNumber,
      stagedQualities,
      tracks,
      hf,
      workBaseDir,
      onProgress,
    } = params;

    const sourceIdentity = Object.entries(stagedQualities).sort().map(([q, file]) => {
      const stat = fs.statSync(file!);
      return [q, path.resolve(file!), stat.size, stat.mtimeMs];
    });
    const identity = crypto.createHash("sha256").update(JSON.stringify({
      sourceIdentity, tracks, animeId, episodeNumber, bucket: `${hf.owner}/${hf.bucket}`, version: 1,
    })).digest("hex").slice(0, 20);
    const workDir = path.join(workBaseDir, `vm_remux_${jobId}_${identity}`);
    await fs.promises.mkdir(workDir, { recursive: true });

    const validQualities = (["1080p", "720p", "480p"] as VideoResolutionQuality[]).filter(
      (q) => Boolean(stagedQualities[q] && fs.existsSync(stagedQualities[q]!)),
    );

    if (validQualities.length === 0) {
      await fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
      throw new Error(`Job #${jobId} has no existing staged quality files on disk for VM direct remux`);
    }

    const normalizedTracks: [string, number][] =
      tracks.length > 0
        ? tracks.filter((t) => t[0] === "sub" || t[0] === "dub")
        : [["sub", 0]];

    if (!normalizedTracks.length) throw new Error(`Job #${jobId} has no valid audio tracks`);
    const records: KiraBatchHfRecord[] = [];
    const addItems: [string, string][] = [];
    const startTime = Date.now();
    const checkpointPath = path.join(workDir, "checkpoint.json");
    let cachedRecords: KiraBatchHfRecord[] = [];
    try { const data = JSON.parse(await fs.promises.readFile(checkpointPath, "utf8")); if (Array.isArray(data)) cachedRecords = data; }
    catch {} // An incomplete checkpoint is safe to rebuild.
    const saveCheckpoint = async () => {
      await fs.promises.writeFile(checkpointPath + ".tmp", JSON.stringify(records));
      await fs.promises.rename(checkpointPath + ".tmp", checkpointPath);
    };

    try {
      // Pre-allocate remote folder UUIDs per track ("sub" / "dub")
      const trackRemoteFolders = new Map<string, { f1: string; f2: string }>();
      for (const [tName] of normalizedTracks) {
        trackRemoteFolders.set(tName, {
          f1: crypto.createHash("sha256").update(`${identity}:${tName}`).digest("hex").slice(0, 32),
          f2: crypto.createHash("sha256").update(`${jobId}:${identity}:${tName}`).digest("hex").slice(0, 32),
        });
      }

      for (const qName of validQualities) {
        const inputPath = stagedQualities[qName]!;
        let probe: MkvStreamProbe | null = null;
        try {
          probe = await inspectMkvStreamsSync(inputPath);
        } catch {}

        for (const [trackName, fallbackAudioIdx] of normalizedTracks) {
          let targetAudioIdx = fallbackAudioIdx;
          if (probe) {
            if (trackName === "dub" && probe.englishStreamIndex !== null) {
              targetAudioIdx = probe.englishStreamIndex;
            } else if (trackName === "sub") {
              targetAudioIdx = probe.japaneseStreamIndex ?? fallbackAudioIdx;
            }
          }

          const audioInfo = probe?.classifiedAudio.find((a) => a.audioIndex === targetAudioIdx);
          const isAlreadyStereoAac =
            audioInfo &&
            audioInfo.codec === "aac" &&
            audioInfo.channels > 0 &&
            audioInfo.channels <= 2;

          const outMp4Path = path.join(workDir, `${trackName}_${qName}.mp4`);

          const cached = cachedRecords.find(r => r.type === trackName && r.quality === qName);
          if (cached && fs.existsSync(outMp4Path) && fs.statSync(outMp4Path).size === cached.metadata?.size &&
              await this.computeFileSha256(outMp4Path) === cached.sha256) {
            records.push(cached);
            addItems.push([outMp4Path, cached.huggingface.path]);
            continue;
          }

          const runFfmpegRemux = async (copyAudio: boolean, mapAudioSpec: string) => {
            const audioArgs = copyAudio
              ? ["-c:a", "copy"]
              : ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

            const ffArgs = [
              "-hide_banner",
              "-y",
              "-v",
              "warning",
              "-analyzeduration",
              "50M",
              "-probesize",
              "25M",
              "-fflags",
              "+genpts+igndts",
              "-threads",
              String(KIRA_VM_FFMPEG_THREADS),
              "-i",
              inputPath,
              "-map",
              "0:v:0",
              "-map",
              mapAudioSpec,
              "-sn",
              "-dn",
              "-map_chapters",
              "-1",
              "-c:v",
              "copy",
              ...audioArgs,
              "-metadata",
              "title=AniLight",
              "-metadata",
              "comment=AniLight",
              "-avoid_negative_ts",
              "make_zero",
              "-max_muxing_queue_size",
              "4096",
              "-movflags",
              "+faststart",
              outMp4Path,
            ];

            if (process.platform === "linux") {
              await execFileAsync("nice", ["-n", "10", "ffmpeg", ...ffArgs], {
                timeout: 600_000,
              });
            } else {
              await execFileAsync("ffmpeg", ffArgs, { timeout: 600_000 });
            }
          };

          try {
            await runFfmpegRemux(Boolean(isAlreadyStereoAac), `0:a:${targetAudioIdx}`);
          } catch {
            try {
              await runFfmpegRemux(false, `0:a:${targetAudioIdx}`);
            } catch (error) {
              throw new Error(`Audio track ${targetAudioIdx} (${trackName}) could not be converted: ${String(error)}`);
            }
          }

          if (!fs.existsSync(outMp4Path) || fs.statSync(outMp4Path).size < 10_240) {
            throw new Error(`VM direct remux produced empty MP4 for Job #${jobId} (${trackName} ${qName})`);
          }

          const sha256 = await this.computeFileSha256(outMp4Path);
          const outSize = fs.statSync(outMp4Path).size;
          const folders = trackRemoteFolders.get(trackName)!;
          const remotePath = `${folders.f1}/${folders.f2}/${qName}.mp4`;
          const downloadUrl = `https://huggingface.co/buckets/${hf.owner}/${hf.bucket}/resolve/${remotePath}`;

          records.push({
            job_id: jobId,
            anime_id: animeId,
            episode_number: episodeNumber,
            type: trackName,
            quality: qName,
            sha256,
            metadata: {
              container: "mp4",
              size: outSize,
              watermarked: false,
              remuxedOnVm: true,
              audioMode: isAlreadyStereoAac ? "copy" : "aac_192k",
            },
            huggingface: {
              owner: hf.owner,
              repo: hf.bucket,
              path: remotePath,
              downloadUrl,
            },
          });

          addItems.push([outMp4Path, remotePath]);
          await saveCheckpoint();
          if (onProgress) {
            await onProgress().catch(() => {});
          }
        }
      }

      log.info(
        "VM:Remux",
        `Job #${jobId}: Direct-converted ${addItems.length} MP4 file(s) (${validQualities.join(", ")}) in ${((Date.now() - startTime) / 1000).toFixed(1)}s. Uploading to HF ${hf.owner}/${hf.bucket}...`,
      );

      await this.uploadFilesToHfBucket(hf, addItems);

      log.success(
        "VM:Remux",
        `Job #${jobId}: Uploaded ${addItems.length} direct-remuxed MP4 stream(s) to Hugging Face!`,
      );

      return records;
    } catch (err) {
      // Keep converted files and destinations until DB completion or explicit deletion.
      log.warn("VM:Remux", `Job #${jobId}: retaining checkpoint for retry in ${workDir}`);
      throw err;
    }
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

    log.info(
      "Kaggle:REST",
      `Requesting GCS upload URL for ${remoteFilename} (${(filesize / (1024 * 1024)).toFixed(1)} MB)...`,
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

    for (let gcsAttempt = 1; gcsAttempt <= 3; gcsAttempt++) {
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
        if (gcsAttempt >= 3) throw err;
        log.warn(
          "Kaggle:REST",
          `Retrying GCS upload (${gcsAttempt}/3) for ${remoteFilename} after transient error...`,
        );
        await new Promise((r) => setTimeout(r, 3000 * gcsAttempt));
      }
    }

    return token;
  }

  /**
   * Uploads multiple episode video files into ONE single Kaggle Dataset.
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

    // Ensure any stale dataset with the same slug is removed before creating a fresh one
    await this.deleteKaggleDataset(datasetSlug, username, key).catch(() => {});

    const totalGb = (
      items.reduce((acc, i) => acc + i.sizeBytes, 0) /
      (1024 * 1024 * 1024)
    ).toFixed(2);
    log.info(
      "Kaggle:Dataset",
      `Uploading ${items.length} file(s) (${totalGb} GiB) into dataset '${username}/${datasetSlug}'...`,
    );

    const tokens: { token: string }[] = new Array(items.length);

    // Upload blobs sequentially with gentle pacing so Kaggle's StartBlobUpload endpoint never hits HTTP 429
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      if (idx > 0) {
        await new Promise((r) => setTimeout(r, 1500));
      }
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

    log.info(
      "Kaggle:Dataset",
      `All ${items.length} GCS blobs uploaded. Registering dataset '${username}/${datasetSlug}'...`,
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

    log.success("Kaggle:Dataset", `Dataset '${username}/${datasetSlug}' registered on Kaggle; awaiting indexing...`);
    return true;
  }

  public extractCleanStatus(rawStatus: any): string {
    if (!rawStatus) return "";
    let val = "";
    if (typeof rawStatus === "object") {
      val =
        rawStatus.status ||
        rawStatus.state ||
        rawStatus.kernelWorkerStatus ||
        rawStatus.datasetStatus ||
        rawStatus.raw ||
        "";
    } else {
      val = String(rawStatus);
    }
    let s = val.trim().toLowerCase().replace(/^["']|["']$/g, "");
    if (s.includes(".") && !s.includes(" ")) {
      s = s.split(".").pop() || s;
    }
    s = s
      .replace(/^kernel_worker_status_/, "")
      .replace(/^dataset_status_/, "")
      .replace(/^databundle_status_/, "");
    return s;
  }


  /**
   * Single non-blocking dataset readiness check.
   * Paced to minimize Kaggle API calls: checks primary /datasets/status first and only falls back to /datasets/view if ambiguous.
   */
  public async checkDatasetStatusOnce(
    datasetSlug: string,
    username: string,
    key: string,
    allowListFallback = false,
  ): Promise<{ state: "ready" | "indexing" | "failed"; rawStatus: string }> {
    const datasetIdentifier = `${username}/${datasetSlug}`;
    let cleanStatus = "";
    let httpNote = "";

    try {
      const dsData = await this.makeKaggleRequest(
        `https://www.kaggle.com/api/v1/datasets/status/${datasetIdentifier}`,
        username,
        key,
        {
          method: "GET",
          quietCodes: [403, 404],
        },
      );
      const cand = this.extractCleanStatus(dsData);
      if (cand && !cand.slice(0, 20).includes("error")) {
        cleanStatus = cand;
      } else if (["error", "failed"].includes(cand)) {
        cleanStatus = cand;
      }
    } catch {
      httpNote = "iam_propagating";
    }

    if (["ready", "complete", "completed", "ok"].includes(cleanStatus)) {
      return { state: "ready", rawStatus: cleanStatus };
    }

    // Secondary check: /datasets/view/${username}/${datasetSlug} only when primary status is not yet ready
    if (!cleanStatus || !["ready", "complete", "completed", "ok", "error", "failed"].includes(cleanStatus)) {
      try {
        const viewUrl = `https://www.kaggle.com/api/v1/datasets/view/${datasetIdentifier}`;
        const viewData = await this.makeKaggleRequest(viewUrl, username, key, {
          method: "GET",
          quietCodes: [403, 404],
        });
        if (viewData && (viewData.currentVersionNumber || viewData.id)) {
          const vStatus = this.extractCleanStatus(viewData.status || viewData.datasetStatus || "");
          if (["ready", "complete", "completed", "ok"].includes(vStatus)) {
            cleanStatus = "ready";
          } else if (["error", "failed"].includes(vStatus)) {
            cleanStatus = "failed";
          } else if (!cleanStatus && viewData.currentVersionNumber >= 1 && Number(viewData.totalBytes || 0) > 0) {
            cleanStatus = "ready";
          }
        }
      } catch {}
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
              const itemStatus = this.extractCleanStatus(item.status || "");
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
    timeoutSec = 720,
    onHeartbeat?: () => Promise<void>,
  ): Promise<boolean> {
    log.info(
      "Kaggle:Dataset",
      `Waiting for Kaggle backend to index dataset '${username}/${datasetSlug}' (paced 15s polling)...`,
    );
    const startTime = Date.now();
    await new Promise((r) => setTimeout(r, 8000));

    while ((Date.now() - startTime) / 1000 < timeoutSec) {
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      if (onHeartbeat) {
        await onHeartbeat().catch(() => {});
      }

      const res = await this.checkDatasetStatusOnce(
        datasetSlug,
        username,
        key,
        elapsed >= 45,
      );

      log.info(
        "Kaggle:Dataset",
        `Dataset '${datasetSlug}' status: '${res.rawStatus}' | Elapsed: ${elapsed}s`,
      );

      if (res.state === "ready") {
        // Extra 6s settle buffer so Kaggle NFS mounts propagate to GPU worker nodes
        await new Promise((r) => setTimeout(r, 6000));
        log.success(
          "Kaggle:Dataset",
          `Dataset '${username}/${datasetSlug}' is indexed and READY on Kaggle!`,
        );
        return true;
      }
      if (res.state === "failed") {
        throw new Error(
          `Kaggle dataset '${username}/${datasetSlug}' failed cloud indexing with status: '${res.rawStatus}'`,
        );
      }

      await new Promise((r) => setTimeout(r, 15_000));
    }

    throw new Error(
      `Timed out after ${timeoutSec}s waiting for Kaggle dataset '${username}/${datasetSlug}' to become ready`,
    );
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
          quietCodes: [400, 403, 404],
        },
      );
      log.info("Kaggle:Cleanup", `Cleaned up Kaggle Dataset '${datasetSlug}'.`);
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
   * - ALWAYS encodes all 3 qualities (1080p, 720p, 480p) via hardware h264_nvenc with the "AniLight" RGBA watermark burned in for the first 30s.
   * - Zero-desync A/V pipeline: setpts=PTS-STARTPTS + aresample=async=1000:min_hard_comp=0.100000:first_pts=0 + -fps_mode cfr + -avoid_negative_ts make_zero.
   * - Parallel execution across both Tesla T4 GPUs (intra-episode GPU split for 1-job batch, or parallel worker queue for multi-episode batches).
   * - Resilient /kaggle/input dataset file discovery (exact match, case-insensitive match, or jobId prefix match).
   */
  public generateBatchGpuKernelScript(
    manifestItems: KiraBatchManifestItem[],
  ): string {
    const manifestB64 = Buffer.from(
      JSON.stringify(manifestItems),
      "utf8",
    ).toString("base64");

    return `
import os, sys, json, base64, uuid, hashlib, subprocess, time, shutil, threading, concurrent.futures, importlib, queue

print("=== AniLight Kaggle Batch GPU Transcoder (Dual-T4 NVENC | 1080p + 720p + 480p Watermarked) ===", flush=True)

ffmpeg_ver = subprocess.run(["ffmpeg", "-version"], capture_output=True, text=True).stdout.splitlines()[0]
print(f"[FFmpeg:System] {ffmpeg_ver}", flush=True)

manifest = json.loads(base64.b64decode("${manifestB64}").decode("utf-8"))
print(f"Batch Manifest loaded: {len(manifest)} episode job(s) to encode across all 3 qualities (1080p, 720p, 480p).", flush=True)

# 1. STRICT GPU HARDWARE ASSERTION (CPU FALLBACK IS DISABLED)
smi = subprocess.run(["nvidia-smi", "-L"], capture_output=True, text=True)
gpu_lines = [line for line in smi.stdout.strip().splitlines() if "GPU " in line] if smi.returncode == 0 else []
gpu_count = len(gpu_lines)
if smi.returncode != 0 or gpu_count == 0:
    raise RuntimeError("FATAL: No NVIDIA GPU detected on Kaggle worker! CPU fallback is disabled.")

enc_check = subprocess.run(["ffmpeg", "-hide_banner", "-encoders"], capture_output=True, text=True)
if "h264_nvenc" not in enc_check.stdout:
    raise RuntimeError("FATAL: h264_nvenc hardware encoder unavailable in FFmpeg!")

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
selected_preset = "p4" if has_p4 else ("p5" if has_p5 else "fast")
print(
    f"GPU Verified: count={gpu_count}, preset={selected_preset}, fps_mode={has_fps_mode}, tune_hq={has_tune_hq}, "
    f"multipass={has_multipass}, b_ref_mode={has_b_ref}, libdav1d={has_libdav1d}, fdk_aac={has_fdk_aac}",
    flush=True,
)
for gl in gpu_lines:
    print(f"  -> {gl}", flush=True)

# 2. Ensure Pillow & huggingface_hub are installed and fresh
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "Pillow"], check=True)
    importlib.invalidate_caches()
    from PIL import Image, ImageDraw, ImageFont

try:
    from huggingface_hub import batch_bucket_files, get_bucket_paths_info
except ImportError:
    subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U", "huggingface_hub"], check=True)
    for mod_key in [k for k in list(sys.modules.keys()) if k == "huggingface_hub" or k.startswith("huggingface_hub.")]:
        del sys.modules[mod_key]
    importlib.invalidate_caches()
    from huggingface_hub import batch_bucket_files, get_bucket_paths_info

# 3. Discover mounted dataset files in /kaggle/input (with retry for slow NFS mounts)
start_search = time.time()
input_file_map = {}
all_video_files = []
search_roots = ["/kaggle/input"]
if os.path.exists("/root/.cache/kagglehub"):
    search_roots.append("/root/.cache/kagglehub")

while time.time() - start_search < 240:
    input_file_map.clear()
    all_video_files.clear()
    for s_root in search_roots:
        if not os.path.exists(s_root):
            continue
        for root, _, f_names in os.walk(s_root):
            for f in f_names:
                full_p = os.path.join(root, f)
                input_file_map[f] = full_p
                input_file_map[f.lower()] = full_p
                if f.lower().endswith((".mkv", ".mp4", ".avi", ".webm")):
                    all_video_files.append(full_p)
    if all_video_files:
        if all((item["filename"] in input_file_map or item["filename"].lower() in input_file_map) for item in manifest) or len(all_video_files) >= len(manifest):
            break
    time.sleep(3)

print(f"Discovered {len(all_video_files)} video file(s) in /kaggle/input: {all_video_files}", flush=True)
if not all_video_files:
    try:
        diag = subprocess.run(["find", "/kaggle", "-maxdepth", "4"], capture_output=True, text=True).stdout
        print(f"Diagnostic /kaggle tree:\\n{diag}", flush=True)
    except Exception:
        pass
    raise RuntimeError("No input video files found in /kaggle/input! Ensure dataset was indexed before kernel push.")

def resolve_input_file(item):
    fname = item["filename"]
    job_id = item["jobId"]
    if fname in input_file_map and os.path.exists(input_file_map[fname]):
        return input_file_map[fname]
    if fname.lower() in input_file_map and os.path.exists(input_file_map[fname.lower()]):
        return input_file_map[fname.lower()]
    prefix = f"input_{job_id}".lower()
    for vf in all_video_files:
        if os.path.basename(vf).lower().startswith(prefix):
            return vf
    if len(manifest) == 1 and len(all_video_files) == 1:
        return all_video_files[0]
    raise RuntimeError(f"Input file '{fname}' for job {job_id} not found in /kaggle/input (available: {[os.path.basename(x) for x in all_video_files]})")

BASE_WORK_DIR = "/tmp/anilight_batch_work"
os.makedirs(BASE_WORK_DIR, exist_ok=True)
os.makedirs("/kaggle/working", exist_ok=True)

# 4. Generate Crisp "AniLight" RGBA Watermark PNGs for 1080p, 720p, and 480p
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
                if fn.lower().endswith(".ttf"):
                    return os.path.join(root, fn)
    return ""

sys_font = find_system_font()

def generate_watermark_png(output_path, text="AniLight", fontsize=18, alpha=125, border_alpha=90):
    font = None
    if sys_font:
        try:
            font = ImageFont.truetype(sys_font, fontsize)
        except Exception:
            pass
    if font is None:
        font = ImageFont.load_default()

    dummy = Image.new("RGBA", (400, 120), (0, 0, 0, 0))
    d = ImageDraw.Draw(dummy)
    try:
        bbox = d.textbbox((0, 0), text, font=font)
        tw = bbox[2] - bbox[0]
        th = bbox[3] - bbox[1]
    except Exception:
        tw, th = int(fontsize * len(text) * 0.6), int(fontsize * 1.2)

    w = (tw + 14 + 1) & ~1
    h = (th + 14 + 1) & ~1
    img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    text_color = (255, 255, 255, alpha)
    border_color = (0, 0, 0, border_alpha)

    try:
        draw.text((4, 4), text, font=font, fill=text_color, stroke_width=1, stroke_fill=border_color)
    except Exception:
        draw.text((5, 5), text, font=font, fill=border_color)
        draw.text((4, 4), text, font=font, fill=text_color)

    img.save(output_path, format="PNG")
    return w, h

wm_1080_png = f"{BASE_WORK_DIR}/wm_1080.png"
wm_720_png = f"{BASE_WORK_DIR}/wm_720.png"
wm_480_png = f"{BASE_WORK_DIR}/wm_480.png"
generate_watermark_png(wm_1080_png, "AniLight", fontsize=20, alpha=125, border_alpha=90)
generate_watermark_png(wm_720_png, "AniLight", fontsize=14, alpha=125, border_alpha=90)
generate_watermark_png(wm_480_png, "AniLight", fontsize=10, alpha=125, border_alpha=90)

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

        fps = "24000/1001"
        for cand in (st.get("r_frame_rate"), st.get("avg_frame_rate")):
            if not cand or not isinstance(cand, str):
                continue
            if "/" in cand:
                n_str, d_str = cand.split("/", 1)
                n_val, d_val = float(n_str or 0), float(d_str or 0)
                if d_val > 0 and 1.0 <= (n_val / d_val) <= 120.0:
                    val = n_val / d_val
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
    is_high_bit = ("10" in pix_fmt) or ("12" in pix_fmt)
    if v_codec == "av1":
        return False
    if v_codec == "h264" and is_high_bit:
        return False
    return v_codec in ("h264", "hevc", "vp9", "vp8", "mpeg2video", "vc1")

${HF_UPLOAD_FUNCTION}

# 5. Asynchronous Background Hugging Face Uploader
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
    with open("/kaggle/working/result.json.tmp", "w") as rf:
        json.dump(payload, rf)
    os.replace("/kaggle/working/result.json.tmp", "/kaggle/working/result.json")

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

        print(f"[HF:Upload] Uploading {len(combined_add)} MP4 file(s) ({len(entries)} ep(s)) to {hf_owner}/{hf_bucket}...", flush=True)
        last_hf_err = None
        uploaded_ok = False
        for attempt in range(1, 5):
            try:
                upload_verified(f"{hf_owner}/{hf_bucket}", combined_add, hf_token)
                uploaded_ok = True
                break
            except Exception as exc:
                last_hf_err = exc
                print(f"[HF:Warn] Upload attempt {attempt}/4 failed: {exc}", flush=True)
                time.sleep(5 * attempt)

        with upload_lock:
            if uploaded_ok:
                for e in entries:
                    completed_records.extend(e["records"])
                    if e["job_id"] not in completed_job_ids:
                        completed_job_ids.append(e["job_id"])
                    shutil.rmtree(e["work_dir"], ignore_errors=True)
                print(f"[HF:Done] Uploaded & cleaned /tmp for job(s): {[e['job_id'] for e in entries]}", flush=True)
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

# 6. Core GPU Episode Transcoder (ALWAYS encodes 1080p, 720p, and 480p with AniLight Watermark)
def transcode_episode_on_gpu(item, assigned_gpu_id, allow_intra_split=False):
    job_id = item["jobId"]
    anime_id = item["animeId"]
    ep_num = item["episodeNumber"]
    raw_tracks = item.get("tracks") or [["sub", 0]]
    hf = item["hf"]

    # Normalize tracks so we only ever encode valid audio track names ("sub" / "dub")
    tracks = []
    for t_entry in raw_tracks:
        t_label = str(t_entry[0]).lower()
        t_idx = int(t_entry[1] or 0)
        if t_label in ("sub", "dub"):
            tracks.append([t_label, t_idx])
    if not tracks:
        tracks = [["sub", 0]]

    src_input = resolve_input_file(item)
    work_dir = f"{BASE_WORK_DIR}/job_{job_id}"
    os.makedirs(work_dir, exist_ok=True)

    t_ep_start = time.time()
    in_width, in_height, in_fps, v_codec, pix_fmt = probe_input_video(src_input)
    can_nvdec = supports_t4_nvdec(v_codec, pix_fmt)

    print(
        f"\\n[Job {job_id}] Starting 3-Quality Watermarked GPU encode for Anime {anime_id} Ep {ep_num} on GPU {assigned_gpu_id} "
        f"(codec={v_codec}, pix_fmt={pix_fmt}, fps={in_fps}, nvdec={can_nvdec}, tracks={tracks})...",
        flush=True,
    )

    primary_track_name, primary_a_idx = tracks[0]
    primary_files = {
        "1080p": f"{work_dir}/{primary_track_name}_1080p.mp4",
        "720p": f"{work_dir}/{primary_track_name}_720p.mp4",
        "480p": f"{work_dir}/{primary_track_name}_480p.mp4",
    }

    aac_codec_args = (
        ["-c:a", "libfdk_aac", "-b:a", "256k", "-cutoff", "20000", "-ar", "48000", "-ac", "2"]
        if has_fdk_aac
        else ["-c:a", "aac", "-b:a", "256k", "-ar", "48000", "-ac", "2"]
    )
    audio_sync_filter = "aresample=async=1000:min_hard_comp=0.100000:first_pts=0,asetpts=PTS-STARTPTS"

    # Extract primary audio track (with fallback to 0:a:0 if specific index fails)
    primary_audio = f"{work_dir}/{primary_track_name}_audio.m4a"
    a_cmd = [
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
    ]
    if subprocess.run(a_cmd).returncode != 0:
        a_cmd[a_cmd.index(f"0:a:{primary_a_idx}")] = "0:a:0"
        subprocess.run(a_cmd, check=True)

    # Extract secondary audio tracks (e.g. Dual-Audio dub)
    if len(tracks) > 1:
        for extra_track_name, extra_a_idx in tracks[1:]:
            extra_audio = f"{work_dir}/{extra_track_name}_audio.m4a"
            ea_cmd = [
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
            ]
            if subprocess.run(ea_cmd).returncode != 0:
                ea_cmd[ea_cmd.index(f"0:a:{extra_a_idx}")] = "0:a:0"
                subprocess.run(ea_cmd, check=True)

    def clean_partials(qualities=("1080p", "720p", "480p")):
        for q_k in qualities:
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

    preset_flags = (
        ["-preset", selected_preset] +
        (["-tune", "hq"] if has_tune_hq else [])
    )
    bframe_extra = (["-b_ref_mode", "middle"] if has_b_ref else []) + (["-nonref_p", "1"] if has_nonref_p else [])
    fps_sync_flags = ["-fps_mode", "cfr"] if has_fps_mode else ["-vsync", "cfr"]

    nvenc_common = (
        ["-c:v", "h264_nvenc"] + preset_flags +
        ["-profile:v", "high", "-rc:v", "vbr", "-b:v", "0",
         "-spatial-aq", "1", "-temporal-aq", "1", "-aq-strength", "8",
         "-rc-lookahead", "10", "-bf", "3"] + bframe_extra +
        ["-g", "240", "-forced-idr", "1", "-pix_fmt", "yuv420p",
         "-color_primaries", "bt709", "-color_trc", "bt709", "-colorspace", "bt709",
         "-c:a", "copy",
         "-metadata", "title=AniLight",
         "-metadata", "comment=AniLight"] +
        fps_sync_flags +
        ["-r", str(in_fps),
         "-avoid_negative_ts", "make_zero",
         "-max_muxing_queue_size", "4096",
         "-movflags", "+faststart"]
    )

    nvenc_1080 = ["-cq", "19", "-maxrate", "6500k", "-bufsize", "13000k"] + nvenc_common + [primary_files["1080p"]]
    nvenc_720 = ["-cq", "21", "-maxrate", "3500k", "-bufsize", "7000k"] + nvenc_common + [primary_files["720p"]]
    nvenc_480 = ["-cq", "23", "-maxrate", "1600k", "-bufsize", "3200k"] + nvenc_common + [primary_files["480p"]]

    lanczos_flags = "bicubic"
    v1080_scale = "format=yuv420p" if in_height == 1080 else f"scale=-2:1080:flags={lanczos_flags},format=yuv420p"

    wm_input_1080 = ["-framerate", str(in_fps), "-loop", "1", "-t", "30", "-i", wm_1080_png]
    wm_input_720 = ["-framerate", str(in_fps), "-loop", "1", "-t", "30", "-i", wm_720_png]
    wm_input_480 = ["-framerate", str(in_fps), "-loop", "1", "-t", "30", "-i", wm_480_png]
    wm_inputs_all = wm_input_1080 + wm_input_720 + wm_input_480
    wm_inputs_lower = wm_input_720 + wm_input_480

    fc_1080_only = (
        f"[0:v:0]setpts=PTS-STARTPTS,{v1080_scale}[b1080];"
        "[1:v:0]format=rgba[wm1080];"
        "[b1080][wm1080]overlay=x=20:y=18:enable='between(t,0,30)':eof_action=pass:format=auto,format=yuv420p[out1080]"
    )
    fc_720_only = (
        f"[0:v:0]setpts=PTS-STARTPTS,scale=-2:720:flags={lanczos_flags},format=yuv420p[b720];"
        "[1:v:0]format=rgba[wm720];"
        "[b720][wm720]overlay=x=14:y=12:enable='between(t,0,30)':eof_action=pass:format=auto,format=yuv420p[out720]"
    )
    fc_480_only = (
        f"[0:v:0]setpts=PTS-STARTPTS,scale=-2:480:flags={lanczos_flags},format=yuv420p[b480];"
        "[1:v:0]format=rgba[wm480];"
        "[b480][wm480]overlay=x=10:y=8:enable='between(t,0,30)':eof_action=pass:format=auto,format=yuv420p[out480]"
    )
    fc_lower_2 = (
        f"[0:v:0]setpts=PTS-STARTPTS,scale=-2:720:flags={lanczos_flags},format=yuv420p,split=2[b720][s720];"
        f"[s720]scale=-2:480:flags={lanczos_flags},format=yuv420p[b480];"
        "[1:v:0]format=rgba[wm720];"
        "[2:v:0]format=rgba[wm480];"
        "[b720][wm720]overlay=x=14:y=12:enable='between(t,0,30)':eof_action=pass:format=auto,format=yuv420p[out720];"
        "[b480][wm480]overlay=x=10:y=8:enable='between(t,0,30)':eof_action=pass:format=auto,format=yuv420p[out480]"
    )
    fc_all_3 = (
        f"[0:v:0]setpts=PTS-STARTPTS,{v1080_scale},split=2[b1080][s1080];"
        f"[s1080]scale=-2:720:flags={lanczos_flags},format=yuv420p,split=2[b720][s720];"
        f"[s720]scale=-2:480:flags={lanczos_flags},format=yuv420p[b480];"
        "[1:v:0]format=rgba[wm1080];"
        "[2:v:0]format=rgba[wm720];"
        "[3:v:0]format=rgba[wm480];"
        "[b1080][wm1080]overlay=x=20:y=18:enable='between(t,0,30)':eof_action=pass:format=auto,format=yuv420p[out1080];"
        "[b720][wm720]overlay=x=14:y=12:enable='between(t,0,30)':eof_action=pass:format=auto,format=yuv420p[out720];"
        "[b480][wm480]overlay=x=10:y=8:enable='between(t,0,30)':eof_action=pass:format=auto,format=yuv420p[out480]"
    )

    encode_ok = False
    gpu_env = dict(os.environ, CUDA_VISIBLE_DEVICES=str(assigned_gpu_id))
    dec_prefix = hw_dec_args if can_nvdec else sw_dec_args

    # Mode A: Single-episode batch across 2x Tesla T4 GPUs -> GPU 0 encodes 1080p, GPU 1 encodes 720p + 480p simultaneously
    if allow_intra_split and gpu_count > 1:
        def run_split_across_2_gpus(d_args):
            c_1080 = (
                ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + d_args +
                ["-i", src_input] + wm_input_1080 + ["-i", primary_audio,
                 "-filter_complex", fc_1080_only,
                 "-map", "[out1080]", "-map", "2:a:0"] + nvenc_1080
            )
            c_lower = (
                ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + d_args +
                ["-i", src_input] + wm_inputs_lower + ["-i", primary_audio,
                 "-filter_complex", fc_lower_2,
                 "-map", "[out720]", "-map", "3:a:0"] + nvenc_720 +
                ["-map", "[out480]", "-map", "3:a:0"] + nvenc_480
            )
            with concurrent.futures.ThreadPoolExecutor(max_workers=2) as sub_ex:
                f0 = sub_ex.submit(lambda: subprocess.run(c_1080, env=dict(os.environ, CUDA_VISIBLE_DEVICES="0")).returncode == 0)
                f1 = sub_ex.submit(lambda: subprocess.run(c_lower, env=dict(os.environ, CUDA_VISIBLE_DEVICES="1")).returncode == 0)
                return f0.result() and f1.result()

        encode_ok = run_split_across_2_gpus(dec_prefix)
        if not encode_ok and can_nvdec:
            clean_partials()
            encode_ok = run_split_across_2_gpus(sw_dec_args)

    # Mode B: Multi-episode batch -> Worker encodes 1080p + 720p + 480p on its dedicated T4 GPU
    if not encode_ok:
        clean_partials()
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
            clean_partials()
            print(f"[Job {job_id}] Retrying SW decode -> 3x h264_nvenc (1080p+720p+480p) on GPU {assigned_gpu_id}...", flush=True)
            cmd_all_sw = (
                ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + sw_dec_args +
                ["-i", src_input] + wm_inputs_all + ["-i", primary_audio,
                 "-filter_complex", fc_all_3,
                 "-map", "[out1080]", "-map", "4:a:0"] + nvenc_1080 +
                ["-map", "[out720]", "-map", "4:a:0"] + nvenc_720 +
                ["-map", "[out480]", "-map", "4:a:0"] + nvenc_480
            )
            encode_ok = (subprocess.run(cmd_all_sw, env=gpu_env).returncode == 0)

        # Tier 3 fallback: Sequential per-quality h264_nvenc on GPU (if simultaneous 3-session NVENC hits VRAM limit)
        if not encode_ok:
            clean_partials()
            print(f"[Job {job_id}] Retrying sequential 1080p -> 720p -> 480p h264_nvenc on GPU {assigned_gpu_id}...", flush=True)
            c1080 = (
                ["ffmpeg", "-hide_banner", "-y", "-v", "warning"] + sw_dec_args +
                ["-i", src_input] + wm_input_1080 + ["-i", primary_audio,
                 "-filter_complex", fc_1080_only, "-map", "[out1080]", "-map", "2:a:0"] + nvenc_1080
            )
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
            encode_ok = (
                subprocess.run(c1080, env=gpu_env).returncode == 0 and
                subprocess.run(c720, env=gpu_env).returncode == 0 and
                subprocess.run(c480, env=gpu_env).returncode == 0
            )

    if not encode_ok:
        shutil.rmtree(work_dir, ignore_errors=True)
        raise RuntimeError(f"GPU h264_nvenc transcode failed across all tiers for Job {job_id}.")

    # Remux additional audio tracks (e.g. Dual-Audio dub) into the watermarked 1080p, 720p, 480p video streams
    if len(tracks) > 1:
        for extra_track_name, _ in tracks[1:]:
            extra_audio = f"{work_dir}/{extra_track_name}_audio.m4a"
            for q_name in ("1080p", "720p", "480p"):
                out_mp4 = f"{work_dir}/{extra_track_name}_{q_name}.mp4"
                subprocess.run([
                    "ffmpeg", "-hide_banner", "-y", "-v", "warning",
                    "-i", primary_files[q_name], "-i", extra_audio,
                    "-map", "0:v:0", "-map", "1:a:0",
                    "-c:v", "copy", "-c:a", "copy",
                    "-metadata", "title=AniLight",
                    "-metadata", "comment=AniLight",
                    "-avoid_negative_ts", "make_zero",
                    "-movflags", "+faststart",
                    out_mp4
                ], check=True)

    # Verify all 3 qualities exist and build SHA-256 + HF upload manifest
    job_records = []
    job_add_items = []
    for t_name, _ in tracks:
        f1 = uuid.uuid4().hex
        f2 = uuid.uuid4().hex
        for q_name in ("1080p", "720p", "480p"):
            mp4_path = f"{work_dir}/{t_name}_{q_name}.mp4"
            if not os.path.exists(mp4_path) or os.path.getsize(mp4_path) < 10240:
                raise RuntimeError(f"Encoded output missing or empty for Job {job_id} ({t_name} {q_name})")
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
                    "watermarked": True,
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

    print(f"[Job {job_id}] Encoded all 3 watermarked qualities (1080p, 720p, 480p) in {time.time() - t_ep_start:.1f}s! Queuing HF upload.", flush=True)

    upload_queue.put({
        "job_id": job_id,
        "work_dir": work_dir,
        "records": job_records,
        "hf": hf,
        "add_items": job_add_items,
    })

# 7. Execute across Dual-T4 GPU workers
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

# 8. Wait for HF background uploader thread to finish and write final result.json
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
   * Pushes a strictly GPU-enabled Kaggle batch notebook.
   * Automatically handles dataset IAM propagation delays if Kaggle reports dataset not yet visible.
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

    log.info(
      "Kaggle:Kernel",
      `Pushing GPU-ONLY batch kernel '${username}/${kernelSlug}' (${manifestItems.length} episode(s), Shape: '${acceleratorShape}', Dataset: '${username}/${datasetSlug}')...`,
    );

    let pushed = false;
    let lastErr: any = null;

    for (let pushAttempt = 1; pushAttempt <= 6; pushAttempt++) {
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
        log.success("Kaggle:Kernel", `Kernel '${username}/${kernelSlug}' pushed and queued on Kaggle GPU!`);
        break;
      } catch (err: any) {
        lastErr = err;
        const errMsg = String(err?.message || err);
        log.warn(
          "Kaggle:Kernel",
          `Push attempt ${pushAttempt}/6 failed: ${errMsg}`,
        );
        if (pushAttempt < 6) {
          // If dataset was still propagating on Kaggle IAM, wait for it before next push attempt
          if (errMsg.toLowerCase().includes("dataset") || errMsg.includes("404") || errMsg.includes("400")) {
            await this.waitForDatasetReady(datasetSlug, username, key, 150).catch(() => {});
          }
          await new Promise((r) => setTimeout(r, 14_000 * pushAttempt));
        }
      }
    }

    if (!pushed) {
      throw new Error(
        `Failed to push Kaggle GPU kernel '${username}/${kernelSlug}' after 6 attempts: ${lastErr?.message || lastErr}`,
      );
    }
  }

  /**
   * Helper to download a file URL from Kaggle /api/v1/kernels/output.
   * Crucial: Pre-signed GCS URLs (storage.googleapis.com with X-Goog-Signature) reject requests that include
   * an Authorization header (HTTP 400 InvalidAuthentication). We try without Authorization first for signed URLs.
   */
  private async fetchKaggleOutputFileUrl(
    fileUrl: string,
    username: string,
    key: string,
  ): Promise<Response | null> {
    const authHeader = VideoEncodingManager.getKaggleAuthHeader(username, key);
    const isSignedGcs =
      fileUrl.includes("storage.googleapis.com") ||
      fileUrl.includes("X-Goog-Signature") ||
      fileUrl.includes("Signature=");

    const headerAttempts: Record<string, string>[] = isSignedGcs
      ? [
          { "User-Agent": "AniLight-Worker/3.0" },
          { Authorization: authHeader, "User-Agent": "AniLight-Worker/3.0" },
        ]
      : [
          { Authorization: authHeader, "User-Agent": "AniLight-Worker/3.0" },
          { "User-Agent": "AniLight-Worker/3.0" },
        ];

    for (const headers of headerAttempts) {
      try {
        const res = await fetch(fileUrl, { headers });
        if (res.ok) {
          return res;
        }
      } catch {}
    }
    return null;
  }

  /**
   * Non-blocking single status check for a running or reattached Kaggle kernel.
   * Accurately detects Kaggle errors, cancellations, failureMessages, and deleted/missing kernels
   * so jobs never remain stuck in 'encoding' when Kaggle errors out.
   */
  public async checkKernelStatusOnce(
    kernelSlug: string,
    username: string,
    key: string,
  ): Promise<{
    state: "running" | "completed" | "failed" | "not_found";
    rawStatus: string;
    failureMessage?: string;
  }> {
    const statusUrls = [
      `https://www.kaggle.com/api/v1/kernels/status?userName=${encodeURIComponent(username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`,
      `https://api.kaggle.com/v1/kernels/status?userName=${encodeURIComponent(username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`,
    ];

    let lastErrMsg = "";
    for (const statusUrl of statusUrls) {
      try {
        const sData = await this.makeKaggleRequest(statusUrl, username, key, {
          method: "GET",
          quietCodes: [400, 403, 404],
          maxRetries: 3,
        });
        const cleanStatus = this.extractCleanStatus(sData);
        const failureMsg =
          sData?.failureMessage ||
          sData?.failure_message ||
          sData?.error ||
          undefined;

        if (
          cleanStatus.includes("error") ||
          cleanStatus.includes("fail") ||
          cleanStatus.includes("cancel") ||
          cleanStatus.includes("timeout") ||
          cleanStatus.includes("killed") ||
          (typeof failureMsg === "string" && failureMsg.trim().length > 0 && !cleanStatus.includes("running") && !cleanStatus.includes("queued"))
        ) {
          return {
            state: "failed",
            rawStatus: cleanStatus || "error",
            failureMessage: typeof failureMsg === "string" ? failureMsg.trim() : undefined,
          };
        }

        if (
          ["complete", "completed", "success", "finished"].includes(cleanStatus) ||
          cleanStatus.includes("complete")
        ) {
          return { state: "completed", rawStatus: cleanStatus || "complete" };
        }

        return { state: "running", rawStatus: cleanStatus || "running" };
      } catch (err: any) {
        lastErrMsg = String(err?.message || err);
      }
    }

    // Fallback: Check user's kernel list to verify if kernel errored, completed, or was deleted on Kaggle
    try {
      const userKernels = await this.listUserKernels(username, key, 30);
      const matched = userKernels.find((k: any) => {
        const ref = String(k?.ref || k?.slug || k?.title || "").toLowerCase();
        return ref.includes(kernelSlug.toLowerCase());
      });
      if (matched) {
        const kStat = this.extractCleanStatus(matched.status || matched.lastRunStatus || "");
        if (kStat.includes("error") || kStat.includes("fail") || kStat.includes("cancel")) {
          return {
            state: "failed",
            rawStatus: kStat,
            failureMessage: matched.failureMessage || matched.error || undefined,
          };
        }
        if (kStat.includes("complete") || kStat === "success") {
          return { state: "completed", rawStatus: kStat };
        }
        if (kStat) {
          return { state: "running", rawStatus: kStat };
        }
      }
    } catch {}

    if (
      lastErrMsg.includes("HTTP 404") ||
      lastErrMsg.includes("HTTP 400") ||
      lastErrMsg.toLowerCase().includes("not found")
    ) {
      return {
        state: "not_found",
        rawStatus: "404_not_found",
        failureMessage: lastErrMsg.slice(0, 240),
      };
    }

    if (lastErrMsg.includes("HTTP 401") || lastErrMsg.includes("HTTP 403")) {
      return {
        state: "failed",
        rawStatus: "auth_or_permission_error",
        failureMessage: lastErrMsg.slice(0, 240),
      };
    }

    return { state: "running", rawStatus: "polling_transient_err" };
  }

  /**
   * Retrieves the tail of the Kaggle kernel log when a kernel fails so the exact Python/FFmpeg error is surfaced.
   * Supports both inline `outData.log` and signed GCS `.log` file URLs in `outData.files`.
   */
  public async fetchKernelErrorSnippet(
    kernelSlug: string,
    username: string,
    key: string,
  ): Promise<string> {
    try {
      const outData = await this.makeKaggleRequest(
        `https://www.kaggle.com/api/v1/kernels/output?userName=${encodeURIComponent(username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`,
        username,
        key,
        { method: "GET", quietCodes: [400, 403, 404], maxRetries: 2 },
      );

      let logText = "";
      if (outData?.log && typeof outData.log === "string") {
        logText = outData.log;
      } else if (Array.isArray(outData?.files)) {
        const logFile = outData.files.find(
          (f: any) =>
            String(f?.fileName || f?.name || "")
              .toLowerCase()
              .endsWith(".log"),
        );
        if (logFile?.url) {
          const logRes = await this.fetchKaggleOutputFileUrl(logFile.url, username, key);
          if (logRes) {
            logText = await logRes.text().catch(() => "");
          }
        }
      }

      if (logText && logText.trim()) {
        const lines = logText
          .trim()
          .split(/\r?\n/)
          .map((l) => l.trim())
          .filter(Boolean);
        return lines.slice(-15).join(" | ").slice(-700);
      }
    } catch {}
    return "";
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
   * Handles both GCS signed URLs for `result.json` / `.log` files and inline `outData.log`.
   */
  public async fetchBatchKernelOutput(
    kernelSlug: string,
    username: string,
    key: string,
  ): Promise<KiraBatchKernelOutput> {
    let lastLogTail = "";
    try {
      const outData = await this.makeKaggleRequest(
        `https://www.kaggle.com/api/v1/kernels/output?userName=${encodeURIComponent(username)}&kernelSlug=${encodeURIComponent(kernelSlug)}`,
        username,
        key,
        { method: "GET" },
      );

      const files = Array.isArray(outData?.files) ? outData.files : [];
      const resFile = files.find(
        (f: any) =>
          f.fileName === "result.json" ||
          f.fileName?.endsWith("result.json") ||
          f.name === "result.json",
      );

      if (resFile?.url) {
        const fetchRes = await this.fetchKaggleOutputFileUrl(
          resFile.url,
          username,
          key,
        );
        if (fetchRes) {
          const data = await fetchRes.json().catch(() => null);
          const norm = this.normalizeKernelOutput(data);
          if (norm) {
            return norm;
          }
        }
      }

      // Check inline log OR downloadable .log file in outData.files for __TASK_RESULT__
      let logStr = typeof outData?.log === "string" ? outData.log : "";
      if (!logStr.includes("__TASK_RESULT__=")) {
        const logFile = files.find((f: any) =>
          String(f?.fileName || f?.name || "")
            .toLowerCase()
            .endsWith(".log"),
        );
        if (logFile?.url) {
          const logRes = await this.fetchKaggleOutputFileUrl(
            logFile.url,
            username,
            key,
          );
          if (logRes) {
            logStr = await logRes.text().catch(() => logStr);
          }
        }
      }

      if (logStr) {
        const match = logStr.match(/__TASK_RESULT__=(.*)/);
        if (match) {
          try {
            const parsed = JSON.parse(match[1]);
            const norm = this.normalizeKernelOutput(parsed);
            if (norm) {
              return norm;
            }
          } catch {}
        }
        const lines = logStr
          .trim()
          .split(/\r?\n/)
          .map((l: string) => l.trim())
          .filter(Boolean);
        lastLogTail = lines.slice(-12).join(" | ").slice(-500);
      }
    } catch (e: any) {
      log.warn(
        "Kaggle:Output",
        `Could not fetch kernel output for '${kernelSlug}': ${e?.message || e}`,
      );
      lastLogTail = e?.message || String(e);
    }

    throw new Error(
      `Kaggle kernel '${kernelSlug}' completed without result.json${lastLogTail ? ` — Log tail: ${lastLogTail}` : ""}`,
    );
  }
}

