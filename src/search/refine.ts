import type { SearchResult, TranscriptCue } from "../types/transcript";
import { characterNgrams, tokenize } from "../transcript/normalize";
import { scorePrepared, termWeights, type Corpus } from "./token-match";

/**
 * Per-cue token and n-gram sets, computed once per transcript.
 *
 * Refinement evaluates dozens of overlapping windows per result; without this it re-tokenized the
 * joined text of every window and cost ~110 ms per keystroke.
 */
export interface CueTerms {
  tokens: Array<Set<string>>;
  ngrams: Array<Set<string>>;
}

export function buildCueTerms(cues: TranscriptCue[]): CueTerms {
  return {
    tokens: cues.map((cue) => new Set(tokenize(cue.text))),
    ngrams: cues.map((cue) => characterNgrams(cue.text)),
  };
}

function unionInto<T>(target: Set<T>, source: Set<T> | undefined): void {
  if (!source) return;
  for (const value of source) target.add(value);
}

/**
 * A query tokenized once per search rather than once per candidate.
 *
 * A single Meaning-mode search refines up to ~75 fused candidates; deriving the query's tokens and
 * n-grams inside each of them dominated the per-keystroke cost on long transcripts.
 */
export interface PreparedQuery {
  tokens: Set<string>;
  ngrams: Set<string>;
}

export function prepareQuery(query: string): PreparedQuery {
  return { tokens: new Set(tokenize(query)), ngrams: characterNgrams(query) };
}

/**
 * Timestamp refinement.
 *
 * A semantic hit identifies a chunk that can span 45 seconds, but the user asked for a moment.
 * Seeking to the chunk start can therefore drop the viewer most of a minute before the sentence
 * they remembered.
 *
 * We score every short window of cues inside the retrieved span against the query, pick the
 * strongest, and seek slightly before it — but only when there is real lexical evidence to justify
 * moving. See `MIN_REFINE_EVIDENCE`.
 */

/** Seconds of lead-in so the viewer hears the run-up to the evidence. */
const LEAD_IN_SECONDS = 1.5;
/** Largest evidence window considered, in cues. */
const MAX_WINDOW_CUES = 3;

/**
 * Minimum weight of the most distinctive query term that must appear in the chosen window before
 * we move the seek target.
 *
 * Set from measurement, not intuition. Refinement scores windows *lexically*; a paraphrased or
 * cross-language query has little lexical signal inside the retrieved passage by definition, so an
 * unconditional refiner picks an essentially arbitrary sentence and drags the result off the
 * passage dense retrieval correctly found — in benchmarks/ that cost 18 points of Recall@1
 * (0.97 -> 0.79). Gating on the single most distinctive matched term, rather than on normalized
 * coverage, also stops a query of pure function words ("the a of and is") from qualifying.
 *
 * The value was chosen by sweeping it against benchmarks/ (0.8 / 1.5 / 2.2). At 0.8 refinement
 * still cost 4 points of Recall@1; from 1.5 upwards recall matches the unrefined pipeline exactly
 * while P95 timestamp error falls from 22 s to 9 s. See docs/RETRIEVAL_BENCHMARK.md.
 *
 * For scale: over a 25-cue transcript a term appearing in one cue weighs ~2.9, in five cues ~1.6,
 * and in half the cues ~0.7.
 */
const MIN_REFINE_EVIDENCE = 1.5;

export interface RefinedEvidence {
  start: number;
  end: number;
  cueStartIndex: number;
  cueEndIndex: number;
  text: string;
  /** Weight of the most distinctive query term found in this window. */
  evidence: number;
}

/**
 * Finds the strongest short window of cues within `[cueStartIndex, cueEndIndex]` for `query`.
 * Returns `undefined` when nothing inside the span responds to the query, in which case the caller
 * should keep the original span rather than seek somewhere arbitrary.
 */
export function refineEvidence(
  cues: TranscriptCue[],
  cueStartIndex: number,
  cueEndIndex: number,
  query: string | PreparedQuery,
  corpus?: Corpus,
  terms?: CueTerms
): RefinedEvidence | undefined {
  const first = Math.max(0, cueStartIndex);
  const last = Math.min(cues.length - 1, cueEndIndex);
  if (first > last) return undefined;

  const { tokens: queryTokens, ngrams: queryNgrams } =
    typeof query === "string" ? prepareQuery(query) : query;
  if (!queryTokens.size) return undefined;

  // Weights come from the whole transcript when available: statistics over a three-cue span are
  // far too noisy to judge whether a term is distinctive.
  const weights = termWeights(
    cues.slice(first, last + 1).map((cue) => cue.text),
    queryTokens,
    corpus
  );
  if (weights.totalWeight <= 0) return undefined;

  const prepared = terms ?? buildCueTerms(cues);
  let best: { ranking: number; evidence: number; from: number; to: number } | undefined;

  for (let from = first; from <= last; from += 1) {
    // Grow the window one cue at a time, accumulating token and n-gram sets instead of
    // re-tokenizing the joined text for every window.
    const tokens = new Set<string>();
    const ngrams = new Set<string>();
    for (let size = 1; size <= MAX_WINDOW_CUES && from + size - 1 <= last; size += 1) {
      const to = from + size - 1;
      unionInto(tokens, prepared.tokens[to]);
      unionInto(ngrams, prepared.ngrams[to]);
      const scored = scorePrepared(tokens, ngrams, queryTokens, queryNgrams, weights);
      // Slightly favour tighter windows so we do not drift back to the whole span on a tie.
      const ranking = scored.ranking - (size - 1) * 0.02;
      if (!best || ranking > best.ranking) best = { ranking, evidence: scored.evidence, from, to };
    }
  }

  if (!best || best.ranking <= 0) return undefined;

  const fromCue = cues[best.from]!;
  const toCue = cues[best.to]!;
  return {
    start: fromCue.start,
    end: toCue.end,
    cueStartIndex: best.from,
    cueEndIndex: best.to,
    text: cues
      .slice(best.from, best.to + 1)
      .map((cue) => cue.text)
      .join(" "),
    evidence: best.evidence,
  };
}

/**
 * Applies refinement to a result, moving its seek target onto the strongest evidence while keeping
 * the broader retrieved passage as displayed context.
 */
export function refineResult(
  result: SearchResult,
  cues: TranscriptCue[],
  query: string | PreparedQuery,
  corpus?: Corpus,
  terms?: CueTerms
): SearchResult {
  const refined = refineEvidence(cues, result.cueStartIndex, result.cueEndIndex, query, corpus, terms);
  // Without distinctive lexical evidence, narrowing would be a guess that moves the user away from
  // the passage dense retrieval found. Keeping the broader span is the honest outcome.
  if (!refined || refined.evidence < MIN_REFINE_EVIDENCE) return result;

  const previous = cues[refined.cueStartIndex - 1];
  const next = cues[refined.cueEndIndex + 1];

  return {
    ...result,
    start: Math.max(0, refined.start - LEAD_IN_SECONDS),
    end: refined.end,
    text: refined.text,
    contextBefore: previous?.text ?? result.contextBefore,
    contextAfter: next?.text ?? result.contextAfter,
    cueStartIndex: refined.cueStartIndex,
    cueEndIndex: refined.cueEndIndex,
  };
}
