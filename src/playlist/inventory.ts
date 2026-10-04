import type { PlaylistInventory, PlaylistInventorySource, PlaylistVideo } from "../types/playlist";
import { cleanPlaylistId, cleanVideoId, playlistContextFromUrl } from "./url";

const MAX_ITEMS = 5_000;
const MAX_VISITED_NODES = 100_000;

function text(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().slice(0, 500) || undefined;
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.simpleText === "string") return record.simpleText.trim().slice(0, 500) || undefined;
  if (Array.isArray(record.runs)) {
    const joined = record.runs
      .slice(0, 40)
      .map((run) => (run && typeof run === "object" && typeof (run as Record<string, unknown>).text === "string"
        ? (run as Record<string, unknown>).text
        : ""))
      .join("")
      .trim();
    return joined.slice(0, 500) || undefined;
  }
  return undefined;
}

function numericPosition(value: unknown, fallback: number): number {
  const rendered = text(value) ?? (typeof value === "number" || typeof value === "string" ? String(value) : "");
  const match = rendered.replace(/,/gu, "").match(/\d+/u);
  if (!match) return fallback;
  const parsed = Number(match[0]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed - 1 : fallback;
}

function thumbnail(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const raw = Array.isArray(record.thumbnails) ? record.thumbnails.at(-1) : undefined;
  if (!raw || typeof raw !== "object") return undefined;
  const url = (raw as Record<string, unknown>).url;
  return typeof url === "string" && url.startsWith("https://") ? url.slice(0, 2_000) : undefined;
}

function rendererVideo(value: unknown, fallbackPosition: number): PlaylistVideo | undefined {
  if (!value || typeof value !== "object") return undefined;
  const renderer = value as Record<string, unknown>;
  const videoId = cleanVideoId(renderer.videoId);
  if (!videoId) return undefined;
  return {
    videoId,
    title: text(renderer.title) ?? `Video ${fallbackPosition + 1}`,
    position: numericPosition(renderer.index, fallbackPosition),
    thumbnailUrl: thumbnail(renderer.thumbnail),
  };
}

interface Extracted {
  title?: string;
  totalVideos?: number;
  items: PlaylistVideo[];
  hasContinuation: boolean;
}

/**
 * Reads only known renderer shapes from YouTube's already-loaded bootstrap object. It performs no
 * internal API requests and is bounded so hostile page data cannot lock the extension thread.
 */
export function extractPlaylistBootstrap(value: unknown): Extracted {
  const items: PlaylistVideo[] = [];
  let title: string | undefined;
  let totalVideos: number | undefined;
  let hasContinuation = false;
  let visited = 0;
  const stack: unknown[] = [value];
  const seen = new Set<object>();

  while (stack.length && visited < MAX_VISITED_NODES && items.length < MAX_ITEMS) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    visited += 1;

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      continue;
    }

    const record = current as Record<string, unknown>;
    if (record.continuationItemRenderer) hasContinuation = true;
    for (const key of ["playlistVideoRenderer", "playlistPanelVideoRenderer"] as const) {
      const video = rendererVideo(record[key], items.length);
      if (video) items.push(video);
    }

    title ??= text(record.titleText) ?? text(record.playlistTitle);
    if (totalVideos === undefined) {
      const countText = text(record.numVideosText) ?? text(record.videoCountText);
      const match = countText?.replace(/,/gu, "").match(/\d+/u);
      if (match) totalVideos = Number(match[0]);
    }

    for (const child of Object.values(record)) stack.push(child);
  }

  return { items, title, totalVideos, hasContinuation };
}

/** YouTube's own 1-based `index` on a playlist watch link; authoritative even for a partial render. */
function urlPosition(url: URL): number | undefined {
  const raw = url.searchParams.get("index");
  if (!raw || !/^\d{1,5}$/u.test(raw)) return undefined;
  const index = Number(raw);
  return index >= 1 ? index - 1 : undefined;
}

function domPosition(anchor: Element, fallback: number): number {
  const container = anchor.closest(
    "ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model"
  );
  const index = container?.querySelector("#index")?.textContent
    ?? container?.querySelector(".index, [class*='index']")?.textContent;
  return numericPosition(index, fallback);
}

/** Reads the currently rendered playlist rows. Safe to run in either isolated or main world. */
export function extractPlaylistDom(document: Document, href: string): Extracted {
  const context = playlistContextFromUrl(href);
  if (!context) return { items: [], hasContinuation: false };
  const items: PlaylistVideo[] = [];
  const byVideo = new Map<string, { item: PlaylistVideo; titled: boolean }>();
  const anchors = document.querySelectorAll<HTMLAnchorElement>(
    "ytd-playlist-video-renderer a[href*='/watch'], ytd-playlist-panel-video-renderer a[href*='/watch'], yt-lockup-view-model a[href*='/watch'], a#video-title[href*='/watch'][href*='list=']"
  );
  for (const anchor of anchors) {
    let url: URL;
    try {
      url = new URL(anchor.href, href);
    } catch {
      continue;
    }
    const playlistId = cleanPlaylistId(url.searchParams.get("list"));
    if (playlistId && playlistId !== context.playlistId) continue;
    const videoId = cleanVideoId(url.searchParams.get("v"));
    if (!videoId) continue;
    const container = anchor.closest(
      "ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, yt-lockup-view-model"
    );
    // A row is a video, not a link. Current `yt-lockup-view-model` rows carry two watch links —
    // thumbnail and title — and counting both assigned every second position, so a 10-video
    // playlist was labelled 1, 3, 5 … 19.
    const explicitTitle = anchor.getAttribute("title") ?? anchor.getAttribute("aria-label");
    const titleLike = Boolean(explicitTitle) || anchor.id === "video-title" || /title/iu.test(anchor.className);
    const rawTitle = (explicitTitle ?? anchor.textContent)?.trim().slice(0, 500);
    const existing = byVideo.get(videoId);
    if (existing) {
      // The thumbnail link's text is the duration badge; the title link wins whichever comes first.
      if (!existing.titled && titleLike && rawTitle) {
        existing.item.title = rawTitle;
        existing.titled = true;
      }
      continue;
    }
    const image = container?.querySelector<HTMLImageElement>("img[src]");
    const item: PlaylistVideo = {
      videoId,
      title: (titleLike && rawTitle) || `Video ${byVideo.size + 1}`,
      position: urlPosition(url) ?? domPosition(anchor, byVideo.size),
      thumbnailUrl: image?.src.startsWith("https://") ? image.src.slice(0, 2_000) : undefined,
    };
    byVideo.set(videoId, { item, titled: titleLike && Boolean(rawTitle) });
    items.push(item);
  }

  const heading = document.querySelector("ytd-playlist-header-renderer h1, ytd-playlist-panel-renderer #title");
  const metadataTitle = document.querySelector<HTMLMetaElement>("meta[property='og:title']")?.content;
  const documentTitle = document.title.replace(/\s+-\s+YouTube$/u, "");
  const title = heading?.textContent?.trim().slice(0, 500)
    || metadataTitle?.trim().slice(0, 500)
    || documentTitle.trim().slice(0, 500)
    || undefined;
  const count = document.querySelector("ytd-playlist-byline-renderer, #stats")?.textContent;
  const countMatch = count?.replace(/,/gu, "").match(/\d+/u);
  return {
    items,
    title,
    totalVideos: countMatch ? Number(countMatch[0]) : undefined,
    hasContinuation: Boolean(document.querySelector("ytd-continuation-item-renderer")),
  };
}

function mergeItems(groups: PlaylistVideo[][]): PlaylistVideo[] {
  const byId = new Map<string, PlaylistVideo>();
  for (const group of groups) {
    for (const item of group) {
      const previous = byId.get(item.videoId);
      if (!previous) byId.set(item.videoId, item);
      else {
        byId.set(item.videoId, {
          ...previous,
          ...item,
          title: item.title.startsWith("Video ") ? previous.title : item.title,
          position: Math.min(previous.position, item.position),
          thumbnailUrl: item.thumbnailUrl ?? previous.thumbnailUrl,
        });
      }
    }
  }
  const sorted = [...byId.values()].sort(
    (left, right) => left.position - right.position || left.videoId.localeCompare(right.videoId)
  );
  // Some renderer variants omit their visible index. Keep DOM order deterministic and repair
  // duplicate fallback positions instead of letting two results claim the same playlist slot.
  let previous = -1;
  return sorted.map((item) => {
    const position = item.position <= previous ? previous + 1 : item.position;
    previous = position;
    return position === item.position ? item : { ...item, position };
  });
}

export function buildPlaylistInventory(options: {
  href: string;
  bootstrap?: unknown;
  document?: Document;
  collectedAt?: number;
}): PlaylistInventory | undefined {
  const context = playlistContextFromUrl(options.href);
  if (!context) return undefined;
  const bootstrap = extractPlaylistBootstrap(options.bootstrap);
  const dom = options.document
    ? extractPlaylistDom(options.document, options.href)
    : { items: [], hasContinuation: false } satisfies Extracted;
  const items = mergeItems([bootstrap.items, dom.items]);
  const sources: PlaylistInventorySource[] = [];
  if (bootstrap.items.length) sources.push("bootstrap");
  if (dom.items.length) sources.push("dom");
  const totalVideos = bootstrap.totalVideos ?? dom.totalVideos;
  return {
    playlistId: context.playlistId,
    title: bootstrap.title ?? dom.title,
    items,
    totalVideos,
    complete:
      items.length > 0 &&
      !bootstrap.hasContinuation &&
      !dom.hasContinuation &&
      (totalVideos === undefined || items.length >= totalVideos),
    sources,
    collectedAt: options.collectedAt ?? Date.now(),
  };
}

export function mergePlaylistInventories(...inventories: Array<PlaylistInventory | undefined>): PlaylistInventory | undefined {
  const available = inventories.filter((value): value is PlaylistInventory => Boolean(value));
  if (!available.length) return undefined;
  const playlistId = available[0]!.playlistId;
  const matching = available.filter((value) => value.playlistId === playlistId);
  const totalVideos = Math.max(...matching.map((value) => value.totalVideos ?? 0)) || undefined;
  const items = mergeItems(matching.map((value) => value.items));
  return {
    playlistId,
    title: matching.find((value) => value.title)?.title,
    items,
    totalVideos,
    complete: matching.some((value) => value.complete) || (totalVideos !== undefined && items.length >= totalVideos),
    sources: [...new Set(matching.flatMap((value) => value.sources))],
    collectedAt: Math.max(...matching.map((value) => value.collectedAt)),
  };
}

function safeThumbnail(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 2_000) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return undefined;
    if (!/^i\d?\.ytimg\.com$/u.test(url.hostname) && url.hostname !== "img.youtube.com") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

/** Validates inventory crossing from the untrusted YouTube page world. */
export function parsePlaylistInventory(value: unknown): PlaylistInventory | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const playlistId = cleanPlaylistId(record.playlistId);
  if (!playlistId || !Array.isArray(record.items)) return undefined;
  const items: PlaylistVideo[] = [];
  const ids = new Set<string>();
  for (const raw of record.items.slice(0, MAX_ITEMS)) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const videoId = cleanVideoId(item.videoId);
    if (!videoId || ids.has(videoId)) continue;
    const title = text(item.title) ?? `Video ${items.length + 1}`;
    const position = typeof item.position === "number" && Number.isSafeInteger(item.position) && item.position >= 0
      ? Math.min(item.position, MAX_ITEMS - 1)
      : items.length;
    ids.add(videoId);
    items.push({ videoId, title, position, thumbnailUrl: safeThumbnail(item.thumbnailUrl) });
  }
  const rawTotal = record.totalVideos;
  const totalVideos = typeof rawTotal === "number" && Number.isSafeInteger(rawTotal) && rawTotal >= items.length
    ? Math.min(rawTotal, MAX_ITEMS)
    : undefined;
  const sourceSet = new Set<PlaylistInventorySource>(["bootstrap", "dom"]);
  const sources = Array.isArray(record.sources)
    ? record.sources.filter((source): source is PlaylistInventorySource => sourceSet.has(source as PlaylistInventorySource))
    : [];
  return {
    playlistId,
    title: text(record.title),
    items: mergeItems([items]),
    totalVideos,
    complete: record.complete === true && (totalVideos === undefined || items.length >= totalVideos),
    sources: [...new Set(sources)],
    collectedAt:
      typeof record.collectedAt === "number" && Number.isFinite(record.collectedAt)
        ? Math.max(0, Math.floor(record.collectedAt))
        : Date.now(),
  };
}
