import type { SearchResult, TranscriptCue } from "../types/transcript";

/**
 * Projects a result's per-cue highlight offsets onto the single string the UI renders.
 *
 * Highlights are recorded in original-cue coordinates so they survive normalization
 * The panel joins the matched cues with a space, so each highlight
 * shifts by the length of everything joined before its cue.
 */
export interface RenderableMatch {
  text: string;
  /** Half-open ranges into `text`, sorted and non-overlapping. */
  ranges: Array<[number, number]>;
}

export function renderableMatch(result: SearchResult, cues: TranscriptCue[]): RenderableMatch {
  const first = Math.max(0, result.cueStartIndex);
  const last = Math.min(cues.length - 1, result.cueEndIndex);
  if (first > last || !cues.length) return { text: result.text, ranges: [] };

  const offsets = new Map<number, number>();
  const parts: string[] = [];
  let cursor = 0;
  for (let index = first; index <= last; index += 1) {
    const cue = cues[index]!;
    if (parts.length) {
      parts.push(" ");
      cursor += 1;
    }
    offsets.set(index, cursor);
    parts.push(cue.text);
    cursor += cue.text.length;
  }

  const text = parts.join("");
  const ranges: Array<[number, number]> = [];
  for (const highlight of result.highlights) {
    const base = offsets.get(highlight.cueIndex);
    if (base === undefined) continue;
    const cue = cues[highlight.cueIndex];
    if (!cue) continue;
    const start = base + Math.max(0, Math.min(cue.text.length, highlight.start));
    const end = base + Math.max(0, Math.min(cue.text.length, highlight.end));
    if (end > start) ranges.push([start, end]);
  }

  ranges.sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    if (previous && range[0] <= previous[1]) previous[1] = Math.max(previous[1], range[1]);
    else merged.push([...range]);
  }

  return { text, ranges: merged };
}
