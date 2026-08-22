import {
  embeddingKey,
  loadEmbeddingRecord,
  saveEmbeddingRecord,
  type EmbeddingIdentity,
} from "../storage/indexeddb";
import { CHUNKER_VERSION } from "../transcript/chunk";
import { NORMALIZER_VERSION } from "../transcript/normalize";
import type { SearchResult, TranscriptChunk } from "../types/transcript";
import { embeddingBatches } from "./embedding-batches";
import { modelDescriptor } from "./models";
import type { ModelStatus, SemanticWorkerRequest, SemanticWorkerResponse } from "./protocol";
import { dot, type Backend, type EmbeddingProvider } from "./provider";
import { TransformersEmbeddingProvider } from "./transformers-provider";

/**
 * The semantic worker owns the model for the whole extension.
 *
 * Responsibilities the alpha lacked: a single model instance (concurrent index requests used to be
 * able to build two), real cancellation, cache keys that cannot collide across transcripts, and
 * an index bound to a transcript id so a result can never be returned for the wrong video.
 */

const worker = self as unknown as {
  postMessage: (message: SemanticWorkerResponse) => void;
  onmessage: ((event: MessageEvent<SemanticWorkerRequest>) => void) | null;
};

interface LoadedIndex {
  transcriptId: string;
  chunks: TranscriptChunk[];
  vectors: Float32Array;
  dimension: number;
}

let provider: EmbeddingProvider | undefined;
let providerKey: string | undefined;
let initializing: Promise<{ backend: Backend }> | undefined;
let loaded: LoadedIndex | undefined;
const cancelled = new Set<string>();

function post(message: SemanticWorkerResponse) {
  worker.postMessage(message);
}

function status(requestId: string | undefined, value: ModelStatus) {
  post({ type: "status", requestId, status: value });
}

class Cancelled extends Error {
  constructor() {
    super("Cancelled");
    this.name = "Cancelled";
  }
}

function assertLive(requestId: string) {
  if (cancelled.has(requestId)) throw new Cancelled();
}

/** Yields to the event loop so queued `cancel` messages are actually delivered. */
function yieldToLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

async function ensureProvider(
  modelKey: string,
  preferredBackend: Backend,
  requestId: string
): Promise<EmbeddingProvider> {
  if (provider && providerKey === modelKey) {
    if (initializing) await initializing;
    return provider;
  }

  // Switching model: never hold two large models at once.
  if (provider) {
    await provider.dispose().catch(() => undefined);
    provider = undefined;
    loaded = undefined;
  }

  const descriptor = modelDescriptor(modelKey);
  const instance = new TransformersEmbeddingProvider(modelKey);
  providerKey = modelKey;
  provider = instance;

  status(requestId, {
    phase: "downloading",
    message: `Preparing the local ${descriptor.id} model…`,
    modelId: descriptor.repo,
  });

  initializing = instance.initialize({
    preferredBackend,
    onProgress: (progress) => {
      if (progress.phase === "downloading") {
        status(requestId, {
          phase: "downloading",
          message: "Downloading the multilingual search model (one time)…",
          progress: progress.progress,
          modelId: descriptor.repo,
        });
      }
    },
  });

  try {
    const { backend } = await initializing;
    status(requestId, {
      phase: "ready",
      message: backend === "webgpu" ? "Ready — using WebGPU." : "Ready — using CPU (WASM).",
      backend,
      modelId: descriptor.repo,
    });
    return instance;
  } catch (error) {
    provider = undefined;
    providerKey = undefined;
    throw error;
  } finally {
    initializing = undefined;
  }
}

function identityFor(provider: EmbeddingProvider, transcriptId: string): EmbeddingIdentity {
  return {
    transcriptId,
    modelId: provider.modelId,
    modelRevision: provider.modelRevision,
    dtype: provider.dtype,
    pooling: provider.pooling,
    dimension: provider.dimension,
    chunkerVersion: CHUNKER_VERSION,
    normalizerVersion: NORMALIZER_VERSION,
  };
}

async function indexTranscript(message: Extract<SemanticWorkerRequest, { type: "index" }>) {
  const started = performance.now();
  const active = await ensureProvider(message.modelKey, message.preferredBackend, message.requestId);
  assertLive(message.requestId);

  const identity = identityFor(active, message.transcriptId);
  const key = embeddingKey(identity);

  const cached = await loadEmbeddingRecord(key).catch(() => undefined);
  if (cached && cached.chunks.length === message.chunks.length) {
    loaded = {
      transcriptId: message.transcriptId,
      chunks: cached.chunks,
      vectors: cached.vectors,
      dimension: cached.dimension,
    };
    post({
      type: "indexed",
      requestId: message.requestId,
      transcriptId: message.transcriptId,
      cached: true,
      chunks: cached.chunks.length,
      backend: (active as TransformersEmbeddingProvider).activeBackend,
      elapsedMs: performance.now() - started,
    });
    status(message.requestId, { phase: "ready", message: "Meaning search is ready (cached)." });
    return;
  }

  const dimension = active.dimension;
  const vectors = new Float32Array(message.chunks.length * dimension);

  let cursor = 0;
  for (const batch of embeddingBatches(message.chunks)) {
    assertLive(message.requestId);
    const embedded = await active.embedPassages(batch.map((chunk) => chunk.text));
    for (let offset = 0; offset < embedded.length; offset += 1) {
      vectors.set(embedded[offset]!, (cursor + offset) * dimension);
    }
    const done = Math.min(message.chunks.length, cursor + batch.length);
    status(message.requestId, {
      phase: "indexing",
      message: "Understanding this video…",
      progress: (done / message.chunks.length) * 100,
      indexed: done,
      total: message.chunks.length,
    });
    cursor = done;
    await yieldToLoop();
  }

  assertLive(message.requestId);
  loaded = { transcriptId: message.transcriptId, chunks: message.chunks, vectors, dimension };

  await saveEmbeddingRecord({
    ...identity,
    key,
    videoId: message.videoId,
    chunks: message.chunks,
    vectors,
    createdAt: Date.now(),
  }).catch(() => undefined); // A full disk must not break the in-memory index we just built.

  post({
    type: "indexed",
    requestId: message.requestId,
    transcriptId: message.transcriptId,
    cached: false,
    chunks: message.chunks.length,
    backend: (active as TransformersEmbeddingProvider).activeBackend,
    elapsedMs: performance.now() - started,
  });
  status(message.requestId, { phase: "ready", message: "Meaning search is ready." });
}

async function search(message: Extract<SemanticWorkerRequest, { type: "search" }>) {
  const index = loaded;
  // Binding results to a transcript id is what stops a result from a previous video being shown
  // after navigation.
  if (!index || index.transcriptId !== message.transcriptId) {
    throw new Error("This transcript is not indexed yet.");
  }
  if (!provider) throw new Error("The embedding model is not initialized.");

  status(message.requestId, { phase: "searching", message: "Searching by meaning…" });
  const [queryVector] = await provider.embedQueries([message.query]);
  assertLive(message.requestId);
  if (!queryVector) throw new Error("The query could not be embedded.");

  const { chunks, vectors, dimension } = index;
  const scored: Array<{ chunk: TranscriptChunk; score: number }> = [];
  for (let position = 0; position < chunks.length; position += 1) {
    scored.push({ chunk: chunks[position]!, score: dot(queryVector, vectors, position * dimension, dimension) });
  }

  const results: SearchResult[] = scored
    .sort((left, right) => right.score - left.score)
    .slice(0, message.limit)
    .map(({ chunk, score }) => ({
      id: `semantic-${chunk.id}`,
      start: chunk.start,
      end: chunk.end,
      text: chunk.text,
      score,
      signals: ["semantic"],
      cueStartIndex: chunk.cueStartIndex,
      cueEndIndex: chunk.cueEndIndex,
      highlights: [],
      explanation: "Close in meaning to what you described.",
    }));

  post({ type: "results", requestId: message.requestId, transcriptId: message.transcriptId, results });
  status(message.requestId, { phase: "ready", message: "Meaning search is ready." });
}

worker.onmessage = (event: MessageEvent<SemanticWorkerRequest>) => {
  const message = event.data;

  if (message.type === "cancel") {
    cancelled.add(message.targetRequestId);
    post({ type: "cancelled", requestId: message.targetRequestId });
    return;
  }

  if (message.type === "dispose") {
    loaded = undefined;
    const previous = provider;
    provider = undefined;
    providerKey = undefined;
    void previous?.dispose().catch(() => undefined);
    post({ type: "cancelled", requestId: message.requestId });
    return;
  }

  const task = message.type === "index" ? indexTranscript(message) : search(message);
  void task
    .catch((error: unknown) => {
      if (error instanceof Cancelled) {
        post({ type: "cancelled", requestId: message.requestId });
        return;
      }
      const detail = error instanceof Error ? error.message : "Local semantic search failed.";
      status(message.requestId, { phase: "failed", message: detail });
      post({ type: "error", requestId: message.requestId, error: detail, recoverable: true });
    })
    .finally(() => {
      cancelled.delete(message.requestId);
    });
};
