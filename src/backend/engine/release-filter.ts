import path from "path";
import type {
  AnimeToshoItem,
  CandidateSelectionTier,
  ParsedReleaseTitle,
  PipelineExecutionType,
  ReleaseCandidateBundle,
  ReleaseQualityEntry,
  VideoResolutionQuality,
} from "./types.js";
import { DEFAULT_MIN_SEEDERS, ALLOW_CAM } from "../config.js";
import { torrentIdentityKey } from "./torrent-identity.js";
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
    "anozu", "strikes", "cartel",
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
    /(?:\b|_)(?:ncop|nced|creditless|clean\s*op|clean\s*ed|menu|pv|cm|trailer|preview|teaser|making\s*of|interview|bd\s*menu|extra|bonus|omake|ova|oad|special|sp\d*|recap|s00|season\s*00?)(?:\b|\d|_)/i;

  public static readonly HARD_BONUS_OR_EXTRA_PATTERN =
    /(?:\b|_)(?:ncop\d*|nced\d*|creditless|clean\s*op|clean\s*ed|bd\s*menu|pv\d*|cm\d*|s00|season\s*00?)(?:\b|\d|_)/i;

  public static readonly WEIRD_OR_PROMO_PATTERN =
    /(?:\b|_)(?:twitch(?:-rip|\.tv)?|youtube|yt-dlp|yt-rip|tiktok|livestream|stream-rip|preview|prerelease|pre-air|preair|screener|dvdscr|bdscr|workprint|sample|test\s*clip|promo|promotional|watermarked?|leaked?)(?:\b|\d|_)/i;

  private static readonly WATERMARKED_WEB_SOURCE_PATTERN =
    /(?<![\p{L}\p{N}])(?:bilibili[\s._-]+(?:international|intl|global)|b[.\s_-]+global)(?![\p{L}\p{N}])/iu;

  public static readonly UNSUPPORTED_CONTAINER_PATTERN =
    /(?:\b|_)(?:bdmv|dvd-iso|bd-iso|\.iso|\.rar|\.zip|\.7z)(?:\b|\d|_)/i;

  public static hasWatermarkedSource(title: string | null | undefined): boolean {
    return typeof title === "string" && this.WATERMARKED_WEB_SOURCE_PATTERN.test(title.normalize("NFKC"));
  }

  private static readonly SEQUEL_ROMAN_TO_ARABIC: Record<string, string> = {
    ii: "2",
    iii: "3",
    iv: "4",
    v: "5",
    vi: "6",
    vii: "7",
    viii: "8",
    ix: "9",
    x: "10",
  };

  private static readonly SEQUEL_ARABIC_TO_ROMAN: Record<string, string> = {
    "2": "II",
    "3": "III",
    "4": "IV",
    "5": "V",
    "6": "VI",
    "7": "VII",
    "8": "VIII",
    "9": "IX",
    "10": "X",
  };

  private static readonly TRAILING_NON_TITLE_PAREN =
    /^(?:dual[\s._-]*audio|multi[\s._-]*(?:audio|subs?|dub)|english[\s._-]*dub|eng[\s._-]*dub|dub|weekly|batch|complete|uncensored|censored|web-?dl|webrip|bd|bluray|\d{3,4}p|4k|hevc|av1|x26[45]|h\.?26[45]|avc1?|aac.*|flac|opus|[0-9a-f]{8})(?:[\s,._-]|$)/i;

  private static normalizeSeriesTitle(title: string): string {
    return title.normalize("NFKC").normalize("NFD")
      .replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
      .normalize("NFC")
      .toLowerCase()
      .replace(/['’`]/g, "")
      .replace(/[^\p{L}\p{M}\p{N}]+/gu, " ")
      .trim();
  }

  private static normalizeSequelRomanNumerals(normalized: string): string {
    return normalized.replace(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b/g, (match) =>
      this.SEQUEL_ROMAN_TO_ARABIC[match] ?? match,
    );
  }

  private static seriesTitleEnd(release: string, title: string): number {
    let end = 0;
    for (const character of title.replaceAll(" ", "")) {
      if (release[end] === " ") end++;
      if (!release.startsWith(character, end)) return -1;
      end += character.length;
    }
    return end === release.length || release[end] === " " ? end : -1;
  }

  private static releaseName(title: string): string {
    return title.normalize("NFKC")
      .replace(/^(?:\s*\[[^\]]+\])+\s*/, "")
      .replace(/\.(?:mkv|mp4|avi|webm)$/i, "");
  }

  private static readonly TRAILING_STAGE_OR_COUR_RANGE =
    /\s*(?:[-:–~|/]+\s*)?(?:\d{1,2}(?:st|nd|rd|th)(?:\s*[-–—&]\s*\d{1,2}(?:st|nd|rd|th))*\s+(?:stage|cour|part)|(?:stage|cour|part)\s*\d{1,2}(?:\s*[-–—&]\s*\d{1,2})*)\s*$/i;

  private static extractSubtitledFranchise(raw: string): { franchise: string; subtitle: string; hasExplicitSeason: boolean } | null {
    const trimmed = raw.trim();
    if (!trimmed) return null;
    const withoutStageSuffix = trimmed.replace(this.TRAILING_STAGE_OR_COUR_RANGE, "").trim();
    const target = withoutStageSuffix || trimmed;
    const colon = target.match(/^([^:]+):\s*(.+)$/);
    const dashParts = !colon ? target.split(/\s+[-–—]\s+/) : [];
    const franchise = colon ? colon[1].trim() : dashParts.length > 1 ? dashParts.slice(0, -1).join(" ").trim() : "";
    const subtitle = colon ? colon[2].trim() : dashParts.length > 1 ? dashParts.at(-1)!.trim() : "";
    if (!franchise || !subtitle) return null;
    const normalizedFranchise = this.normalizeSeriesTitle(franchise);
    if (!normalizedFranchise || normalizedFranchise.length < 2) return null;
    const hasExplicitSeason = /\b(?:\d{1,2}(?:st|nd|rd|th)\s+season|season\s+\d{1,2}|s\d{1,2})$/i.test(this.normalizeSeriesTitle(trimmed));
    return { franchise, subtitle, hasExplicitSeason };
  }

  private static extractNumberedPrefix(raw: string): string | null {
    const split = this.extractSubtitledFranchise(raw);
    if (!split) return null;
    const normalized = this.normalizeSequelRomanNumerals(this.normalizeSeriesTitle(split.franchise));
    // Require a trailing sequel number (2..10) so Season 1 is never confused with a sequel.
    if (!/\s(?:[2-9]|10)$/.test(normalized)) return null;
    return normalized;
  }

  private static hasConflictingArcParen(releaseName: string, knownTitles: (string | null | undefined)[]): boolean {
    const afterSeasonEp = releaseName.match(/\bs\d{1,2}\s*e\d{1,4}(?:v\d+)?\s*\(([^()]+)\)/i);
    if (!afterSeasonEp) return false;
    const parenContent = afterSeasonEp[1].trim();
    if (!parenContent || this.TRAILING_NON_TITLE_PAREN.test(parenContent)) return false;
    const normalizedParen = this.normalizeSeriesTitle(parenContent);
    if (!normalizedParen) return false;
    return !knownTitles.some((raw) => {
      if (!raw) return false;
      const split = this.extractSubtitledFranchise(raw);
      if (!split) return false;
      const expectedSub = this.normalizeSeriesTitle(split.subtitle);
      return expectedSub && this.seriesTitleEnd(normalizedParen, expectedSub) === normalizedParen.length;
    });
  }

  public static matchesSeriesTitle(
    releaseTitle: string,
    knownTitles: (string | null | undefined)[],
    { allowUnmarkedSeason = false, allowVerifiedSeason = false } = {},
  ): boolean {
    if (typeof releaseTitle !== "string") return false;
    const releaseName = this.releaseName(releaseTitle);
    return this.matchesLeadingSeriesTitle(releaseName, knownTitles, allowUnmarkedSeason, false, allowVerifiedSeason) ||
      this.findTrailingCourAlias(releaseName, knownTitles, allowUnmarkedSeason) !== undefined;
  }

  private static stripTrailingSeasonAndSubdivision(normalizedTitle: string): {
    baseTitle: string;
    expectedSeason: number | null;
    expectedSubdivision: { kind: "stage" | "cour" | "part"; nums: string } | null;
  } {
    let working = normalizedTitle;
    let expectedSubdivision: { kind: "stage" | "cour" | "part"; nums: string } | null = null;
    let expectedSeason: number | null = null;

    const subMatch = working.match(
      / (?:(\d{1,2}(?:st|nd|rd|th)(?: \d{1,2}(?:st|nd|rd|th))*) (stage|cour|part)|(stage|cour|part) (\d{1,2}(?: \d{1,2})*))$/,
    );
    if (subMatch && subMatch.index! > 0) {
      const kind = (subMatch[2] || subMatch[3]) as "stage" | "cour" | "part";
      const rawNums = subMatch[1] || subMatch[4];
      const nums = (rawNums.match(/\d+/g) ?? []).map(n => String(Number(n))).join(" ");
      expectedSubdivision = { kind, nums };
      working = working.slice(0, subMatch.index).trim();
    }

    const seasonMatch = working.match(/ (?:(\d{1,2})(?:st|nd|rd|th) season|season (\d{1,2})|s(\d{1,2}))$/);
    if (seasonMatch && seasonMatch.index! > 0) {
      expectedSeason = Number(seasonMatch[1] || seasonMatch[2] || seasonMatch[3]);
      working = working.slice(0, seasonMatch.index).trim();
    }

    return {
      baseTitle: working || normalizedTitle,
      expectedSeason,
      expectedSubdivision,
    };
  }

  private static matchesLeadingSeriesTitle(
    releaseName: string,
    knownTitles: (string | null | undefined)[],
    allowUnmarkedSeason: boolean,
    verifiedCourAlias = false,
    allowVerifiedSeason = false,
  ): boolean {
    const release = this.normalizeSeriesTitle(releaseName);
    const releaseNum = this.normalizeSequelRomanNumerals(release);
    const episodeDivider = Array.from(releaseName.matchAll(/\s+[-–—]\s+(?=\d{1,4}(?:v\d+)?\b)/gi)).at(-1);
    const beforeEpisode = episodeDivider ? this.normalizeSeriesTitle(releaseName.slice(0, episodeDivider.index)) : "";
    const seasonStart = /^(?:(\d{1,2})(?:st|nd|rd|th) season|season (\d{1,2})|s(\d{1,2}))(?=e\d| |$)/;
    const subdivisionStart = /^(?:(\d{1,2}(?:st|nd|rd|th)(?: \d{1,2}(?:st|nd|rd|th))*) (stage|cour|part)|(stage|cour|part) (\d{1,2}))(?= |$)/;
    const releaseSuffix = /^(?:\d{1,4}(?:v\d+)?|e(?:p(?:isode)?)? ?\d+(?:v\d+)?|第 ?\d+ ?話|\d{3,4}p|4k|batch|complete|collection|web|bd|bluray|hevc|av1|h264|x264|x265)(?: |$)/;

    const numberedPrefixes = knownTitles
      .map(raw => (raw ? this.extractNumberedPrefix(raw) : null))
      .filter((prefix): prefix is string => Boolean(prefix));

    const consumePairedTitle = (candidateSuffix: string, useRomanNormalized: boolean): string => {
      if (!candidateSuffix) return candidateSuffix;
      const alternateTitles = [
        ...knownTitles.map(raw => {
          const norm = this.normalizeSeriesTitle(raw ?? "");
          return useRomanNormalized ? this.normalizeSequelRomanNumerals(norm) : norm;
        }),
        ...(useRomanNormalized ? numberedPrefixes : []),
      ].filter(Boolean);
      for (const alt of alternateTitles) {
        const end = this.seriesTitleEnd(candidateSuffix, alt);
        if (end > 0) return candidateSuffix.slice(end).trimStart();
      }
      return candidateSuffix;
    };

    const directMatch = knownTitles.some(raw => {
      const title = this.normalizeSeriesTitle(raw ?? "");
      if (!title) return false;
      if (release === title) return true;

      // Check full exact canonical title (including e.g. "2nd Season Part 2" or "2nd - 3rd STAGE") first.
      const fullEnd = this.seriesTitleEnd(release, title);
      if (fullEnd >= 0) {
        const fullSuffix = release.slice(fullEnd).trimStart();
        const hasNumberBeforeEp =
          /^\d/.test(beforeEpisode.slice(fullEnd).trimStart()) ||
          /^\d{1,4} (?:(?:s\d{1,2} ?)?e(?:p(?:isode)?)? ?\d+)/.test(fullSuffix);
        if (!hasNumberBeforeEp) {
          if (!fullSuffix || releaseSuffix.test(fullSuffix)) return true;
          const afterFullPaired = consumePairedTitle(fullSuffix, false);
          if (afterFullPaired !== fullSuffix && (!afterFullPaired || releaseSuffix.test(afterFullPaired))) return true;
        }
      }

      const { baseTitle, expectedSeason, expectedSubdivision } = this.stripTrailingSeasonAndSubdivision(title);
      const hasNamedSubtitle = Boolean(raw && this.extractSubtitledFranchise(raw)) || Boolean(expectedSubdivision);
      const titleEnd = this.seriesTitleEnd(release, baseTitle);
      if (titleEnd < 0) return false;

      let suffix = release.slice(titleEnd).trimStart();
      const releaseSeason = suffix.match(seasonStart);
      if (releaseSeason) {
        const season = Number(releaseSeason[1] || releaseSeason[2] || releaseSeason[3]);
        const allowsArcSeason = allowVerifiedSeason && hasNamedSubtitle && season > 1;
        if (expectedSeason !== null ? season !== expectedSeason : season !== 1 && !verifiedCourAlias && !allowsArcSeason) {
          return false;
        }
        suffix = suffix.slice(releaseSeason[0].length).trimStart();
      } else if (expectedSeason !== null && !allowUnmarkedSeason) {
        return false;
      }

      const releaseSub = suffix.match(subdivisionStart);
      if (releaseSub) {
        if (!expectedSubdivision) return false;
        const relKind = (releaseSub[2] || releaseSub[3]) as "stage" | "cour" | "part";
        const relRawNums = releaseSub[1] || releaseSub[4];
        const relNums = (relRawNums.match(/\d+/g) ?? []).map(n => String(Number(n))).join(" ");
        const kindCompatible =
          relKind === expectedSubdivision.kind ||
          ((relKind === "part" || relKind === "cour") &&
            (expectedSubdivision.kind === "part" || expectedSubdivision.kind === "cour"));
        if (!kindCompatible || relNums !== expectedSubdivision.nums) return false;
        suffix = suffix.slice(releaseSub[0].length).trimStart();
      } else if (expectedSubdivision !== null && !allowUnmarkedSeason) {
        return false;
      }

      if (!releaseSeason && !releaseSub && (
        /^\d/.test(beforeEpisode.slice(titleEnd).trimStart()) ||
        /^\d{1,4} (?:(?:s\d{1,2} ?)?e(?:p(?:isode)?)? ?\d+)/.test(suffix)
      )) {
        // A number in the title before the explicit episode separator can denote a different series.
        return false;
      }

      if (!suffix || releaseSuffix.test(suffix)) return true;
      const afterPaired = consumePairedTitle(suffix, false);
      return afterPaired !== suffix && (!afterPaired || releaseSuffix.test(afterPaired));
    });
    if (directMatch) return true;

    // Match swapped two-part colon titles when both halves are distinctive (e.g. "Steel Ball Run: JoJo no Kimyou na Bouken"
    // vs "JoJo no Kimyou na Bouken: Steel Ball Run" or "STEEL BALL RUN JoJo no Kimyou na Bouken 2nd - 3rd STAGE").
    const swappedMatch = knownTitles.some(raw => {
      if (!raw) return false;
      const strippedRaw = raw
        .trim()
        .replace(/\s*(?:[-:–~|/]+\s*)?(?:\d{1,2}(?:st|nd|rd|th)(?:\s*[-–—&]\s*\d{1,2}(?:st|nd|rd|th))*\s+(?:stage|cour|part)|(?:stage|cour|part)\s*\d{1,2}(?:\s*[-–—&]\s*\d{1,2})*)\s*$/i, "")
        .trim();
      const split = this.extractSubtitledFranchise(strippedRaw);
      if (!split) return false;
      const partA = this.normalizeSeriesTitle(split.franchise);
      const partB = this.normalizeSeriesTitle(split.subtitle);
      if (!partA || !partB || partA.split(" ").length < 2 || partB.split(" ").length < 2) return false;
      const swapped = `${partB} ${partA}`;
      const titleEnd = this.seriesTitleEnd(release, swapped);
      if (titleEnd < 0) return false;
      let suffix = release.slice(titleEnd).trimStart();
      const releaseSeason = suffix.match(seasonStart);
      if (releaseSeason) {
        const season = Number(releaseSeason[1] || releaseSeason[2] || releaseSeason[3]);
        if (season !== 1 && !allowVerifiedSeason && !verifiedCourAlias) return false;
        suffix = suffix.slice(releaseSeason[0].length).trimStart();
      }
      if (!allowUnmarkedSeason && strippedRaw !== raw.trim()) return false;
      return !suffix || releaseSuffix.test(suffix);
    });
    if (swappedMatch) return true;

    // Match explicitly numbered colon-prefixes (e.g. "Douluo Dalu II - Soul Land 2 - 178" against "Douluo Dalu 2: Jueshi Tangmen" / "Soul Land 2: ...").
    if (numberedPrefixes.length > 0) {
      const matchedNumberedPrefix = numberedPrefixes.some(prefix => {
        const titleEnd = this.seriesTitleEnd(releaseNum, prefix);
        if (titleEnd < 0) return false;
        let suffix = releaseNum.slice(titleEnd).trimStart();
        const afterPaired = consumePairedTitle(suffix, true);
        if (afterPaired !== suffix) suffix = afterPaired;
        const releaseSeason = suffix.match(seasonStart);
        if (releaseSeason) {
          const season = Number(releaseSeason[1] || releaseSeason[2] || releaseSeason[3]);
          const expectedSequel = Number(prefix.match(/(\d+)$/)?.[1]);
          if (season !== 1 && season !== expectedSequel) return false;
          suffix = suffix.slice(releaseSeason[0].length).trimStart();
        }
        return !suffix || releaseSuffix.test(suffix);
      });
      if (matchedNumberedPrefix) return true;
    }

    // For provider ID-verified releases (Tsukihime anime_id or AnimeTosho anidb_aid), allow standard TVDB/scene
    // "Franchise S04E08" naming (e.g. ToonsHub/VARYG/Judas) against subtitled sequel arcs like "Tokyo Revengers: Santen Sensou-hen"
    // or "Steel Ball Run: JoJo's Bizarre Adventure", strictly requiring S02+ and rejecting conflicting trailing arc subtitles.
    if (allowVerifiedSeason && !this.hasConflictingArcParen(releaseName, knownTitles)) {
      const matchedFranchiseSeason = knownTitles.some(raw => {
        if (!raw) return false;
        const split = this.extractSubtitledFranchise(raw);
        if (!split || split.hasExplicitSeason) return false;
        const candidates = [this.normalizeSeriesTitle(split.franchise)];
        const normalizedSub = this.normalizeSeriesTitle(split.subtitle);
        if (normalizedSub && normalizedSub.split(" ").length >= 2) {
          candidates.push(normalizedSub);
        }
        return candidates.some(franchise => {
          if (!franchise) return false;
          const titleEnd = this.seriesTitleEnd(release, franchise);
          if (titleEnd < 0) return false;
          let suffix = release.slice(titleEnd).trimStart();
          const releaseSeason = suffix.match(seasonStart);
          if (!releaseSeason) return false;
          const season = Number(releaseSeason[1] || releaseSeason[2] || releaseSeason[3]);
          if (season < 2) return false;
          suffix = suffix.slice(releaseSeason[0].length).trimStart();
          return !suffix || releaseSuffix.test(suffix);
        });
      });
      if (matchedFranchiseSeason) return true;
    }

    return false;
  }

  private static findTrailingCourAlias(
    releaseName: string,
    knownTitles: (string | null | undefined)[],
    allowUnmarkedSeason: boolean,
  ): { relativeEpisode?: number } | undefined {
    const namedCourTitles = knownTitles.flatMap(raw => {
      if (!raw) return [];
      const cleaned = raw.trim().replace(this.TRAILING_STAGE_OR_COUR_RANGE, "").trim() || raw.trim();
      const entries: { title: string; franchise: string }[] = [];
      const dashParts = cleaned.split(/\s+[-–—]\s+/);
      if (dashParts.length > 1) {
        entries.push({ title: raw, franchise: dashParts.slice(0, -1).join(" ") });
      }
      const colon = cleaned.match(/^([^:]+):\s*(.+)$/);
      if (colon && colon[1].trim() && colon[2].trim()) {
        entries.push({ title: raw, franchise: colon[1].trim() });
      }
      return entries;
    });
    if (!namedCourTitles.length) return;

    const franchiseTitles = Array.from(new Set(namedCourTitles.map(cour => cour.franchise)));
    const aliases = releaseName.matchAll(/(?:\(([^()]*)\)|\[([^\[\]]*)\])(?=(?:\s*(?:\([^()]*\)|\[[^\]]*\]))*\s*$)/g);
    for (const alias of aliases) {
      const rawAliasTitle = alias[1] ?? alias[2];
      // Strip trailing audio/sub tag clauses inside the same parenthesis (e.g. "(JoJo no Kimyou na Bouken: Steel Ball Run, Dual-Audio, Multi-Subs)")
      const aliasTitle = rawAliasTitle
        .replace(/(?:,\s*(?:dual[\s._-]*audio|multi[\s._-]*(?:audio|subs?|dub)|english[\s._-]*dub|eng[\s._-]*dub|subbed|dubbed|weekly|uncensored|censored))+\s*$/i, "")
        .trim();
      const normalizedAlias = this.normalizeSeriesTitle(aliasTitle);
      const leadingTitle = releaseName.slice(0, alias.index);
      for (const { title } of namedCourTitles) {
        if (this.matchesSplitCourTitle(leadingTitle, normalizedAlias, title)) return {};
        const end = this.seriesTitleEnd(normalizedAlias, this.normalizeSeriesTitle(title));
        if (end >= 0) {
          const suffix = normalizedAlias.slice(end).trim();
          const episode = suffix.match(/^(?:(?:s(\d{1,2}) ?)?e(?:p(?:isode)?)? ?)?(\d{1,4})(?:v\d+)?$/);
          if (suffix && (!episode || Number(episode[1]) === 0 || Number(episode[2]) === 0)) continue;
          if (!this.matchesLeadingSeriesTitle(aliasTitle, [title], true, true)) continue;
          if (this.matchesLeadingSeriesTitle(leadingTitle, franchiseTitles, allowUnmarkedSeason, true)) {
            return { relativeEpisode: episode ? Number(episode[2]) : undefined };
          }
          continue;
        }
        // Also support verified full alias inside parens when the leading title is the franchise + S02+E##
        // (e.g. "[ToonsHub] JoJos Bizarre Adventure S06E10 ... (JoJo no Kimyou na Bouken: Steel Ball Run, Dual-Audio, Multi-Subs)")
        if (allowUnmarkedSeason && this.matchesLeadingSeriesTitle(aliasTitle, [title], true, true, true)) {
          const leadingNorm = this.normalizeSeriesTitle(leadingTitle);
          if (/\bs0?[2-9]\s*e0*[1-9]\d*\b|\bs[1-9]\d\s*e0*[1-9]\d*\b/.test(leadingNorm)) {
            return {};
          }
        }
      }
    }
  }

  private static matchesSplitCourTitle(leadingTitle: string, normalizedAlias: string, canonicalTitle: string): boolean {
    // Some releases put the numbered franchise first and the complete cour subtitle in brackets.
    const canonical = canonicalTitle.normalize("NFKC").match(/^([^:]+):\s*(.+)$/);
    if (!canonical || this.seriesTitleEnd(normalizedAlias, this.normalizeSeriesTitle(canonical[2])) !== normalizedAlias.length) {
      return false;
    }
    const prefix = this.normalizeSeriesTitle(leadingTitle);
    const franchise = this.normalizeSeriesTitle(canonical[1]);
    const franchiseEnd = this.seriesTitleEnd(prefix, franchise);
    if (!franchise || franchiseEnd < 0) return false;
    const numbered = prefix.slice(franchiseEnd).trimStart().match(/^s(\d{1,2}) ?e(\d{1,4})(?:v\d+)?$/);
    // The alias identifies the cour. Episode matching still uses a file number or a trusted mapping.
    return Boolean(numbered && Number(numbered[1]) > 0 && Number(numbered[2]) > 0);
  }

  private static expandKnownTitleVariants(
    knownTitles?: (string | null | undefined)[],
  ): RegExp[] {
    if (!knownTitles || knownTitles.length === 0) return [];
    const variants = new Set<string>();
    const trailingSeasonSuffixRx =
      /\s*(?:[-:–~|/]+\s*)?(?:(?:\d+(?:st|nd|rd|th)(?:\s*[-–—&]\s*\d+(?:st|nd|rd|th))*\s+(?:Season|Stage|Cour|Part))|(?:(?:Season|Stage|Part|Cour)\s*\d+(?:\s*[-–—&]\s*\d+)?)|(?:S\d+))\s*$/i;

    for (const raw of knownTitles) {
      if (!raw) continue;
      const trimmed = raw.trim();
      if (!trimmed) continue;
      variants.add(trimmed);
      let base = trimmed;
      for (let pass = 0; pass < 2; pass++) {
        const next = base.replace(trailingSeasonSuffixRx, "").trim();
        if (!next || next === base) break;
        base = next;
        if (base.length >= 2) {
          variants.add(base);
        }
      }
      // Also strip colon-split franchise/numbered-sequel prefixes (e.g. "Douluo Dalu 2", "Douluo Dalu II", "Soul Land 2")
      // so sequel numbers before " - <ep>" are never misparsed as episode ranges.
      const split = this.extractSubtitledFranchise(trimmed);
      if (split) {
        const prefix = split.franchise.trim();
        if (prefix.length >= 2) {
          variants.add(prefix);
          const arabicToRoman = prefix.replace(/\b([2-9]|10)$/, (n) => this.SEQUEL_ARABIC_TO_ROMAN[n] ?? n);
          if (arabicToRoman !== prefix) variants.add(arabicToRoman);
          const romanToArabic = prefix.replace(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)$/i, (r) =>
            this.SEQUEL_ROMAN_TO_ARABIC[r.toLowerCase()] ?? r,
          );
          if (romanToArabic !== prefix) variants.add(romanToArabic);
        }
      }
    }

    const sorted = Array.from(variants).sort((a, b) => b.length - a.length);
    const regexes: RegExp[] = [];

    for (const title of sorted) {
      let pattern = "";
      let i = 0;
      while (i < title.length) {
        const ch = title[i];
        if (ch === "'" || ch === "’" || ch === "`") {
          pattern += "['’`]?";
          i++;
        } else if (/[\s:\-–—]/.test(ch)) {
          let hadColonOrDash = false;
          let hadSpace = false;
          while (i < title.length && /[\s:\-–—]/.test(title[i])) {
            if (title[i] === ":" || title[i] === "-" || title[i] === "–" || title[i] === "—") {
              hadColonOrDash = true;
            } else {
              hadSpace = true;
            }
            i++;
          }
          if (hadColonOrDash && !hadSpace) {
            pattern += "[\\s._:\\-–—]*";
          } else if (hadColonOrDash) {
            pattern += "[\\s._:\\-–—]+";
          } else {
            pattern += "[\\s._-]+";
          }
        } else {
          pattern += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          i++;
        }
      }
      if (!pattern) continue;
      const startsAlnum = /^[a-zA-Z0-9]/.test(title);
      const endsAlnum = /[a-zA-Z0-9]$/.test(title);
      const prefix = startsAlnum ? "(?<![a-zA-Z0-9])" : "";
      const suffix = endsAlnum ? "(?![a-zA-Z0-9])" : "";
      regexes.push(new RegExp(`${prefix}${pattern}${suffix}`, "gi"));
    }

    return regexes;
  }

  public static stripNoiseForEpisodeParsing(
    text: string,
    knownTitles?: (string | null | undefined)[],
  ): string {
    let s = path.basename(text);
    s = s.replace(/\.(?:mkv|mp4|avi|webm|ass|srt|vtt)$/i, "");
    s = s.replace(/^\s*\[[^\]]+\]\s*/, "");
    s = s.replace(/[\[\(][0-9A-Fa-f]{8}[\]\)]/g, " ");

    const titleRegexes = this.expandKnownTitleVariants(knownTitles);
    for (const rx of titleRegexes) {
      s = s.replace(rx, " ");
    }

    s = s.replace(/\[(?![0-9]{1,4}\s*[-~–]\s*[0-9]{1,4}\])[^\]]*\]/g, " ");
    s = s.replace(/\((?![0-9]{1,4}\s*[-~–]\s*[0-9]{1,4}\))[^\)]*\)/g, " ");

    for (const rx of titleRegexes) {
      s = s.replace(rx, " ");
    }

    s = s.replace(
      /\b(?:2160p|1080p|720p|576p|540p|480p|360p|4k|uhd|fhd|hd|sd|hevc|av1|x264|x265|h\.?264|h\.?265|avc1?|10\s*-?bit|8\s*-?bit|hi10p|aac[\s._-]*\d*(?:\.\d)?|eac3[\s._-]*\d*(?:\.\d)?|ac3[\s._-]*\d*(?:\.\d)?|flac|opus|ddp[\s._-]*\d*(?:\.\d)?|dts(?:-hd)?|web-dl|webrip|bluray|bdrip|bdremux|remux|hdtv|cr|amzn|nf|dsnp|hidive|b-global|dual[\s._-]*audio|multi[\s._-]*(?:audio|subs?)|(?:19|20)\d{2})\b/gi,
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

    if (!isForeign && /\b(?:dub|simuldub|eng(?:lish)?[\s._-]*dub|dubbed)\b/i.test(lower)) {
      isEnglishDub = true;
    }

    // Use explicit audio/subtitle language arrays from Tsukihime when available
    if (Array.isArray(item?.audiolangs) && item.audiolangs.length > 0) {
      const audioLangs = item.audiolangs.map((l) => String(l).toLowerCase().trim());
      const hasOriginalAudio = audioLangs.some(
        lang => /^(?:ja|jp|jpn|japanese|zh|zho|chi|cmn|chinese|ko|kor|korean)(?:[-_]|$)/.test(lang),
      );
      const hasEnAudio = audioLangs.some(
        (l) => l === "en" || l === "eng" || l.startsWith("en-") || l.startsWith("eng"),
      );
      if (hasOriginalAudio && hasEnAudio) {
        isDualAudio = true;
        isEnglishDub = true;
        isForeign = false;
      } else if (hasEnAudio && !hasOriginalAudio) {
        isDualAudio = false;
        isEnglishDub = true;
        isForeign = false;
      } else if (hasOriginalAudio && !hasEnAudio) {
        isDualAudio = false;
        isEnglishDub = false;
      } else {
        isDualAudio = false;
        isEnglishDub = false;
        isForeign = true;
      }
    }
    const hasExplicitSubLangs = Array.isArray(item?.sublangs);
    const explicitSubLangs = hasExplicitSubLangs
      ? item!.sublangs!.map((l) => String(l).toLowerCase().trim()).filter(Boolean)
      : [];
    const hasExplicitEnSub = explicitSubLangs.some(
      (l) => l === "en" || l === "eng" || l === "multi" || l.startsWith("en-") || l.startsWith("eng"),
    );
    if (explicitSubLangs.length > 0) {
      if (!hasExplicitEnSub && !isEnglishDub && !isDualAudio) {
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

    const isWeirdOrPromo = this.WEIRD_OR_PROMO_PATTERN.test(lower) || this.hasWatermarkedSource(titleClean);
    const isUnsupportedContainer = this.UNSUPPORTED_CONTAINER_PATTERN.test(lower) || is4k;

    const cleaned = this.stripNoiseForEpisodeParsing(titleClean, knownTitles);
    let cleanedForEp = cleaned;

    let seasonNum: number | null = null;
    let singleEp: number | null = null;
    let epRange: [number, number] | null = null;

    const ordinalSeasonMatch = cleanedForEp.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+Season\b/i);
    if (ordinalSeasonMatch) {
      seasonNum = parseInt(ordinalSeasonMatch[1], 10);
      cleanedForEp = cleanedForEp.replace(/\b\d{1,2}(?:st|nd|rd|th)\s+Season\b/gi, " ");
    }

    const prefixSeasonMatch = cleanedForEp.match(/\bS(?:eason)?\s*0?(\d{1,2})(?=\b|[\s._-])/i);
    if (prefixSeasonMatch && seasonNum === null) {
      seasonNum = parseInt(prefixSeasonMatch[1], 10);
    }

    cleanedForEp = cleanedForEp.replace(
      /\b(?:Season|Part|Cour|Stage|Act|Vol(?:ume)?)\s*0?\d{1,2}(?=\b|[\s._-])/gi,
      " ",
    );

    const rangeMatch = cleanedForEp.match(
      /(?:(?:S(?:eason\s*)?0?(\d{1,2})[\s._-]*)?E(?:p(?:isode)?\s*)?0*(\d{1,4})|(?:\b|[\(\[\s_-])0*(\d{1,4}))(\s*[-~–]\s*)(?:(?:S(?:eason\s*)?0?\d{1,2}[\s._-]*)?E(?:p(?:isode)?\s*)?|(?:\b|[\(\[\s_-]))?0*(\d{1,4})(?:v\d+)?(?=\b|[\)\]\s_.-]|$)/i,
    );
    if (rangeMatch) {
      const fullMatch = rangeMatch[0];
      const matchStart = rangeMatch.index ?? 0;
      const beforeMatch = cleanedForEp.slice(0, matchStart);
      const separator = rangeMatch[4];
      const rStart = parseInt(rangeMatch[2] || rangeMatch[3], 10);
      const rEnd = parseInt(rangeMatch[5], 10);
      const hasExplicitEpPrefix = Boolean(rangeMatch[1] || rangeMatch[2]);
      const isSpacedHyphen = /^\s+-\s+$/.test(separator);
      const startsZeroPadded = /^(?:[\(\[\s_-])*0\d/.test(fullMatch);
      // Guard against "<Title> 2 - 178" (sequel number in title followed by standard " - <ep>" divider).
      const looksLikeSequelTitleBeforeEp =
        !hasExplicitEpPrefix &&
        isSpacedHyphen &&
        !startsZeroPadded &&
        rStart >= 0 &&
        rStart <= 10 &&
        /\p{L}\s*$/u.test(beforeMatch) &&
        !/[([{\s_-]$/.test(beforeMatch.trimEnd());
      if (!looksLikeSequelTitleBeforeEp && rStart >= 0 && rStart < rEnd && rEnd <= 2000) {
        if (rangeMatch[1]) {
          seasonNum = parseInt(rangeMatch[1], 10);
        }
        epRange = [rStart, rEnd];
      }
    }

    if (!epRange) {
      const seMatch = cleanedForEp.match(
        /\bS(?:eason\s*)?0?(\d{1,2})[\s._-]*E(?:p(?:isode)?\s*)?0*(\d{1,4})(?:v\d+)?\b/i,
      );
      if (seMatch) {
        seasonNum = parseInt(seMatch[1], 10);
        singleEp = parseInt(seMatch[2], 10);
      } else {
        const seasonMatch = cleanedForEp.match(/\bS(?:eason\s*)?0?(\d{1,2})\b/i);
        if (seasonMatch && seasonNum === null) {
          seasonNum = parseInt(seasonMatch[1], 10);
        }
      }

      if (singleEp === null) {
        const explicitMatches = Array.from(
          cleanedForEp.matchAll(
            /(?:-\s+|\b[eE][pP](?:isode)?[\s._-]*|\b[eE])0*(\d{1,4})(?:v\d+)?(?=\b|[\s\(\[\._-]|$)/g,
          ),
        );
        if (explicitMatches.length > 0) {
          singleEp = parseInt(explicitMatches[explicitMatches.length - 1][1], 10);
        } else {
          const tailMatches = Array.from(
            cleanedForEp.trim().matchAll(/(?:^|[\s._-])0*(\d{2,3})(?:v\d+)?(?=\s*$)/g),
          );
          if (tailMatches.length > 0) {
            singleEp = parseInt(tailMatches[tailMatches.length - 1][1], 10);
          }
        }
      }
    }

    const isHardBonus = this.HARD_BONUS_OR_EXTRA_PATTERN.test(path.basename(titleClean));
    const hasRegularNumberedEp =
      (seasonNum !== null && seasonNum > 0 && singleEp !== null && singleEp > 0) ||
      (typeof item?.tsukihime_episode_no === "number" && item.tsukihime_episode_no > 0);
    const isSoftBonus = !hasRegularNumberedEp && this.BONUS_OR_EXTRA_PATTERN.test(cleaned);
    const isBonusOrExtra = isHardBonus || isSoftBonus || seasonNum === 0;

    const isBatch =
      /\b(?:batch|complete|collection|full\s*season)\b/.test(lower) ||
      epRange !== null ||
      (seasonNum !== null && singleEp === null);

    const isSeasonBatch =
      /\b(?:complete|collection|full\s*season|all\s*episodes)\b/i.test(lower) ||
      (/\bs(?:eason)?\s*0?(\d{1,2})\b/i.test(lower) &&
        singleEp === null &&
        epRange === null &&
        !/\be(?:p(?:isode)?)?\s*0*(\d{1,4})\b/i.test(lower));

    const relativeEpisode = !isBatch && knownTitles?.length && singleEp !== null
      ? this.findTrailingCourAlias(
        this.releaseName(titleClean),
        knownTitles,
        item?.provider === "tsukihime" || Number(item?.anidb_aid) > 0,
      )?.relativeEpisode
      : undefined;

    return {
      group,
      groupLower,
      singleEp,
      relativeEpisode,
      epRange,
      seasonNum,
      isBatch,
      isSeasonBatch,
      isDualAudio,
      isEnglishDub,
      lacksSubtitles: /\b(?:raw|no[ ._-]*subs?(?:titles?)?|unsubbed)\b/i.test(lower)
        || (hasExplicitSubLangs && (explicitSubLangs.length === 0 || !hasExplicitEnSub)),
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
      isBonusOrExtra,
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
    if (!this.matchesCandidateTitle(item, knownTitles)) return false;
    const parsed = this.parseTitle(item.title || "", knownTitles, item);
    if (parsed.isWeirdOrPromo || parsed.isUnsupportedContainer) return false;
    const seeders = item.seeders || 0;
    const isTier1 = this.TRUSTED_GROUPS_TIER_1.has(parsed.groupLower);
    const isTier2 = this.TRUSTED_GROUPS_TIER_2.has(parsed.groupLower);
    const isSeadex = Boolean(item.is_seadex);
    const isDub = String(langType).toLowerCase() === "dub";
    const isAll = String(langType).toLowerCase() === "all";
    const isSingleEpTarget = String(targetEp).toLowerCase() !== "all";

    // Never stop pagination early on a batch torrent when searching for a single episode
    if (isSingleEpTarget && (parsed.isBatch || (item.num_files || 1) > 1)) {
      return false;
    }

    // Strongly prefer stopping early only when we have a viable H.264 1080p solo candidate
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

    if (isAll && !parsed.isDualAudio) return false;

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
    knownTitles?: (string | null | undefined)[],
    expectedOffset?: number,
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
      if (parsed.lacksSubtitles || (parsed.isForeign && !parsed.isDualAudio)) return false;
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

    if (!parsed.isBatch) {
      if (parsed.singleEp === null) return false;
      const indexed = this.providerEpisode(item);
      const relative = this.mappedRelativeEpisode(parsed, item, totalExpectedEps, knownTitles, expectedOffset);
      if ((parsed.relativeEpisode !== undefined && relative === undefined) ||
        (indexed !== undefined && indexed !== parsed.singleEp && indexed !== relative)) return false;
      return parsed.singleEp === targetEpNum || relative === targetEpNum;
    }

    // For batch torrents when targeting a single episode:
    // Reject if the batch only has 1 file (monolithic combined file/archive cannot extract 1 episode!)
    if (parsed.isBatch || parsed.epRange !== null) {
      if (item?.num_files !== undefined && item.num_files <= 1) {
        return false;
      }
    }

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
    expectedOffset?: number,
  ): number {
    if (!this.matchesCandidateTitle(item, knownTitles)) return -10_000;
    const parsed = this.parseTitle(item.title || "", knownTitles, item);
    const numFiles = item.num_files || 1;
    const seeders = item.seeders || 0;
    const isSeadex = Boolean(item.is_seadex);

    if (!this.matchesTarget(parsed, targetEp, langType, numFiles, totalExpectedEps, item, knownTitles, expectedOffset)) {
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
      if (!parsed.isBatch && numFiles === 1 &&
        (parsed.singleEp === targetEpNum || parsed.relativeEpisode === targetEpNum || isTsukihimeEpMatch)) {
        score += 120;
        if (isTsukihimeEpMatch) score += 15;
      } else if (parsed.isBatch || numFiles > 1) {
        score -= 80;
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

  private static torrentKey(item: AnimeToshoItem): string {
    return torrentIdentityKey(item);
  }

  private static isVerifiedProviderItem(item?: AnimeToshoItem): boolean {
    return Boolean(item && (item.provider === "tsukihime" || Number(item.anidb_aid) > 0));
  }

  private static matchesCandidateTitle(item: AnimeToshoItem, knownTitles?: (string | null | undefined)[]) {
    const verified = this.isVerifiedProviderItem(item);
    return typeof item.title === "string" && Boolean(item.title.trim()) &&
      (!knownTitles?.length || this.matchesSeriesTitle(item.title, knownTitles, {
        allowUnmarkedSeason: verified,
        allowVerifiedSeason: verified,
      }));
  }

  private static providerEpisode(item?: AnimeToshoItem): number | undefined {
    const episode = item?.tsukihime_episode_no;
    return typeof episode === "number" && Number.isSafeInteger(episode) && episode > 0 &&
      (item?.provider === "tsukihime" || item?.tsukihime_id) ? episode : undefined;
  }

  private static mappedRelativeEpisode(
    parsed: ParsedReleaseTitle,
    item?: AnimeToshoItem,
    expectedCount?: number | null,
    knownTitles?: (string | null | undefined)[],
    expectedOffset?: number,
  ): number | undefined {
    const absolute = parsed.singleEp;
    if (parsed.isBatch || absolute === null) return;
    const indexed = this.providerEpisode(item);
    const alias = parsed.relativeEpisode;
    if (alias !== undefined) {
      if (alias <= absolute && (!expectedCount || alias <= expectedCount) &&
        (indexed === undefined || indexed === alias || indexed === absolute)) return alias;
      return;
    }
    if (expectedOffset && expectedOffset > 0 && indexed !== undefined && absolute - indexed === expectedOffset) {
      return indexed;
    }
    const continuation = !knownTitles?.length || knownTitles.some(title =>
      title && (/\s[-–—]\s/.test(title) || /\b(?:season\s*\d+|\d+(?:st|nd|rd|th)\s+(?:season|stage|cour|part)|stage\s*\d+|part\s*\d+|cour\s*\d+|s\d+)$/i.test(title.trim())));
    if (indexed !== undefined && continuation && absolute > indexed &&
      this.VALID_COUR_OFFSETS.has(absolute - indexed) &&
      (expectedCount ? (indexed <= expectedCount && absolute > expectedCount) : indexed <= 26)) {
      return indexed;
    }
  }

  public static inferCumulativeOffsets(
    torrentList: AnimeToshoItem[],
    targetEpNum: number,
    knownTitles?: (string | null | undefined)[],
    totalExpectedEps?: number | null,
  ): number[] {
    if (Number.isNaN(targetEpNum) || targetEpNum <= 0) return [];

    const mappings = new Map<number, Set<number>>();
    for (const t of torrentList) {
      if ((t.seeders || 0) <= 0 || !this.matchesCandidateTitle(t, knownTitles)) continue;
      const parsed = this.parseTitle(t.title || "", knownTitles, t);
      if (parsed.isBonusOrExtra || parsed.seasonNum === 0 || parsed.isWeirdOrPromo || parsed.isUnsupportedContainer) {
        continue;
      }

      const relative = this.mappedRelativeEpisode(parsed, t, totalExpectedEps, knownTitles);
      if (relative !== undefined && parsed.singleEp !== null && parsed.singleEp > relative) {
        const offset = parsed.singleEp - relative;
        const episodes = mappings.get(offset) ?? new Set<number>();
        episodes.add(relative);
        mappings.set(offset, episodes);
      }
    }

    // Multiple mappings cannot safely translate a release that has no mapping of its own.
    if (mappings.size !== 1) return [];
    return [...mappings].filter(([, episodes]) => episodes.has(targetEpNum) || episodes.size >= 2).map(([offset]) => offset);
  }

  /**
   * Deterministic 3-Tier Waterfall + Strict Solo-Over-Batch Selection:
   *
   * 1. Tier 1 ("h264_multi" -> Pipeline 1 "vm_remux"):
   *    Identify a 1080p H.264 release group that ALSO has 720p and/or 480p from the EXACT same group.
   *    If the first 1080p H.264 group lacks 720p/480p, it goes back to 1080p candidates and picks another
   *    H.264 group whose lower qualities (720p/480p) ARE available.
   *    Groups with all 3 qualities (1080p + 720p + 480p) rank highest, followed by 2 qualities.
   *
   * 2. Tier 2 ("h264_single_1080p" -> Pipeline 1 "vm_remux", 1 quality only):
   *    If NO H.264 group has lower qualities (720p/480p), fall back to the best 1080p H.264 release
   *    and ONLY process 1 quality (1080p) via VM Direct-Remux (-c:v copy).
   *
   * 3. Tier 3 ("hevc_av1_gpu" -> Pipeline 2 "kaggle_gpu"):
   *    If not even a single 1080p H.264 release exists, select the best 1080p HEVC (x265) or AV1 release
   *    and route it to the second pipeline (Kaggle Dual-T4 GPU Batch Transcoder).
   *
   * Solo vs Batch Rule:
   *    Solo (single-episode) releases ALWAYS outrank multi-episode batch torrents (+10,000 solo priority).
   */
  public static selectTopCandidateBundles(
    torrentList: AnimeToshoItem[],
    targetEp: number | string,
    langType: string,
    options: {
      knownTitles?: (string | null | undefined)[];
      totalExpectedEps?: number | null;
      episodeOffset?: number;
      strictEpisodeOffset?: boolean;
      maxBundles?: number;
      minSeeders?: number;
    } = {},
  ): ReleaseCandidateBundle[] {
    const {
      knownTitles,
      totalExpectedEps,
      episodeOffset = 0,
      strictEpisodeOffset = false,
      maxBundles = 5,
      minSeeders = DEFAULT_MIN_SEEDERS,
    } = options;
    const isSingleEpTarget = String(targetEp).toLowerCase() !== "all";
    const target = Number(targetEp);
    if (isSingleEpTarget && (!Number.isSafeInteger(target) || target < 0 ||
      (typeof targetEp === "string" && !/^\d+$/.test(targetEp)) ||
      (totalExpectedEps && totalExpectedEps > 0 && target > totalExpectedEps))) return [];

    const blocked = new Set(torrentList.filter(item => this.hasWatermarkedSource(item.title)).map(item => this.torrentKey(item)));
    const eligibleTorrents = torrentList.filter(item =>
      !blocked.has(this.torrentKey(item)) && this.matchesCandidateTitle(item, knownTitles));
    const useStrictOffset = isSingleEpTarget && episodeOffset > 0 && strictEpisodeOffset;
    const candidatesToTry: (number | string)[] = useStrictOffset ? [target + episodeOffset] : [targetEp];
    const absoluteMatches = new Set<number>();

    if (isSingleEpTarget) {
      for (const item of eligibleTorrents) {
        if ((item.seeders ?? 0) <= 0) continue;
        const parsed = this.parseTitle(item.title, knownTitles, item);
        if (parsed.isWeirdOrPromo || parsed.isBonusOrExtra || parsed.isUnsupportedContainer) continue;
        if (parsed.singleEp !== null && parsed.singleEp > target &&
          this.mappedRelativeEpisode(parsed, item, totalExpectedEps, knownTitles, episodeOffset || undefined) === target) {
          absoluteMatches.add(parsed.singleEp);
        }
      }
      if (!useStrictOffset && episodeOffset && episodeOffset > 0) {
        candidatesToTry.unshift(target + episodeOffset);
      }
      const inferredOffsets = episodeOffset > 0 ? [] : this.inferCumulativeOffsets(
        eligibleTorrents,
        target,
        knownTitles,
        totalExpectedEps,
      );
      for (const off of inferredOffsets) {
        const mappedEp = target + off;
        if (!candidatesToTry.includes(mappedEp)) {
          log.info(
            "ReleaseFilter",
            `Cumulative numbering offset +${off} detected (Ep ${target} -> Ep ${mappedEp})`,
          );
          candidatesToTry.push(mappedEp);
        }
      }
    }

    const bestByItemKey = new Map<
      string,
      {
        score: number;
        item: AnimeToshoItem;
        effectiveEp: number | string;
        parsed: ParsedReleaseTitle;
      }
    >();

    for (const candidateEp of candidatesToTry) {
      const isDirectMatch = !useStrictOffset && candidateEp === targetEp;
      for (const t of eligibleTorrents) {
        let score = this.scoreTorrent(
          t,
          candidateEp,
          langType,
          knownTitles,
          totalExpectedEps,
          episodeOffset > 0 ? episodeOffset : undefined,
        );
        if (score > 0) {
          if (isDirectMatch) {
            score += 15;
          }
          const parsed = this.parseTitle(t.title || "", knownTitles, t);
          const relative = this.mappedRelativeEpisode(
            parsed,
            t,
            totalExpectedEps,
            knownTitles,
            episodeOffset > 0 ? episodeOffset : undefined,
          );
          if (isSingleEpTarget) {
            if (relative !== undefined && relative !== target) continue;
            if (relative === target && parsed.singleEp !== target &&
              (episodeOffset > 0 ? parsed.singleEp !== target + episodeOffset : absoluteMatches.size > 1)) continue;
          }
          // A scoped provider may omit the expected season/stage/part marker for a verified cumulative offset,
          // while an explicit S02+ season tag on a verified provider entry is allowed for subtitled sequel arcs.
          const verified = this.isVerifiedProviderItem(t);
          const verifiedOffsetRelease = verified && episodeOffset > 0 && candidateEp === target + episodeOffset;
          if (relative === undefined && knownTitles?.length && !this.matchesSeriesTitle(t.title, knownTitles, {
            allowUnmarkedSeason: verifiedOffsetRelease,
            allowVerifiedSeason: verified,
          })) continue;
          const effectiveEpForFile = relative === target && parsed.singleEp !== null ? parsed.singleEp : candidateEp;
          const key = this.torrentKey(t);
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
      const itemUniqueId = this.torrentKey(item);

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
    const isAllLang = String(langType).toLowerCase() === "all";

    for (const b of bundleMap.values()) {
      const q1080 = b.qualities["1080p"];
      const q720 = b.qualities["720p"];
      const q480 = b.qualities["480p"];

      const primaryEntry = q1080 || q720 || q480;
      if (!primaryEntry) continue;

      const hasLowerSameGroup = Boolean(b.groupLower && q1080 && (q720 || q480));
      const hasAllThreeSameGroup = Boolean(b.groupLower && q1080 && q720 && q480);

      let selectionTier: CandidateSelectionTier;
      let pipelineType: PipelineExecutionType;
      let effectiveQualities: Partial<Record<VideoResolutionQuality, ReleaseQualityEntry>>;
      let tierBonus = 0;

      if (b.isH264 && hasLowerSameGroup) {
        // Tier 1: Same-group H.264 with 1080p AND lower qualities (720p and/or 480p)
        selectionTier = "h264_multi";
        pipelineType = "vm_remux";
        effectiveQualities = b.qualities;
        tierBonus = 3000 + (hasAllThreeSameGroup ? 250 : 100);
      } else if (b.isH264) {
        // Tier 2: Best 1080p H.264 without lower qualities -> process ONLY 1 quality (1080p) on VM Remux!
        selectionTier = "h264_single_1080p";
        pipelineType = "vm_remux";
        effectiveQualities = { [primaryEntry.quality]: primaryEntry };
        tierBonus = q1080 ? 2000 : 1500;
      } else {
        // Tier 3: HEVC / AV1 fallback -> route to Pipeline 2 (Kaggle Dual-T4 GPU Encode)
        selectionTier = "hevc_av1_gpu";
        pipelineType = "kaggle_gpu";
        effectiveQualities = { [primaryEntry.quality]: primaryEntry };
        tierBonus = q1080 ? 1000 : 600;
      }

      // Solo vs Batch priority: Live solo releases ALWAYS outrank batch torrents when targeting a single episode
      const hasLiveSeeders = (primaryEntry.item.seeders ?? 1) > 0;
      const soloBonus = isSingleEpTarget && b.isSolo && hasLiveSeeders ? 10000 : 0;
      const dualAudioPreferenceBonus =
        isAllLang && b.isDualAudio
          ? 1500
          : isAllLang && b.isEnglishDub && !b.isDualAudio
            ? -2500
            : 0;
      const bundleScore = soloBonus + tierBonus + dualAudioPreferenceBonus + primaryEntry.score;

      bundles.push({
        group: b.group,
        groupLower: b.groupLower,
        isH264: b.isH264,
        isDualAudio: b.isDualAudio,
        isEnglishDub: b.isEnglishDub,
        isSolo: b.isSolo,
        selectionTier,
        pipelineType,
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
      strictEpisodeOffset?: boolean;
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
      strictEpisodeOffset?: boolean;
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

  /** Maps files with verifiable series and episode labels. Conflicting matches stay unmapped. */
  public static matchFilesToEpisodes(
    files: { name?: string; length?: number }[],
    options: {
      knownTitles?: (string | null | undefined)[];
      targetEp?: number | string | null;
      effectiveEp?: number | string | null;
      totalExpectedEps?: number | null;
      allowWatermarkedSource?: boolean;
      allowVerifiedSeason?: boolean;
      manualTorrent?: boolean;
      torrentTitle?: string;
    } = {},
  ): Map<number, [number, string]> {
    const epMap = new Map<number, [number, string]>();
    const {
      knownTitles = [],
      targetEp,
      effectiveEp,
      torrentTitle,
      totalExpectedEps,
      allowWatermarkedSource = false,
      allowVerifiedSeason = false,
      manualTorrent = false,
    } = options;
    if (!Array.isArray(files) || (!manualTorrent && !knownTitles.some(title => title?.trim()))) return epMap;

    const singleEpisode = targetEp != null && String(targetEp).toLowerCase() !== "all";
    const target = singleEpisode ? Number(targetEp) : null;
    const expected = singleEpisode ? Number(effectiveEp ?? targetEp) : null;
    if (target !== null && (!Number.isSafeInteger(target) || target < 1)) return epMap;
    if (expected !== null && (!Number.isSafeInteger(expected) || expected < 1)) return epMap;

    const videoName = (name: unknown): name is string => typeof name === "string" && /\.(?:mkv|mp4|avi|webm)$/i.test(name);
    const safeVideoFiles = files
      .map((f, idx) => ({ idx, relPath: f?.name }))
      .filter((entry): entry is { idx: number; relPath: string } => {
        if (!videoName(entry.relPath) || /^[a-z]:|[\u0000-\u001f\u007f]/i.test(entry.relPath)) return false;
        const segments = entry.relPath.split(/[\\/]/);
        if (segments.some(segment => !segment || segment === "." || segment === "..")) return false;
        const folders = segments.slice(0, -1);
        return !folders.some(segment => /^(?:extras?|bonus|samples?|specials?|ncop|nced)$/i.test(segment) ||
          /^(?:s|season\s*)0+$/i.test(segment));
      });

    // If an operator explicitly pinned a manual torrent and it has a single safe video file, select it directly.
    if (manualTorrent && target !== null && safeVideoFiles.length === 1) {
      const only = safeVideoFiles[0];
      const parsedOnly = this.parseTitle(only.relPath.split(/[\\/]/).at(-1)!, knownTitles);
      if (!parsedOnly.isBatch) {
        epMap.set(target, [only.idx, only.relPath]);
        return epMap;
      }
    }

    if (knownTitles.some(title => title?.trim())) {
      const titleMatch = {
        allowUnmarkedSeason: expected !== null && expected !== target,
        allowVerifiedSeason,
      };
      const trustedTorrentTitle = torrentTitle && this.matchesSeriesTitle(torrentTitle, knownTitles, titleMatch);
      const torrent = trustedTorrentTitle ? this.parseTitle(torrentTitle, knownTitles) : undefined;
      const standalone = target === 1 && expected === 1 && totalExpectedEps === 1 && torrent && !torrent.isBatch &&
        (torrent.singleEp === null || torrent.singleEp === 1) && files.filter(file => videoName(file?.name)).length === 1;
      const canonicalSeasons = new Set(knownTitles.flatMap(title => {
        const cleaned = title?.trim().replace(this.TRAILING_STAGE_OR_COUR_RANGE, "").trim();
        const suffix = cleaned?.match(/(?:\b(\d{1,2})(?:st|nd|rd|th)\s+season|\bseason\s+(\d{1,2})|\bs(\d{1,2}))\s*$/i);
        return suffix ? [Number(suffix[1] || suffix[2] || suffix[3])] : [];
      }));
      const defaultSeason = canonicalSeasons.size === 1 ? [...canonicalSeasons][0] : 1;
      const expectedSeason = torrent?.seasonNum ?? defaultSeason;
      const seenEpisodes = new Set<number>();
      const verifiedEpisodes = new Set<number>();

      for (let idx = 0; idx < files.length; idx++) {
        const relPath = files[idx]?.name;
        if (!videoName(relPath) || /^[a-z]:|[\u0000-\u001f\u007f]/i.test(relPath)) continue;
        const segments = relPath.split(/[\\/]/);
        if (segments.some(segment => !segment || segment === "." || segment === "..")) continue;

        const file = segments.at(-1)!;
        const folders = segments.slice(0, -1);
        if (folders.some(segment => /^(?:extras?|bonus|samples?|specials?|ncop|nced)$/i.test(segment) ||
          /^(?:s|season\s*)0+$/i.test(segment))) continue;
        const parsed = this.parseTitle(file, knownTitles);
        if (parsed.isBatch || parsed.isBonusOrExtra || parsed.isUnsupportedContainer ||
          this.WEIRD_OR_PROMO_PATTERN.test(file) || (parsed.isCam && !ALLOW_CAM)) continue;
        if (parsed.seasonNum !== null && torrent?.seasonNum != null && parsed.seasonNum !== expectedSeason) continue;

        const namedFile = this.matchesSeriesTitle(file, knownTitles, titleMatch);
        let episode = parsed.singleEp ?? (namedFile && standalone ? 1 : null);
        if (!namedFile) {
          if (!torrent || canonicalSeasons.size > 1) continue;
          const folder = folders.at(-1);
          if (folder && !this.matchesSeriesTitle(folder, knownTitles, titleMatch)) {
            const number = folder.match(/^(?:s|season\s*)0*(\d{1,2})$/i);
            const series = folders.at(-2);
            if (!number || Number(number[1]) !== expectedSeason || !series ||
              !this.matchesSeriesTitle(series, knownTitles, titleMatch)) continue;
          }
          let bareName = file.replace(/\.(?:mkv|mp4|avi|webm)$/i, "").trim();
          const group = bareName.match(/^\[([^\]]+)\]\s*/);
          if (group && group[1].trim().toLowerCase() === torrent.groupLower) bareName = bareName.slice(group[0].length);
          bareName = bareName.replace(/(?:\s*(?:\[(?:1080p|720p|480p|[0-9a-f]{8})\]|\((?:1080p|720p|480p|[0-9a-f]{8})\)))*$/i, "");
          const label = bareName.match(/^(?:(?:s(\d{1,2})[\s._-]*)?e(?:p(?:isode)?)?[\s._-]*)?(\d{1,4})(?:v\d+)?$/i);
          if (!label || (label[1] !== undefined && Number(label[1]) !== expectedSeason)) continue;
          episode = Number(label[2]);
        }
        if (episode === null || !Number.isSafeInteger(episode) || episode < 1) continue;

        verifiedEpisodes.add(episode);
        if (!allowWatermarkedSource && this.hasWatermarkedSource(relPath)) continue;
        if (expected !== null && (episode !== expected ||
          (parsed.relativeEpisode !== undefined && parsed.relativeEpisode !== target))) continue;

        const key = target ?? episode;
        if (seenEpisodes.has(key)) {
          epMap.delete(key);
        } else {
          seenEpisodes.add(key);
          epMap.set(key, [idx, relPath]);
        }
      }

      if (torrent?.isBatch && verifiedEpisodes.size < 2) epMap.clear();
    }

    // For a multi-file manual torrent whose filenames don't match canonical knownTitles,
    // fall back to isolating the unique non-bonus video file matching the target episode number.
    if (manualTorrent && target !== null && epMap.size === 0 && safeVideoFiles.length > 1) {
      const seen = new Set<number>();
      for (const { idx, relPath } of safeVideoFiles) {
        const file = relPath.split(/[\\/]/).at(-1)!;
        const parsed = this.parseTitle(file, knownTitles);
        if (parsed.isBatch || parsed.isBonusOrExtra || parsed.isUnsupportedContainer) continue;
        const matchesEp = parsed.singleEp === expected || parsed.singleEp === target || parsed.relativeEpisode === target;
        if (!matchesEp) continue;
        if (seen.has(target)) {
          epMap.delete(target);
        } else {
          seen.add(target);
          epMap.set(target, [idx, relPath]);
        }
      }
    }

    return epMap;
  }
}
