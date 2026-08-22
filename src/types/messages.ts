import type { AdapterDiagnostic, PageSnapshot } from "./transcript";

/** Requests the side panel sends to a YouTube tab. */
export type ContentRequest =
  | { type: "recalltube:get-state" }
  | { type: "recalltube:refresh"; languageCode?: string }
  | { type: "recalltube:seek"; seconds: number }
  | { type: "recalltube:diagnostics" };

export type ContentResponse =
  | { ok: true; snapshot?: PageSnapshot; diagnostics?: AdapterDiagnostic[] }
  | { ok: false; error: string };

/** Broadcast from a tab when its transcript state changes. */
export interface StateChangedMessage {
  type: "recalltube:state-changed";
  snapshot: PageSnapshot;
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

export interface PageDataPayload {
  videoId?: string;
  title?: string;
  captionTracks: CaptionTrackInfo[];
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
    case "recalltube:refresh":
      return {
        type: "recalltube:refresh",
        languageCode: typeof value.languageCode === "string" ? value.languageCode.slice(0, 16) : undefined,
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
  return { type: "recalltube:state-changed", snapshot: snapshot as unknown as PageSnapshot };
}
