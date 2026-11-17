import type { AnimeToshoItem } from "./types.js";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function normalizeBtih(raw: string | undefined): string | undefined {
  const value = raw?.trim().toUpperCase();
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
  const magnetHash = item.magnet_uri?.match(/[?&]xt=urn:btih:([a-z\d]+)(?=&|$)/i)?.[1];
  return normalizeBtih(item.info_hash) ?? normalizeBtih(magnetHash);
}

export function torrentIdentityKey(item: AnimeToshoItem): string {
  const hash = torrentInfoHash(item);
  if (hash) return `btih:${hash}`;

  const provider = item.provider ?? "animetosho";
  return item.id == null ? `${provider}:title:${item.title.trim().toLowerCase()}` : `${provider}:id:${item.id}`;
}
