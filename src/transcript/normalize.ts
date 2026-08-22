/**
 * Search normalization that never loses its way back to the original text.
 *
 * The previous implementation returned a bare string. Every step below can change string length
 * (NFKD decomposition, mark stripping, tatweel removal, punctuation collapsing), so normalized
 * offsets and original offsets diverge — "café ﬁle ①" (10 chars) normalizes to "cafe file 1"
 * (11 chars). Without a mapping, a match found in normalized space cannot be highlighted in the
 * text the user actually sees, which is why Arabic queries used to highlight nothing at all.
 * This mapping keeps highlights correct after Unicode folding changes string length.
 *
 * We therefore normalize code point by code point and record, for every normalized character, the
 * span of `original` it came from.
 */

/** Bumped whenever normalization output changes, so caches and embeddings invalidate. */
export const NORMALIZER_VERSION = 3;

const ARABIC_DIACRITICS = /[ؐ-ًؚ-ٰٟۖ-ۭ]/u;
const COMBINING_MARK = /\p{M}/u;
const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;
const WHITESPACE = /\s/u;
const APOSTROPHE = /['\u2019\u02bc]/u;
const LETTER_OR_NUMBER = /[\p{L}\p{N}]/u;
const TATWEEL = "ـ";

/**
 * Scripts where NFKD decomposition destroys meaning rather than removing decoration.
 *
 * Japanese kana decompose voiced sounds into base + dakuten, so stripping marks turns で into て
 * and merges distinct morae. Hangul syllables decompose into individual jamo. Both are searchable
 * as written, so we leave them composed.
 */
const KEEP_COMPOSED = /[\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

/**
 * Arabic and Persian orthographic variants folded to one canonical form. This mirrors Lucene's
 * ArabicNormalizationFilter / PersianNormalizationFilter, which is normalization rather than
 * stemming: it merges spellings of the same word without merging different words.
 */
const LETTER_FOLD = new Map<string, string>([
  ["إ", "ا"], // إ -> ا
  ["أ", "ا"], // أ -> ا
  ["آ", "ا"], // آ -> ا
  ["ٱ", "ا"], // ٱ -> ا
  ["ى", "ي"], // ى -> ي
  ["ة", "ه"], // ة -> ه
  ["ک", "ك"], // ک -> ك
  ["ی", "ي"], // ی -> ي
]);

export interface NormalizedText {
  original: string;
  normalized: string;
  /** For normalized index i, where that character's source begins in `original`. */
  normalizedToOriginal: Uint32Array;
  /** For normalized index i, the exclusive end of that character's source in `original`. */
  normalizedToOriginalEnd: Uint32Array;
}

/**
 * Normalizes `value` and records the original span behind every normalized character.
 *
 * Characters that vanish (diacritics, tatweel) extend the preceding character's source span, so a
 * match over "ان" maps back across the diacritics inside "إِنَّ".
 */
export function normalize(value: string): NormalizedText {
  const out: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingSeparator = false;

  const push = (char: string, from: number, to: number) => {
    out.push(char);
    starts.push(from);
    ends.push(to);
  };

  /** Absorb a dropped character into whatever we emitted last, so spans stay contiguous. */
  const extendLast = (to: number) => {
    if (ends.length) ends[ends.length - 1] = Math.max(ends[ends.length - 1]!, to);
  };

  for (let index = 0; index < value.length; ) {
    const codePoint = value.codePointAt(index)!;
    const source = String.fromCodePoint(codePoint);
    const from = index;
    index += source.length;
    const to = index;

    // Apostrophes inside a word are formatting, not word boundaries: users commonly type "dont"
    // for "don't" and "thats" for "that's". Absorb the mark into the preceding source span so a
    // normalized hit still highlights the complete original contraction.
    const before = value.slice(0, from).match(/.$/u)?.[0] ?? "";
    const afterCodePoint = value.codePointAt(to);
    const after = afterCodePoint === undefined ? "" : String.fromCodePoint(afterCodePoint);
    if (APOSTROPHE.test(source) && LETTER_OR_NUMBER.test(before) && LETTER_OR_NUMBER.test(after)) {
      extendLast(to);
      continue;
    }

    // Whitespace and remaining punctuation separate words. A run of them collapses to one space,
    // and we never emit a leading or trailing one.
    if (WHITESPACE.test(source) || PUNCTUATION_OR_SYMBOL.test(source)) {
      if (out.length) pendingSeparator = true;
      else extendLast(to);
      continue;
    }

    if (source === TATWEEL || ARABIC_DIACRITICS.test(source)) {
      extendLast(to);
      continue;
    }

    const folded = LETTER_FOLD.get(source) ?? source;
    // `toLowerCase` rather than `toLocaleLowerCase`: the host locale must not change normalization,
    // otherwise cache keys and benchmark results differ between machines.
    const decomposed = KEEP_COMPOSED.test(source)
      ? folded.toLowerCase()
      : folded.normalize("NFKD").toLowerCase();

    let emitted = false;
    for (const unit of decomposed) {
      if (COMBINING_MARK.test(unit)) {
        // Accents are stripped; attribute them to whatever they decorate.
        if (emitted || out.length) extendLast(to);
        continue;
      }
      // Decomposition can *introduce* characters that the source-level filters already reject:
      // "⑴" becomes "(1)", and the Arabic presentation form "ﹿ" becomes tatweel + sukun. Checking
      // only the source code point let a bare tatweel through, which a second pass then stripped —
      // so normalization was not idempotent and cache keys were unstable.
      if (unit === TATWEEL || ARABIC_DIACRITICS.test(unit)) {
        if (emitted || out.length) extendLast(to);
        continue;
      }
      if (WHITESPACE.test(unit) || PUNCTUATION_OR_SYMBOL.test(unit)) {
        if (out.length) pendingSeparator = true;
        else extendLast(to);
        continue;
      }
      if (pendingSeparator) {
        push(" ", from, from);
        pendingSeparator = false;
      }
      // Decomposition also exposes letters that still need folding: the Arabic presentation form
      // "ﯹ" decomposes to yeh-with-hamza plus alef maksura, and only the second needs folding.
      const unitFolded = LETTER_FOLD.get(unit) ?? unit;
      // One array entry per UTF-16 code unit, so the offset arrays stay aligned with
      // `normalized.length` for astral code points such as "𐊀".
      for (let offset = 0; offset < unitFolded.length; offset += 1) {
        push(unitFolded[offset]!, from, to);
      }
      emitted = true;
    }

    if (!emitted) extendLast(to);
  }

  return {
    original: value,
    normalized: out.join(""),
    normalizedToOriginal: Uint32Array.from(starts),
    normalizedToOriginalEnd: Uint32Array.from(ends),
  };
}

/** Convenience wrapper for callers that only need the normalized string. */
export function normalizeForSearch(value: string): string {
  return normalize(value).normalized;
}

/**
 * Maps a half-open range in normalized space back to a half-open range in the original string.
 * Returns `undefined` for an empty or out-of-range span rather than guessing.
 */
export function toOriginalRange(
  text: NormalizedText,
  start: number,
  end: number
): { start: number; end: number } | undefined {
  if (start < 0 || end > text.normalized.length || end <= start) return undefined;
  const originalStart = text.normalizedToOriginal[start];
  const originalEnd = text.normalizedToOriginalEnd[end - 1];
  if (originalStart === undefined || originalEnd === undefined) return undefined;
  return { start: originalStart, end: Math.max(originalStart, originalEnd) };
}

const wordSegmenter =
  typeof Intl !== "undefined" && typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "word" })
    : undefined;

const SPACELESS_SCRIPTS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
const SPACELESS_RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]+/gu;

/**
 * Splits normalized text into search tokens.
 *
 * `Intl.Segmenter` handles languages that do not delimit words with spaces (Chinese, Japanese,
 * Thai). Where it is unavailable we fall back to whitespace splitting. Character bigrams are added
 * for every spaceless run regardless of segmentation, because caption text is frequently segmented
 * differently from the query — the old implementation only did this when the *entire* string was a
 * single token, so mixed queries like "AI とは何ですか" silently lost CJK recall.
 */
export function tokenize(value: string): string[] {
  const normalized = normalize(value).normalized;
  if (!normalized) return [];

  const tokens: string[] = [];
  if (wordSegmenter) {
    for (const segment of wordSegmenter.segment(normalized)) {
      if (segment.isWordLike && segment.segment.trim()) tokens.push(segment.segment);
    }
  } else {
    tokens.push(...normalized.split(" ").filter(Boolean));
  }

  if (SPACELESS_SCRIPTS.test(normalized)) {
    for (const run of normalized.match(SPACELESS_RUNS) ?? []) {
      const characters = Array.from(run);
      for (let index = 0; index < characters.length; index += 1) {
        tokens.push(characters[index]!);
        if (index + 1 < characters.length) tokens.push(`${characters[index]}${characters[index + 1]}`);
      }
    }
  }

  return tokens;
}

/** Character n-grams, used by the lexical layer to survive typos and ASR errors. */
export function characterNgrams(value: string, sizes: readonly number[] = [3, 4]): Set<string> {
  const padded = ` ${normalize(value).normalized} `;
  const grams = new Set<string>();
  for (const size of sizes) {
    for (let index = 0; index + size <= padded.length; index += 1) grams.add(padded.slice(index, index + size));
  }
  return grams;
}
