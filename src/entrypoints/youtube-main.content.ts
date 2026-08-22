import type { CaptionTrackInfo, PageDataResponse } from "../types/messages";

/**
 * Main-world bridge.
 *
 * Runs in the page world purely to read the player's caption-track list, which is not reachable
 * from an isolated content script. It holds no privileges and performs no fetches: everything it
 * reports is re-validated on the isolated side (src/transcript/bridge.ts) before use, because any
 * script in the page can observe this channel and forge a reply.
 */

interface CaptionTrack {
  baseUrl?: string;
  languageCode?: string;
  kind?: string;
  isTranslatable?: boolean;
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
  vssId?: string;
}

interface YoutubePlayerResponse {
  videoDetails?: { videoId?: string; title?: string };
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: CaptionTrack[];
      translationLanguages?: Array<{ languageCode?: string; languageName?: { simpleText?: string } }>;
    };
  };
}

declare global {
  interface Window {
    ytInitialPlayerResponse?: YoutubePlayerResponse;
  }
}

function readPlayerResponse(): YoutubePlayerResponse | undefined {
  const player = document.querySelector("#movie_player") as
    | (HTMLElement & { getPlayerResponse?: () => YoutubePlayerResponse })
    | null;
  try {
    return player?.getPlayerResponse?.() ?? window.ytInitialPlayerResponse;
  } catch {
    return window.ytInitialPlayerResponse;
  }
}

function trackName(name: CaptionTrack["name"]): string {
  return name?.simpleText ?? name?.runs?.map((run) => run.text ?? "").join("") ?? "Captions";
}

/** YouTube marks machine-translated tracks with a `tlang` parameter on the track URL. */
function translatedFrom(track: CaptionTrack): string | undefined {
  if (!track.baseUrl) return undefined;
  try {
    const url = new URL(track.baseUrl, location.href);
    const target = url.searchParams.get("tlang");
    if (!target) return undefined;
    return url.searchParams.get("lang") ?? track.languageCode;
  } catch {
    return undefined;
  }
}

export default defineContentScript({
  matches: ["*://*.youtube.com/*"],
  world: "MAIN",
  runAt: "document_start",
  main() {
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window) return;
      const data = event.data as { type?: unknown; requestId?: unknown } | null;
      if (!data || data.type !== "recalltube:request-page-data") return;
      if (typeof data.requestId !== "string" || data.requestId.length > 64) return;

      const response = readPlayerResponse();
      const rawTracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
      const captionTracks: CaptionTrackInfo[] = [];
      for (const track of rawTracks) {
        if (!track?.baseUrl || !track.languageCode) continue;
        captionTracks.push({
          baseUrl: track.baseUrl,
          languageCode: track.languageCode,
          name: trackName(track.name),
          kind: track.kind,
          isTranslatable: track.isTranslatable === true,
          translatedFrom: translatedFrom(track),
        });
      }

      const payload: PageDataResponse = {
        type: "recalltube:page-data",
        requestId: data.requestId,
        payload: {
          videoId:
            response?.videoDetails?.videoId ?? new URL(location.href).searchParams.get("v") ?? undefined,
          title: response?.videoDetails?.title ?? document.title.replace(/\s+-\s+YouTube$/u, ""),
          captionTracks,
        },
      };
      window.postMessage(payload, location.origin);
    });
  },
});
