import { characterNgrams, tokenize } from "../transcript/normalize";

/**
 * Shared token-matching primitives for the components that score short passages against a query:
 * timestamp refinement and the extractive Ask provider.
 *
 * Both need the same two properties, and both got them wrong independently before this existed:
 *
 *   - Mild inflection tolerance, so "reject" finds "rejected", without the false positives a real
 *     stemmer produces, especially in Arabic.
 *   - Term weighting, so function words cannot decide the answer. Unweighted coverage let
 *     "the a of and is" outscore a genuine match.
 */

/** Shortest token for which a prefix relation is meaningful rather than coincidental. */
const MIN_PREFIX_LENGTH = 4;

export function tokenMatches(queryToken: string, documentTokens: Set<string>): boolean {
  if (documentTokens.has(queryToken)) return true;
  if (queryToken.length < MIN_PREFIX_LENGTH) return false;
  for (const token of documentTokens) {
    if (token.length < MIN_PREFIX_LENGTH) continue;
    if (token.startsWith(queryToken) || queryToken.startsWith(token)) return true;
  }
  return false;
}

export interface TermWeights {
  weightOf(token: string): number;
  totalWeight: number;
}

/** Term statistics over a whole transcript, computed once per transcript. */
export interface Corpus {
  documentFrequency: Map<string, number>;
  documentCount: number;
}

export function buildCorpus(documents: string[]): Corpus {
  const documentFrequency = new Map<string, number>();
  for (const document of documents) {
    for (const token of new Set(tokenize(document))) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
  }
  return { documentFrequency, documentCount: Math.max(1, documents.length) };
}

/**
 * Inverse-document-frequency weights.
 *
 * Prefer passing a transcript-wide `Corpus`: statistics over a three-cue span are far too noisy to
 * judge whether a term is distinctive, and "of" appearing in one cue of eight looks as rare as
 * "discharge" does.
 */
export function termWeights(documents: string[], queryTokens: Iterable<string>, corpus?: Corpus): TermWeights {
  const stats = corpus ?? buildCorpus(documents);
  const weightOf = (token: string) => {
    const frequency = stats.documentFrequency.get(token) ?? 0;
    return Math.log(1 + (stats.documentCount - frequency + 0.5) / (frequency + 0.5));
  };
  let totalWeight = 0;
  for (const token of queryTokens) totalWeight += weightOf(token);
  return { weightOf, totalWeight };
}

/**
 * Whether a token is long enough for its presence to count as *evidence*.
 *
 * A one- or two-character Latin token ("a", "of", "is") carries no retrieval signal however rare it
 * looks in a short transcript. Characters in scripts written without spaces do carry signal, so
 * they are exempt.
 */
const SPACELESS_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Hangul}]/u;

export function canBeEvidence(token: string): boolean {
  return token.length >= 3 || SPACELESS_SCRIPT.test(token);
}

export interface PassageScore {
  /** Relative fit, for ordering candidates. */
  ranking: number;
  /** Weight of the single most distinctive query term that matched, for gating. */
  evidence: number;
}

export function scorePassage(
  text: string,
  queryTokens: Set<string>,
  queryNgrams: Set<string>,
  weights: TermWeights
): PassageScore {
  return scorePrepared(new Set(tokenize(text)), characterNgrams(text), queryTokens, queryNgrams, weights);
}

/**
 * Scores a passage whose token and n-gram sets have already been computed.
 *
 * Timestamp refinement evaluates dozens of overlapping cue windows per result; re-tokenizing the
 * joined text of each window measured at ~110 ms per keystroke, well over the 50 ms long-task
 * budget. Callers precompute per-cue sets once and union them, which makes window scoring
 * proportional to the query rather than to the transcript.
 */
export function scorePrepared(
  tokens: Set<string>,
  ngrams: Set<string>,
  queryTokens: Set<string>,
  queryNgrams: Set<string>,
  weights: TermWeights
): PassageScore {
  if (!tokens.size || weights.totalWeight <= 0) return { ranking: 0, evidence: 0 };

  let matched = 0;
  let evidence = 0;
  for (const token of queryTokens) {
    if (!tokenMatches(token, tokens)) continue;
    const weight = weights.weightOf(token);
    matched += weight;
    if (canBeEvidence(token)) evidence = Math.max(evidence, weight);
  }

  let overlap = 0;
  for (const gram of queryNgrams) if (ngrams.has(gram)) overlap += 1;
  const fuzzy = queryNgrams.size ? overlap / queryNgrams.size : 0;

  return { ranking: (matched / weights.totalWeight) * 0.75 + fuzzy * 0.25, evidence };
}
