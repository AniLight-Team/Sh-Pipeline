import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";
import type {
  R2SubtitleRecord,
  PipelineSubtitleTrack,
} from "./types.js";
import {
  CAPTIONS_R2_ACCOUNT_ID,
  CAPTIONS_R2_ACCESS_KEY_ID,
  CAPTIONS_R2_SECRET_ACCESS_KEY,
  CAPTIONS_R2_BUCKET_NAME,
  DEFAULT_SUBTITLE_PUBLIC_BASE,
  BITMAP_SUBTITLE_CODECS,
} from "../config.js";
import { log } from "../utils/logger.js";

const execFileAsync = promisify(execFile);

export interface ClassifiedAudioTrack {
  streamIndex: number;
  audioIndex: number;
  language: string;
  title: string;
  channels: number;
  codec: string;
  isCommentary: boolean;
  isDefault: boolean;
}

export interface ExtractedSubtitleTrack {
  language: string;
  baseLanguage: string;
  role: "dialogue" | "signs" | "sdh";
  label: string;
  filePath: string;
  isDefaultSub: boolean;
  isDefaultDub: boolean;
}

export interface MkvStreamProbe {
  video: any[];
  audio: any[];
  subtitles: any[];
  isDualAudio: boolean;
  classifiedAudio: ClassifiedAudioTrack[];
  japaneseStreamIndex: number;
  englishStreamIndex: number | null;
  videoCodec: string;
  pixelFormat: string;
  width: number;
  height: number;
  isBrowserCompatibleH264: boolean;
}

export function inspectMkvStreamsSync(filepath: string): Promise<MkvStreamProbe> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_streams", "-show_format", filepath],
      (err, stdout, stderr) => {
        if (err) {
          return reject(new Error(`Failed to probe media streams for ${filepath}: ${stderr || err.message}`));
        }
        try {
          const data = JSON.parse(stdout);
          const streams = data.streams || [];

          const videoStreams = streams.filter(
            (s: any) =>
              s.codec_type === "video" &&
              !s.disposition?.attached_pic,
          );
          const audioStreams = streams.filter((s: any) => s.codec_type === "audio");
          const subtitleStreams = streams.filter((s: any) => s.codec_type === "subtitle");

          const primaryVideo = (videoStreams.length > 0
            ? videoStreams
            : streams.filter((s: any) => s.codec_type === "video"))[0] || {};
          const videoCodec = String(primaryVideo.codec_name || "h264").trim().toLowerCase();
          const pixelFormat = String(primaryVideo.pix_fmt || "yuv420p").trim().toLowerCase();
          const width = parseInt(String(primaryVideo.width || "1920"), 10) || 1920;
          const height = parseInt(String(primaryVideo.height || "1080"), 10) || 1080;
          const isHighBit = pixelFormat.includes("10") || pixelFormat.includes("12");
          const isBrowserCompatibleH264 =
            (videoCodec === "h264" || videoCodec === "avc" || videoCodec === "avc1") && !isHighBit;

          const classifiedAudio: ClassifiedAudioTrack[] = [];
          const originalCandidates: number[] = [];
          const englishCandidates: number[] = [];

          const ORIGINAL_LANGS = new Set([
            "jpn", "ja", "japanese", "zho", "chi", "cmn", "zh", "chinese", "kor", "ko", "korean",
          ]);
          const ENGLISH_LANGS = new Set(["eng", "en", "english"]);
          const COMMENTARY_KEYWORDS = ["commentary", "cast", "staff", "director", "audio description"];

          for (let idx = 0; idx < audioStreams.length; idx++) {
            const a = audioStreams[idx];
            const tags = a.tags || {};
            const lang = (tags.language || "und").trim().toLowerCase();
            const title = (tags.title || "").trim().toLowerCase();
            const disposition = a.disposition || {};

            const isCommentary =
              Boolean(disposition.comment) ||
              Boolean(disposition.visual_impaired) ||
              COMMENTARY_KEYWORDS.some((kw) => title.includes(kw));

            const info: ClassifiedAudioTrack = {
              streamIndex: a.index ?? idx,
              audioIndex: idx,
              language: lang,
              title,
              channels: parseInt(a.channels || "2", 10),
              codec: (a.codec_name || "").toLowerCase(),
              isCommentary,
              isDefault: Boolean(disposition.default),
            };
            classifiedAudio.push(info);

            if (isCommentary) continue;

            if (
              ORIGINAL_LANGS.has(lang) ||
              ["japanese", "jpn", "original", "mandarin", "korean"].some((k) => title.includes(k))
            ) {
              originalCandidates.push(idx);
            } else if (
              ENGLISH_LANGS.has(lang) ||
              ["english", "eng", "dub"].some((k) => title.includes(k))
            ) {
              englishCandidates.push(idx);
            }
          }

          let nonCommentary = classifiedAudio.filter((a) => !a.isCommentary).map((a) => a.audioIndex);
          if (nonCommentary.length === 0 && classifiedAudio.length > 0) {
            nonCommentary = [0];
          }

          let japaneseStreamIdx = originalCandidates[0] ?? null;
          let englishStreamIdx = englishCandidates[0] ?? null;

          if (nonCommentary.length >= 2) {
            if (japaneseStreamIdx !== null && englishStreamIdx === null) {
              for (const idx of nonCommentary) {
                if (idx !== japaneseStreamIdx) {
                  const otherLang = classifiedAudio[idx].language;
                  if (["und", "eng", "en", ""].includes(otherLang)) {
                    englishStreamIdx = idx;
                    break;
                  }
                }
              }
            } else if (englishStreamIdx !== null && japaneseStreamIdx === null) {
              for (const idx of nonCommentary) {
                if (idx !== englishStreamIdx) {
                  const otherLang = classifiedAudio[idx].language;
                  if (["und", "jpn", "ja", ""].includes(otherLang)) {
                    japaneseStreamIdx = idx;
                    break;
                  }
                }
              }
            }
          }

          const isDual =
            japaneseStreamIdx !== null &&
            englishStreamIdx !== null &&
            japaneseStreamIdx !== englishStreamIdx;

          if (japaneseStreamIdx === null) {
            japaneseStreamIdx = nonCommentary[0] ?? 0;
          }

          resolve({
            video: videoStreams.length > 0 ? videoStreams : streams.filter((s: any) => s.codec_type === "video"),
            audio: audioStreams,
            subtitles: subtitleStreams,
            isDualAudio: isDual,
            classifiedAudio,
            japaneseStreamIndex: japaneseStreamIdx,
            englishStreamIndex: englishStreamIdx,
            videoCodec,
            pixelFormat,
            width,
            height,
            isBrowserCompatibleH264,
          });
        } catch (parseErr) {
          reject(parseErr);
        }
      },
    );
  });
}

export class SubtitleManager {
  private s3Client: S3Client | null = null;
  private bucket: string;

  constructor() {
    this.bucket = CAPTIONS_R2_BUCKET_NAME;
    if (CAPTIONS_R2_ACCOUNT_ID && CAPTIONS_R2_ACCESS_KEY_ID && CAPTIONS_R2_SECRET_ACCESS_KEY) {
      this.s3Client = new S3Client({
        region: "auto",
        endpoint: `https://${CAPTIONS_R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
        credentials: {
          accessKeyId: CAPTIONS_R2_ACCESS_KEY_ID,
          secretAccessKey: CAPTIONS_R2_SECRET_ACCESS_KEY,
        },
      });
    }
  }

  public static normalizeLangCode(rawLang: string, idx: number): string {
    const lang = (rawLang || `sub${idx}`).trim().toLowerCase();
    const mapping: Record<string, string> = {
      eng: "en", en: "en", english: "en",
      jpn: "ja", ja: "ja", japanese: "ja",
      spa: "es", es: "es", spanish: "es",
      fre: "fr", fra: "fr", fr: "fr",
      ger: "de", deu: "de", de: "de",
      ita: "it", it: "it",
      por: "pt", pt: "pt", "pt-br": "pt-br",
      rus: "ru", ru: "ru",
      ara: "ar", ar: "ar",
      chi: "zh", zho: "zh", zh: "zh",
      kor: "ko", ko: "ko",
      ind: "id", id: "id",
      tha: "th", th: "th",
      vie: "vi", vi: "vi",
    };
    return mapping[lang] || lang;
  }

  public async extractSubtitlesFromMkv(
    mkvPath: string,
    outputDir: string,
  ): Promise<ExtractedSubtitleTrack[]> {
    await fs.promises.mkdir(outputDir, { recursive: true });
    const probe = await inspectMkvStreamsSync(mkvPath);
    const subStreams = probe.subtitles || [];

    const extracted: ExtractedSubtitleTrack[] = [];
    const usedLangKeys = new Set<string>();

    for (let idx = 0; idx < subStreams.length; idx++) {
      const sub = subStreams[idx];
      const streamIdx = sub.index;
      const codecName = (sub.codec_name || "").toLowerCase();
      const tags = sub.tags || {};
      const disposition = sub.disposition || {};

      if (BITMAP_SUBTITLE_CODECS.has(codecName)) {
        log.info(
          "Subtitles",
          `Skipping bitmap subtitle stream #${streamIdx} (${codecName}) - not WebVTT compatible.`,
        );
        continue;
      }

      const rawLang = tags.language || `sub${idx}`;
      const baseLang = SubtitleManager.normalizeLangCode(rawLang, idx);
      const rawTitle = (tags.title || "").trim();
      const titleLower = rawTitle.toLowerCase();

      const isSigns =
        (Boolean(disposition.forced) ||
          ["sign", "song", "forced", "typeset"].some((k) => titleLower.includes(k))) &&
        !titleLower.includes("full");
      const isSdh =
        Boolean(disposition.hearing_impaired) ||
        ["sdh", "cc", "hearing"].some((k) => titleLower.includes(k));

      let langKey: string;
      let label: string;
      let trackRole: "dialogue" | "signs" | "sdh";

      if (isSigns) {
        langKey = `${baseLang}-signs`;
        label = rawTitle || `${baseLang.toUpperCase()} (Signs & Songs)`;
        trackRole = "signs";
      } else if (isSdh) {
        langKey = `${baseLang}-sdh`;
        label = rawTitle || `${baseLang.toUpperCase()} (SDH)`;
        trackRole = "sdh";
      } else {
        langKey = baseLang;
        label = rawTitle || `${baseLang.toUpperCase()} (Full)`;
        trackRole = "dialogue";
      }

      let uniqueLangKey = langKey;
      let suffixCounter = 2;
      while (usedLangKeys.has(uniqueLangKey)) {
        uniqueLangKey = `${langKey}-${suffixCounter}`;
        suffixCounter++;
      }
      usedLangKeys.add(uniqueLangKey);

      const vttFilename = `${uniqueLangKey}.vtt`;
      const vttPath = path.join(outputDir, vttFilename);

      const cmdArgs = [
        "-y", "-v", "quiet",
        "-i", mkvPath,
        "-map", `0:${streamIdx}`,
        "-c:s", "webvtt",
        vttPath,
      ];

      try {
        await execFileAsync("ffmpeg", cmdArgs);
        if (fs.existsSync(vttPath) && fs.statSync(vttPath).size > 50) {
          extracted.push({
            language: uniqueLangKey,
            baseLanguage: baseLang,
            role: trackRole,
            label,
            filePath: vttPath,
            isDefaultSub: baseLang === "en" && trackRole === "dialogue",
            isDefaultDub: baseLang === "en" && trackRole === "signs",
          });
        }
      } catch (e: any) {
        log.warn("Subtitles", `Failed to extract stream ${streamIdx} (${uniqueLangKey}): ${e?.message || e}`);
      }
    }

    if (extracted.length > 0 && !extracted.some((x) => x.isDefaultSub)) {
      const dialogueTracks = extracted.filter((x) => x.role === "dialogue");
      if (dialogueTracks.length > 0) {
        dialogueTracks[0].isDefaultSub = true;
      } else {
        extracted[0].isDefaultSub = true;
      }
    }

    return extracted;
  }

  public async uploadSubtitles(
    subtitles: ExtractedSubtitleTrack[],
    animeId: number,
    epNum: number,
    langType: string,
  ): Promise<R2SubtitleRecord[]> {
    if (!this.s3Client) {
      log.warn("Subtitles", "Captions R2 client not configured. Subtitle upload skipped.");
      return [];
    }

    const effectiveBucketType = langType === "dub" ? "dub" : "sub";
    const uploadedRecords: R2SubtitleRecord[] = [];

    for (const sub of subtitles) {
      const key = `captions/${animeId}/${epNum}/${effectiveBucketType}/${sub.language}.vtt`;
      const publicUrl = DEFAULT_SUBTITLE_PUBLIC_BASE
        ? `${DEFAULT_SUBTITLE_PUBLIC_BASE}/${key}`
        : key;
      try {
        const fileBuffer = await fs.promises.readFile(sub.filePath);
        await this.s3Client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: key,
            Body: fileBuffer,
            ContentType: "text/vtt; charset=utf-8",
          }),
        );

        uploadedRecords.push({
          anime_id: animeId,
          episode_number: epNum,
          type: effectiveBucketType,
          language: sub.language,
          path: key,
          role: sub.role,
          label: sub.label,
          url: publicUrl,
          default_sub: sub.isDefaultSub,
          default_dub: sub.isDefaultDub,
        });

        log.success("Subtitles", `Subtitle uploaded to R2: ${key} (${sub.label})`);
      } catch (err: any) {
        log.error("Subtitles", `Failed to upload ${key} to R2: ${err?.message || err}`);
      }
    }

    return uploadedRecords;
  }

  public static formatForCallback(
    r2SubRecords: R2SubtitleRecord[],
    streamType: "sub" | "dub",
  ): PipelineSubtitleTrack[] {
    return (r2SubRecords || []).map((r) => {
      const isDefault = Boolean(streamType === "dub" ? r.default_dub : r.default_sub);
      const url = r.url || (DEFAULT_SUBTITLE_PUBLIC_BASE ? `${DEFAULT_SUBTITLE_PUBLIC_BASE}/${r.path}` : r.path);
      return {
        language: r.language,
        label: r.label || r.language.toUpperCase(),
        role: (r.role as "dialogue" | "signs" | "sdh") || "dialogue",
        path: r.path,
        url,
        isDefault,
      };
    });
  }
}
