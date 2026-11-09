import { MAIN_BACKEND_URL, INTERNAL_SECRET } from "../config.js";
import { log } from "./logger.js";

export async function notifyMainBackendRevalidate(payload: {
  animeId: number;
  slug?: string | null;
  episodeNumber: number;
  airType: "sub" | "dub";
}): Promise<void> {
  const url = `${MAIN_BACKEND_URL}/api/internal/revalidate`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-internal-secret": INTERNAL_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      log.warn(
        "Notifier",
        `Main backend revalidation returned HTTP ${res.status} for Anime ${payload.animeId} Ep ${payload.episodeNumber}`,
      );
    } else {
      log.success(
        "Notifier",
        `Triggered cache revalidation on Main Backend for Anime ${payload.animeId} Ep ${payload.episodeNumber} (${payload.airType})`,
      );
    }
  } catch (err: any) {
    log.warn(
      "Notifier",
      `Could not reach Main Backend at ${url}: ${err?.message || err}. (Main backend may be restarting; DB records are safe!)`,
    );
  }
}

