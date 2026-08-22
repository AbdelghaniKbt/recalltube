import type { CaptionTrackInfo, PageDataPayload } from "../types/messages";
import type { CaptionTrackIdentity } from "../types/transcript";

/**
 * Validation for the main-world bridge payload.
 *
 * The bridge request id travels via `window.postMessage`, which every script in the page can read,
 * so a hostile page script can forge the response and supply any `baseUrl` it likes — which the
 * alpha then fetched with `credentials: "include"` and no validation at all. See
 * Treat every page-provided field as untrusted input.
 *
 * Everything crossing this boundary is therefore treated as untrusted: shape-checked, length-
 * capped, and — critically — the caption URL is allowlisted to YouTube's timed-text endpoint
 * before any credentialed request is made.
 */

const MAX_TRACKS = 200;
const MAX_STRING = 512;

const ALLOWED_CAPTION_HOSTS = new Set(["www.youtube.com", "youtube.com", "m.youtube.com"]);
const ALLOWED_CAPTION_PATHS = ["/api/timedtext"];

/** True only for a URL we are willing to fetch with the user's YouTube credentials. */
export function isAllowedCaptionUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (!ALLOWED_CAPTION_HOSTS.has(url.hostname)) return false;
  return ALLOWED_CAPTION_PATHS.some((path) => url.pathname === path || url.pathname.startsWith(`${path}/`));
}

function cleanString(value: unknown, max = MAX_STRING): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function parseTrack(value: unknown): CaptionTrackInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const baseUrl = cleanString(record.baseUrl, 4_000);
  const languageCode = cleanString(record.languageCode, 32);
  if (!baseUrl || !languageCode) return undefined;
  if (!isAllowedCaptionUrl(baseUrl)) return undefined;
  return {
    baseUrl,
    languageCode,
    name: cleanString(record.name, 200) ?? languageCode,
    kind: cleanString(record.kind, 32),
    isTranslatable: record.isTranslatable === true,
    translatedFrom: cleanString(record.translatedFrom, 32),
  };
}

export function parsePageDataPayload(value: unknown): PageDataPayload | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const rawTracks = Array.isArray(record.captionTracks) ? record.captionTracks.slice(0, MAX_TRACKS) : [];
  const captionTracks: CaptionTrackInfo[] = [];
  for (const raw of rawTracks) {
    const track = parseTrack(raw);
    if (track) captionTracks.push(track);
  }
  return {
    videoId: cleanString(record.videoId, 32),
    title: cleanString(record.title, 500),
    captionTracks,
  };
}

/** A stable handle for a track, so a track change invalidates the transcript identity. */
export function trackIdentity(track: CaptionTrackInfo): CaptionTrackIdentity {
  let handle = track.languageCode;
  try {
    const url = new URL(track.baseUrl);
    // `v` and `lang`/`name` distinguish tracks; the signature parameters change per request and
    // must not enter the identity or every reload would look like a new transcript.
    const parts = [url.searchParams.get("v"), url.searchParams.get("lang"), url.searchParams.get("name"), track.kind];
    handle = parts.filter(Boolean).join(":") || track.languageCode;
  } catch {
    // Fall back to the language code.
  }
  return {
    id: handle,
    languageCode: track.languageCode,
    languageName: track.name,
    kind: track.kind === "asr" ? "asr" : "manual",
    translatedFrom: track.translatedFrom,
  };
}
