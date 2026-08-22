import { describe, expect, it } from "vitest";
import type { TranscriptCue } from "../types/transcript";
import { chunkTranscript } from "./chunk";

function speech(count: number, seconds = 3): TranscriptCue[] {
  return Array.from({ length: count }, (_, index) => ({
    start: index * seconds,
    end: index * seconds + seconds,
    text: `sentence number ${index} about retrieval.`,
  }));
}

describe("chunkTranscript", () => {
  it("produces both granularities", () => {
    const { fine, context } = chunkTranscript(speech(40));
    expect(fine.length).toBeGreaterThan(0);
    expect(context.length).toBeGreaterThan(0);
    // Fine chunks are the evidence unit and must be finer than context chunks.
    expect(fine.length).toBeGreaterThan(context.length);
    expect(fine.every((chunk) => chunk.scale === "fine")).toBe(true);
  });

  it("covers every cue with fine chunks and never repeats one", () => {
    const cues = speech(37);
    const { fine } = chunkTranscript(cues);
    const covered: number[] = [];
    for (const chunk of fine) {
      for (let index = chunk.cueStartIndex; index <= chunk.cueEndIndex; index += 1) covered.push(index);
    }
    expect(covered).toEqual([...Array(cues.length).keys()]);
  });

  it("honours the requested context overlap instead of collapsing to single-cue steps", () => {
    // The alpha produced eleven near-identical chunks for twelve cues.
    const { context } = chunkTranscript(speech(12, 2), { contextMaxSeconds: 8, contextOverlapRatio: 0.34 });
    expect(context.length).toBeLessThan(6);
    const starts = context.map((chunk) => chunk.cueStartIndex);
    expect(new Set(starts).size).toBe(starts.length);
  });

  it("prefers to end a chunk on a sentence boundary", () => {
    const cues: TranscriptCue[] = [
      { start: 0, end: 3, text: "First idea ends here." },
      { start: 3, end: 6, text: "Second idea starts" },
      { start: 6, end: 9, text: "and keeps going" },
      { start: 9, end: 12, text: "until it finally stops." },
    ];
    const { fine } = chunkTranscript(cues, { fineMaxSeconds: 7, fineMaxCharacters: 200 });
    expect(fine[0]?.text.trim().endsWith(".")).toBe(true);
  });

  it("terminates on pathological input", () => {
    expect(chunkTranscript([]).fine).toEqual([]);
    const huge = chunkTranscript([{ start: 0, end: 300, text: "x".repeat(5_000) }]);
    expect(huge.fine).toHaveLength(1);
    const identical = chunkTranscript(Array.from({ length: 50 }, () => ({ start: 0, end: 0, text: "same" })));
    expect(identical.context.length).toBeGreaterThan(0);
  });

  it("keeps chunk ids stable for the same input", () => {
    const cues = speech(20);
    expect(chunkTranscript(cues).context.map((chunk) => chunk.id)).toEqual(
      chunkTranscript(cues).context.map((chunk) => chunk.id)
    );
  });
});
