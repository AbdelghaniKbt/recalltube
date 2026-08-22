import type { AcquisitionFailureReason } from "../../types/transcript";

export function formatTime(seconds: number): string {
  const rounded = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

/**
 * Builds a timestamped link from a validated video id and a number, rather than from a URL the
 * page supplied.
 */
export function timestampedLink(videoId: string, seconds: number): string {
  const safeId = videoId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 24);
  return `https://www.youtube.com/watch?v=${safeId}&t=${Math.max(0, Math.floor(seconds))}s`;
}

export function formatBytes(bytes?: number): string {
  if (bytes === undefined) return "unknown";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

/** One distinct, actionable message per failure reason. */
export function describeFailure(reason: AcquisitionFailureReason): { title: string; body: string } {
  switch (reason) {
    case "no-captions":
      return {
        title: "No captions for this video",
        body: "The uploader has not published captions and YouTube has not generated any. RecallTube cannot search a video without captions.",
      };
    case "captions-withheld":
      return {
        title: "YouTube did not expose usable captions",
        body: "RecallTube tried the direct caption track and YouTube's native transcript panel, then restored the page. Try again in a moment; YouTube sometimes makes the panel available after the player settles.",
      };
    case "track-unavailable":
      return {
        title: "That caption track would not load",
        body: "Captions exist for this video but the selected track failed. Try another language from the selector above.",
      };
    case "tab-not-connected":
      return {
        title: "This tab needs a reload",
        body: "RecallTube was installed or updated after this YouTube tab was opened, so the tab is not connected yet. Reloading it takes a second and only has to happen once.",
      };
    case "not-ready":
      return {
        title: "The player is still loading",
        body: "RecallTube could not read the player yet. Give the video a moment, then try again.",
      };
    case "network-error":
      return {
        title: "Could not reach YouTube's caption service",
        body: "The caption request failed. Check your connection and try again — this is usually temporary.",
      };
    case "parse-error":
      return {
        title: "The caption data could not be read",
        body: "YouTube returned captions in a form RecallTube did not understand. Please report this with the diagnostics below.",
      };
    case "permission-denied":
      return {
        title: "Captions are not accessible",
        body: "YouTube refused the caption request for this video. This happens with some restricted, private or region-limited videos.",
      };
    case "navigation-cancelled":
      return { title: "Loading was cancelled", body: "You navigated away before the transcript finished loading." };
    case "unsupported":
      return {
        title: "This page is not supported",
        body: "Open a YouTube watch page. Live streams and premieres may not expose captions until they finish.",
      };
  }
}
