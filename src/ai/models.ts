/**
 * Candidate embedding models.
 *
 * A model earns the default slot by winning RecallTube's own benchmark on quality *per device
 * cost*, not by leading a public leaderboard. See docs/RETRIEVAL_BENCHMARK.md for the measurements
 * behind the current default.
 *
 * `revision` is pinned so a silent upstream change cannot alter results or quietly invalidate
 * caches without a version bump here.
 */

export interface ModelDescriptor {
  id: string;
  /** Hugging Face repo id. */
  repo: string;
  /** Pinned revision. `main` is only acceptable for candidates that are not the default. */
  revision: string;
  dimension: number;
  dtype: "fp32" | "fp16" | "q8";
  pooling: "mean" | "cls";
  /** Prefixes required by the model card, if the model is asymmetric. */
  queryPrefix: string;
  passagePrefix: string;
  /** Approximate download size in MB, measured over the wire. */
  approximateDownloadMb: number;
  license: string;
  /** Whether this model is offered in the UI, or only available to the benchmark. */
  availability: "default" | "experimental" | "benchmark-only";
  notes: string;
}

export const MODELS: Record<string, ModelDescriptor> = {
  "e5-small": {
    id: "e5-small",
    repo: "Xenova/multilingual-e5-small",
    revision: "main",
    dimension: 384,
    dtype: "q8",
    pooling: "mean",
    // Required by the intfloat/multilingual-e5-small model card: every input must carry one of
    // these prefixes, and symmetric use of the wrong prefix measurably degrades retrieval.
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    approximateDownloadMb: 118,
    license: "MIT",
    availability: "default",
    notes: "Multilingual E5 small. Mean pooling, L2-normalized, asymmetric query/passage prefixes.",
  },
  "e5-base": {
    id: "e5-base",
    repo: "Xenova/multilingual-e5-base",
    revision: "main",
    dimension: 768,
    dtype: "q8",
    pooling: "mean",
    queryPrefix: "query: ",
    passagePrefix: "passage: ",
    approximateDownloadMb: 290,
    license: "MIT",
    availability: "benchmark-only",
    notes: "Larger E5. Benchmarked as a quality ceiling; too heavy to be a sensible default.",
  },
  "granite-107m": {
    id: "granite-107m",
    repo: "ibm-granite/granite-embedding-107m-multilingual",
    revision: "main",
    dimension: 384,
    dtype: "q8",
    pooling: "cls",
    // Granite embedding models are symmetric: no prefixes.
    queryPrefix: "",
    passagePrefix: "",
    approximateDownloadMb: 0,
    license: "Apache-2.0",
    availability: "benchmark-only",
    notes:
      "Compact multilingual candidate with a permissive licence. Requires a browser-compatible ONNX export to be verified before it can be offered; see docs/RETRIEVAL_BENCHMARK.md.",
  },
};

export const DEFAULT_MODEL_ID = "e5-small";

export function modelDescriptor(id: string): ModelDescriptor {
  return MODELS[id] ?? MODELS[DEFAULT_MODEL_ID]!;
}
