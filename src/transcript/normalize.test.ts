import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { characterNgrams, normalize, normalizeForSearch, tokenize, toOriginalRange } from "./normalize";

describe("normalizeForSearch", () => {
  it("normalizes Arabic diacritics and Alef forms", () => {
    expect(normalizeForSearch("إِنَّ الذَّكَاءَ الاصطناعيّ")).toBe("ان الذكاء الاصطناعي");
    expect(normalizeForSearch("أثر إبداع آلي")).toBe("اثر ابداع الي");
  });

  it("folds teh marbuta and Persian letters the way Arabic IR normalization does", () => {
    expect(normalizeForSearch("مدرسة")).toBe(normalizeForSearch("مدرسه"));
    expect(normalizeForSearch("کتاب")).toBe(normalizeForSearch("كتاب"));
  });

  it("normalizes case, accents, punctuation, and whitespace", () => {
    expect(normalizeForSearch("  Café—MACHINE   Learning! ")).toBe("cafe machine learning");
  });

  it("folds apostrophes inside contractions without merging punctuation-separated words", () => {
    expect(normalizeForSearch("That's where we're starting; rock-n-roll")).toBe(
      "thats where were starting rock n roll"
    );
  });

  it("does not depend on the host locale", () => {
    // toLocaleLowerCase folds "I" differently under a Turkish locale, which would make cache keys
    // and benchmark numbers machine-dependent.
    expect(normalizeForSearch("INDEX")).toBe("index");
  });

  it("removes tatweel without merging separate words", () => {
    expect(normalizeForSearch("كــتــاب جديد")).toBe("كتاب جديد");
  });

  it("strips characters that decomposition introduces, not just source ones", () => {
    // Found by stress-testing the idempotence property: U+FE7F decomposes to tatweel + sukun, and
    // filtering only the source code point emitted a bare tatweel that a second pass then removed.
    expect(normalizeForSearch("ﹿ")).toBe("");
    // U+2474 decomposes to "(1)"; the parentheses must not survive either.
    expect(normalizeForSearch("⑴")).toBe("1");
  });
});

describe("tokenize", () => {
  it("creates CJK fallback tokens", () => {
    expect(tokenize("機械学習")).toContain("機械");
  });

  it("keeps CJK recall in a mixed-script query", () => {
    // The old implementation only added bigrams when the whole string was a single token.
    expect(tokenize("AI とは何ですか")).toContain("何で");
  });

  it("returns nothing for punctuation-only input", () => {
    expect(tokenize("!!! ??? ...")).toEqual([]);
  });
});

describe("offset mapping", () => {
  it("maps an apostrophe-free query back across the original contraction", () => {
    const text = normalize("That's all");
    const start = text.normalized.indexOf("thats");
    expect(toOriginalRange(text, start, start + "thats".length)).toEqual({ start: 0, end: 6 });
  });

  it("maps a normalized match back onto Arabic text that contains diacritics", () => {
    const text = normalize("إِنَّ الذكاء الاصطناعي مهم");
    const needle = "ان الذكاء";
    const at = text.normalized.indexOf(needle);
    expect(at).toBeGreaterThanOrEqual(0);
    const range = toOriginalRange(text, at, at + needle.length)!;
    // The original span must cover the diacritics that normalization removed.
    expect(text.original.slice(range.start, range.end)).toBe("إِنَّ الذكاء");
  });

  it("maps through a ligature that expands during normalization", () => {
    const text = normalize("the ﬁle is here");
    const at = text.normalized.indexOf("file");
    const range = toOriginalRange(text, at, at + 4)!;
    expect(text.original.slice(range.start, range.end)).toBe("ﬁle");
  });

  it("rejects empty and out-of-range spans instead of guessing", () => {
    const text = normalize("hello");
    expect(toOriginalRange(text, 2, 2)).toBeUndefined();
    expect(toOriginalRange(text, 0, 99)).toBeUndefined();
  });
});

describe("property: normalization offsets", () => {
  const anyText = fc.oneof(
    fc.string(),
    fc.string({ unit: "grapheme" }),
    fc.string({ unit: "binary" }),
    fc.stringMatching(/^[؀-ۿـً-ٟ ]{0,40}$/u),
    // Arabic presentation forms decompose in ways the source-level filters do not see.
    fc.stringMatching(/^[ﭐ-﷿ﹰ-﻿ ]{0,20}$/u),
    fc.stringMatching(/^[一-鿿぀-ヿ가-힣 ]{0,20}$/u),
    fc.constantFrom("", " ", "\n\n\t", "ﬁﬂ", "①②③", "é", "👩‍👩‍👧‍👦", "؀؁؂", "ـــ", "á̂b")
  );

  it("every offset stays in bounds and is monotonic", () => {
    fc.assert(
      fc.property(anyText, (value) => {
        const text = normalize(value);
        expect(text.normalizedToOriginal.length).toBe(text.normalized.length);
        expect(text.normalizedToOriginalEnd.length).toBe(text.normalized.length);
        let previousStart = -1;
        for (let index = 0; index < text.normalized.length; index += 1) {
          const start = text.normalizedToOriginal[index]!;
          const end = text.normalizedToOriginalEnd[index]!;
          expect(start).toBeGreaterThanOrEqual(0);
          expect(start).toBeLessThanOrEqual(value.length);
          expect(end).toBeLessThanOrEqual(value.length);
          expect(end).toBeGreaterThanOrEqual(start);
          // Offsets never move backwards, so a highlight range can never invert.
          expect(start).toBeGreaterThanOrEqual(previousStart);
          previousStart = start;
        }
      }),
      { numRuns: 1500 }
    );
  });

  it("the mapped span for a whole-string match still normalizes to the same text", () => {
    fc.assert(
      fc.property(anyText, (value) => {
        const text = normalize(value);
        if (!text.normalized.length) return;
        const range = toOriginalRange(text, 0, text.normalized.length)!;
        const slice = text.original.slice(range.start, range.end);
        expect(normalize(slice).normalized).toBe(text.normalized);
      }),
      { numRuns: 1500 }
    );
  });

  it("never yields leading, trailing or doubled spaces", () => {
    fc.assert(
      fc.property(anyText, (value) => {
        const { normalized } = normalize(value);
        expect(normalized).toBe(normalized.trim());
        expect(normalized).not.toContain("  ");
      }),
      { numRuns: 1500 }
    );
  });

  it("is idempotent", () => {
    fc.assert(
      fc.property(anyText, (value) => {
        const once = normalizeForSearch(value);
        expect(normalizeForSearch(once)).toBe(once);
      }),
      { numRuns: 1500 }
    );
  });
});

describe("characterNgrams", () => {
  it("overlaps heavily for a misspelling", () => {
    const correct = characterNgrams("retrieval augmented generation");
    const typo = characterNgrams("retreival augmentd generaton");
    let shared = 0;
    for (const gram of typo) if (correct.has(gram)) shared += 1;
    expect(shared / typo.size).toBeGreaterThan(0.5);
  });
});
