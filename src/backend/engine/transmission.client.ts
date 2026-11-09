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

  public async ping(): Promise<boolean> {
    try {
      await this.callRpc("session-get", {});
      return true;
    } catch {
      return false;
    }
  }

  public async addTorrent(
    magnetOrUrl: string,
    downloadDir = DEFAULT_DOWNLOAD_DIR,
    paused = false,
  ): Promise<{ id: number; name: string }> {
    log.info("Transmission", `Adding torrent to ${this.activeUrl}...`);
    const res = await this.callRpc("torrent-add", {
      filename: magnetOrUrl,
      "download-dir": downloadDir,
      paused,
    });

    if (res["torrent-added"]) {
      const info = res["torrent-added"];
      log.success("Transmission", `Torrent added: ${info.name} (ID: ${info.id})`);
      return info;
    }
    if (res["torrent-duplicate"]) {
      const info = res["torrent-duplicate"];
      log.info("Transmission", `Torrent already present: ${info.name} (ID: ${info.id})`);
      return info;
    }
    throw new Error(`Unexpected response adding torrent: ${JSON.stringify(res)}`);
  }

  public async selectOnlyFiles(
    torrentId: number,
    wantedIndices: number[],
    totalFiles: number,
  ): Promise<void> {
    const wantedSet = new Set(wantedIndices);
    const unwanted: number[] = [];
    for (let i = 0; i < totalFiles; i++) {
      if (!wantedSet.has(i)) unwanted.push(i);
    }

    const args: Record<string, any> = { ids: [torrentId] };
    if (wantedIndices.length > 0) args["files-wanted"] = Array.from(wantedSet);
    if (unwanted.length > 0) args["files-unwanted"] = unwanted;

    await this.callRpc("torrent-set", args);
    await this.startTorrent(torrentId);
    log.info(
      "Transmission",
      `Selective file download: wanted=[${Array.from(wantedSet)}] (skipped ${unwanted.length} other files)`,
    );
  }

  public async markFileWanted(
    torrentId: number,
    fileIndex: number,
  ): Promise<void> {
    await this.callRpc("torrent-set", {
      ids: [torrentId],
      "files-wanted": [fileIndex],
    });
    await this.startTorrent(torrentId);
    log.info("Transmission", `Added file index ${fileIndex} to wanted list for Torrent ID ${torrentId}`);
  }

  public async startTorrent(torrentId: number): Promise<void> {
    await this.callRpc("torrent-start", { ids: [torrentId] });
  }

  public async stopTorrent(torrentId: number): Promise<void> {
    await this.callRpc("torrent-stop", { ids: [torrentId] });
  }

  public async verifyTorrent(torrentId: number): Promise<void> {
    log.warn("Transmission", `Triggering torrent-verify for Torrent ${torrentId}...`);
    await this.callRpc("torrent-verify", { ids: [torrentId] });
  }

  public async getStatus(torrentId: number): Promise<any> {
    const res = await this.callRpc("torrent-get", {
      ids: [torrentId],
      fields: [
        "id", "name", "percentDone", "status", "files", "fileStats",
        "downloadDir", "isFinished", "errorString", "rateDownload",
        "eta", "peersConnected", "peersSendingToUs", "leftUntilDone", "totalSize",
        "sizeWhenDone",
      ],
    });
    return res.torrents?.[0] || null;
  }

  public async waitForMetadata(torrentId: number, timeoutSec = 180): Promise<any> {
    const start = Date.now();
    while ((Date.now() - start) / 1000 < timeoutSec) {
      const info = await this.getStatus(torrentId);
      if (info && Array.isArray(info.files) && info.files.length > 0) {
        return info;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Timed out waiting for magnet metadata on Torrent ${torrentId}`);
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
      pollInterval = 5,
      timeoutSec = TORRENT_DOWNLOAD_TIMEOUT_SEC,
    } = options;

    log.info(
      "Transmission",
      `Monitoring download for Torrent ID ${torrentId} (Timeout: ${Math.floor(timeoutSec / 60)}m)...`,
    );
    const startTime = Date.now();
    let lastVerifyAttempt = 0;

    while ((Date.now() - startTime) / 1000 < timeoutSec) {
      const info = await this.getStatus(torrentId);
      if (!info) {
        throw new Error(`Torrent ${torrentId} not found in Transmission`);
      }

      const files = info.files || [];
      const rateDownload = info.rateDownload || 0;
      const rateMb = rateDownload / (1024 * 1024);
      const status = info.status || 0;
      const eta = info.eta ?? -1;
      const peers = info.peersSendingToUs || info.peersConnected || 0;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);

      let remainingBytes = 0;
      let percent = 0;
      let targetSz = 1;
      let fDone = 0;

      if (wantedFileIndex !== undefined && wantedFileIndex < files.length) {
        const fObj = files[wantedFileIndex];
        targetSz = fObj.length || 1;
        fDone = fObj.bytesCompleted || 0;
        remainingBytes = Math.max(0, targetSz - fDone);
        percent = (fDone / targetSz) * 100;
      } else {
        const totalSz = info.sizeWhenDone || info.totalSize || 1;
        percent = (info.percentDone || 0) * 100;
        remainingBytes =
          info.leftUntilDone ||
          Math.max(0, totalSz - Math.floor(totalSz * (percent / 100)));
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
          `  [Transmission] Target: ${percent.toFixed(1)}% | Speed: ${rateMb.toFixed(2)} MB/s | Peers: ${peers} | ETA: ${etaStr} | Elapsed: ${elapsedStr}\r`,
        );

        if (fDone >= targetSz && targetSz > 0) {
          if (
            expectedDiskPath &&
            (!fs.existsSync(expectedDiskPath) ||
              fs.statSync(expectedDiskPath).size <= 1024)
          ) {
            const now = Date.now();
            if (now - lastVerifyAttempt > 20000) {
              log.warn(
                "Transmission",
                `Transmission reports 100%, but file missing on disk: ${expectedDiskPath}`,
              );
              await this.verifyTorrent(torrentId);
              await this.startTorrent(torrentId);
              lastVerifyAttempt = now;
            }
            await new Promise((r) => setTimeout(r, pollInterval * 1000));
            continue;
          }
          log.success(
            "Transmission",
            `Selective file download complete: ${files[wantedFileIndex]?.name}`,
          );
          return info;
        }
      } else {
        process.stdout.write(
          `  [Transmission] Progress: ${percent.toFixed(1)}% | Speed: ${rateMb.toFixed(2)} MB/s | Peers: ${peers} | ETA: ${etaStr} | Elapsed: ${elapsedStr}\r`,
        );

        if (info.isFinished || percent >= 100 || status === 6) {
          if (
            expectedDiskPath &&
            (!fs.existsSync(expectedDiskPath) ||
              fs.statSync(expectedDiskPath).size <= 1024)
          ) {
            const now = Date.now();
            if (now - lastVerifyAttempt > 20000) {
              log.warn(
                "Transmission",
                `Transmission reports 100%, but file missing on disk: ${expectedDiskPath}`,
              );
              await this.verifyTorrent(torrentId);
              await this.startTorrent(torrentId);
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

