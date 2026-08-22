import type { SearchResult, TranscriptChunk } from "../types/transcript";
import type { ModelStatus, SemanticWorkerRequest, SemanticWorkerResponse } from "./protocol";
import type { Backend } from "./provider";

/**
 * Side-panel handle on the semantic worker.
 *
 * Adds what the alpha's client lacked: cancellation that actually reaches the worker, results
 * validated against the transcript they were requested for, and rejection of every outstanding
 * request when the worker is disposed.
 */

/** `Omit` collapses a union into its common keys; this preserves each variant. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

interface Pending {
  resolve: (value: never) => void;
  reject: (error: Error) => void;
  kind: "index" | "search";
  transcriptId: string;
}

export interface IndexOutcome {
  cached: boolean;
  chunks: number;
  backend: Backend;
  elapsedMs: number;
}

export class SemanticSearchClient {
  private worker?: Worker;
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly onStatus: (status: ModelStatus) => void) {}

  /** The worker — and therefore the model download — is only created on first real use. */
  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL("./semantic.worker.ts", import.meta.url), {
      type: "module",
      name: "recalltube-semantic-search",
    });
    worker.addEventListener("message", (event: MessageEvent<SemanticWorkerResponse>) => {
      this.handle(event.data);
    });
    worker.addEventListener("error", () => {
      this.rejectAll(new Error("The local search worker stopped unexpectedly."));
    });
    this.worker = worker;
    return worker;
  }

  private handle(message: SemanticWorkerResponse) {
    if (message.type === "status") {
      this.onStatus(message.status);
      return;
    }

    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    this.pending.delete(message.requestId);

    switch (message.type) {
      case "error":
        pending.reject(new Error(message.error));
        return;
      case "cancelled":
        pending.reject(new DOMException("Aborted", "AbortError"));
        return;
      case "indexed":
        (pending.resolve as (value: IndexOutcome) => void)({
          cached: message.cached,
          chunks: message.chunks,
          backend: message.backend,
          elapsedMs: message.elapsedMs,
        });
        return;
      case "results":
        // A result for a different transcript is stale by definition; never surface it.
        if (message.transcriptId !== pending.transcriptId) {
          pending.reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        (pending.resolve as (value: SearchResult[]) => void)(message.results);
    }
  }

  private rejectAll(error: Error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  private request<T>(
    message: DistributiveOmit<SemanticWorkerRequest, "requestId">,
    kind: Pending["kind"],
    transcriptId: string,
    signal?: AbortSignal
  ): Promise<T> {
    const worker = this.ensureWorker();
    const requestId = crypto.randomUUID();

    return new Promise<T>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new DOMException("Aborted", "AbortError"));
        return;
      }
      this.pending.set(requestId, {
        resolve: resolve as (value: never) => void,
        reject,
        kind,
        transcriptId,
      });
      signal?.addEventListener(
        "abort",
        () => {
          if (!this.pending.has(requestId)) return;
          // Tell the worker to stop, rather than merely ignoring what it eventually returns.
          worker.postMessage({ type: "cancel", requestId: crypto.randomUUID(), targetRequestId: requestId });
        },
        { once: true }
      );
      worker.postMessage({ ...message, requestId } as SemanticWorkerRequest);
    });
  }

  index(
    options: {
      transcriptId: string;
      videoId: string;
      modelKey: string;
      preferredBackend: Backend;
      chunks: TranscriptChunk[];
    },
    signal?: AbortSignal
  ): Promise<IndexOutcome> {
    return this.request<IndexOutcome>({ type: "index", ...options }, "index", options.transcriptId, signal);
  }

  search(transcriptId: string, query: string, limit = 25, signal?: AbortSignal): Promise<SearchResult[]> {
    return this.request<SearchResult[]>(
      { type: "search", transcriptId, query, limit },
      "search",
      transcriptId,
      signal
    );
  }

  dispose() {
    this.worker?.terminate();
    this.worker = undefined;
    this.rejectAll(new Error("Semantic search stopped."));
  }
}
