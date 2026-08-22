import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { TranscriptCue } from "../types/transcript";
import { exactSearch } from "./exact-search";
import { renderableMatch } from "./highlight";

const cues: TranscriptCue[] = [
  { start: 10, end: 12, text: "We started using machine" },
  { start: 12, end: 15, text: "learning for anomaly detection." },
  { start: 30, end: 34, text: "Machine learning appears again." },
];

describe("exactSearch", () => {
  it("finds phrases spanning a caption boundary", () => {
    const [result] = exactSearch(cues, "machine learning");
    expect(result).toMatchObject({ start: 10, end: 15, cueStartIndex: 0, cueEndIndex: 1 });
    expect(result!.signals).toContain("boundary-exact");
  });

  it("returns every occurrence in timestamp order", () => {
    expect(exactSearch(cues, "machine learning").map((result) => result.start)).toEqual([10, 30]);
  });

  it("finds overlapping occurrences", () => {
    // The alpha advanced the cursor by the needle length and reported only two of the three.
    expect(exactSearch([{ start: 0, end: 5, text: "abababab" }], "abab")).toHaveLength(3);
  });

  it("matches normalized Arabic spelling", () => {
    const arabic: TranscriptCue[] = [{ start: 5, end: 8, text: "إِنَّ الذكاء الاصطناعي مهم" }];
    expect(exactSearch(arabic, "ان الذكاء الاصطناعي")[0]?.start).toBe(5);
  });

  it("highlights the original Arabic text including its diacritics", () => {
    const arabic: TranscriptCue[] = [{ start: 5, end: 8, text: "إِنَّ الذكاء الاصطناعي مهم" }];
    const [result] = exactSearch(arabic, "ان الذكاء");
    const rendered = renderableMatch(result!, arabic);
    expect(rendered.ranges).toHaveLength(1);
    const [start, end] = rendered.ranges[0]!;
    // The regression that mattered: the alpha rendered zero <mark> elements here.
    expect(rendered.text.slice(start, end)).toBe("إِنَّ الذكاء");
  });

  it("highlights each cue of a boundary-spanning match", () => {
    const [result] = exactSearch(cues, "machine learning");
    const rendered = renderableMatch(result!, cues);
    expect(rendered.ranges.map(([start, end]) => rendered.text.slice(start, end))).toEqual([
      "machine",
      "learning",
    ]);
  });

  it("highlights through a length-changing normalization", () => {
    const accented: TranscriptCue[] = [{ start: 0, end: 3, text: "the Café Métro opened" }];
    const [result] = exactSearch(accented, "cafe metro");
    const rendered = renderableMatch(result!, accented);
    const [start, end] = rendered.ranges[0]!;
    expect(rendered.text.slice(start, end)).toBe("Café Métro");
  });

  it("ignores punctuation differences between query and captions", () => {
    const punctuated: TranscriptCue[] = [{ start: 0, end: 3, text: "It's a well-known problem, honestly." }];
    expect(exactSearch(punctuated, "well known problem")).toHaveLength(1);
    expect(exactSearch(punctuated, "its a well known problem")).toHaveLength(1);
  });

  it("returns nothing for a one-character query", () => {
    expect(exactSearch(cues, "a")).toEqual([]);
  });

  it("skips cues that normalize to nothing without breaking offsets", () => {
    const withNoise: TranscriptCue[] = [
      { start: 0, end: 1, text: "[Music]" },
      { start: 1, end: 2, text: "♪♪♪" },
      { start: 2, end: 4, text: "and then we shipped it" },
    ];
    const [result] = exactSearch(withNoise, "we shipped");
    expect(result?.start).toBe(2);
    const rendered = renderableMatch(result!, withNoise);
    const [start, end] = rendered.ranges[0]!;
    expect(rendered.text.slice(start, end)).toBe("we shipped");
  });
});

describe("property: exact search never corrupts highlights", () => {
  const cueArbitrary = fc.record({
    start: fc.double({ min: 0, max: 10_000, noNaN: true }),
    text: fc.oneof(
      fc.string(),
      fc.string({ unit: "grapheme" }),
      fc.constantFrom("مرحبا بالعالم", "機械学習です", "café", "")
    ),
  });

  it("highlight ranges always lie inside the rendered text", () => {
    fc.assert(
      fc.property(fc.array(cueArbitrary, { maxLength: 12 }), fc.string({ maxLength: 8 }), (rawCues, query) => {
        const transcript: TranscriptCue[] = rawCues.map((cue, index) => ({
          start: cue.start + index,
          end: cue.start + index + 1,
          text: cue.text,
        }));
        for (const result of exactSearch(transcript, query, 10)) {
          expect(Number.isFinite(result.start)).toBe(true);
          expect(result.start).toBeGreaterThanOrEqual(0);
          expect(result.cueStartIndex).toBeGreaterThanOrEqual(0);
          expect(result.cueEndIndex).toBeLessThan(transcript.length);
          expect(result.cueEndIndex).toBeGreaterThanOrEqual(result.cueStartIndex);
          const rendered = renderableMatch(result, transcript);
          for (const [start, end] of rendered.ranges) {
            expect(start).toBeGreaterThanOrEqual(0);
            expect(end).toBeLessThanOrEqual(rendered.text.length);
            expect(end).toBeGreaterThan(start);
          }
        }
      }),
      { numRuns: 300 }
    );
  });

  it("never throws on malformed cues", () => {
    const hostile: TranscriptCue[] = [
      { start: 0, end: 0, text: "" },
      { start: 1, end: 0, text: "   " },
      { start: 2, end: 3, text: "x".repeat(5_000) },
      { start: 3, end: 4, text: "👩‍👩‍👧‍👦 emoji family" },
    ];
    expect(() => exactSearch(hostile, "emoji")).not.toThrow();
    expect(exactSearch(hostile, "emoji")).toHaveLength(1);
  });
});
