import { describe, expect, it } from "vitest";
import type { MatchSignal, SearchResult } from "../types/transcript";
import { diversify, fuseRanked, fuseResults, matchLabel } from "./hybrid-ranker";

function result(start: number, signals: MatchSignal[], id = `${signals[0]}-${start}`): SearchResult {
  return {
    id,
    start,
    end: start + 10,
    text: signals.join("+"),
    score: 1,
    signals: [...signals],
    cueStartIndex: 0,
    cueEndIndex: 0,
    highlights: [],
  };
}

describe("fuseResults", () => {
  it("deduplicates overlapping passages and keeps exact evidence as the representative", () => {
    const results = fuseResults([[result(10, ["exact"])], [result(12, ["semantic"]), result(40, ["semantic"])]]);
    expect(results).toHaveLength(2);
    expect(results[0]?.signals).toContain("exact");
  });

  it("merges the signals of everything that collapsed into one result", () => {
    const results = fuseResults([[result(10, ["exact"])], [result(11, ["semantic"])], [result(12, ["lexical"])]]);
    expect(results).toHaveLength(1);
    expect([...results[0]!.signals].sort()).toEqual(["exact", "lexical", "semantic"]);
  });

  it("groups deterministically regardless of list order", () => {
    // The alpha grouped by "first overlapping candidate found", so A and C could be merged
    // transitively through B depending on insertion order.
    const a = result(0, ["exact"]);
    const b = result(9, ["semantic"]);
    const c = result(18, ["lexical"]);
    const forwards = fuseResults([[a], [b], [c]]).map((entry) => entry.start);
    const backwards = fuseResults([[c], [b], [a]]).map((entry) => entry.start);
    expect(forwards.sort()).toEqual(backwards.sort());
  });
});

describe("fuseRanked", () => {
  it("lets a heavier list outrank a lighter one at the same rank", () => {
    const fused = fuseRanked([
      { results: [result(100, ["lexical"])], weight: 0.7 },
      { results: [result(300, ["exact"])], weight: 1.6 },
    ]);
    expect(fused[0]?.start).toBe(300);
  });

  it("ignores lists with zero weight", () => {
    const fused = fuseRanked([
      { results: [result(100, ["lexical"])], weight: 0 },
      { results: [result(300, ["semantic"])], weight: 1 },
    ]);
    expect(fused.map((entry) => entry.start)).toEqual([300]);
  });

  it("returns nothing for empty input", () => {
    expect(fuseRanked([])).toEqual([]);
  });
});

describe("diversify", () => {
  it("suppresses near-identical adjacent passages", () => {
    const kept = diversify([result(100, ["semantic"]), result(102, ["semantic"]), result(104, ["semantic"])], 8);
    expect(kept).toHaveLength(1);
  });

  it("preserves genuinely repeated mentions at different timestamps", () => {
    const kept = diversify([result(100, ["semantic"]), result(600, ["semantic"]), result(1200, ["semantic"])], 8);
    expect(kept).toHaveLength(3);
  });
});

describe("matchLabel", () => {
  it("never invents a confidence number", () => {
    expect(matchLabel(["exact"])).toBe("Exact phrase");
    expect(matchLabel(["boundary-exact", "exact"])).toBe("Exact phrase");
    expect(matchLabel(["semantic"])).toBe("Same meaning");
    expect(matchLabel(["lexical"])).toBe("Close wording");
    expect(matchLabel(["cross-language"])).toBe("Cross-language match");
    expect(matchLabel([])).toBe("Related discussion");
  });
});
