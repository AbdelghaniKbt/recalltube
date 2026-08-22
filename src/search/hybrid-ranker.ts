import type { MatchSignal, SearchResult } from "../types/transcript";

/**
 * Weighted reciprocal rank fusion with deterministic grouping and temporal diversification.
 *
 * Reciprocal rank fusion is the right primitive here because exact, lexical and dense scores are
 * not on comparable scales and calibrating them would be inventing precision we cannot justify.
 * Three problems in the previous implementation are fixed:
 *
 *   1. Grouping used `fused.find(candidate => overlaps(candidate, result))`, which is not an
 *      equivalence relation — whether B joined A or C depended on insertion order, and A and C
 *      could be merged transitively through B without overlapping each other.
 *   2. That `find` inside a nested loop was O(n²).
 *   3. Every list contributed with equal weight, so a weak lexical list diluted a strong exact one.
 *
 * Weights are constants here and are measured by the benchmark in
 * benchmarks/ rather than chosen by intuition.
 */

/** Standard RRF damping constant (Cormack et al., 2009). */
const RRF_K = 60;

/** Results whose starts fall in the same bucket are the same moment. */
const BUCKET_SECONDS = 8;

export interface RankedList {
  results: SearchResult[];
  weight: number;
}

export interface FusionOptions {
  limit?: number;
  /** Minimum gap between two results shown to the user. */
  diversifySeconds?: number;
}

/** Deterministic bucket key: grouping by time, not by "whichever overlapping result I saw first". */
function bucketOf(result: SearchResult): number {
  return Math.floor(result.start / BUCKET_SECONDS);
}

function mergeSignals(into: SearchResult, from: SearchResult): void {
  for (const signal of from.signals) if (!into.signals.includes(signal)) into.signals.push(signal);
}

/**
 * Picks the representative for a group: an exact hit always wins because it carries real highlight
 * offsets and a precise span; otherwise the earlier-ranked candidate wins.
 */
function preferred(current: SearchResult, candidate: SearchResult): SearchResult {
  const currentExact = current.signals.includes("exact");
  const candidateExact = candidate.signals.includes("exact");
  if (currentExact !== candidateExact) return currentExact ? current : candidate;
  return current;
}

export function fuseRanked(lists: RankedList[], options: FusionOptions = {}): SearchResult[] {
  const limit = options.limit ?? 25;
  const groups = new Map<number, { result: SearchResult; score: number }>();

  for (const { results, weight } of lists) {
    if (weight <= 0) continue;
    results.forEach((result, rank) => {
      const key = bucketOf(result);
      const contribution = weight / (RRF_K + rank + 1);
      const existing = groups.get(key);
      if (!existing) {
        groups.set(key, { result: { ...result, signals: [...result.signals] }, score: contribution });
        return;
      }
      existing.score += contribution;
      const winner = preferred(existing.result, result);
      if (winner !== existing.result) {
        const signals = existing.result.signals;
        existing.result = { ...result, signals: [...result.signals] };
        for (const signal of signals) if (!existing.result.signals.includes(signal)) existing.result.signals.push(signal);
      } else {
        mergeSignals(existing.result, result);
      }
    });
  }

  const ranked = [...groups.values()]
    .sort((left, right) => right.score - left.score || left.result.start - right.result.start)
    .map(({ result, score }) => ({ ...result, score }));

  const gap = options.diversifySeconds ?? BUCKET_SECONDS;
  // `diversifySeconds: 0` lets the caller refine timestamps *before* suppressing neighbours, which
  // is what src/search/engine.ts does — suppressing on un-refined 45-second spans would swallow
  // precise results that happen to fall inside a broad chunk.
  return (gap > 0 ? diversify(ranked, gap) : ranked).slice(0, limit);
}

/**
 * Temporal suppression: overlapping context chunks otherwise produce five near-identical views of
 * one passage. Genuinely repeated mentions at different timestamps survive, because suppression is
 * by distance rather than by text similarity.
 */
export function diversify(results: SearchResult[], minimumGapSeconds: number): SearchResult[] {
  const kept: SearchResult[] = [];
  for (const result of results) {
    const clash = kept.find(
      (existing) =>
        Math.abs(existing.start - result.start) < minimumGapSeconds ||
        (result.start >= existing.start && result.start < existing.end)
    );
    if (!clash) {
      kept.push(result);
      continue;
    }
    // Absorbing a suppressed result must not let the survivor *claim* precision it does not have:
    // an exact hit carries real highlights and a tight span, so it takes over as the
    // representative rather than merely donating its signal to a broad chunk.
    if (result.signals.includes("exact") && !clash.signals.includes("exact")) {
      const signals = [...clash.signals];
      Object.assign(clash, result, { score: clash.score, signals: [...result.signals] });
      for (const signal of signals) if (!clash.signals.includes(signal)) clash.signals.push(signal);
    } else {
      mergeSignals(clash, result);
    }
  }
  return kept;
}

/** Back-compatible helper: equal weights, used by tests and the benchmark baselines. */
export function fuseResults(resultLists: SearchResult[][], limit = 25): SearchResult[] {
  return fuseRanked(
    resultLists.map((results) => ({ results, weight: 1 })),
    { limit }
  );
}

/** The user-facing label for a result. Never a percentage. */
export function matchLabel(signals: MatchSignal[]): string {
  if (signals.includes("boundary-exact")) return "Exact phrase";
  if (signals.includes("exact")) return "Exact phrase";
  if (signals.includes("cross-language")) return "Cross-language match";
  if (signals.includes("semantic") && signals.includes("lexical")) return "Same meaning";
  if (signals.includes("semantic")) return "Same meaning";
  if (signals.includes("lexical")) return "Close wording";
  return "Related discussion";
}
