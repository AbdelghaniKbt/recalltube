const PLAYLIST_ID = /^[A-Za-z0-9_-]{10,128}$/u;
const VIDEO_ID = /^[A-Za-z0-9_-]{6,24}$/u;

function youtubeUrl(value: string): URL | undefined {
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host !== "youtube.com" && host !== "www.youtube.com" && host !== "m.youtube.com") return undefined;
    return url;
  } catch {
    return undefined;
  }
}

export function cleanPlaylistId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return PLAYLIST_ID.test(trimmed) ? trimmed : undefined;
}

export function cleanVideoId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return VIDEO_ID.test(trimmed) ? trimmed : undefined;
}

export interface PlaylistUrlContext {
  playlistId: string;
  videoId?: string;
  isPlaylistPage: boolean;
}

export function playlistContextFromUrl(value: string): PlaylistUrlContext | undefined {
  const url = youtubeUrl(value);
  if (!url) return undefined;
  const playlistId = cleanPlaylistId(url.searchParams.get("list"));
  if (!playlistId) return undefined;
  return {
    playlistId,
    videoId: cleanVideoId(url.searchParams.get("v")),
    isPlaylistPage: url.pathname === "/playlist",
  };
}

export function playlistPageUrl(playlistId: string): string {
  const safe = cleanPlaylistId(playlistId);
  if (!safe) throw new Error("Invalid YouTube playlist id.");
  return `https://www.youtube.com/playlist?list=${encodeURIComponent(safe)}`;
}

export function playlistWatchUrl(playlistId: string, videoId: string, seconds = 0): string {
  const safePlaylist = cleanPlaylistId(playlistId);
  const safeVideo = cleanVideoId(videoId);
  if (!safePlaylist || !safeVideo) throw new Error("Invalid YouTube playlist or video id.");
  const url = new URL("https://www.youtube.com/watch");
  url.searchParams.set("v", safeVideo);
  url.searchParams.set("list", safePlaylist);
  if (seconds > 0) url.searchParams.set("t", `${Math.floor(seconds)}s`);
  return url.toString();
}

/** Worker tabs deliberately omit playlist context so YouTube cannot auto-advance mid-capture. */
export function videoWatchUrl(videoId: string): string {
  const safeVideo = cleanVideoId(videoId);
  if (!safeVideo) throw new Error("Invalid YouTube video id.");
  return `https://www.youtube.com/watch?v=${encodeURIComponent(safeVideo)}`;
}
