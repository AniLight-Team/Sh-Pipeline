import path from "path";
import type { AnimeToshoItem, ParsedReleaseTitle } from "./types.js";
import { DEFAULT_MIN_SEEDERS, ALLOW_CAM } from "../config.js";
import { log } from "../utils/logger.js";

export class ReleaseFilter {
  public static readonly TRUSTED_GROUPS_TIER_1 = new Set([
    "vodes", "sokudo", "ember", "anime time", "judas", "notshroud",
    "kaleido", "beatrice-raws", "coalgirls", "commie", "smol", "chihiro",
    "dkb", "gjm", "mtbb", "scum",
  ]);

  public static readonly TRUSTED_GROUPS_TIER_2 = new Set([
    "subsplease", "erai-raws", "asw", "kaizoku", "dubs-empire",
    "blackrabbit", "minikaizoku", "anitsu", "jaaj", "toonshub",
    "yameii", "varyg", "neohevc", "psa",
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
      /\b(?:2160p|1080p|720p|576p|480p|360p|4k|uhd|fhd|hd|hevc|av1|x264|x265|h\.?264|h\.?265|10\s*-?bit|8\s*-?bit|hi10p|aac\d*(?:\.\d)?|eac3|ac3|flac|opus|ddp\d*(?:\.\d)?|dts(?:-hd)?|web-dl|webrip|bluray|bdrip|bdremux|remux|hdtv|cr|amzn|nf|dsnp|hidive|b-global|dual[\s._-]*audio|multi[\s._-]*(?:audio|subs?)|(?:19|20)\d{2})\b/gi,
      " ",
    );
    return s;
  }

  public static parseTitle(
    title: string,
    knownTitles?: (string | null | undefined)[],
  ): ParsedReleaseTitle {
    const titleClean = title.trim();
    const lower = titleClean.toLowerCase();

    let group = "";
    const groupMatch = titleClean.match(/^\s*\[([^\]]+)\]/);
    if (groupMatch) {
      group = groupMatch[1].trim();
    }

    const isDualAudio = Array.from(this.DUAL_AUDIO_TAGS).some((tag) =>
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

    const isCam = /\b(?:telesync|camrip|hdcam|ts-rip|tele-sync|cam(?:\s*v\d+)?)\b/.test(lower);
    const isBluray = /\b(?:bluray|bdrip|bd\s*1080p|bdremux|remux|bd)\b/.test(lower);
    const isWeb = /\b(?:web-dl|webrip|cr|crunchyroll|web|amzn|nf|hidive)\b/.test(lower);
    const isHevc = /\b(?:hevc|x265|h\.?265)\b/.test(lower);
    const isAv1 = /\bav1\b/.test(lower);
    const isHevcOrAv1 = isHevc || isAv1 || /\b(?:10bit|10-bit)\b/.test(lower);
    const is1080p = /\b(?:1080p|fhd|1920x1080)\b/i.test(lower);
    const is720p = /\b(?:720p|hd|1280x720)\b/i.test(lower);
    const isBonusOrExtra = this.BONUS_OR_EXTRA_PATTERN.test(path.basename(titleClean));
    const isWeirdOrPromo = this.WEIRD_OR_PROMO_PATTERN.test(lower);
    const isUnsupportedContainer = this.UNSUPPORTED_CONTAINER_PATTERN.test(lower);

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
      groupLower: group.toLowerCase(),
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
      isHevc,
      isAv1,
      is1080p,
      is720p,
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
    const parsed = this.parseTitle(item.title || "", knownTitles);
    if (parsed.isWeirdOrPromo || parsed.isUnsupportedContainer) return false;
    const seeders = item.seeders || 0;
    const isTier1 = this.TRUSTED_GROUPS_TIER_1.has(parsed.groupLower);
    const isTier2 = this.TRUSTED_GROUPS_TIER_2.has(parsed.groupLower);
    const isSeadex = Boolean(item.is_seadex);
    const isDub = String(langType).toLowerCase() === "dub";

    if (isDub) {
      if (isSeadex && seeders >= 1) return true;
      if (isTier1 && (parsed.isDualAudio || parsed.isEnglishDub) && seeders >= 2) return true;
      if (parsed.isDualAudio && parsed.is1080p && seeders >= 3) return true;
      if (isTier2 && (parsed.isDualAudio || parsed.isEnglishDub) && seeders >= 3) return true;
      return false;
    }

    if (isSeadex && seeders >= 1) return true;
    if (isTier1 && seeders >= 5) return true;
    if (isTier2 && seeders >= 8) return true;
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
    const parsed = this.parseTitle(item.title || "", knownTitles);
    const numFiles = item.num_files || 1;
    const seeders = item.seeders || 0;
    const isSeadex = Boolean(item.is_seadex);

    if (!this.matchesTarget(parsed, targetEp, langType, numFiles, totalExpectedEps)) {
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
    else if (parsed.isWeb) score += 15;

    if (parsed.isHevc && !parsed.isAv1) score += 15;
    else if (parsed.isAv1) score -= 15;
    if (parsed.isCam) score -= 50;

    if (parsed.isDualAudio) {
      score += 40;
      if (String(langType).toLowerCase() === "all") score += 35;
    } else if (String(langType).toLowerCase() === "dub" && parsed.isEnglishDub) {
      score += 35;
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
      if (parsed.singleEp === targetEpNum) {
        score += 60;
      } else if (parsed.isBatch) {
        score -= 20;
      }
    }

    return score;
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
    const {
      knownTitles,
      totalExpectedEps,
      episodeOffset = 0,
      maxCandidates = 3,
      minSeeders = DEFAULT_MIN_SEEDERS,
    } = options;

    const candidatesToTry: (number | string)[] = [targetEp];

    if (String(targetEp).toLowerCase() !== "all") {
      const tNum = Number(targetEp);
      if (episodeOffset && episodeOffset > 0) {
        candidatesToTry.unshift(tNum + episodeOffset);
      } else {
        const singleEps = new Set<number>();
        for (const t of torrentList) {
          if ((t.seeders || 0) > 0) {
            const parsed = this.parseTitle(t.title || "", knownTitles);
            if (parsed.singleEp !== null) singleEps.add(parsed.singleEp);
          }
        }
        if (singleEps.size > 0 && !singleEps.has(tNum)) {
          const minEp = Math.min(...Array.from(singleEps));
          const courOffsets = new Set([11, 12, 13, 23, 24, 25, 26, 36, 37, 48, 49, 50]);
          if (minEp > 1 && courOffsets.has(minEp - 1)) {
            const inferred = minEp - 1 + tNum;
            if (singleEps.has(inferred)) {
              log.info(
                "ReleaseFilter",
                `Cumulative numbering offset +${minEp - 1} detected (Ep ${tNum} -> Ep ${inferred})`,
              );
              candidatesToTry.push(inferred);
            }
          }
        }
      }
    }

    for (const candidateEp of candidatesToTry) {
      const ranked: { score: number; item: AnimeToshoItem }[] = [];
      for (const t of torrentList) {
        const score = this.scoreTorrent(
          t,
          candidateEp,
          langType,
          knownTitles,
          totalExpectedEps,
        );
        if (score > 0) {
          ranked.push({ score, item: t });
        }
      }

      if (ranked.length > 0) {
        ranked.sort((a, b) => b.score - a.score);

        let candidatePool = ranked;
        if (String(targetEp).toLowerCase() !== "all") {
          const isSoloCandidate = (t: AnimeToshoItem): boolean => {
            const p = this.parseTitle(t.title || "", knownTitles);
            const nFiles = t.num_files || 1;
            return !p.isBatch && p.epRange === null && nFiles === 1;
          };

          const soloCandidates = ranked.filter((r) => isSoloCandidate(r.item));
          const batchCandidates = ranked.filter((r) => !isSoloCandidate(r.item));

          const hasSeaDexBatch = batchCandidates.some((b) => Boolean(b.item.is_seadex));
          if (hasSeaDexBatch) {
            candidatePool = ranked;
          } else if (soloCandidates.length > 0) {
            candidatePool = soloCandidates;
          } else if (batchCandidates.length > 0) {
            candidatePool = batchCandidates;
          }
        }

        const topRanked = candidatePool.slice(0, maxCandidates);

        const viable: [AnimeToshoItem, number | string, number, number][] = [];
        for (let idx = 0; idx < topRanked.length; idx++) {
          const entry = topRanked[idx];
          const sCount = entry.item.seeders || 0;
          if (sCount >= minSeeders) {
            viable.push([entry.item, candidateEp, entry.score, idx + 1]);
          }
        }

        if (viable.length === 0) {
          for (let idx = 0; idx < topRanked.length; idx++) {
            const entry = topRanked[idx];
            const sCount = entry.item.seeders || 0;
            if (sCount >= 1) {
              viable.push([entry.item, candidateEp, entry.score, idx + 1]);
            }
          }
        }

        if (viable.length > 0) {
          return viable.map(([t, ep]) => [t, ep]);
        }
      }
    }

    return [];
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
          if (epN === Number(effectiveEp)) {
            epN = Number(targetEp);
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

