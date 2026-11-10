import fs from "fs";
import {
  DEFAULT_TRANSMISSION_URL,
  DEFAULT_TRANSMISSION_LOCAL,
  TRANSMISSION_USER,
  TRANSMISSION_PASS,
  DEFAULT_DOWNLOAD_DIR,
  TORRENT_DOWNLOAD_TIMEOUT_SEC,
  TorrentDownloadTooSlowException,
} from "../config.js";
import { log } from "../utils/logger.js";

const EXTRA_PUBLIC_ANIME_TRACKERS = [
  "http://nyaa.tracker.wf:7777/announce",
  "udp://open.stealth.si:80/announce",
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://exodus.desync.com:6969/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "http://tracker.anirena.com:80/announce",
  "udp://open.demonii.com:1337/announce",
];

/**
 * Shared process-wide state for multi-file batch torrents so concurrent jobs
 * targeting different episodes of the SAME batch torrent NEVER overwrite each
 * other's `files-wanted` list or delete the torrent while another job is using it.
 */
const activeTorrentWantedFiles = new Map<number, Set<number>>();
const activeTorrentCompletedFiles = new Map<number, Set<number>>();
const activeTorrentRefCount = new Map<number, number>();
let sessionConfigured = false;

export class TransmissionClient {
  private rpcUrl: string;
  private localRpcUrl: string;
  private authHeader: string | null = null;
  private sessionId: string | null = null;
  private activeUrl: string;

  constructor(options: {
    rpcUrl?: string;
    localRpcUrl?: string;
    user?: string;
    password?: string;
  } = {}) {
    this.rpcUrl = options.rpcUrl || DEFAULT_TRANSMISSION_URL;
    this.localRpcUrl = options.localRpcUrl || DEFAULT_TRANSMISSION_LOCAL;
    const user = options.user || TRANSMISSION_USER;
    const pass = options.password || TRANSMISSION_PASS;
    if (user && pass) {
      this.authHeader = "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
    }
    this.activeUrl = this.rpcUrl;
  }

  public getActiveUrl(): string {
    return this.activeUrl;
  }

  /**
   * Enriches any magnet URI with reliable public anime trackers so Transmission
   * finds peers rapidly even if DHT is slow or the source magnet had few trackers.
   */
  public static enrichMagnetUri(magnetUri: string): string {
    if (!magnetUri || !magnetUri.startsWith("magnet:?")) return magnetUri;
    let enriched = magnetUri;
    const lower = magnetUri.toLowerCase();
    for (const tr of EXTRA_PUBLIC_ANIME_TRACKERS) {
      const encoded = encodeURIComponent(tr);
      if (!lower.includes(encoded.toLowerCase()) && !lower.includes(tr.toLowerCase())) {
        enriched += `&tr=${encoded}`;
      }
    }
    return enriched;
  }

  private async callRpc(method: string, args: Record<string, any> = {}): Promise<any> {
    const payload = JSON.stringify({ method, arguments: args });
    const urlsToTry = [this.activeUrl];
    if (this.activeUrl !== this.localRpcUrl) {
      urlsToTry.push(this.localRpcUrl);
    }

    let lastError: any = null;

    for (const url of urlsToTry) {
      for (let retry = 0; retry < 2; retry++) {
        const headers: Record<string, string> = {
          "Content-Type": "application/json",
        };
        if (this.sessionId) {
          headers["X-Transmission-Session-Id"] = this.sessionId;
        }
        if (this.authHeader) {
          headers["Authorization"] = this.authHeader;
        }

        try {
          const res = await fetch(url, {
            method: "POST",
            headers,
            body: payload,
          });

          if (res.status === 409) {
            const newSession = res.headers.get("X-Transmission-Session-Id");
            if (newSession) {
              this.sessionId = newSession;
              continue;
            }
          }

          if (!res.ok) {
            throw new Error(`HTTP ${res.status}: ${res.statusText}`);
          }

          const data = (await res.json()) as any;
          if (data.result === "success") {
            this.activeUrl = url;
            return data.arguments || {};
          }
          throw new Error(`Transmission RPC error: ${data.result}`);
        } catch (err: any) {
          lastError = err;
        }
      }
    }

    throw new Error(
      `Failed to communicate with Transmission at ${urlsToTry.join(", ")}: ${lastError?.message || lastError}`,
    );
  }

  /**
   * Disables Transmission's default 5-torrent download queue bottleneck (`download-queue-enabled: false`)
   * and ensures DHT, PEX, LPD, and uTP peer discovery are enabled on the VM daemon.
   */
  public async ensureOptimalSessionSettings(): Promise<void> {
    if (sessionConfigured) return;
    sessionConfigured = true;
    try {
      await this.callRpc("session-set", {
        "download-queue-enabled": false,
        "download-queue-size": 64,
        "seed-queue-enabled": false,
        "queue-stalled-enabled": true,
        "queue-stalled-minutes": 5,
        "dht-enabled": true,
        "pex-enabled": true,
        "lpd-enabled": true,
        "utp-enabled": true,
        "peer-limit-global": 1000,
        "peer-limit-per-torrent": 120,
      });
      log.info(
        "Transmission",
        "Configured Transmission session: download-queue-enabled=false, DHT/PEX/LPD/uTP=true, peer-limit=1000",
      );
    } catch (err: any) {
      sessionConfigured = false;
      log.warn("Transmission", `Could not update session settings: ${err?.message || err}`);
    }
  }

  public async ping(): Promise<boolean> {
    try {
      await this.callRpc("session-get", {});
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Adds a torrent to Transmission and increments its active reference count so concurrent jobs
   * sharing a multi-file batch torrent coordinate cleanly.
   */
  public async addTorrent(
    magnetOrUrl: string,
    downloadDir = DEFAULT_DOWNLOAD_DIR,
    paused = false,
    fallbackMagnet?: string,
  ): Promise<{ id: number; name: string; isDuplicate?: boolean }> {
    await this.ensureOptimalSessionSettings();

    const target = magnetOrUrl.startsWith("magnet:?")
      ? TransmissionClient.enrichMagnetUri(magnetOrUrl)
      : magnetOrUrl;

    log.info("Transmission", `Adding torrent to ${this.activeUrl}...`);
    let res: any;
    try {
      res = await this.callRpc("torrent-add", {
        filename: target,
        "download-dir": downloadDir,
        paused,
      });
    } catch (err: any) {
      if (fallbackMagnet && fallbackMagnet !== target) {
        const enrichedFallback = TransmissionClient.enrichMagnetUri(fallbackMagnet);
        res = await this.callRpc("torrent-add", {
          filename: enrichedFallback,
          "download-dir": downloadDir,
          paused,
        });
      } else {
        throw err;
      }
    }

    if (res["torrent-added"]) {
      const info = res["torrent-added"];
      const tId = Number(info.id);
      activeTorrentRefCount.set(tId, (activeTorrentRefCount.get(tId) || 0) + 1);
      await this.startTorrentNow(tId).catch(() => {});
      log.success("Transmission", `Torrent added: ${info.name} (ID: ${tId})`);
      return { id: tId, name: info.name, isDuplicate: false };
    }
    if (res["torrent-duplicate"]) {
      const info = res["torrent-duplicate"];
      const tId = Number(info.id);
      activeTorrentRefCount.set(tId, (activeTorrentRefCount.get(tId) || 0) + 1);
      await this.startTorrentNow(tId).catch(() => {});
      log.info("Transmission", `Torrent already present: ${info.name} (ID: ${tId}, activeRefs=${activeTorrentRefCount.get(tId)})`);
      return { id: tId, name: info.name, isDuplicate: true };
    }
    throw new Error(`Unexpected response adding torrent: ${JSON.stringify(res)}`);
  }

  /**
   * Coordinates selective single-episode extraction across concurrent jobs!
   * If Job A wants file 21 and Job B wants file 22 from the SAME batch torrent ID,
   * both [21, 22] are kept in `files-wanted` and all other files (0..N-1) are in `files-unwanted`.
   * This prevents concurrent jobs from overwriting each other's wanted files in an infinite loop!
   */
  public async selectOnlyFiles(
    torrentId: number,
    wantedIndices: number[],
    totalFiles: number,
  ): Promise<void> {
    let activeSet = activeTorrentWantedFiles.get(torrentId);
    if (!activeSet) {
      activeSet = new Set<number>();
      activeTorrentWantedFiles.set(torrentId, activeSet);
    }
    for (const idx of wantedIndices) {
      activeSet.add(idx);
    }

    const completedSet = activeTorrentCompletedFiles.get(torrentId) || new Set<number>();
    const combinedWanted = Array.from(activeSet);
    const unwanted: number[] = [];
    for (let i = 0; i < totalFiles; i++) {
      if (!activeSet.has(i) && !completedSet.has(i)) {
        unwanted.push(i);
      }
    }

    const args: Record<string, any> = { ids: [torrentId] };
    if (combinedWanted.length > 0) {
      args["files-wanted"] = combinedWanted;
      args["priority-high"] = combinedWanted;
    }
    if (unwanted.length > 0) {
      args["files-unwanted"] = unwanted;
      args["priority-low"] = unwanted;
    }

    await this.callRpc("torrent-set", args);
    await this.startTorrentNow(torrentId);
    log.info(
      "Transmission",
      `Selective single-episode extraction on Torrent ${torrentId}: activeWanted=[${combinedWanted.join(",")}] (excluded ${unwanted.length} other batch files)`,
    );
  }

  /**
   * Releases a job's claim on a torrent (and optionally a specific wanted file index).
   * - If other concurrent jobs are still downloading other episodes from this same `torrentId`,
   *   we do NOT delete the torrent out from under them! We only deselect our finished file index.
   * - Once the last job using `torrentId` finishes (`remainingRefs <= 0`), we remove the torrent
   *   and clean up any leftover un-staged data.
   */
  public async releaseTorrentClaim(
    torrentId: number,
    wantedFileIndex?: number,
    deleteLocalData = true,
    fileCompleted = false,
  ): Promise<void> {
    const activeSet = activeTorrentWantedFiles.get(torrentId);
    if (activeSet && wantedFileIndex !== undefined) {
      activeSet.delete(wantedFileIndex);
    }
    if (fileCompleted && wantedFileIndex !== undefined) {
      let comp = activeTorrentCompletedFiles.get(torrentId);
      if (!comp) {
        comp = new Set<number>();
        activeTorrentCompletedFiles.set(torrentId, comp);
      }
      comp.add(wantedFileIndex);
    }

    const prevRefs = activeTorrentRefCount.get(torrentId) || 1;
    const nextRefs = Math.max(0, prevRefs - 1);

    if (nextRefs > 0) {
      activeTorrentRefCount.set(torrentId, nextRefs);
      // Deselect the completed/aborted file so Transmission focuses 100% bandwidth on remaining active jobs' files
      if (wantedFileIndex !== undefined) {
        await this.callRpc("torrent-set", {
          ids: [torrentId],
          "files-unwanted": [wantedFileIndex],
        }).catch(() => {});
      }
      log.info(
        "Transmission",
        `Released file [${wantedFileIndex ?? "all"}] on Torrent ${torrentId}; keeping torrent alive for ${nextRefs} other active job(s).`,
      );
      return;
    }

    activeTorrentRefCount.delete(torrentId);
    activeTorrentWantedFiles.delete(torrentId);
    activeTorrentCompletedFiles.delete(torrentId);
    await this.removeTorrent(torrentId, deleteLocalData);
  }

  public async markFileWanted(
    torrentId: number,
    fileIndex: number,
  ): Promise<void> {
    let activeSet = activeTorrentWantedFiles.get(torrentId);
    if (!activeSet) {
      activeSet = new Set<number>();
      activeTorrentWantedFiles.set(torrentId, activeSet);
    }
    activeSet.add(fileIndex);

    await this.callRpc("torrent-set", {
      ids: [torrentId],
      "files-wanted": Array.from(activeSet),
      "priority-high": [fileIndex],
    });
    await this.startTorrentNow(torrentId);
    log.info("Transmission", `Added file index ${fileIndex} to wanted list for Torrent ID ${torrentId}`);
  }

  /**
   * Uses `torrent-start-now` so Transmission bypasses any internal download queue Wait state
   * (`TR_STATUS_DOWNLOAD_WAIT`) and begins peer connections immediately.
   */
  public async startTorrentNow(torrentId: number): Promise<void> {
    try {
      await this.callRpc("torrent-start-now", { ids: [torrentId] });
    } catch {
      await this.callRpc("torrent-start", { ids: [torrentId] }).catch(() => {});
    }
  }

  public async startTorrent(torrentId: number): Promise<void> {
    await this.startTorrentNow(torrentId);
  }

  public async stopTorrent(torrentId: number): Promise<void> {
    await this.callRpc("torrent-stop", { ids: [torrentId] });
  }

  public async verifyTorrent(torrentId: number): Promise<void> {
    log.warn("Transmission", `Triggering torrent-verify for Torrent ${torrentId}...`);
    await this.callRpc("torrent-verify", { ids: [torrentId] });
  }

  public async reannounceTorrent(torrentId: number): Promise<void> {
    await this.callRpc("torrent-reannounce", { ids: [torrentId] }).catch(() => {});
  }

  public async getStatus(torrentId: number): Promise<any> {
    const res = await this.callRpc("torrent-get", {
      ids: [torrentId],
      fields: [
        "id", "name", "percentDone", "metadataPercentComplete", "status", "files", "fileStats",
        "downloadDir", "isFinished", "errorString", "rateDownload",
        "eta", "peersConnected", "peersSendingToUs", "leftUntilDone", "totalSize",
        "sizeWhenDone",
      ],
    });
    return res.torrents?.[0] || null;
  }

  public async waitForMetadata(torrentId: number, timeoutSec = 65): Promise<any> {
    const start = Date.now();
    let reannounced = false;

    while ((Date.now() - start) / 1000 < timeoutSec) {
      const info = await this.getStatus(torrentId);
      if (info && Array.isArray(info.files) && info.files.length > 0) {
        return info;
      }

      // If stuck in Stopped (0) or Queued to Download (3), force start-now immediately
      if (info && (info.status === 0 || info.status === 3)) {
        await this.startTorrentNow(torrentId).catch(() => {});
      }

      const elapsedSec = (Date.now() - start) / 1000;
      if (!reannounced && elapsedSec > 15) {
        reannounced = true;
        await this.reannounceTorrent(torrentId);
      }

      await new Promise((r) => setTimeout(r, 800));
    }
    throw new Error(`Timed out waiting for magnet metadata on Torrent ${torrentId} (0 peers providing metadata after ${timeoutSec}s)`);
  }

  public async waitForCompletion(
    torrentId: number,
    options: {
      wantedFileIndex?: number;
      expectedDiskPath?: string;
      pollInterval?: number;
      timeoutSec?: number;
    } = {},
  ): Promise<any> {
    const {
      wantedFileIndex,
      expectedDiskPath,
      pollInterval = 2,
      timeoutSec = TORRENT_DOWNLOAD_TIMEOUT_SEC,
    } = options;

    log.info(
      "Transmission",
      `Monitoring download for Torrent ID ${torrentId}${wantedFileIndex !== undefined ? ` [fileIndex=${wantedFileIndex}]` : ""} (Timeout: ${Math.floor(timeoutSec / 60)}m)...`,
    );
    const startTime = Date.now();
    let lastVerifyAttempt = 0;
    let lastByteProgressTime = Date.now();
    let lastRecordedBytes = -1;
    let lastEnforcementTime = 0;

    // Dead-swarm fast-fail thresholds so 0-peer torrents don't block jobs for 30 minutes:
    // - 90 seconds if 0 bytes downloaded and 0 peers sending
    // - 180 seconds if download stalls mid-transfer with 0 peers sending
    const ZERO_START_STALL_TIMEOUT_SEC = 90;
    const MID_TRANSFER_STALL_TIMEOUT_SEC = 180;

    while ((Date.now() - startTime) / 1000 < timeoutSec) {
      const info = await this.getStatus(torrentId);
      if (!info) {
        throw new Error(`Torrent ${torrentId} not found in Transmission`);
      }

      const files = info.files || [];
      const fileStats = info.fileStats || [];
      const rateDownload = info.rateDownload || 0;
      const rateMb = rateDownload / (1024 * 1024);
      const status = info.status || 0;
      const eta = info.eta ?? -1;
      const peersSending = info.peersSendingToUs || 0;
      const peersConnected = info.peersConnected || 0;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      // If Transmission placed the torrent in Stopped (0) or Download-Wait Queue (3), force start-now!
      if (status === 0 || status === 3) {
        await this.startTorrentNow(torrentId).catch(() => {});
      }

      let remainingBytes = 0;
      let percent = 0;
      let targetSz = 1;
      let fDone = 0;

      if (wantedFileIndex !== undefined && wantedFileIndex < files.length) {
        // Make sure OUR wantedFileIndex is marked wanted, and any file NOT claimed by an active job is unwanted.
        // Only check every 10s so we never spam Transmission RPC.
        const nowMs = Date.now();
        if (files.length > 1 && Array.isArray(fileStats) && fileStats.length === files.length && nowMs - lastEnforcementTime > 10_000) {
          const activeSet = activeTorrentWantedFiles.get(torrentId) || new Set([wantedFileIndex]);
          const completedSet = activeTorrentCompletedFiles.get(torrentId) || new Set<number>();
          const ourFileUnwanted = fileStats[wantedFileIndex]?.wanted === false;
          const rogueUnclaimedWanted = fileStats.some(
            (st: any, idx: number) =>
              st?.wanted === true && !activeSet.has(idx) && !completedSet.has(idx),
          );
          if (ourFileUnwanted || rogueUnclaimedWanted) {
            lastEnforcementTime = nowMs;
            await this.selectOnlyFiles(torrentId, [wantedFileIndex], files.length).catch(() => {});
          }
        }

        const fObj = files[wantedFileIndex];
        targetSz = fObj.length || 1;
        fDone = fObj.bytesCompleted || 0;
        remainingBytes = Math.max(0, targetSz - fDone);
        percent = (fDone / targetSz) * 100;
      } else {
        const totalSz = info.sizeWhenDone || info.totalSize || 1;
        percent = (info.percentDone || 0) * 100;
        fDone = Math.floor(totalSz * ((info.percentDone || 0)));
        remainingBytes =
          info.leftUntilDone ||
          Math.max(0, totalSz - fDone);
      }

      if (lastRecordedBytes < 0) {
        lastRecordedBytes = fDone;
        lastByteProgressTime = Date.now();
      } else if (fDone > lastRecordedBytes || rateDownload > 0 || peersSending > 0) {
        lastRecordedBytes = fDone;
        lastByteProgressTime = Date.now();
      }

      const stalledSec = Math.floor((Date.now() - lastByteProgressTime) / 1000);

      // Fast-fail if torrent is stuck at 0 out of 0 peers sending data
      if (fDone === 0 && peersSending === 0 && rateDownload === 0 && stalledSec >= ZERO_START_STALL_TIMEOUT_SEC) {
        throw new TorrentDownloadTooSlowException(
          `Torrent ${torrentId} stalled at 0.0% with 0/${peersConnected} peers sending data for ${stalledSec}s (dead swarm)`,
        );
      }
      if (fDone > 0 && fDone < targetSz && peersSending === 0 && rateDownload === 0 && stalledSec >= MID_TRANSFER_STALL_TIMEOUT_SEC) {
        throw new TorrentDownloadTooSlowException(
          `Torrent ${torrentId} stalled at ${percent.toFixed(1)}% with 0/${peersConnected} peers sending data for ${stalledSec}s`,
        );
      }

      const etaStr =
        eta > 0
          ? `${Math.floor(eta / 60)}m ${eta % 60}s`
          : remainingBytes === 0
            ? "done"
            : "unknown";
      const elapsedStr = `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;

      if (wantedFileIndex !== undefined && wantedFileIndex < files.length) {
        process.stdout.write(
          `  [Transmission] Target: ${percent.toFixed(1)}% | Speed: ${rateMb.toFixed(2)} MB/s | Peers: ${peersSending}/${peersConnected} | ETA: ${etaStr} | Elapsed: ${elapsedStr}\r`,
        );

        if (fDone >= targetSz && targetSz > 0) {
          if (
            expectedDiskPath &&
            (!fs.existsSync(expectedDiskPath) ||
              fs.statSync(expectedDiskPath).size <= 1024)
          ) {
            const now = Date.now();
            if (now - lastVerifyAttempt > 15000) {
              log.warn(
                "Transmission",
                `Transmission reports 100%, but file missing on disk: ${expectedDiskPath}`,
              );
              await this.verifyTorrent(torrentId);
              await this.startTorrentNow(torrentId);
              lastVerifyAttempt = now;
            }
            await new Promise((r) => setTimeout(r, pollInterval * 1000));
            continue;
          }
          // Only stop the whole torrent if no other concurrent job is actively downloading another episode from it
          const remainingActive = activeTorrentWantedFiles.get(torrentId);
          if (!remainingActive || remainingActive.size <= 1) {
            await this.stopTorrent(torrentId).catch(() => {});
          }
          log.success(
            "Transmission",
            `Selective file download complete: ${files[wantedFileIndex]?.name}`,
          );
          return info;
        }
      } else {
        process.stdout.write(
          `  [Transmission] Progress: ${percent.toFixed(1)}% | Speed: ${rateMb.toFixed(2)} MB/s | Peers: ${peersSending}/${peersConnected} | ETA: ${etaStr} | Elapsed: ${elapsedStr}\r`,
        );

        if (info.isFinished || percent >= 100 || status === 6) {
          if (
            expectedDiskPath &&
            (!fs.existsSync(expectedDiskPath) ||
              fs.statSync(expectedDiskPath).size <= 1024)
          ) {
            const now = Date.now();
            if (now - lastVerifyAttempt > 15000) {
              log.warn(
                "Transmission",
                `Transmission reports 100%, but file missing on disk: ${expectedDiskPath}`,
              );
              await this.verifyTorrent(torrentId);
              await this.startTorrentNow(torrentId);
              lastVerifyAttempt = now;
            }
            await new Promise((r) => setTimeout(r, pollInterval * 1000));
            continue;
          }
          log.success("Transmission", `Download complete for ${info.name}`);
          return info;
        }
      }

      await new Promise((r) => setTimeout(r, pollInterval * 1000));
    }

    throw new TorrentDownloadTooSlowException(
      `Torrent download timed out after ${Math.floor(timeoutSec / 60)} minutes (Torrent ID: ${torrentId})`,
    );
  }

  public async listAllTorrents(): Promise<
    {
      id: number;
      name: string;
      totalSize: number;
      sizeWhenDone: number;
      leftUntilDone: number;
      status: number;
      rateDownload: number;
      percentDone: number;
    }[]
  > {
    try {
      const res = await this.callRpc("torrent-get", {
        fields: [
          "id",
          "name",
          "totalSize",
          "sizeWhenDone",
          "leftUntilDone",
          "status",
          "rateDownload",
          "percentDone",
        ],
      });
      return Array.isArray(res?.torrents) ? res.torrents : [];
    } catch {
      return [];
    }
  }

  public async removeTorrent(torrentId: number, deleteLocalData = true): Promise<void> {
    activeTorrentRefCount.delete(torrentId);
    activeTorrentWantedFiles.delete(torrentId);
    activeTorrentCompletedFiles.delete(torrentId);
    log.info("Transmission", `Removing Torrent ${torrentId} (deleteLocalData=${deleteLocalData})...`);
    try {
      await this.callRpc("torrent-remove", {
        ids: [torrentId],
        "delete-local-data": deleteLocalData,
      });
      log.success("Transmission", `Torrent ${torrentId} removed.`);
    } catch (e: any) {
      log.warn("Transmission", `Warning removing torrent ${torrentId}: ${e?.message || e}`);
    }
  }
}
