import type { AnimeToshoItem } from "./types.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function normalizeBtih(raw: unknown): string | undefined {
  const value = typeof raw === "string" ? raw.trim().toUpperCase() : undefined;
  if (!value) return;
  if (/^[0-9A-F]{40}$/.test(value)) return value.toLowerCase();
  if (!/^[A-Z2-7]{32}$/.test(value)) return;

  let bits = 0;
  let chunk = 0;
  let hex = "";
  for (const char of value) {
    chunk = (chunk << 5) | BASE32_ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      hex += ((chunk >>> bits) & 255).toString(16).padStart(2, "0");
    }
  }
  return hex;
}

export function torrentInfoHash(item: AnimeToshoItem): string | undefined {
  const hashes = new Set<string>();
  const declared = normalizeBtih(item.info_hash);
  if (declared) hashes.add(declared);
  if (typeof item.magnet_uri === "string" && item.magnet_uri.startsWith("magnet:?")) {
    for (const topic of new URLSearchParams(item.magnet_uri.slice(8)).getAll("xt")) {
      if (!/^urn:btih:/i.test(topic)) continue;
      const hash = normalizeBtih(topic.slice(9));
      if (hash) hashes.add(hash);
    }
  }
  return hashes.size === 1 ? hashes.values().next().value : undefined;
}

export function torrentIdentityKey(item: AnimeToshoItem): string {
  const hash = torrentInfoHash(item);
  if (hash) return `btih:${hash}`;

  const provider = item.provider ?? "animetosho";
  return item.id == null ? `${provider}:title:${item.title.trim().toLowerCase()}` : `${provider}:id:${item.id}`;
}
