import type { TranscriptCue } from "../types/transcript";
import type { CueHighlight } from "../types/transcript";
import { normalize, type NormalizedText, toOriginalRange } from "./normalize";

/**
 * A transcript flattened into one normalized string so phrases can be matched across cue
 * boundaries, while keeping enough information to map any match back to original characters in
 * specific cues.
 *
 * Build it once per transcript. The previous code rebuilt it on every keystroke, which measured
 * ~42 ms per search on a 20,000-cue transcript.
 */
export interface IndexedCue {
  cue: TranscriptCue;
  /** Position of this cue in the caller's original `cues` array. */
  cueIndex: number;
  text: NormalizedText;
  /** Offsets of this cue's normalized text inside `TranscriptSearchIndex.text`. */
  searchStart: number;
  searchEnd: number;
}

export interface TranscriptSearchIndex {
  text: string;
  cues: IndexedCue[];
  /** Sorted `searchStart` values, for binary search. */
  starts: Uint32Array;
}

export function buildSearchIndex(cues: TranscriptCue[]): TranscriptSearchIndex {
  const indexed: IndexedCue[] = [];
  const parts: string[] = [];
  let length = 0;

  for (let cueIndex = 0; cueIndex < cues.length; cueIndex += 1) {
    const cue = cues[cueIndex]!;
    const text = normalize(cue.text);
    if (!text.normalized) continue;
    if (length) {
      parts.push(" ");
      length += 1;
    }
    const searchStart = length;
    parts.push(text.normalized);
    length += text.normalized.length;
    indexed.push({ cue, cueIndex, text, searchStart, searchEnd: length });
  }

  return {
    text: parts.join(""),
    cues: indexed,
    starts: Uint32Array.from(indexed, (entry) => entry.searchStart),
  };
}

/**
 * Position (within `index.cues`) of the cue containing `offset`. Offsets landing on an inter-cue
 * separator resolve to the following cue, so a match starting at a separator is attributed to
 * where its text actually is.
 */
export function cueIndexAtOffset(index: TranscriptSearchIndex, offset: number): number {
  const { starts, cues } = index;
  if (!cues.length) return -1;

  let low = 0;
  let high = starts.length - 1;
  let candidate = 0;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (starts[middle]! <= offset) {
      candidate = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const entry = cues[candidate]!;
  if (offset >= entry.searchEnd && candidate + 1 < cues.length) return candidate + 1;
  return candidate;
}

/** Positions in `index.cues` covered by a flattened span. */
export function coveredCuePositions(
  index: TranscriptSearchIndex,
  startOffset: number,
  endOffset: number
): { first: number; last: number } {
  const first = cueIndexAtOffset(index, startOffset);
  const last = cueIndexAtOffset(index, Math.max(startOffset, endOffset - 1));
  return { first, last: Math.max(first, last) };
}

/**
 * Converts a match span in flattened normalized space into per-cue highlights in *original*
 * coordinates. A phrase spanning three cues yields three highlights.
 */
export function highlightsForSpan(
  index: TranscriptSearchIndex,
  startOffset: number,
  endOffset: number
): CueHighlight[] {
  const { first, last } = coveredCuePositions(index, startOffset, endOffset);
  if (first < 0) return [];

  const highlights: CueHighlight[] = [];
  for (let position = first; position <= last && position < index.cues.length; position += 1) {
    const entry = index.cues[position]!;
    const localStart = Math.max(0, startOffset - entry.searchStart);
    const localEnd = Math.min(entry.text.normalized.length, endOffset - entry.searchStart);
    const range = toOriginalRange(entry.text, localStart, localEnd);
    if (range) highlights.push({ cueIndex: entry.cueIndex, start: range.start, end: range.end });
  }
  return highlights;
}
