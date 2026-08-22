import type { ChunkScale, TranscriptChunk, TranscriptCue } from "../types/transcript";

/** Bumped whenever chunk boundaries change, so embedding caches invalidate. */
export const CHUNKER_VERSION = 2;

/**
 * Multi-scale, sentence-aware chunking.
 *
 * The previous chunker split purely on elapsed time and character count, so evidence passages
 * routinely began and ended mid-sentence, and its `overlapCues` option silently degraded to a
 * one-cue step whenever the requested overlap was not smaller than the chunk — twelve cues
 * produced eleven near-identical chunks.
 *
 * We now produce two granularities:
 *
 *   - `fine`    — roughly a sentence or two. Used as the evidence unit and to refine timestamps.
 *   - `context` — the surrounding idea. Used for semantic recall, because a paraphrased memory
 *                 rarely aligns with a single sentence.
 *
 * Retrieval searches context chunks for recall and then refines down to fine chunks and cues for
 * the timestamp actually shown to the user.
 */
export interface ChunkOptions {
  /** Soft target for a fine chunk. */
  fineMaxSeconds?: number;
  fineMaxCharacters?: number;
  /** Soft target for a context chunk. */
  contextMaxSeconds?: number;
  contextMaxCharacters?: number;
  /** Fraction of a context chunk that the next one repeats, in [0, 0.9). */
  contextOverlapRatio?: number;
}

const DEFAULTS = {
  fineMaxSeconds: 14,
  fineMaxCharacters: 260,
  contextMaxSeconds: 45,
  contextMaxCharacters: 900,
  contextOverlapRatio: 0.34,
} satisfies Required<ChunkOptions>;

/** Sentence-final punctuation across Latin, Arabic, CJK and Devanagari scripts. */
const SENTENCE_END = /[.!?。！？…؟۔]["'”’)\]]*\s*$/u;

function endsSentence(text: string): boolean {
  return SENTENCE_END.test(text.trim());
}

function makeChunk(
  cues: TranscriptCue[],
  first: number,
  last: number,
  scale: ChunkScale
): TranscriptChunk | undefined {
  const slice = cues.slice(first, last + 1);
  const text = slice
    .map((cue) => cue.text)
    .join(" ")
    .trim();
  if (!text) return undefined;
  return {
    id: `${scale}-${first}-${last}`,
    scale,
    start: slice[0]!.start,
    end: slice.at(-1)!.end,
    text,
    cueStartIndex: first,
    cueEndIndex: last,
  };
}

function buildScale(
  cues: TranscriptCue[],
  scale: ChunkScale,
  maxSeconds: number,
  maxCharacters: number,
  overlapRatio: number
): TranscriptChunk[] {
  const chunks: TranscriptChunk[] = [];
  let cursor = 0;

  while (cursor < cues.length) {
    const startCue = cues[cursor]!;
    let last = cursor;
    let characters = 0;
    let sentenceBoundary = -1;

    for (let index = cursor; index < cues.length; index += 1) {
      const cue = cues[index]!;
      const nextCharacters = characters + cue.text.length + 1;
      const elapsed = cue.end - startCue.start;
      const overBudget = index > cursor && (nextCharacters > maxCharacters || elapsed > maxSeconds);
      if (overBudget) break;
      characters = nextCharacters;
      last = index;
      if (endsSentence(cue.text)) sentenceBoundary = index;
    }

    // Prefer ending on a sentence, but never give up more than half the window to do so.
    // `>= cursor` matters: when the very first cue completes a sentence, that is a good chunk.
    if (sentenceBoundary >= cursor && sentenceBoundary < last) {
      const kept = sentenceBoundary - cursor + 1;
      const available = last - cursor + 1;
      if (kept >= available * 0.5) last = sentenceBoundary;
    }

    const chunk = makeChunk(cues, cursor, last, scale);
    if (chunk) chunks.push(chunk);

    if (last >= cues.length - 1) break;

    const span = last - cursor + 1;
    const step = Math.max(1, Math.round(span * (1 - overlapRatio)));
    cursor += step;
  }

  return chunks;
}

export interface MultiScaleChunks {
  fine: TranscriptChunk[];
  context: TranscriptChunk[];
  version: number;
}

export function chunkTranscript(cues: TranscriptCue[], options: ChunkOptions = {}): MultiScaleChunks {
  const settings = { ...DEFAULTS, ...options };
  const overlap = Math.min(0.9, Math.max(0, settings.contextOverlapRatio));
  return {
    // Fine chunks do not overlap: they are evidence units, and duplicates there would be shown
    // to the user twice.
    fine: buildScale(cues, "fine", settings.fineMaxSeconds, settings.fineMaxCharacters, 0),
    context: buildScale(cues, "context", settings.contextMaxSeconds, settings.contextMaxCharacters, overlap),
    version: CHUNKER_VERSION,
  };
}
