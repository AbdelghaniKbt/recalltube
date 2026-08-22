import type { SearchResult, TranscriptChunk } from "../types/transcript";
import { characterNgrams, normalizeForSearch, tokenize } from "../transcript/normalize";

/**
 * Lexical retrieval for imperfect memories and caption errors.
 *
 * BM25 over chunk tokens handles inflection and word-order differences; character n-grams handle
 * misspellings, ASR errors, partial words and scripts without whitespace. The index is built once
 * per transcript — the previous implementation re-tokenized and re-trigrammed every chunk on every
 * keystroke (51.7 ms per keystroke on a 2-hour transcript) and ran even in Exact mode where its
 * output was discarded.
 *
 * No stemming: Arabic stemming in particular produces heavy false positives, so it stays behind a
 * benchmark.
 */

const K1 = 1.2;
const B = 0.75;
/** Below this, a chunk is noise rather than a candidate. */
const SCORE_FLOOR = 0.06;

interface LexicalDocument {
  chunk: TranscriptChunk;
  length: number;
  frequencies: Map<string, number>;
  ngrams: Set<string>;
  normalized: string;
}

export interface LexicalIndex {
  documents: LexicalDocument[];
  documentFrequency: Map<string, number>;
  averageLength: number;
}

export function buildLexicalIndex(chunks: TranscriptChunk[]): LexicalIndex {
  const documents: LexicalDocument[] = [];
  const documentFrequency = new Map<string, number>();
  let totalLength = 0;

  for (const chunk of chunks) {
    const tokens = tokenize(chunk.text);
    const frequencies = new Map<string, number>();
    for (const token of tokens) frequencies.set(token, (frequencies.get(token) ?? 0) + 1);
    for (const token of frequencies.keys()) {
      documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
    }
    totalLength += tokens.length;
    documents.push({
      chunk,
      length: tokens.length,
      frequencies,
      ngrams: characterNgrams(chunk.text),
      normalized: normalizeForSearch(chunk.text),
    });
  }

  return {
    documents,
    documentFrequency,
    averageLength: documents.length ? totalLength / documents.length : 0,
  };
}

/**
 * How much of the *query* appears in the document.
 *
 * Containment rather than Dice: a query has far fewer n-grams than a chunk, so Dice's
 * size-symmetric denominator drives the score towards zero for exactly the long chunks we care
 * about, and a misspelled query scores below any sensible floor.
 */
function containment(query: Set<string>, document: Set<string>): number {
  if (!query.size || !document.size) return 0;
  let overlap = 0;
  for (const gram of query) if (document.has(gram)) overlap += 1;
  return overlap / query.size;
}

export function lexicalSearchIndexed(index: LexicalIndex, query: string, limit = 25): SearchResult[] {
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !index.documents.length) return [];

  const queryNgrams = characterNgrams(query);
  const normalizedQuery = normalizeForSearch(query);
  const uniqueQueryTokens = new Set(queryTokens);
  const total = index.documents.length;

  const scored = index.documents.map((document) => {
    let bm25 = 0;
    for (const token of uniqueQueryTokens) {
      const frequency = document.frequencies.get(token);
      if (!frequency) continue;
      const documentFrequency = index.documentFrequency.get(token) ?? 0;
      // Lucene-style IDF: always positive, so a term present in every chunk contributes ~0 rather
      // than subtracting score.
      const idf = Math.log(1 + (total - documentFrequency + 0.5) / (documentFrequency + 0.5));
      const normalizedLength = index.averageLength ? document.length / index.averageLength : 1;
      bm25 += idf * ((frequency * (K1 + 1)) / (frequency + K1 * (1 - B + B * normalizedLength)));
    }

    // Squash BM25 into [0,1) so it can be blended with the bounded fuzzy signal.
    const lexical = bm25 / (bm25 + 3);
    const fuzzy = containment(queryNgrams, document.ngrams);
    const phrase = normalizedQuery.length >= 4 && document.normalized.includes(normalizedQuery) ? 0.3 : 0;
    return { document, score: lexical * 0.6 + fuzzy * 0.4 + phrase };
  });

  return scored
    .filter((entry) => entry.score >= SCORE_FLOOR)
    .sort((left, right) => right.score - left.score || left.document.chunk.start - right.document.chunk.start)
    .slice(0, limit)
    .map(({ document, score }) => ({
      id: `lexical-${document.chunk.id}`,
      start: document.chunk.start,
      end: document.chunk.end,
      text: document.chunk.text,
      score: Math.min(1, score),
      signals: ["lexical"] as SearchResult["signals"],
      cueStartIndex: document.chunk.cueStartIndex,
      cueEndIndex: document.chunk.cueEndIndex,
      highlights: [],
      explanation: "Close wording — matched despite spelling or caption differences.",
    }));
}

/** Convenience entry point for tests and benchmarks. */
export function lexicalSearch(chunks: TranscriptChunk[], query: string, limit = 25): SearchResult[] {
  return lexicalSearchIndexed(buildLexicalIndex(chunks), query, limit);
}
