import fs from "fs";
import os from "os";
import path from "path";
import dotenv from "dotenv";
import type { HuggingFaceAccount, KaggleAccount } from "./engine/types.js";

dotenv.config();

export class TorrentEntryNotFoundException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TorrentEntryNotFoundException";
  }
}

export class TorrentDownloadTooSlowException extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TorrentDownloadTooSlowException";
  }
}

// ── Service & Networking Configuration ──────────────────────────
export const PORT = parseInt(process.env.PORT || "4050", 10);
export const HOST = process.env.HOST || "0.0.0.0";
export const NODE_ENV = process.env.NODE_ENV || "development";
export const IS_PROD = NODE_ENV === "production";
export const MAIN_BACKEND_URL = (process.env.MAIN_BACKEND_URL || "http://127.0.0.1:4000").replace(/\/+$/, "");
export const INTERNAL_SECRET = process.env.INTERNAL_SECRET || "anilight-pipeline-internal-secret-2026";
export const DATABASE_URL = process.env.DATABASE_URL || "";

// ── Captions Cloudflare R2 Credentials ─────────────────────────
export const CAPTIONS_R2_ACCOUNT_ID = process.env.CAPTIONS_R2_ACCOUNT_ID || "";
export const CAPTIONS_R2_ACCESS_KEY_ID = process.env.CAPTIONS_R2_ACCESS_KEY_ID || "";
export const CAPTIONS_R2_SECRET_ACCESS_KEY = process.env.CAPTIONS_R2_SECRET_ACCESS_KEY || "";
export const CAPTIONS_R2_BUCKET_NAME = process.env.CAPTIONS_R2_BUCKET_NAME || "capthumb";
export const DEFAULT_SUBTITLE_PUBLIC_BASE = (process.env.CAPTIONS_PUBLIC_BASE_URL || "").replace(/\/+$/, "");

// ── Transmission RPC Configuration ─────────────────────────────
export const DEFAULT_TRANSMISSION_URL = process.env.TRANSMISSION_URL || "https://torrent.anilight.live/transmission/rpc";
export const DEFAULT_TRANSMISSION_LOCAL = process.env.TRANSMISSION_LOCAL_URL || "http://127.0.0.1:9091/transmission/rpc";
export const TRANSMISSION_USER = process.env.TRANSMISSION_USER || "";
export const TRANSMISSION_PASS = process.env.TRANSMISSION_PASS || "";
export const DEFAULT_DOWNLOAD_DIR = process.env.DEFAULT_DOWNLOAD_DIR || "/srv/torrents/complete";

// ── Thresholds & Performance Limits ────────────────────────────
export const DEFAULT_MIN_SEEDERS = parseInt(process.env.MIN_SEEDERS || "1", 10);
export const TORRENT_DOWNLOAD_TIMEOUT_SEC = parseInt(process.env.TORRENT_DOWNLOAD_TIMEOUT_SEC || "1800", 10);
export const ALLOW_CAM = (process.env.ALLOW_CAM || "true").toLowerCase() === "true";
export const EAGER_VM_DELETE = (process.env.EAGER_VM_DELETE || "true").toLowerCase() === "true";

// ── Batching, Queue & SSD Storage Guardrails ───────────────────
export const KIRA_BATCH_WINDOW_MIN = Math.max(1, parseInt(process.env.KIRA_BATCH_WINDOW_MIN || "30", 10));
export const KIRA_BATCH_WINDOW_MS = KIRA_BATCH_WINDOW_MIN * 60 * 1000;
export const KIRA_BATCH_MAX_GB = Math.max(1, parseInt(process.env.KIRA_BATCH_MAX_GB || "10", 10));
export const KIRA_BATCH_MAX_BYTES = Math.floor(KIRA_BATCH_MAX_GB * 1_000_000_000);
export const KIRA_BATCH_SAFE_MAX_BYTES = Math.min(98_000_000_000, KIRA_BATCH_MAX_BYTES);
export const KIRA_BATCH_MAX_ITEMS = Math.max(1, parseInt(process.env.KIRA_BATCH_MAX_ITEMS || "10", 10)); // Maximum 10 files per batch
export const KIRA_MAX_STAGING_GB = Math.max(KIRA_BATCH_MAX_GB, parseInt(process.env.KIRA_MAX_STAGING_GB || "60", 10));
export const KIRA_MAX_STAGING_BYTES = Math.floor(KIRA_MAX_STAGING_GB * 1_000_000_000);
export const KIRA_MIN_FREE_SSD_BYTES = Math.floor(Math.max(5, parseInt(process.env.KIRA_MIN_FREE_SSD_GB || "12", 10)) * 1_000_000_000);
export const KIRA_PER_DOWNLOAD_RESERVE_BYTES = 1_400_000_000; // 1.4 GB reserve per parallel download
export const KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT = 2; // Kaggle allows 2 concurrent sessions per account

export function getMaxConcurrentBatches(): number {
  const { kaggleAccounts } = loadAccountsFromEnv();
  // Total concurrent tasks limit = total number of kaggle accounts * 2
  return Math.max(1, kaggleAccounts.length * KAGGLE_MAX_NOTEBOOKS_PER_ACCOUNT);
}

// Backward-compatible alias
export const KIRA_MAX_CONCURRENT_BATCHES = getMaxConcurrentBatches();
export const KIRA_MAX_TOTAL_BATCHES = getMaxConcurrentBatches();

let cachedStagingDir: string | null = null;

export function getKiraStagingDir(): string {
  if (cachedStagingDir) return cachedStagingDir;

  const candidates: string[] = [];
  if (process.env.KIRA_STAGING_DIR) {
    candidates.push(process.env.KIRA_STAGING_DIR);
  }
  if (DEFAULT_DOWNLOAD_DIR) {
    candidates.push(path.join(DEFAULT_DOWNLOAD_DIR, ".kira-staging"));
  }
  candidates.push(path.join(os.tmpdir(), "kira-staging"));

  for (const dir of candidates) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      cachedStagingDir = dir;
      return dir;
    } catch {
      // Try fallback
    }
  }

  const fallback = path.join(os.tmpdir(), "kira-staging");
  cachedStagingDir = fallback;
  return fallback;
}

export const BITMAP_SUBTITLE_CODECS = new Set([
  "hdmv_pgs_subtitle",
  "pgssub",
  "dvd_subtitle",
  "dvdsub",
  "dvb_subtitle",
  "dvbsub",
  "xsub",
]);

export function loadAccountsFromEnv(): {
  kaggleAccounts: KaggleAccount[];
  hfAccounts: HuggingFaceAccount[];
} {
  let kaggleAccounts: KaggleAccount[] = [];
  if (process.env.KAGGLE_ACCOUNTS) {
    try {
      kaggleAccounts = JSON.parse(process.env.KAGGLE_ACCOUNTS);
    } catch (e) {
      console.warn("[Config] Failed to parse KAGGLE_ACCOUNTS JSON from ENV:", e);
    }
  } else if (process.env.KAGGLE_USERNAME && (process.env.KAGGLE_KEY || process.env.KAGGLE_API_TOKEN)) {
    kaggleAccounts = [
      {
        username: process.env.KAGGLE_USERNAME,
        key: process.env.KAGGLE_KEY || process.env.KAGGLE_API_TOKEN || "",
      },
    ];
  }

  let hfAccounts: HuggingFaceAccount[] = [];
  if (process.env.HF_ACCOUNTS) {
    try {
      hfAccounts = JSON.parse(process.env.HF_ACCOUNTS);
    } catch (e) {
      console.warn("[Config] Failed to parse HF_ACCOUNTS JSON from ENV:", e);
    }
  } else if (process.env.HF_OWNER && process.env.HF_BUCKET && process.env.HF_TOKEN) {
    hfAccounts = [
      {
        owner: process.env.HF_OWNER,
        bucket: process.env.HF_BUCKET,
        token: process.env.HF_TOKEN,
      },
    ];
  }

  return { kaggleAccounts, hfAccounts };
}

