import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { ask } from "../src/ask";
import { buildRetrievalIndex, embeddableChunks, search } from "../src/search/engine";
import { parseReferenceTranscript } from "../src/testing/reference-transcript";

const source = process.argv[2];
if (!source) {
  throw new Error("Usage: npm run test:reference -- <transcript.txt>");
}

const absoluteSource = path.resolve(source);
const raw = fs.readFileSync(absoluteSource, "utf8");
const parsedAt = performance.now();
const cues = parseReferenceTranscript(raw);
const parseMs = performance.now() - parsedAt;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(cues.length >= 500, `Expected a full transcript; parsed only ${cues.length} cues.`);
assert(cues[0]!.start <= 5, `Unexpected first cue at ${cues[0]!.start}s.`);
assert(cues.at(-1)!.end >= 29 * 60, `Transcript ends too early at ${cues.at(-1)!.end}s.`);
for (let index = 1; index < cues.length; index += 1) {
  assert(cues[index]!.start >= cues[index - 1]!.start, `Cue ${index} is out of order.`);
  assert(cues[index]!.end >= cues[index]!.start, `Cue ${index} has a negative duration.`);
}

const indexStarted = performance.now();
const retrieval = buildRetrievalIndex("andrej-karpathy-reference", cues);
const indexMs = performance.now() - indexStarted;

const cases = [
  { name: "boundary phrase", query: "first special guest", mode: "exact" as const, from: 2, to: 6 },
  { name: "normalized punctuation", query: "thats where were starting today", mode: "exact" as const, from: 35, to: 45 },
  { name: "repeated exact phrase", query: "vibe coding", mode: "exact" as const, from: 30, to: 40 },
  { name: "agentic engineering", query: "agentic engineering when I call it that", mode: "exact" as const, from: 980, to: 995 },
  { name: "typo-tolerant memory", query: "programer feeling behnd", mode: "meaning" as const, from: 30, to: 65 },
  { name: "closing statement", query: "fully automated out of the loop", mode: "exact" as const, from: 1765, to: 1785 },
];

const outcomes = cases.map((testCase) => {
  const started = performance.now();
  const results = search(retrieval, testCase.query, { mode: testCase.mode, limit: 10 });
  const elapsedMs = performance.now() - started;
  const hit = results.find((result) => result.start >= testCase.from && result.start <= testCase.to);
  assert(hit, `${testCase.name} did not return a hit in ${testCase.from}-${testCase.to}s.`);
  return {
    name: testCase.name,
    query: testCase.query,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    resultCount: results.length,
    hit: { start: hit.start, end: hit.end, text: hit.text, signals: hit.signals },
  };
});

const askQuery = "What did the speaker say about feeling behind as a programmer?";
const askResults = search(retrieval, "felt more behind as a programmer", { mode: "meaning", limit: 6 });
const answer = await ask(askQuery, askResults, cues, { allowPromptApi: false });
assert(answer.status === "answered", "Extractive Ask did not produce a grounded answer.");
assert(answer.citations.length > 0, "Extractive Ask returned no timestamp citations.");
for (const citation of answer.citations) {
  assert(answer.evidence.some((item) => item.id === citation.evidenceId), "Ask invented an evidence citation.");
}

console.log(
  JSON.stringify(
    {
      source: absoluteSource,
      bytes: Buffer.byteLength(raw),
      cues: cues.length,
      durationSeconds: cues.at(-1)!.end,
      contextChunks: embeddableChunks(retrieval).length,
      timingsMs: { parse: Number(parseMs.toFixed(2)), exactIndex: Number(indexMs.toFixed(2)) },
      cases: outcomes,
      ask: {
        status: answer.status,
        generative: answer.generative,
        answer: answer.answer,
        citations: answer.citations,
      },
    },
    null,
    2
  )
);
