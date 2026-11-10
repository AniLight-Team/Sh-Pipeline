import path from "path";
import type {
  AnimeToshoItem,
  ParsedReleaseTitle,
  ReleaseCandidateBundle,
  ReleaseQualityEntry,
  VideoResolutionQuality,
} from "./types.js";
import { DEFAULT_MIN_SEEDERS, ALLOW_CAM } from "../config.js";
import { log } from "../utils/logger.js";

export class ReleaseFilter {
  public static readonly TRUSTED_GROUPS_TIER_1 = new Set([
    "vodes", "sokudo", "ember", "anime time", "judas", "notshroud",
    "kaleido", "beatrice-raws", "coalgirls", "commie", "smol", "chihiro",
    "dkb", "gjm", "mtbb", "scum", "subsplease", "erai-raws", "toonshub", "yameii",
  ]);

  public static readonly TRUSTED_GROUPS_TIER_2 = new Set([
    "asw", "kaizoku", "dubs-empire", "blackrabbit", "minikaizoku",
    "anitsu", "jaaj", "varyg", "neohevc", "psa", "horriblesubs",
  ]);

  // Groups known to encode exclusively in HEVC/10-bit unless explicitly tagged H.264/x264
  public static readonly HEVC_DEFAULT_GROUPS = new Set([
    "judas", "ember", "psa", "neohevc", "asw", "anime time",
    "sokudo", "vodes", "cleo", "raze", "hakata ramen", "yuii",
  ]);

  public static readonly NON_ENGLISH_TAGS = new Set([
    "ita", "italian", "vostfr", "french", "german", "deutsch", "ger",
    "rus", "russian", "castellano", "latino", "pt-br", "portuguese",
    "mandarin", "cht", "chs", "taiwan", "spanish", "esp", "hindi",
    "arabic", "polish", "turkish", "indonesian", "thai", "vietnamese",
    "korean", "kor", "ko", "hangul",
  ]);

  public static readonly DUAL_AUDIO_TAGS = new Set([
    "dual audio", "dual-audio", "multi-dub", "multi-audio",
    "dual", "multi audio",
  ]);

  public static readonly ENGLISH_DUB_TAGS = new Set([
    "dubs-empire", "eng dub", "english dub", "en dub", "[dub]", "(dub)",
    "dubbed", "english audio", "eng audio", "yameii",
  ]);

  public static readonly BONUS_OR_EXTRA_PATTERN =
    /(?:\b|_)(?:ncop|nced|creditless|clean\s*op|clean\s*ed|menu|pv|cm|trailer|preview|teaser|making\s*of|interview|bd\s*menu|extra|bonus|omake|heroines|ova|oad|special|sp\d*|recap|s00|season\s*00?)(?:\b|\d|_)/i;

  public static readonly WEIRD_OR_PROMO_PATTERN =
    /(?:\b|_)(?:twitch(?:-rip|\.tv)?|youtube|yt-dlp|yt-rip|tiktok|livestream|stream-rip|preview|prerelease|pre-air|preair|screener|dvdscr|bdscr|workprint|sample|test\s*clip|promo|promotional|watermarked?|leaked?)(?:\b|\d|_)/i;

  public static readonly UNSUPPORTED_CONTAINER_PATTERN =
    /(?:\b|_)(?:bdmv|dvd-iso|bd-iso|\.iso|\.rar|\.zip|\.7z)(?:\b|\d|_)/i;

  public static stripNoiseForEpisodeParsing(
    text: string,
    knownTitles?: (string | null | undefined)[],
  ): string {
    let s = path.basename(text);
    s = s.replace(/\.(?:mkv|mp4|avi|webm|ass|srt|vtt)$/i, "");
    s = s.replace(/^\s*\[[^\]]+\]\s*/, "");
    s = s.replace(/[\[\(][0-9A-Fa-f]{8}[\]\)]/g, " ");
    s = s.replace(/\[(?![0-9]{1,4}\s*[-~–]\s*[0-9]{1,4}\])[^\]]*\]/g, " ");
    s = s.replace(/\((?![0-9]{1,4}\s*[-~–]\s*[0-9]{1,4}\))[^\)]*\)/g, " ");

    if (knownTitles) {
      const validTitles = (knownTitles.filter(Boolean) as string[]).sort(
        (a, b) => b.length - a.length,
      );
      for (const t of validTitles) {
        const escaped = t.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        s = s.replace(new RegExp(escaped, "gi"), " ");
      }
    }

    s = s.replace(
      /\b(?:2160p|1080p|720p|576p|540p|480p|360p|4k|uhd|fhd|hd|sd|hevc|av1|x264|x265|h\.?264|h\.?265|avc1?|10\s*-?bit|8\s*-?bit|hi10p|aac\d*(?:\.\d)?|eac3|ac3|flac|opus|ddp\d*(?:\.\d)?|dts(?:-hd)?|web-dl|webrip|bluray|bdrip|bdremux|remux|hdtv|cr|amzn|nf|dsnp|hidive|b-global|dual[\s._-]*audio|multi[\s._-]*(?:audio|subs?)|(?:19|20)\d{2})\b/gi,
      " ",
    );
    return s;
  }

  public static parseTitle(
    title: string,
    knownTitles?: (string | null | undefined)[],
    item?: AnimeToshoItem,
  ): ParsedReleaseTitle {
    const titleClean = title.trim();
    const lower = titleClean.toLowerCase();

    let group = "";
    const groupMatch = titleClean.match(/^\s*\[([^\]]+)\]/);
    if (groupMatch) {
      group = groupMatch[1].trim();
    } else if (item?.group_name) {
      group = item.group_name.trim();
    }
    const groupLower = group.toLowerCase();

    let isDualAudio = Array.from(this.DUAL_AUDIO_TAGS).some((tag) =>
      lower.includes(tag),
    );
    let isEnglishDub =
      isDualAudio ||
      Array.from(this.ENGLISH_DUB_TAGS).some((tag) => lower.includes(tag));
    if (/\b(?:eng(?:lish)?\s*dub|dubbed)\b/.test(lower)) {
      isEnglishDub = true;
    }

    let isForeign = false;
    for (const tag of this.NON_ENGLISH_TAGS) {
      const rx = new RegExp(`\\b${tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
      if (rx.test(lower)) {
        if (!lower.includes("multi") && !lower.includes("eng") && !lower.includes("dual")) {
          isForeign = true;
          break;
        }
      }
    }

    const tagMatch = titleClean.match(/\{Tags:[^}]*S=([a-zA-Z,]+)[^}]*\}/i);
    if (tagMatch) {
      const subLangs = tagMatch[1].toLowerCase().split(",");
      const hasEnglishSub = subLangs.some((l) => l === "en" || l === "eng" || l === "multi");
      if (!hasEnglishSub && !lower.includes("multi") && !lower.includes("eng") && !lower.includes("dual")) {
        isForeign = true;
      }
    }

    // Use explicit audio/subtitle language arrays from Tsukihime when available
    if (Array.isArray(item?.audiolangs) && item.audiolangs.length > 0) {
      const audioLangs = item.audiolangs.map((l) => String(l).toLowerCase().trim());
      const hasJaAudio = audioLangs.some(
        (l) => l === "ja" || l === "jp" || l === "jpn" || l.startsWith("ja-") || l.startsWith("jpn"),
      );
      const hasEnAudio = audioLangs.some(
        (l) => l === "en" || l === "eng" || l.startsWith("en-") || l.startsWith("eng"),
      );
      if (hasJaAudio && hasEnAudio) {
        isDualAudio = true;
        isEnglishDub = true;
        isForeign = false;
      } else if (hasEnAudio && !hasJaAudio) {
        isDualAudio = false;
        isEnglishDub = true;
        isForeign = false;
      } else if (hasJaAudio && !hasEnAudio) {
        isDualAudio = false;
        isEnglishDub = false;
      } else {
        isDualAudio = false;
        isEnglishDub = false;
        isForeign = true;
      }
    }

    if (Array.isArray(item?.sublangs) && item.sublangs.length > 0) {
      const subLangs = item.sublangs.map((l) => String(l).toLowerCase().trim());
      const hasEnSub = subLangs.some(
        (l) => l === "en" || l === "eng" || l === "multi" || l.startsWith("en-") || l.startsWith("eng"),
      );
      if (!hasEnSub && !isEnglishDub && !isDualAudio) {
        isForeign = true;
      }
    }

    const isCam = /\b(?:telesync|camrip|hdcam|ts-rip|tele-sync|cam(?:\s*v\d+)?)\b/.test(lower);
    const isBluray = /\b(?:bluray|bdrip|bd\s*1080p|bdremux|remux|bd)\b/.test(lower);
    const isWeb = /\b(?:web-dl|webrip|cr|crunchyroll|web|amzn|nf|hidive|dsnp|b-global)\b/.test(lower);

    const explicitH264 = /\b(?:x264|h\.?264|avc1?)\b/i.test(lower);
    const explicitHevc = /\b(?:hevc|x265|h\.?265)\b/i.test(lower);
    const isAv1 = /\bav1\b/i.test(lower);
    const is10Bit = /\b(?:10\s*-?bit|hi10p|yuv420p10)\b/i.test(lower);
    const isHevcGroupDefault = !explicitH264 && this.HEVC_DEFAULT_GROUPS.has(groupLower);

    const isHevc = explicitHevc || isHevcGroupDefault;
    const isHevcOrAv1 = isHevc || isAv1 || is10Bit;
    const isH264 = !isHevcOrAv1;

    const is4k = /\b(?:2160p|4k|uhd|3840x2160)\b/i.test(lower);
    const is480p = !is4k && /\b(?:480p|540p|576p|360p|sd|848x480|854x480|640x360)\b/i.test(lower);
    const is720p = !is4k && !is480p && /\b(?:720p|hd|1280x720)\b/i.test(lower);
    const is1080p = !is4k && !is480p && !is720p;

    const resolution: VideoResolutionQuality = is480p
      ? "480p"
      : is720p
        ? "720p"
        : "1080p";

    const isBonusOrExtra = this.BONUS_OR_EXTRA_PATTERN.test(path.basename(titleClean));
    const isWeirdOrPromo = this.WEIRD_OR_PROMO_PATTERN.test(lower);
    const isUnsupportedContainer = this.UNSUPPORTED_CONTAINER_PATTERN.test(lower) || is4k;

    const cleaned = this.stripNoiseForEpisodeParsing(titleClean, knownTitles);

    let seasonNum: number | null = null;
    let singleEp: number | null = null;
    let epRange: [number, number] | null = null;

    const rangeMatch = cleaned.match(
      /(?:(?:S(?:eason\s*)?0?(\d{1,2})[\s._-]*)?E(?:p(?:isode)?\s*)?0*(\d{1,4})|(?:\b|[\(\[\s_-])0*(\d{1,4}))\s*[-~–]\s*(?:(?:S(?:eason\s*)?0?\d{1,2}[\s._-]*)?E(?:p(?:isode)?\s*)?|(?:\b|[\(\[\s_-]))?0*(\d{1,4})(?:v\d+)?(?=\b|[\)\]\s_.-]|$)/i,
    );
    if (rangeMatch) {
      if (rangeMatch[1]) {
        seasonNum = parseInt(rangeMatch[1], 10);
      }
      const rStart = parseInt(rangeMatch[2] || rangeMatch[3], 10);
      const rEnd = parseInt(rangeMatch[4], 10);
      if (rStart >= 0 && rStart < rEnd && rEnd <= 2000) {
        epRange = [rStart, rEnd];
      }
    }

    if (!epRange) {
      const seMatch = cleaned.match(
        /\bS(?:eason\s*)?0?(\d{1,2})[\s._-]*E(?:p(?:isode)?\s*)?0*(\d{1,4})(?:v\d+)?\b/i,
      );
      if (seMatch) {
        seasonNum = parseInt(seMatch[1], 10);
        singleEp = parseInt(seMatch[2], 10);
      } else {
        const seasonMatch = cleaned.match(/\bS(?:eason\s*)?0?(\d{1,2})\b/i);
        if (seasonMatch) {
          seasonNum = parseInt(seasonMatch[1], 10);
        }
      }

      if (singleEp === null) {
        const explicitMatches = Array.from(
          cleaned.matchAll(
            /(?:-\s+|\b[eE][pP](?:isode)?[\s._-]*|\b[eE])0*(\d{1,4})(?:v\d+)?(?=\b|[\s\(\[\._-]|$)/g,
          ),
        );
        if (explicitMatches.length > 0) {
          singleEp = parseInt(explicitMatches[explicitMatches.length - 1][1], 10);
        } else {
          const tailMatches = Array.from(
            cleaned.trim().matchAll(/(?:^|[\s._-])0*(\d{2,3})(?:v\d+)?(?=\s*$)/g),
          );
          if (tailMatches.length > 0) {
            singleEp = parseInt(tailMatches[tailMatches.length - 1][1], 10);
          }
        }
      }
    }

    const isBatch =
      /\b(?:batch|complete|collection|full\s*season)\b/.test(lower) ||
      epRange !== null ||
      (seasonNum !== null && singleEp === null);

    const isSeasonBatch =
      /\b(?:complete|collection|full\s*season|all\s*episodes)\b/i.test(lower) ||
      (/\bs(?:eason)?\s*0?(\d{1,2})\b/i.test(lower) && !/\be(?:p(?:isode)?)?\s*0*(\d{1,4})\b/i.test(lower));

    return {
      group,
      groupLower,
      singleEp,
      epRange,
      seasonNum,
      isBatch,
      isSeasonBatch,
      isDualAudio,
      isEnglishDub,
      isForeign,
      isCam,
      isBluray,
      isWeb,
      isHevcOrAv1,
      isH264,
      isHevc,
      isAv1,
      is1080p,
      is720p,
      is480p,
      resolution,
      isBonusOrExtra: isBonusOrExtra || seasonNum === 0,
      isWeirdOrPromo,
      isUnsupportedContainer,
      titleRaw: titleClean,
    };
  }

  public static isHighQualityCandidate(
    item: AnimeToshoItem,
    targetEp: number | string,
    langType: string,
    knownTitles?: (string | null | undefined)[],
  ): boolean {
    const parsed = this.parseTitle(item.title || "", knownTitles, item);
    if (parsed.isWeirdOrPromo || parsed.isUnsupportedContainer) return false;
    const seeders = item.seeders || 0;
    const isTier1 = this.TRUSTED_GROUPS_TIER_1.has(parsed.groupLower);
    const isTier2 = this.TRUSTED_GROUPS_TIER_2.has(parsed.groupLower);
    const isSeadex = Boolean(item.is_seadex);
    const isDub = String(langType).toLowerCase() === "dub";
    const isSingleEpTarget = String(targetEp).toLowerCase() !== "all";

    // When searching for a single episode, do not stop pagination early on a non-SeaDex batch
    if (isSingleEpTarget && (parsed.isBatch || (item.num_files || 1) > 1) && !isSeadex) {
      return false;
    }

    // Strongly prefer stopping early only when we have a viable H.264 1080p candidate
    if (!parsed.isH264) {
      return false;
    }

    if (isDub) {
      if (isSeadex && seeders >= 1) return true;
      if (isTier1 && (parsed.isDualAudio || parsed.isEnglishDub) && seeders >= 2) return true;
      if (parsed.isDualAudio && parsed.is1080p && seeders >= 3) return true;
      if (isTier2 && (parsed.isDualAudio || parsed.isEnglishDub) && seeders >= 3) return true;
      return false;
    }

    if (parsed.isEnglishDub && !parsed.isDualAudio) return false;
    if (parsed.isForeign && !parsed.isDualAudio) return false;

    if (isSeadex && seeders >= 1) return true;
    if (isTier1 && parsed.is1080p && seeders >= 5) return true;
    if (isTier2 && parsed.is1080p && seeders >= 8) return true;
    if (parsed.isDualAudio && parsed.is1080p && seeders >= 3) return true;
    if (parsed.is1080p && seeders >= 12) return true;
    return false;
  }

  public static matchesTarget(
    parsed: ParsedReleaseTitle,
    targetEp: number | string,
    langType: string,
    numFiles = 1,
    totalExpectedEps?: number | null,
    item?: AnimeToshoItem,
  ): boolean {
    if (parsed.isWeirdOrPromo || parsed.isUnsupportedContainer) return false;
    if (parsed.isCam && !ALLOW_CAM) return false;
    if (parsed.isBonusOrExtra || parsed.seasonNum === 0) {
      if (targetEp !== 0) return false;
    }

    const lang = String(langType).toLowerCase();
    if (lang === "dub") {
      if (parsed.isForeign && !parsed.isEnglishDub && !parsed.isDualAudio) return false;
      if (!parsed.isEnglishDub && !parsed.isDualAudio && !parsed.groupLower.includes("dub")) return false;
    } else if (lang === "sub") {
      if (parsed.isForeign && !parsed.isDualAudio) return false;
      if (parsed.isEnglishDub && !parsed.isDualAudio) return false;
    } else {
      // lang === "all"
      if (parsed.isForeign && !parsed.isEnglishDub && !parsed.isDualAudio) return false;
    }

    if (String(targetEp).toLowerCase() === "all") {
      if (parsed.epRange) {
        const [start, end] = parsed.epRange;
        if (totalExpectedEps && totalExpectedEps > 2 && end < totalExpectedEps) {
          return false;
        }
        return true;
      }
      if (parsed.isBatch || numFiles > 1) return true;
      if (totalExpectedEps === 1 && (parsed.singleEp === 1 || parsed.singleEp === null)) {
        return true;
      }
      return false;
    }

    const targetEpNum = Number(targetEp);
    if (Number.isNaN(targetEpNum)) return false;

    // Tsukihime curates relative episode_no per anime even when release titles use cumulative episode numbers
    if (
      typeof item?.tsukihime_episode_no === "number" &&
      item.tsukihime_episode_no === targetEpNum &&
      !parsed.isBatch &&
      numFiles === 1
    ) {
      return true;
    }

    if (parsed.singleEp === targetEpNum) return true;

    if (parsed.epRange) {
      const [start, end] = parsed.epRange;
      return start <= targetEpNum && targetEpNum <= end;
    }

    if (parsed.isBatch && parsed.singleEp === null) {
      if (numFiles > 1) {
        return numFiles >= Math.max(1, targetEpNum);
      }
      if (numFiles === 1 && targetEpNum > 1) {
        return false;
      }
      if (totalExpectedEps && targetEpNum <= totalExpectedEps) {
        if (parsed.isSeasonBatch) return true;
      }
    }

    return false;
  }

  public static scoreTorrent(
    item: AnimeToshoItem,
    targetEp: number | string,
    langType: string,
    knownTitles?: (string | null | undefined)[],
    totalExpectedEps?: number | null,
  ): number {
    const parsed = this.parseTitle(item.title || "", knownTitles, item);
    const numFiles = item.num_files || 1;
    const seeders = item.seeders || 0;
    const isSeadex = Boolean(item.is_seadex);

    if (!this.matchesTarget(parsed, targetEp, langType, numFiles, totalExpectedEps, item)) {
      return -10000;
    }

    if (seeders <= 0) return -5000;

    let score = 100;
    if (isSeadex) score += 60;

    const grp = parsed.groupLower;
    if (this.TRUSTED_GROUPS_TIER_1.has(grp)) {
      score += 45;
    } else if (this.TRUSTED_GROUPS_TIER_2.has(grp)) {
      score += 30;
    }

    if (parsed.isBluray) score += 30;
    else if (parsed.isWeb) score += 20;

    // Prefer H.264 releases strongly so they can be direct-remuxed without GPU re-encoding.
    // Only fall back to HEVC/AV1 when no viable H.264 release exists.
    if (parsed.isH264) {
      score += 55;
    } else if (parsed.isHevc && !parsed.isAv1) {
      score += 5;
    } else if (parsed.isAv1) {
      score -= 20;
    }
    if (parsed.isCam) score -= 50;

    const langLower = String(langType).toLowerCase();
    if (parsed.isDualAudio) {
      score += 40;
      if (langLower === "all") score += 35;
    } else if (langLower === "dub" && parsed.isEnglishDub) {
      score += 35;
    } else if (langLower === "all" && parsed.isEnglishDub && !parsed.isDualAudio) {
      // Dub-only release lacks Japanese audio when both sub+dub ("all") are desired
      score -= 35;
    }

    if (seeders >= 100) score += 45;
    else if (seeders >= 50) score += 35;
    else if (seeders >= 20) score += 25;
    else if (seeders >= 10) score += 15;
    else if (seeders >= 5) score += 10;
    else if (seeders < DEFAULT_MIN_SEEDERS) score -= 40;

    const isAll = String(targetEp).toLowerCase() === "all";
    if (isAll) {
      if (parsed.isBatch) score += 70;
      if (totalExpectedEps && numFiles >= totalExpectedEps) score += 25;
    } else {
      const targetEpNum = Number(targetEp);
      const isTsukihimeEpMatch =
        typeof item.tsukihime_episode_no === "number" &&
        item.tsukihime_episode_no === targetEpNum &&
        !parsed.isBatch &&
        numFiles === 1;
      if (parsed.singleEp === targetEpNum || isTsukihimeEpMatch) {
        score += 60;
        if (isTsukihimeEpMatch) score += 10;
      } else if (parsed.isBatch) {
        score -= 20;
      }
    }

    return score;
  }

  public static readonly VALID_COUR_OFFSETS = new Set([
    10, 11, 12, 13, 14, 15, 16,
    21, 22, 23, 24, 25, 26, 27, 28,
    34, 35, 36, 37, 38, 39, 40,
    47, 48, 49, 50, 51, 52,
    60, 61, 62, 63, 64, 65,
  ]);

  /**
   * Infers cumulative episode offsets (e.g. +12, +24, +26, +40, +392) from both
   * cour/season batch ranges (e.g. S01E27-E40, S17E41-E50, 393-406) and contiguous
   * single-episode clusters in the feed.
   */
  public static inferCumulativeOffsets(
    torrentList: AnimeToshoItem[],
    targetEpNum: number,
    knownTitles?: (string | null | undefined)[],
    totalExpectedEps?: number | null,
  ): number[] {
    if (Number.isNaN(targetEpNum) || targetEpNum <= 0) return [];

    const offsets = new Set<number>();
    const singleEps = new Set<number>();

    for (const t of torrentList) {
      if ((t.seeders || 0) <= 0) continue;
      const parsed = this.parseTitle(t.title || "", knownTitles);
      if (parsed.isBonusOrExtra || parsed.seasonNum === 0 || parsed.isWeirdOrPromo || parsed.isUnsupportedContainer) {
        continue;
      }

      if (parsed.singleEp !== null && parsed.singleEp > 0) {
        singleEps.add(parsed.singleEp);
      }

      if (parsed.epRange) {
        const [rStart, rEnd] = parsed.epRange;
        const span = rEnd - rStart + 1;
        if (rStart > 1 && span >= 3 && span <= 60) {
          const offset = rStart - 1;
          if (rStart + targetEpNum - 1 <= rEnd) {
            offsets.add(offset);
          }
        }
      }
    }

    if (singleEps.size > 0) {
      const sorted = Array.from(singleEps).sort((a, b) => a - b);
      const clusters: number[][] = [];
      for (const ep of sorted) {
        if (clusters.length === 0) {
          clusters.push([ep]);
        } else {
          const cur = clusters[clusters.length - 1];
          if (ep - cur[cur.length - 1] <= 3) {
            cur.push(ep);
          } else {
            clusters.push([ep]);
          }
        }
      }

      const relClusters = clusters.filter((c) => c[0] >= 1 && c[c.length - 1] <= 26);
      const cumClusters = clusters.filter((c) => c[0] > 11);
      if (relClusters.length > 0 && cumClusters.length > 0) {
        const relMax = relClusters[0][relClusters[0].length - 1];
        for (const cum of cumClusters) {
          const cumMax = cum[cum.length - 1];
          const diff = cumMax - relMax;
          if (this.VALID_COUR_OFFSETS.has(diff)) {
            offsets.add(diff);
          }
        }
      }

      for (const cluster of cumClusters) {
        const cMin = cluster[0];
        const cMax = cluster[cluster.length - 1];
        if (totalExpectedEps && totalExpectedEps >= 4 && totalExpectedEps <= 30) {
          const expectedOffset = cMax - totalExpectedEps;
          if (this.VALID_COUR_OFFSETS.has(expectedOffset)) {
            offsets.add(expectedOffset);
          }
        }
        const candidateOffset = cMin - 1;
        if (
          cluster.length >= 3 &&
          this.VALID_COUR_OFFSETS.has(candidateOffset) &&
          singleEps.has(candidateOffset + targetEpNum)
        ) {
          offsets.add(candidateOffset);
        }
      }
    }

    return Array.from(offsets);
  }

  /**
   * Selects top candidate bundles grouped by the SAME release group.
   * - Strongly prioritizes H.264 releases (`isH264: true`) over HEVC/AV1 so re-encoding is only used
   *   when no viable H.264 release exists.
   * - For H.264 releases, collects all available quality versions (`1080p`, `720p`, `480p`) from the
   *   EXACT same group, preferring groups with fuller multi-quality coverage and better encodes.
   * - For HEVC/AV1 releases (fallback when no H.264 exists), selects only the best `1080p` release
   *   for GPU transcoding.
   */
  public static selectTopCandidateBundles(
    torrentList: AnimeToshoItem[],
    targetEp: number | string,
    langType: string,
    options: {
      knownTitles?: (string | null | undefined)[];
      totalExpectedEps?: number | null;
      episodeOffset?: number;
      maxBundles?: number;
      minSeeders?: number;
    } = {},
  ): ReleaseCandidateBundle[] {
    const {
      knownTitles,
      totalExpectedEps,
      episodeOffset = 0,
      maxBundles = 4,
      minSeeders = DEFAULT_MIN_SEEDERS,
    } = options;

    const candidatesToTry: (number | string)[] = [targetEp];

    if (String(targetEp).toLowerCase() !== "all") {
      const tNum = Number(targetEp);
      if (episodeOffset && episodeOffset > 0) {
        candidatesToTry.unshift(tNum + episodeOffset);
      }
      const inferredOffsets = this.inferCumulativeOffsets(
        torrentList,
        tNum,
        knownTitles,
        totalExpectedEps,
      );
      for (const off of inferredOffsets) {
        const mappedEp = tNum + off;
        if (!candidatesToTry.includes(mappedEp)) {
          log.info(
            "ReleaseFilter",
            `Cumulative numbering offset +${off} detected (Ep ${tNum} -> Ep ${mappedEp})`,
          );
          candidatesToTry.push(mappedEp);
        }
      }
    }

    const bestByItemKey = new Map<
      string | number,
      {
        score: number;
        item: AnimeToshoItem;
        effectiveEp: number | string;
        parsed: ParsedReleaseTitle;
      }
    >();

    for (const candidateEp of candidatesToTry) {
      const isDirectMatch = candidateEp === targetEp;
      for (const t of torrentList) {
        let score = this.scoreTorrent(
          t,
          candidateEp,
          langType,
          knownTitles,
          totalExpectedEps,
        );
        if (score > 0) {
          if (isDirectMatch) {
            score += 15;
          }
          const parsed = this.parseTitle(t.title || "", knownTitles, t);
          let effectiveEpForFile: number | string = candidateEp;
          if (
            String(candidateEp).toLowerCase() !== "all" &&
            typeof t.tsukihime_episode_no === "number" &&
            t.tsukihime_episode_no === Number(candidateEp)
          ) {
            if (parsed.singleEp !== null && parsed.singleEp !== Number(candidateEp)) {
              effectiveEpForFile = parsed.singleEp;
            }
          }
          const key = (t.info_hash ? t.info_hash.toLowerCase() : null) || t.id || t.title;
          const existing = bestByItemKey.get(key);
          if (!existing || score > existing.score) {
            bestByItemKey.set(key, {
              score,
              item: t,
              effectiveEp: effectiveEpForFile,
              parsed,
            });
          }
        }
      }
    }

    const allScored = Array.from(bestByItemKey.values());
    if (allScored.length === 0) return [];

    // Filter by minimum seeders (or fallback to seeders >= 1 if none meet minSeeders)
    let eligibleScored = allScored.filter((e) => (e.item.seeders || 0) >= minSeeders);
    if (eligibleScored.length === 0) {
      eligibleScored = allScored.filter((e) => (e.item.seeders || 0) >= 1);
    }
    if (eligibleScored.length === 0) return [];

    // Group into same-group bundles: (groupKey, codecClass, audioClass, soloVsBatch)
    const bundleMap = new Map<
      string,
      {
        group: string;
        groupLower: string;
        isH264: boolean;
        isDualAudio: boolean;
        isEnglishDub: boolean;
        isSolo: boolean;
        isSeadex: boolean;
        qualities: Partial<Record<VideoResolutionQuality, ReleaseQualityEntry>>;
      }
    >();

    for (const entry of eligibleScored) {
      const { item, score, effectiveEp, parsed } = entry;
      const isH264 = Boolean(parsed.isH264);
      const quality: VideoResolutionQuality = parsed.resolution || "1080p";
      const nFiles = item.num_files || 1;
      const isSolo = !parsed.isBatch && parsed.epRange === null && nFiles === 1;
      const itemUniqueId = (item.info_hash || item.id || item.title).toString().toLowerCase();

      // Only merge qualities when they share a non-empty release group name
      const groupKey = parsed.groupLower ? parsed.groupLower : `ungrouped_${itemUniqueId}`;
      const audioKey = parsed.isDualAudio ? "dual" : parsed.isEnglishDub ? "dub" : "sub";
      const bundleKey = `${groupKey}::${isH264 ? "h264" : "hevc"}::${audioKey}::${isSolo ? "solo" : "batch"}`;

      let b = bundleMap.get(bundleKey);
      if (!b) {
        b = {
          group: parsed.group || "Unknown",
          groupLower: parsed.groupLower,
          isH264,
          isDualAudio: parsed.isDualAudio,
          isEnglishDub: parsed.isEnglishDub,
          isSolo,
          isSeadex: Boolean(item.is_seadex),
          qualities: {},
        };
        bundleMap.set(bundleKey, b);
      } else if (item.is_seadex) {
        b.isSeadex = true;
      }

      const existingQ = b.qualities[quality];
      if (!existingQ || score > existingQ.score) {
        b.qualities[quality] = {
          quality,
          item,
          effectiveEp,
          score,
        };
      }
    }

    const bundles: ReleaseCandidateBundle[] = [];

    for (const b of bundleMap.values()) {
      const q1080 = b.qualities["1080p"];
      const q720 = b.qualities["720p"];
      const q480 = b.qualities["480p"];

      const primaryEntry = q1080 || q720 || q480;
      if (!primaryEntry) continue;

      // For HEVC/AV1 bundles (which will be GPU transcoded from 1080p into 1080p/720p/480p),
      // only keep the primary (1080p) entry so we never waste bandwidth downloading 720p/480p HEVC.
      const effectiveQualities: Partial<Record<VideoResolutionQuality, ReleaseQualityEntry>> = b.isH264
        ? b.qualities
        : { [primaryEntry.quality]: primaryEntry };

      let bundleScore = primaryEntry.score;

      // Strongly prefer having a 1080p master (for 1080p stream + canonical R2 subtitle extraction)
      if (q1080) {
        bundleScore += 50;
      } else {
        bundleScore -= 80;
      }

      // CRITICAL RULE: Re-encoding is ONLY required when no viable H.264 release exists!
      // Any viable H.264 bundle with a 1080p stream outranks HEVC/AV1 bundles.
      if (b.isH264 && q1080) {
        bundleScore += 250;
        // Same-group multi-quality completeness bonus (rewards groups providing 1080p + 720p + 480p)
        if (q720) bundleScore += 45;
        if (q480) bundleScore += 45;
      } else if (b.isH264) {
        // H.264 without 1080p (e.g. only 720p exists) still gets a moderate H.264 bonus
        bundleScore += 120;
      }

      if (String(targetEp).toLowerCase() !== "all") {
        if (b.isSolo) {
          bundleScore += 35;
        } else if (!b.isSeadex) {
          bundleScore -= 25;
        }
      }

      bundles.push({
        group: b.group,
        groupLower: b.groupLower,
        isH264: b.isH264,
        isDualAudio: b.isDualAudio,
        isEnglishDub: b.isEnglishDub,
        bundleScore,
        primaryEntry,
        qualities: effectiveQualities,
      });
    }

    bundles.sort((a, b) => b.bundleScore - a.bundleScore);
    return bundles.slice(0, maxBundles);
  }

  public static selectTopCandidates(
    torrentList: AnimeToshoItem[],
    targetEp: number | string,
    langType: string,
    options: {
      knownTitles?: (string | null | undefined)[];
      totalExpectedEps?: number | null;
      episodeOffset?: number;
      maxCandidates?: number;
      minSeeders?: number;
    } = {},
  ): [AnimeToshoItem, number | string][] {
    const bundles = this.selectTopCandidateBundles(torrentList, targetEp, langType, {
      ...options,
      maxBundles: options.maxCandidates || 3,
    });
    return bundles.map((b) => [b.primaryEntry.item, b.primaryEntry.effectiveEp]);
  }

  public static selectBest(
    torrentList: AnimeToshoItem[],
    targetEp: number | string,
    langType: string,
    options: {
      knownTitles?: (string | null | undefined)[];
      totalExpectedEps?: number | null;
      episodeOffset?: number;
      minSeeders?: number;
    } = {},
  ): [AnimeToshoItem | null, number | string] {
    const candidates = this.selectTopCandidates(torrentList, targetEp, langType, {
      ...options,
      maxCandidates: 3,
    });
    if (candidates.length > 0) {
      return candidates[0];
    }
    return [null, targetEp];
  }

  public static matchFilesToEpisodes(
    files: { name?: string; length?: number }[],
    options: {
      knownTitles?: (string | null | undefined)[];
      targetEp?: number | string | null;
      effectiveEp?: number | string | null;
      totalExpectedEps?: number | null;
    } = {},
  ): Map<number, [number, string]> {
    const { knownTitles, targetEp, effectiveEp } = options;
    const videoExts = [".mkv", ".mp4", ".avi", ".webm"];
    const epMap = new Map<number, [number, string]>();

    const videoFiles: { idx: number; relPath: string; length: number }[] = [];
    for (let i = 0; i < files.length; i++) {
      const relPath = files[i].name || "";
      const lower = relPath.toLowerCase();
      if (videoExts.some((ext) => lower.endsWith(ext))) {
        videoFiles.push({ idx: i, relPath, length: files[i].length || 0 });
      }
    }

    if (videoFiles.length === 0) return epMap;

    if (videoFiles.length === 1) {
      const { idx, relPath } = videoFiles[0];
      let assignedEp = 1;
      if (targetEp !== null && targetEp !== undefined && String(targetEp).toLowerCase() !== "all") {
        assignedEp = Number(targetEp);
      } else {
        const parsed = this.parseTitle(relPath, knownTitles);
        assignedEp = parsed.singleEp || 1;
      }
      epMap.set(assignedEp, [idx, relPath]);
      return epMap;
    }

    const nonBonusFiles: { idx: number; relPath: string; length: number; parsed: ParsedReleaseTitle }[] = [];
    for (const vf of videoFiles) {
      const parsed = this.parseTitle(vf.relPath, knownTitles);
      if ((parsed.isBonusOrExtra || parsed.seasonNum === 0) && targetEp !== 0) {
        continue;
      }
      nonBonusFiles.push({ ...vf, parsed });

      let epN = parsed.singleEp;
      if (epN !== null) {
        if (
          targetEp !== null &&
          targetEp !== undefined &&
          effectiveEp !== null &&
          effectiveEp !== undefined &&
          String(targetEp).toLowerCase() !== "all"
        ) {
          const targetNum = Number(targetEp);
          const effectiveNum = Number(effectiveEp);
          if (epN === effectiveNum) {
            epN = targetNum;
          } else if (effectiveNum > targetNum && epN > effectiveNum - targetNum) {
            epN = epN - (effectiveNum - targetNum);
          }
        }

        const existing = epMap.get(epN);
        const curLen = vf.length;
        const existLen = existing ? files[existing[0]]?.length || 0 : 0;
        if (!existing || curLen > existLen) {
          epMap.set(epN, [vf.idx, vf.relPath]);
        }
      }
    }

    if (
      targetEp !== null &&
      targetEp !== undefined &&
      String(targetEp).toLowerCase() !== "all" &&
      !epMap.has(Number(targetEp)) &&
      epMap.size > 1
    ) {
      const tNum = Number(targetEp);
      const positiveKeys = Array.from(epMap.keys())
        .filter((k) => k > 0)
        .sort((a, b) => a - b);
      if (positiveKeys.length > 0 && positiveKeys[0] > 1) {
        const inferredKey = positiveKeys[0] - 1 + tNum;
        if (epMap.has(inferredKey)) {
          epMap.set(tNum, epMap.get(inferredKey)!);
        }
      }
    }

    if (epMap.size === 0 && nonBonusFiles.length === 1) {
      const { idx, relPath, parsed } = nonBonusFiles[0];
      let assignedEp = 1;
      if (targetEp !== null && targetEp !== undefined && String(targetEp).toLowerCase() !== "all") {
        assignedEp = Number(targetEp);
      } else {
        assignedEp = parsed.singleEp || 1;
      }
      epMap.set(assignedEp, [idx, relPath]);
      return epMap;
    }

    if (epMap.size === 0 && nonBonusFiles.length > 0) {
      const sorted = [...nonBonusFiles].sort((a, b) => a.relPath.localeCompare(b.relPath));
      for (let i = 0; i < sorted.length; i++) {
        epMap.set(i + 1, [sorted[i].idx, sorted[i].relPath]);
      }
      log.warn(
        "ReleaseFilter",
        `Sequentially mapped ${epMap.size} video files 1..${epMap.size}.`,
      );
    }

    return epMap;
  }
}
