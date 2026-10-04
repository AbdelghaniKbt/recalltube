import type { AcquisitionFailureReason, AdapterDiagnostic, TranscriptDocument } from "./transcript";

export type PlaylistInventorySource = "bootstrap" | "dom";

export interface PlaylistVideo {
  videoId: string;
  title: string;
  /** Zero-based position in the playlist when YouTube exposes it. */
  position: number;
  thumbnailUrl?: string;
}

export interface PlaylistInventory {
  playlistId: string;
  title?: string;
  items: PlaylistVideo[];
  totalVideos?: number;
  /** False means YouTube still exposed a continuation or only a partial rendered list. */
  complete: boolean;
  sources: PlaylistInventorySource[];
  collectedAt: number;
}

export type PlaylistItemState =
  | "pending"
  | "indexing"
  | "indexed"
  | "cached"
  | "no-captions"
  | "unavailable"
  | "failed";

export interface PlaylistIndexItem extends PlaylistVideo {
  state: PlaylistItemState;
  failureReason?: AcquisitionFailureReason;
  /** Privacy-safe adapter outcomes retained so a failed background item can be diagnosed later. */
  diagnostics?: AdapterDiagnostic[];
  attempts: number;
  updatedAt: number;
  transcriptId?: string;
}

export type PlaylistJobState = "queued" | "running" | "paused" | "completed" | "cancelled" | "failed";

export interface PlaylistIndexJob {
  jobId: string;
  playlistId: string;
  playlistTitle?: string;
  ownerTabId?: number;
  state: PlaylistJobState;
  items: PlaylistIndexItem[];
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  finishedAt?: number;
  workerTabId?: number;
  /** Dedicated worker window: minimized for direct fetches, restored unfocused for native rendering. */
  workerWindowId?: number;
  /** Set only if the worker window took focus anyway; cleanup gives focus back to this window. */
  restoreFocusWindowId?: number;
  lastError?: string;
}

export interface PlaylistCoverage {
  total: number;
  searchable: number;
  indexed: number;
  cached: number;
  pending: number;
  unavailable: number;
  failed: number;
}

export interface PlaylistTranscript {
  item: PlaylistVideo;
  transcript: TranscriptDocument;
}

export interface PlaylistSearchResult {
  playlistId: string;
  item: PlaylistVideo;
  transcript: TranscriptDocument;
  result: import("./transcript").SearchResult;
}
