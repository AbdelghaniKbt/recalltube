import type { AdapterDiagnostic, PageSnapshot } from "./transcript";
import type { PlaylistInventory } from "./playlist";

/** Requests the side panel sends to a YouTube tab. */
export type ContentRequest =
  | { type: "recalltube:get-state" }
  | {
      type: "recalltube:refresh";
      languageCode?: string;
      acquisitionMode?: "automatic" | "direct-only" | "native-panel";
    }
  | { type: "recalltube:get-playlist"; complete: boolean }
  | { type: "recalltube:prepare-native" }
  | { type: "recalltube:seek"; seconds: number }
  | { type: "recalltube:diagnostics" };

export type ContentResponse =
  | {
      ok: true;
      snapshot?: PageSnapshot;
      diagnostics?: AdapterDiagnostic[];
      playlist?: PlaylistInventory;
      nativeReady?: boolean;
      videoId?: string;
      /** For `recalltube:refresh`: the attempt generation the request started or joined. */
      generation?: number;
      /**
       * Identifies the page instance that answered. Generations restart at 1 in a new document, so a
       * generation is only meaningful together with the document that issued it.
       */
      documentId?: string;
    }
  | { ok: false; error: string };

/** Broadcast from a tab when its transcript state changes. */
export interface StateChangedMessage {
  type: "recalltube:state-changed";
  snapshot: PageSnapshot;
  /** The page instance that produced the snapshot; generations are comparable only within one. */
  documentId?: string;
}

/** Raw caption-track description as it crosses the main-world bridge. Untrusted until validated. */
export interface CaptionTrackInfo {
  baseUrl: string;
  languageCode: string;
  name: string;
  kind?: string;
  isTranslatable?: boolean;
  translatedFrom?: string;
}

/**
 * The player's own verdict on the video, as it crosses the bridge. Untrusted until validated. Lets a
 * removed, private or not-yet-started video fail honestly at once instead of waiting out the native
 * transcript stage for a control that will never render.
 */
export interface PlayabilityInfo {
  status?: string;
  reason?: string;
  isLive?: boolean;
}

export interface PageDataPayload {
  videoId?: string;
  title?: string;
  captionTracks: CaptionTrackInfo[];
  playability?: PlayabilityInfo;
  playlist?: PlaylistInventory;
}

export interface PageDataResponse {
  type: "recalltube:page-data";
  requestId: string;
  payload: PageDataPayload;
}

/**
 * Runtime validation for extension messages.
 *
 * TypeScript annotations are erased at runtime, and every one of these values arrives from a
 * source we do not control (another extension surface, or in the bridge's case an arbitrary page
 * script). The alpha cast untrusted values straight to typed unions and dereferenced them.
 * Every payload crossing an extension boundary is validated at runtime.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseContentRequest(value: unknown): ContentRequest | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  switch (value.type) {
    case "recalltube:get-state":
      return { type: "recalltube:get-state" };
    case "recalltube:diagnostics":
      return { type: "recalltube:diagnostics" };
    case "recalltube:get-playlist":
      return { type: "recalltube:get-playlist", complete: value.complete === true };
    case "recalltube:prepare-native":
      return { type: "recalltube:prepare-native" };
    case "recalltube:refresh":
      return {
        type: "recalltube:refresh",
        languageCode: typeof value.languageCode === "string" ? value.languageCode.slice(0, 16) : undefined,
        acquisitionMode:
          value.acquisitionMode === "direct-only" || value.acquisitionMode === "native-panel"
            ? value.acquisitionMode
            : "automatic",
      };
    case "recalltube:seek": {
      // Must already be a number: coercing would accept "12", and an untrusted sender should not
      // get to decide which types we tolerate.
      const seconds = value.seconds;
      if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) return undefined;
      return { type: "recalltube:seek", seconds };
    }
    default:
      return undefined;
  }
}

const PAGE_STATUSES = new Set(["idle", "loading", "ready", "failed"]);

export function parseStateChanged(value: unknown): StateChangedMessage | undefined {
  if (!isRecord(value) || value.type !== "recalltube:state-changed") return undefined;
  const snapshot = value.snapshot;
  if (!isRecord(snapshot) || typeof snapshot.status !== "string") return undefined;
  if (!PAGE_STATUSES.has(snapshot.status)) return undefined;
  if (typeof snapshot.generation !== "number" || !Number.isFinite(snapshot.generation)) return undefined;
  const documentId =
    typeof value.documentId === "string" && value.documentId.length > 0 && value.documentId.length <= 64
      ? value.documentId
      : undefined;
  return { type: "recalltube:state-changed", snapshot: snapshot as unknown as PageSnapshot, documentId };
}
