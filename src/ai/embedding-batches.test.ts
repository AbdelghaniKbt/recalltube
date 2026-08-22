import { describe, expect, it } from "vitest";
import { embeddingBatches } from "./embedding-batches";

describe("embeddingBatches", () => {
  it("preserves order while enforcing item and character limits", () => {
    const items = ["aaa", "bbbb", "cc", "ddddd", "e"].map((text, id) => ({ id, text }));
    const batches = embeddingBatches(items, { maxItems: 2, maxCharacters: 6 });

    expect(batches.map((batch) => batch.map((item) => item.id))).toEqual([[0], [1, 2], [3, 4]]);
    expect(batches.flat()).toEqual(items);
  });

  it("makes progress when one passage exceeds the character budget", () => {
    const oversized = { text: "x".repeat(100) };
    expect(embeddingBatches([oversized], { maxItems: 4, maxCharacters: 10 })).toEqual([[oversized]]);
  });

  it("rejects invalid limits", () => {
    expect(() => embeddingBatches([], { maxItems: 0, maxCharacters: 10 })).toThrow(/maxItems/);
    expect(() => embeddingBatches([], { maxItems: 1, maxCharacters: 0 })).toThrow(/maxCharacters/);
  });
});
