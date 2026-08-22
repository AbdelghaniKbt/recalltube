import type { SearchResult, TranscriptChunk } from "../types/transcript";
import type { Backend } from "./provider";

/** What the worker is doing, so the panel can show an honest state rather than a spinner. */
export type ModelPhase =
  | "idle"
  | "initializing"
  | "downloading"
  | "indexing"
  | "ready"
  | "searching"
  | "failed";

export interface ModelStatus {
  phase: ModelPhase;
  message: string;
  /** 0–100 where known. */
  progress?: number;
  backend?: Backend;
  modelId?: string;
  /** Set when `phase === "indexing"` so the panel can show real counts. */
  indexed?: number;
  total?: number;
}

export type SemanticWorkerRequest =
  | {
      type: "index";
      requestId: string;
      transcriptId: string;
      videoId: string;
      modelKey: string;
      preferredBackend: Backend;
      chunks: TranscriptChunk[];
    }
  | { type: "search"; requestId: string; transcriptId: string; query: string; limit: number }
  | { type: "cancel"; requestId: string; targetRequestId: string }
  | { type: "dispose"; requestId: string };

export type SemanticWorkerResponse =
  | { type: "status"; requestId?: string; status: ModelStatus }
  | {
      type: "indexed";
      requestId: string;
      transcriptId: string;
      cached: boolean;
      chunks: number;
      backend: Backend;
      elapsedMs: number;
    }
  | { type: "results"; requestId: string; transcriptId: string; results: SearchResult[] }
  | { type: "cancelled"; requestId: string }
  | { type: "error"; requestId: string; error: string; recoverable: boolean };
