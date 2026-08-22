import type { SearchResult, TranscriptCue } from "../types/transcript";
import {
  buildSearchIndex,
  coveredCuePositions,
  highlightsForSpan,
  type TranscriptSearchIndex,
} from "../transcript/flatten";
import { normalizeForSearch } from "../transcript/normalize";

const MIN_QUERY_LENGTH = 2;

/**
 * Every occurrence of `query` in the flattened transcript, including phrases that straddle cue
 * boundaries, with highlight spans in original-text coordinates.
 *
 * Overlapping occurrences are found too: searching "abab" in "abababab" yields matches at 0, 2 and
 * 4, because a user looking for a repeated phrase wants all of them. The previous implementation
 * advanced the cursor by the needle length and silently skipped overlaps.
 */
export function exactSearchIndexed(
  index: TranscriptSearchIndex,
  query: string,
  limit = 50
): SearchResult[] {
  const needle = normalizeForSearch(query);
  if (needle.length < MIN_QUERY_LENGTH || !index.cues.length) return [];

  const results: SearchResult[] = [];
  let cursor = 0;

  while (results.length < limit) {
    const position = index.text.indexOf(needle, cursor);
    if (position === -1) break;
    const endOffset = position + needle.length;
    const { first, last } = coveredCuePositions(index, position, endOffset);
    const firstCue = index.cues[first];
    const lastCue = index.cues[last];
    if (!firstCue || !lastCue) break;

    const matched = index.cues.slice(first, last + 1);
    const spansCues = last > first;

    results.push({
      id: `exact-${position}`,
      start: firstCue.cue.start,
      end: lastCue.cue.end,
      text: matched.map((entry) => entry.cue.text).join(" "),
      contextBefore: index.cues[first - 1]?.cue.text,
      contextAfter: index.cues[last + 1]?.cue.text,
      score: 1,
      signals: spansCues ? ["exact", "boundary-exact"] : ["exact"],
      cueStartIndex: firstCue.cueIndex,
      cueEndIndex: lastCue.cueIndex,
      highlights: highlightsForSpan(index, position, endOffset),
      explanation: spansCues ? "Exact phrase, spanning a caption break." : undefined,
    });

    cursor = position + 1;
  }

  return results;
}

/** Convenience entry point for callers that do not hold a prebuilt index (tests, benchmarks). */
export function exactSearch(cues: TranscriptCue[], query: string, limit = 50): SearchResult[] {
  return exactSearchIndexed(buildSearchIndex(cues), query, limit);
}
