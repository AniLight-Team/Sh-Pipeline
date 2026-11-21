interface CanonicalAnimeTitles {
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleNative?: string | null;
  synonyms?: (string | null | undefined)[] | null;
  countryOfOrigin?: string | null;
}

const NON_TITLE_TOKEN =
  /^(?:2160p|1080p|720p|576p|540p|480p|360p|4k|uhd|fhd|hd|sd|hevc|av1|x264|x265|h\.?264|h\.?265|avc1?|web(?:-?dl|rip)?|bd(?:rip|remux)?|bluray|raw|sub|dub|ova|ona|special|movie|season\s*\d+|\d+(?:st|nd|rd|th)\s+season|part\s*\d+|cour\s*\d+|s\d{1,2})$/i;
const LATIN_ONLY = /^[\p{Script=Latin}\p{N}\s]+$/u;

function isUsableDiscoveryTitle(raw: string, isSynonym: boolean): boolean {
  const cleaned = raw.normalize("NFKC").replace(/[^\p{L}\p{M}\p{N}]+/gu, " ").trim();
  if (!cleaned || NON_TITLE_TOKEN.test(cleaned)) return false;
  const significantChars = cleaned.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  if (significantChars < 2) return false;
  // Require synonyms written purely in Latin letters/digits to be at least 4 significant characters
  // so short ambiguous acronyms (e.g. "TR", "OP", "S2") cannot match unrelated shows.
  if (isSynonym && LATIN_ONLY.test(cleaned) && significantChars < 4) return false;
  return true;
}

export function canonicalDiscoveryTitles({
  titleRomaji,
  titleEnglish,
  titleNative,
  synonyms,
}: CanonicalAnimeTitles): string[] {
  const titles = new Map<string, string>();
  const add = (candidate: string | null | undefined, isSynonym: boolean) => {
    const title = candidate?.trim();
    if (!title || !isUsableDiscoveryTitle(title, isSynonym)) return;
    const key = title.normalize("NFKC").toLowerCase();
    if (!titles.has(key)) titles.set(key, title);
  };

  for (const candidate of [titleRomaji, titleEnglish, titleNative]) {
    add(candidate, false);
  }
  if (Array.isArray(synonyms)) {
    for (const synonym of synonyms) {
      add(synonym, true);
    }
  }
  return [...titles.values()];
}
