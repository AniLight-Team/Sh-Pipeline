interface CanonicalAnimeTitles {
  titleRomaji?: string | null;
  titleEnglish?: string | null;
  titleNative?: string | null;
  countryOfOrigin?: string | null;
}

const JAPANESE_KANA = /[\p{Script=Hiragana}\p{Script=Katakana}]/u;

export function canonicalDiscoveryTitles({
  titleRomaji,
  titleEnglish,
  titleNative,
  countryOfOrigin,
}: CanonicalAnimeTitles): string[] {
  const hasJapaneseTitle = countryOfOrigin
    ? countryOfOrigin === "JP"
    : JAPANESE_KANA.test(titleNative ?? "");
  const titles = new Map<string, string>();
  for (const candidate of [titleRomaji, titleEnglish, hasJapaneseTitle ? titleNative : null]) {
    const title = candidate?.trim();
    if (!title || !/[\p{L}\p{N}]/u.test(title)) continue;
    const key = title.normalize("NFKC").toLowerCase();
    if (!titles.has(key)) titles.set(key, title);
  }
  return [...titles.values()];
}
