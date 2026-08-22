/**
 * The boundary between RecallTube's retrieval code and whatever inference runtime is underneath.
 *
 * Keeping this narrow is what makes the model tournament in benchmarks/ possible without touching
 * retrieval, and what would let the transformers.js runtime be swapped without a rewrite.
 */

export type Backend = "webgpu" | "wasm";

export interface ModelProgress {
  phase: "downloading" | "loading" | "ready";
  /** 0–100 where known. */
  progress?: number;
  file?: string;
}

export interface InitializeOptions {
  preferredBackend: Backend;
  signal?: AbortSignal;
  onProgress?: (progress: ModelProgress) => void;
}

export interface EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly dimension: number;
  readonly dtype: string;
  readonly pooling: string;

  initialize(options: InitializeOptions): Promise<{ backend: Backend }>;
  /** Embeds search queries, applying whatever asymmetric prefix the model requires. */
  embedQueries(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  /** Embeds transcript passages, applying whatever asymmetric prefix the model requires. */
  embedPassages(texts: string[], signal?: AbortSignal): Promise<Float32Array[]>;
  dispose(): Promise<void>;
}

/** Cosine similarity for L2-normalized vectors is a dot product. */
export function dot(left: Float32Array, right: Float32Array, offset = 0, length = left.length): number {
  let sum = 0;
  for (let index = 0; index < length; index += 1) sum += left[index]! * right[offset + index]!;
  return sum;
}

export function l2Normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (let index = 0; index < vector.length; index += 1) norm += vector[index]! * vector[index]!;
  norm = Math.sqrt(norm);
  if (norm === 0) return vector;
  for (let index = 0; index < vector.length; index += 1) vector[index] = vector[index]! / norm;
  return vector;
}
