import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { buildRetrievalIndex, search } from "../src/search/engine";
import { buildSearchIndex } from "../src/transcript/flatten";
import { chunkTranscript } from "../src/transcript/chunk";
import { buildLexicalIndex } from "../src/search/lexical-search";
import { coalesceCues, parseJson3 } from "../src/transcript/parsers";
import { transcriptIdentitySync } from "../src/transcript/identity";
import type { TranscriptCue } from "../src/types/transcript";

/**
 * Reproducible CPU-side performance harness.
 *
 * Measures the work that happens on the side panel's main thread, because that is what determines
 * whether typing stays responsive. Embedding cost is measured separately by benchmarks/run.ts,
 * which drives the real worker in a browser.
 *
 *   npm run bench:perf
 *
 * Budget: no single operation on the search path may exceed 50 ms, the long-task threshold.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const LONG_TASK_MS = 50;

const SENTENCES = [
  "We started using machine learning for anomaly detection in production systems.",
  "The reason I rejected fine-tuning is cost, and the retraining cycle never ended.",
  "Retrieval augmented generation just needs a fresh document in the index.",
  "They indexed ten years of discharge summaries across four million documents.",
  "Privacy mattered enormously, so everything stayed on premises behind the firewall.",
  "Our latency budget was two hundred milliseconds end to end for the whole pipeline.",
  "إن الذكاء الاصطناعي مهم جدا ولكن الخصوصية تبقى المشكلة الأكبر في رأيي",
  "La confidentialité était essentielle, donc toutes les données restaient sur place.",
];

function syntheticCues(count: number, secondsPerCue = 3): TranscriptCue[] {
  return Array.from({ length: count }, (_, index) => ({
    start: index * secondsPerCue,
    end: index * secondsPerCue + secondsPerCue,
    text: `${SENTENCES[index % SENTENCES.length]} (${index})`,
  }));
}

function measure(label: string, run: () => unknown, iterations = 1): number {
  run(); // warm up JIT and caches so we measure steady state
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  const elapsed = (performance.now() - started) / iterations;
  void label;
  return elapsed;
}

interface Scenario {
  label: string;
  cues: number;
}

const SCENARIOS: Scenario[] = [
  { label: "5 minutes", cues: 100 },
  { label: "30 minutes", cues: 600 },
  { label: "2 hours", cues: 2_400 },
  { label: "1,000 cues", cues: 1_000 },
  { label: "5,000 cues", cues: 5_000 },
  { label: "10,000 cues", cues: 10_000 },
];

const QUERIES = ["privacy", "fine-tuning cost", "retreival augmentd", "الخصوصية", "why did they reject fine tuning"];

const rows: Array<Record<string, unknown>> = [];
const violations: string[] = [];

for (const scenario of SCENARIOS) {
  const cues = syntheticCues(scenario.cues);

  const json3 = { events: cues.map((cue) => ({ tStartMs: cue.start * 1000, dDurationMs: 3000, segs: [{ utf8: cue.text }] })) };
  const parseMs = measure("parse", () => coalesceCues(parseJson3(json3)));
  const identityMs = measure("identity", () => transcriptIdentitySync({ videoId: "v", cues }));
  const flattenMs = measure("flatten", () => buildSearchIndex(cues));
  const chunkMs = measure("chunk", () => chunkTranscript(cues));
  const chunks = chunkTranscript(cues);
  const lexicalIndexMs = measure("lexical-index", () => buildLexicalIndex(chunks.context));
  // Exact mode only pays for this much when the panel opens.
  const buildMs = measure("build-retrieval-index", () => buildRetrievalIndex("v", cues));
  // Meaning mode additionally materializes the lazy members on first use.
  const meaningWarmupMs = measure("meaning-warmup", () => {
    const fresh = buildRetrievalIndex("v", cues);
    void fresh.lexical;
    void fresh.corpus;
    void fresh.cueTerms;
  });

  const index = buildRetrievalIndex("v", cues);
  const exactMs = Math.max(
    ...QUERIES.map((query) => measure("exact", () => search(index, query, { mode: "exact" }), 5))
  );
  const meaningMs = Math.max(
    ...QUERIES.map((query) => measure("meaning", () => search(index, query, { mode: "meaning" }), 5))
  );

  const row = {
    scenario: scenario.label,
    cues: scenario.cues,
    contextChunks: chunks.context.length,
    fineChunks: chunks.fine.length,
    parseMs: Number(parseMs.toFixed(1)),
    identityMs: Number(identityMs.toFixed(1)),
    flattenMs: Number(flattenMs.toFixed(1)),
    chunkMs: Number(chunkMs.toFixed(1)),
    lexicalIndexMs: Number(lexicalIndexMs.toFixed(1)),
    exactReadyMs: Number(buildMs.toFixed(1)),
    meaningReadyMs: Number(meaningWarmupMs.toFixed(1)),
    exactQueryMs: Number(exactMs.toFixed(2)),
    meaningQueryMs: Number(meaningMs.toFixed(2)),
  };
  rows.push(row);

  // Per-keystroke work is the hard budget; indexing happens once and shows progress.
  if (row.exactQueryMs > LONG_TASK_MS) violations.push(`${scenario.label}: exact query ${row.exactQueryMs} ms`);
  if (row.meaningQueryMs > LONG_TASK_MS) violations.push(`${scenario.label}: meaning query ${row.meaningQueryMs} ms`);
}

console.log(
  "scenario      cues   ctx  parse  ident  flat  chunk  lexIdx  exactRdy  meanRdy  exactQ  meaningQ"
);
for (const row of rows) {
  console.log(
    `${String(row.scenario).padEnd(13)} ${String(row.cues).padStart(5)} ${String(row.contextChunks).padStart(5)} ${String(
      row.parseMs
    ).padStart(6)} ${String(row.identityMs).padStart(6)} ${String(row.flattenMs).padStart(5)} ${String(
      row.chunkMs
    ).padStart(6)} ${String(row.lexicalIndexMs).padStart(7)} ${String(row.exactReadyMs).padStart(9)} ${String(
      row.meaningReadyMs
    ).padStart(8)} ${String(row.exactQueryMs).padStart(7)} ${String(row.meaningQueryMs).padStart(9)}`
  );
}

fs.mkdirSync(path.join(here, "results"), { recursive: true });
fs.writeFileSync(
  path.join(here, "results", "performance.json"),
  `${JSON.stringify({ generatedAt: new Date().toISOString(), longTaskBudgetMs: LONG_TASK_MS, rows, violations }, null, 2)}\n`,
  "utf8"
);

if (violations.length) {
  console.error("\nPer-keystroke budget exceeded:");
  for (const violation of violations) console.error(`  - ${violation}`);
  process.exit(1);
}
console.log(`\nAll per-keystroke operations under the ${LONG_TASK_MS} ms budget.`);
