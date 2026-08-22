import { describe, expect, it } from "vitest";
import type { SearchResult, TranscriptCue } from "../types/transcript";
import { buildRetrievalIndex, search } from "./engine";
import { lexicalSearch } from "./lexical-search";
import { refineEvidence, refineResult } from "./refine";
import { chunkTranscript } from "../transcript/chunk";

const transcript: TranscriptCue[] = [
  { start: 0, end: 5, text: "Welcome back to the show." },
  { start: 5, end: 10, text: "Today we are talking about retrieval augmented generation." },
  { start: 10, end: 15, text: "The reason I rejected fine-tuning is cost." },
  { start: 15, end: 20, text: "Fine-tuning needs a new training run for every update." },
  { start: 20, end: 25, text: "Retrieval just needs a fresh document in the index." },
  { start: 25, end: 30, text: "Later I will give a concrete example from a hospital." },
  { start: 30, end: 35, text: "They indexed ten years of discharge summaries." },
  { start: 35, end: 40, text: "Privacy mattered, so everything stayed on premises." },
];

describe("lexical search", () => {
  const chunks = chunkTranscript(transcript).context;

  it("survives a misspelled query", () => {
    const results = lexicalSearch(chunks, "retreival augmentd generaton");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.start).toBeLessThan(15);
  });

  it("finds a phrase with different inflection", () => {
    expect(lexicalSearch(chunks, "rejecting fine tuning").length).toBeGreaterThan(0);
  });

  it("returns nothing for a query with no lexical overlap", () => {
    expect(lexicalSearch(chunks, "zzzz qqqq wwww")).toEqual([]);
  });

  it("labels its results as lexical", () => {
    expect(lexicalSearch(chunks, "fine tuning")[0]?.signals).toEqual(["lexical"]);
  });
});

describe("timestamp refinement", () => {
  it("narrows a broad span to the sentence that answers the query", () => {
    const refined = refineEvidence(transcript, 0, 7, "discharge summaries");
    expect(refined).toBeDefined();
    expect(refined!.cueStartIndex).toBe(6);
    expect(refined!.text).toContain("discharge summaries");
  });

  it("moves the seek target close to the evidence, with a small lead-in", () => {
    const broad: SearchResult = {
      id: "semantic-x",
      start: 0,
      end: 40,
      text: transcript.map((cue) => cue.text).join(" "),
      score: 0.5,
      signals: ["semantic"],
      cueStartIndex: 0,
      cueEndIndex: 7,
      highlights: [],
    };
    const refined = refineResult(broad, transcript, "why did the speaker reject fine-tuning");
    // Without refinement this would seek to 0 — 10+ seconds before the answer.
    expect(refined.start).toBeGreaterThan(7);
    expect(refined.start).toBeLessThanOrEqual(10);
    expect(refined.text).toContain("rejected fine-tuning");
  });

  it("leaves the span alone when nothing inside responds to the query", () => {
    const broad: SearchResult = {
      id: "semantic-y",
      start: 0,
      end: 40,
      text: "whatever",
      score: 0.1,
      signals: ["semantic"],
      cueStartIndex: 0,
      cueEndIndex: 7,
      highlights: [],
    };
    expect(refineResult(broad, transcript, "zzzz").start).toBe(0);
  });

  it("returns undefined for an empty range", () => {
    expect(refineEvidence(transcript, 5, 2, "anything")).toBeUndefined();
  });
});

describe("hybrid engine", () => {
  const index = buildRetrievalIndex("t1", transcript);

  it("returns only verbatim matches in exact mode", () => {
    const results = search(index, "fine-tuning", { mode: "exact" });
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((result) => result.signals.includes("exact"))).toBe(true);
  });

  it("does not run lexical retrieval in exact mode", () => {
    // A query that only the lexical layer could match must return nothing in exact mode.
    expect(search(index, "retreival", { mode: "exact" })).toEqual([]);
  });

  it("finds a misspelled memory in meaning mode without any model", () => {
    const results = search(index, "retreival", { mode: "meaning" });
    expect(results.length).toBeGreaterThan(0);
  });

  it("fuses supplied dense results with exact and lexical ones", () => {
    const semantic: SearchResult[] = [
      {
        id: "semantic-hospital",
        start: 25,
        end: 40,
        text: "hospital passage",
        score: 0.8,
        signals: ["semantic"],
        cueStartIndex: 5,
        cueEndIndex: 7,
        highlights: [],
      },
    ];
    const results = search(index, "hospital records", { mode: "meaning", semantic });
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.signals.includes("semantic"))).toBe(true);
  });

  it("refines dense results but leaves exact spans untouched", () => {
    const semantic: SearchResult[] = [
      {
        id: "semantic-broad",
        start: 0,
        end: 40,
        text: "everything",
        score: 0.9,
        signals: ["semantic"],
        cueStartIndex: 0,
        cueEndIndex: 7,
        highlights: [],
      },
    ];
    const [top] = search(index, "discharge summaries", { mode: "meaning", semantic });
    expect(top!.start).toBeGreaterThan(20);
  });

  it("returns nothing for a query shorter than two characters", () => {
    expect(search(index, "a", { mode: "meaning" })).toEqual([]);
    expect(search(index, "   ", { mode: "exact" })).toEqual([]);
  });

  it("keeps every result inside the transcript's bounds", () => {
    for (const result of search(index, "privacy on premises", { mode: "meaning" })) {
      expect(result.start).toBeGreaterThanOrEqual(0);
      expect(result.end).toBeLessThanOrEqual(40);
      expect(result.cueEndIndex).toBeLessThan(transcript.length);
    }
  });
});

describe("refinement confidence gate", () => {
  // Regression guard for a defect the benchmark caught: an unconditional lexical refiner moved
  // cross-language and paraphrase results off the passage dense retrieval had correctly found,
  // costing 18 points of Recall@1 (0.97 -> 0.79). See docs/RETRIEVAL_BENCHMARK.md.
  const broad: SearchResult = {
    id: "semantic-broad",
    start: 0,
    end: 40,
    text: "whole transcript",
    score: 0.9,
    signals: ["semantic"],
    cueStartIndex: 0,
    cueEndIndex: 7,
    highlights: [],
  };

  it("refines when the query has real lexical support in the passage", () => {
    const refined = refineResult(broad, transcript, "discharge summaries");
    expect(refined.start).toBeGreaterThan(20);
    expect(refined.cueStartIndex).toBeGreaterThan(0);
  });

  it("leaves the span alone for a cross-language query with no lexical overlap", () => {
    const refined = refineResult(broad, transcript, "الخصوصية والبيانات الطبية");
    expect(refined.start).toBe(broad.start);
    expect(refined.cueEndIndex).toBe(broad.cueEndIndex);
  });

  it("leaves the span alone when only function words match", () => {
    // Needs a corpus where inverse document frequency is meaningful: across eight cues a word in
    // three of them genuinely looks discriminative, so this is checked on a realistic transcript.
    const longer: TranscriptCue[] = Array.from({ length: 24 }, (_, index) => ({
      start: index * 5,
      end: index * 5 + 5,
      text: `and so the point is that the ${["team", "index", "model", "budget"][index % 4]} was the thing we changed.`,
    }));
    const wide: SearchResult = { ...broad, end: 120, cueEndIndex: longer.length - 1 };
    const corpus = buildRetrievalIndex("t", longer).corpus;
    expect(refineResult(wide, longer, "the a of and is", corpus).start).toBe(wide.start);
  });

  it("uses transcript-wide statistics when a corpus is supplied", () => {
    const corpus = buildRetrievalIndex("t1", transcript).corpus;
    const refined = refineResult(broad, transcript, "discharge summaries", corpus);
    expect(refined.start).toBeGreaterThan(20);
  });
});
