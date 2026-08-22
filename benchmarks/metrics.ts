import type { SearchResult } from "../src/types/transcript";
import type { BenchmarkQuery } from "./dataset";

/**
 * Retrieval metrics.
 *
 * Relevance is judged by timestamp overlap rather than by chunk identity, so the same labels stay
 * valid across chunking changes. A result counts as relevant when its span overlaps a labelled
 * range at all — the *distance* from the ideal moment is reported separately as timestamp error,
 * because "found the right passage" and "seeks to the right second" are different qualities and
 * conflating them hides regressions in either.
 */

export interface QueryOutcome {
  queryId: string;
  categories: string[];
  rankOfFirstRelevant: number | null;
  /** Seconds between the top result's seek target and the nearest labelled range. */
  timestampErrorSeconds: number | null;
  returnedCount: number;
}

export interface AggregateMetrics {
  queries: number;
  recallAt1: number;
  recallAt3: number;
  recallAt5: number;
  mrr: number;
  ndcgAt5: number;
  medianTimestampError: number | null;
  p95TimestampError: number | null;
  /** Share of no-answer queries where the system correctly returned nothing. */
  correctAbstentions: number | null;
}

function overlaps(result: SearchResult, range: { start: number; end: number }): boolean {
  return result.start < range.end && range.start < result.end;
}

function relevanceOf(result: SearchResult, query: BenchmarkQuery): number {
  let best = 0;
  for (const range of query.relevantTimeRanges) {
    if (overlaps(result, range)) best = Math.max(best, range.relevance);
  }
  return best;
}

/**
 * Seconds by which a seek target misses the labelled moment.
 *
 * Landing a little *before* the labelled range is the intended behaviour, not an error: the
 * retrieval engine deliberately adds a short lead-in so the viewer hears the run-up rather than
 * starting mid-sentence. Counting that lead-in as error would report a system that seeks perfectly
 * as having a 1.5-second median error, and would make an unrefined chunk-start seek look
 * artificially competitive. Landing *after* the moment is always an error — the user has to scrub
 * backwards.
 */
const LEAD_IN_TOLERANCE_SECONDS = 3;

function timestampError(result: SearchResult, query: BenchmarkQuery): number | null {
  if (!query.relevantTimeRanges.length) return null;
  let best = Number.POSITIVE_INFINITY;
  for (const range of query.relevantTimeRanges) {
    const earliestAcceptable = range.start - LEAD_IN_TOLERANCE_SECONDS;
    const distance =
      result.start < earliestAcceptable
        ? earliestAcceptable - result.start
        : result.start > range.end
          ? result.start - range.end
          : 0;
    best = Math.min(best, distance);
  }
  return best;
}

export function scoreQuery(query: BenchmarkQuery, results: SearchResult[]): QueryOutcome {
  let rank: number | null = null;
  for (let index = 0; index < results.length; index += 1) {
    if (relevanceOf(results[index]!, query) > 0) {
      rank = index + 1;
      break;
    }
  }
  return {
    queryId: query.id,
    categories: query.category,
    rankOfFirstRelevant: rank,
    timestampErrorSeconds: results[0] ? timestampError(results[0], query) : null,
    returnedCount: results.length,
  };
}

function dcg(gains: number[]): number {
  return gains.reduce((sum, gain, index) => sum + (2 ** gain - 1) / Math.log2(index + 2), 0);
}

export function ndcgAt5(query: BenchmarkQuery, results: SearchResult[]): number {
  if (!query.relevantTimeRanges.length) return 0;

  // Credit each labelled range once. Without this, five near-identical chunks overlapping the same
  // range each score full relevance and nDCG exceeds 1 — which also rewards exactly the redundant
  // output that diversification exists to prevent.
  const credited = new Set<number>();
  const gains = results.slice(0, 5).map((result) => {
    let best = 0;
    let bestIndex = -1;
    query.relevantTimeRanges.forEach((range, index) => {
      if (credited.has(index) || !overlaps(result, range)) return;
      if (range.relevance > best) {
        best = range.relevance;
        bestIndex = index;
      }
    });
    if (bestIndex >= 0) credited.add(bestIndex);
    return best;
  });

  const ideal = query.relevantTimeRanges
    .map((range) => range.relevance)
    .sort((left, right) => right - left)
    .slice(0, 5);
  const idealDcg = dcg(ideal);
  return idealDcg === 0 ? 0 : dcg(gains) / idealDcg;
}

function percentile(values: number[], fraction: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)));
  return sorted[index]!;
}

export function aggregate(
  queries: BenchmarkQuery[],
  outcomes: QueryOutcome[],
  ndcgs: number[]
): AggregateMetrics {
  const answerable = queries.filter((query) => query.relevantTimeRanges.length > 0);
  const answerableIds = new Set(answerable.map((query) => query.id));
  const answerableOutcomes = outcomes.filter((outcome) => answerableIds.has(outcome.queryId));

  const hitsAt = (n: number) =>
    answerableOutcomes.filter((outcome) => outcome.rankOfFirstRelevant !== null && outcome.rankOfFirstRelevant <= n)
      .length / Math.max(1, answerableOutcomes.length);

  const reciprocalRanks = answerableOutcomes.map((outcome) =>
    outcome.rankOfFirstRelevant ? 1 / outcome.rankOfFirstRelevant : 0
  );

  const errors = answerableOutcomes
    .map((outcome) => outcome.timestampErrorSeconds)
    .filter((value): value is number => value !== null && Number.isFinite(value));

  const unanswerable = queries.filter((query) => query.relevantTimeRanges.length === 0);
  const unanswerableIds = new Set(unanswerable.map((query) => query.id));
  const abstentions = outcomes.filter(
    (outcome) => unanswerableIds.has(outcome.queryId) && outcome.returnedCount === 0
  ).length;

  const answerableNdcgs = ndcgs.slice(0, answerableOutcomes.length);

  return {
    queries: queries.length,
    recallAt1: hitsAt(1),
    recallAt3: hitsAt(3),
    recallAt5: hitsAt(5),
    mrr: reciprocalRanks.reduce((sum, value) => sum + value, 0) / Math.max(1, reciprocalRanks.length),
    ndcgAt5: answerableNdcgs.reduce((sum, value) => sum + value, 0) / Math.max(1, answerableNdcgs.length),
    medianTimestampError: percentile(errors, 0.5),
    p95TimestampError: percentile(errors, 0.95),
    correctAbstentions: unanswerable.length ? abstentions / unanswerable.length : null,
  };
}

export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}
