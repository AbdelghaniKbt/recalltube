import { describe, expect, it } from "vitest";
import { parseReferenceTimecode, parseReferenceTranscript } from "./reference-transcript";

describe("parseReferenceTimecode", () => {
  it("accepts transcript timecode forms", () => {
    expect(parseReferenceTimecode("0:04")).toBe(4);
    expect(parseReferenceTimecode("12:27")).toBe(747);
    expect(parseReferenceTimecode("1:02:30")).toBe(3750);
    expect(parseReferenceTimecode("00:00:04,500")).toBe(4.5);
    expect(parseReferenceTimecode("00:00:04.250")).toBe(4.25);
    expect(parseReferenceTimecode("125:30")).toBe(7530);
  });

  it("rejects non-timecodes", () => {
    for (const value of ["", "abc", "12", "1:2:3:4", "497k views", "2 months ago"]) {
      expect(parseReferenceTimecode(value)).toBeUndefined();
    }
  });
});

describe("parseReferenceTranscript", () => {
  it("reads panel-copy text with timestamps on separate lines", () => {
    const input = `0:00
Welcome back to the show.
0:04
Today we are talking about retrieval.
0:09
The reason I rejected fine-tuning is cost.`;
    expect(parseReferenceTranscript(input)).toEqual([
      { start: 0, end: 4, text: "Welcome back to the show." },
      { start: 4, end: 9, text: "Today we are talking about retrieval." },
      { start: 9, end: 13, text: "The reason I rejected fine-tuning is cost." },
    ]);
  });

  it("reads inline, bracketed and tab-separated cues", () => {
    expect(parseReferenceTranscript("0:00 first\n0:06 second\n0:12 third").map((cue) => cue.start)).toEqual([
      0, 6, 12,
    ]);
    expect(parseReferenceTranscript("[0:00] first\n[0:06] second\n[0:12] third")).toHaveLength(3);
    expect(parseReferenceTranscript("0:00\tfirst\n0:06\tsecond\n0:12\tthird")).toHaveLength(3);
  });

  it("keeps real SRT and WebVTT end times", () => {
    const srt = `1
00:00:01,000 --> 00:00:04,000
First subtitle line

2
00:00:05,500 --> 00:00:09,250
Second subtitle line`;
    expect(parseReferenceTranscript(srt)).toEqual([
      { start: 1, end: 4, text: "First subtitle line" },
      { start: 5.5, end: 9.25, text: "Second subtitle line" },
    ]);

    const vtt = `WEBVTT

00:00:02.000 --> 00:00:05.000
Hello there

00:00:06.000 --> 00:00:08.000
General Kenobi`;
    expect(parseReferenceTranscript(vtt).map((cue) => cue.end)).toEqual([5, 8]);
  });

  it("joins wrapped lines and handles multilingual content", () => {
    const input = `0:00
إن الذكاء الاصطناعي مهم
0:06
機械学習について
話します`;
    expect(parseReferenceTranscript(input).map((cue) => cue.text)).toEqual([
      "إن الذكاء الاصطناعي مهم",
      "機械学習について 話します",
    ]);
  });

  it("rejects prose without timestamps", () => {
    expect(parseReferenceTranscript("")).toEqual([]);
    expect(parseReferenceTranscript("just some prose with no timestamps at all")).toEqual([]);
  });

  it("handles long reference transcripts", () => {
    const input = Array.from({ length: 5_000 }, (_, index) => {
      const seconds = index * 5;
      const stamp = `${Math.floor(seconds / 3600)}:${String(Math.floor((seconds % 3600) / 60)).padStart(
        2,
        "0"
      )}:${String(seconds % 60).padStart(2, "0")}`;
      return `${stamp}\nline number ${index}`;
    }).join("\n");
    expect(parseReferenceTranscript(input)).toHaveLength(5_000);
  });
});
