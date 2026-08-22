import type { SearchResult, TranscriptChunk, TranscriptCue } from "../types/transcript";
import { buildSearchIndex, type TranscriptSearchIndex } from "../transcript/flatten";
import { chunkTranscript, type MultiScaleChunks } from "../transcript/chunk";
import { exactSearchIndexed } from "./exact-search";
import { buildLexicalIndex, lexicalSearchIndexed, type LexicalIndex } from "./lexical-search";
import { diversify, fuseRanked, type RankedList } from "./hybrid-ranker";
import { buildCueTerms, prepareQuery, refineResult, type CueTerms } from "./refine";
import { buildCorpus, type Corpus } from "./token-match";

/**
 * Per-transcript retrieval state, built once and reused for every keystroke.
 *
 * Building this eagerly on each search was the single largest UI-thread cost in the alpha
 * (59.3 ms per keystroke on a 2-hour transcript).
 */
export interface RetrievalIndex {
  transcriptId: string;
  cues: TranscriptCue[];
  flat: TranscriptSearchIndex;
  chunks: MultiScaleChunks;
  /** Built on first Meaning-mode search; Exact mode never touches it. */
  readonly lexical: LexicalIndex;
  /** Transcript-wide term statistics, so refinement can judge what is actually distinctive. */
  readonly corpus: Corpus;
  /** Per-cue token and n-gram sets, so refinement never re-tokenizes during a search. */
  readonly cueTerms: CueTerms;
}

/**
 * Builds everything Exact mode needs immediately, and defers the rest.
 *
 * On a 10,000-cue transcript the lexical index and per-cue term sets cost ~3 s to build. Exact
 * search needs neither, so paying for them up front would freeze the panel on open for a user who
 * never leaves Exact mode. They are built on first use instead, by which point Meaning mode is
 * already showing model progress.
 */
export function buildRetrievalIndex(transcriptId: string, cues: TranscriptCue[]): RetrievalIndex {
  const chunks = chunkTranscript(cues);
  let lexical: LexicalIndex | undefined;
  let corpus: Corpus | undefined;
  let cueTerms: CueTerms | undefined;

  return {
    transcriptId,
    cues,
    flat: buildSearchIndex(cues),
    chunks,
    get lexical() {
      // Lexical retrieval runs over context chunks: they carry enough words for BM25 length
      // normalization to behave, and refinement narrows the timestamp afterwards.
      lexical ??= buildLexicalIndex(chunks.context);
      return lexical;
    },
    get corpus() {
      corpus ??= buildCorpus(cues.map((cue) => cue.text));
      return corpus;
    },
    get cueTerms() {
      cueTerms ??= buildCueTerms(cues);
      return cueTerms;
    },
  };
}

/**
 * Fusion weights. Exact evidence is the strongest signal RecallTube has, dense retrieval is the
 * reason Meaning mode exists, and lexical sits between them as the typo/ASR safety net.
 * These are measured in benchmarks/, not guessed — see docs/RETRIEVAL_BENCHMARK.md.
 */
export const FUSION_WEIGHTS = { exact: 1.6, semantic: 1.0, lexical: 0.7 } as const;

/** Minimum gap between two displayed moments, applied after timestamp refinement. */
const DIVERSIFY_SECONDS = 8;

export interface HybridSearchOptions {
  /** Dense results supplied by the semantic worker, already chunk-aligned. */
  semantic?: SearchResult[];
  limit?: number;
  /** Meaning mode fuses all three signals; Exact mode shows only verbatim matches. */
  mode: "exact" | "meaning";
}

export function search(index: RetrievalIndex, query: string, options: HybridSearchOptions): SearchResult[] {
  const trimmed = query.trim();
  if (trimmed.length < 2) return [];

  const exact = exactSearchIndexed(index.flat, trimmed, options.limit ?? 50);
  if (options.mode === "exact") return exact;

  const lexical = lexicalSearchIndexed(index.lexical, trimmed);
  const lists: RankedList[] = [
    { results: exact, weight: FUSION_WEIGHTS.exact },
    { results: options.semantic ?? [], weight: FUSION_WEIGHTS.semantic },
    { results: lexical, weight: FUSION_WEIGHTS.lexical },
  ];

  const limit = options.limit ?? 25;
  // Fuse without suppressing neighbours, refine each candidate down to its strongest evidence,
  // and only then diversify — otherwise a broad 45-second chunk swallows the precise result that
  // sits inside it.
  const fused = fuseRanked(lists, { limit: limit * 3, diversifySeconds: 0 });
  // Tokenize the query once, not once per candidate.
  const prepared = prepareQuery(trimmed);
  const refined = fused.map((result) =>
    result.signals.includes("exact") ? result : refineResult(result, index.cues, prepared, index.corpus, index.cueTerms)
  );
  return diversify(refined, DIVERSIFY_SECONDS).slice(0, limit);
}

/** Chunks the semantic worker should embed. Context scale is what dense retrieval searches. */
export function embeddableChunks(index: RetrievalIndex): TranscriptChunk[] {
  return index.chunks.context;
}
