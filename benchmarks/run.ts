import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildRetrievalIndex, embeddableChunks, search } from "../src/search/engine";
import { exactSearchIndexed } from "../src/search/exact-search";
import { lexicalSearchIndexed } from "../src/search/lexical-search";
import { fuseRanked } from "../src/search/hybrid-ranker";
import { refineResult } from "../src/search/refine";
import { diversify } from "../src/search/hybrid-ranker";
import type { SearchResult } from "../src/types/transcript";
import { FIXTURES, QUERIES, type TranscriptFixture } from "./dataset";
import { aggregate, ndcgAt5, scoreQuery, type AggregateMetrics, type QueryOutcome } from "./metrics";
import { embedFixtures, type DenseIndex } from "./dense";

/**
 * Runs every retrieval configuration over the benchmark dataset and writes machine-readable
 * results plus a Markdown summary.
 *
 * Baselines run in Node against the same modules the extension ships. Dense retrieval runs in a
 * real browser driving the real packaged worker (benchmarks/dense.ts), because measuring ONNX in
 * Node would measure a runtime we do not ship.
 *
 *   npm run bench            # all systems, downloads the model on first run
 *   npm run bench -- --fast  # skip the dense systems
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const resultsDir = path.join(here, "results");

const LIMIT = 10;

interface SystemResult {
  system: string;
  description: string;
  metrics: AggregateMetrics;
  outcomes: QueryOutcome[];
  timings?: Record<string, number>;
}

function indexesFor(fixtures: TranscriptFixture[]) {
  return new Map(fixtures.map((fixture) => [fixture.id, buildRetrievalIndex(fixture.id, fixture.cues)]));
}

function runSystem(
  name: string,
  description: string,
  retrieve: (fixtureId: string, query: string) => SearchResult[]
): SystemResult {
  const outcomes: QueryOutcome[] = [];
  const ndcgs: number[] = [];
  for (const query of QUERIES) {
    const results = retrieve(query.transcriptFixtureId, query.query).slice(0, LIMIT);
    outcomes.push(scoreQuery(query, results));
    if (query.relevantTimeRanges.length) ndcgs.push(ndcgAt5(query, results));
  }
  return { system: name, description, metrics: aggregate(QUERIES, outcomes, ndcgs), outcomes };
}

async function main() {
  const fast = process.argv.includes("--fast");
  const indexes = indexesFor(FIXTURES);
  const systems: SystemResult[] = [];

  systems.push(
    runSystem("exact-only", "Normalized phrase matching over the flattened transcript.", (fixtureId, query) =>
      exactSearchIndexed(indexes.get(fixtureId)!.flat, query, LIMIT)
    )
  );

  systems.push(
    runSystem("lexical-only", "BM25 plus character n-grams over context chunks.", (fixtureId, query) =>
      lexicalSearchIndexed(indexes.get(fixtureId)!.lexical, query, LIMIT)
    )
  );

  systems.push(
    runSystem(
      "hybrid-no-dense",
      "Exact + lexical fused with weighted RRF, then timestamp-refined. This is what a user gets before enabling the model.",
      (fixtureId, query) => search(indexes.get(fixtureId)!, query, { mode: "meaning", limit: LIMIT })
    )
  );

  let dense: Map<string, DenseIndex> | undefined;
  let denseTimings: Record<string, number> | undefined;

  if (!fast) {
    console.log("Embedding fixtures in a real browser (first run downloads the model)…");
    const embedded = await embedFixtures(FIXTURES, indexes, QUERIES);
    dense = embedded.indexes;
    denseTimings = embedded.timings;

    systems.push(
      runSystem("dense-only", `Dense retrieval alone (${embedded.modelId}, ${embedded.backend}).`, (fixtureId, query) =>
        (dense!.get(fixtureId)?.resultsFor(query) ?? []).slice(0, LIMIT)
      )
    );

    const denseSystem = runSystem(
      "hybrid-full",
      `Exact + lexical + dense fused with weighted RRF, then timestamp-refined (${embedded.modelId}, ${embedded.backend}).`,
      (fixtureId, query) =>
        search(indexes.get(fixtureId)!, query, {
          mode: "meaning",
          limit: LIMIT,
          semantic: dense!.get(fixtureId)?.resultsFor(query) ?? [],
        })
    );
    denseSystem.timings = denseTimings;
    systems.push(denseSystem);

    // Isolates the contribution of timestamp refinement, which is the difference between seeking
    // to a chunk start and seeking to the sentence the user asked about.
    systems.push(
      runSystem(
        "hybrid-full-no-refinement",
        "Identical to hybrid-full but seeking to the retrieved chunk start.",
        (fixtureId, query) => {
          const index = indexes.get(fixtureId)!;
          const fused = fuseRanked(
            [
              { results: exactSearchIndexed(index.flat, query, LIMIT), weight: 1.6 },
              { results: dense!.get(fixtureId)?.resultsFor(query) ?? [], weight: 1.0 },
              { results: lexicalSearchIndexed(index.lexical, query, LIMIT), weight: 0.7 },
            ],
            { limit: LIMIT * 3, diversifySeconds: 0 }
          );
          return diversify(fused, 8).slice(0, LIMIT);
        }
      )
    );
  }

  // Per-category breakdown. Aggregate numbers hide exactly the cases this product is judged on:
  // Arabic, cross-language, ASR errors and misspellings.
  const categories = [...new Set(QUERIES.flatMap((query) => query.category))].sort();
  const byCategory = systems.map((entry) => ({
    system: entry.system,
    categories: Object.fromEntries(
      categories.map((category) => {
        const ids = new Set(
          QUERIES.filter((query) => query.category.includes(category) && query.relevantTimeRanges.length).map(
            (query) => query.id
          )
        );
        const relevant = entry.outcomes.filter((outcome) => ids.has(outcome.queryId));
        if (!relevant.length) return [category, null];
        const hits = relevant.filter((outcome) => outcome.rankOfFirstRelevant === 1).length;
        const top3 = relevant.filter(
          (outcome) => outcome.rankOfFirstRelevant !== null && outcome.rankOfFirstRelevant <= 3
        ).length;
        return [category, { queries: relevant.length, recallAt1: hits / relevant.length, recallAt3: top3 / relevant.length }];
      })
    ),
  }));

  fs.mkdirSync(resultsDir, { recursive: true });
  const payload = {
    generatedAt: new Date().toISOString(),
    dataset: {
      transcripts: FIXTURES.map((fixture) => ({
        id: fixture.id,
        language: fixture.language,
        kind: fixture.kind,
        cues: fixture.cues.length,
        durationSeconds: fixture.cues.at(-1)?.end ?? 0,
      })),
      queries: QUERIES.length,
      categories: [...new Set(QUERIES.flatMap((query) => query.category))].sort(),
    },
    systems,
    byCategory,
  };
  fs.writeFileSync(path.join(resultsDir, "results.json"), `${JSON.stringify(payload, null, 2)}\n`, "utf8");

  const csvRows = [
    "system,recall@1,recall@3,recall@5,mrr,ndcg@5,median_ts_error_s,p95_ts_error_s,correct_abstentions",
    ...systems.map((entry) =>
      [
        entry.system,
        entry.metrics.recallAt1.toFixed(3),
        entry.metrics.recallAt3.toFixed(3),
        entry.metrics.recallAt5.toFixed(3),
        entry.metrics.mrr.toFixed(3),
        entry.metrics.ndcgAt5.toFixed(3),
        entry.metrics.medianTimestampError?.toFixed(2) ?? "",
        entry.metrics.p95TimestampError?.toFixed(2) ?? "",
        entry.metrics.correctAbstentions?.toFixed(3) ?? "",
      ].join(",")
    ),
  ];
  fs.writeFileSync(path.join(resultsDir, "results.csv"), `${csvRows.join("\n")}\n`, "utf8");

  console.log("\nsystem                      R@1    R@3    R@5    MRR   nDCG@5  medTsErr  p95TsErr");
  for (const entry of systems) {
    const m = entry.metrics;
    console.log(
      `${entry.system.padEnd(26)} ${m.recallAt1.toFixed(2)}   ${m.recallAt3.toFixed(2)}   ${m.recallAt5.toFixed(
        2
      )}   ${m.mrr.toFixed(2)}   ${m.ndcgAt5.toFixed(2)}    ${(m.medianTimestampError ?? 0).toFixed(1)}s     ${(
        m.p95TimestampError ?? 0
      ).toFixed(1)}s`
    );
  }
  if (denseTimings) {
    console.log("\ntimings:", JSON.stringify(denseTimings, null, 2));
  }
  console.log(`\nWrote ${path.relative(process.cwd(), resultsDir)}/results.json and results.csv`);
}

await main();
