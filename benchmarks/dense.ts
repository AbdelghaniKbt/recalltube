import { launch } from "../tests/e2e/harness";
import { semanticWorkerPath } from "../tests/e2e/harness";
import type { RetrievalIndex } from "../src/search/engine";
import { embeddableChunks } from "../src/search/engine";
import type { SearchResult } from "../src/types/transcript";
import type { BenchmarkQuery, TranscriptFixture } from "./dataset";

/**
 * Dense retrieval for the benchmark, executed by the real packaged worker in a real browser.
 *
 * Measuring ONNX under Node would measure a runtime RecallTube does not ship, so the numbers in
 * docs/RETRIEVAL_BENCHMARK.md come from the same code path a user runs: the built
 * `.output/chrome-mv3` worker, the same model, the same backend selection and the same batching.
 */

export interface DenseIndex {
  resultsFor(query: string): SearchResult[];
}

export interface DenseRun {
  indexes: Map<string, DenseIndex>;
  modelId: string;
  backend: string;
  timings: Record<string, number>;
}

export async function embedFixtures(
  fixtures: TranscriptFixture[],
  indexes: Map<string, RetrievalIndex>,
  queries: BenchmarkQuery[]
): Promise<DenseRun> {
  const harness = await launch();
  try {
    const page = await harness.openSidePanel();
    const asset = await semanticWorkerPath(page);

    const payload = fixtures.map((fixture) => ({
      id: fixture.id,
      chunks: embeddableChunks(indexes.get(fixture.id)!),
      queries: queries
        .filter((query) => query.transcriptFixtureId === fixture.id)
        .map((query) => ({ id: query.id, text: query.query })),
    }));

    const outcome = await page.evaluate(
      async ({ workerAsset, work }) => {
        const worker = new Worker(`/${workerAsset}`, { type: "module" });
        const inbox: any[] = [];
        worker.addEventListener("message", (event) => inbox.push(event.data));

        const waitFor = (match: (value: any) => boolean, timeoutMs: number) =>
          new Promise<any>((resolve, reject) => {
            const started = Date.now();
            const poll = setInterval(() => {
              const hit = inbox.find(match);
              if (hit) {
                clearInterval(poll);
                resolve(hit);
                return;
              }
              const failure = inbox.find((value) => value?.type === "error");
              if (failure) {
                clearInterval(poll);
                reject(new Error(failure.error));
                return;
              }
              if (Date.now() - started > timeoutMs) {
                clearInterval(poll);
                reject(new Error("timed out waiting for the worker"));
              }
            }, 150);
          });

        const timings: Record<string, number> = {};
        const perFixture: Record<string, Record<string, Array<{ chunkId: string; score: number }>>> = {};
        let backend = "unknown";
        let firstIndex = 0;

        for (const fixture of work) {
          const requestId = `idx-${fixture.id}`;
          const startedAt = performance.now();
          worker.postMessage({
            type: "index",
            requestId,
            transcriptId: fixture.id,
            videoId: fixture.id,
            modelKey: "e5-small",
            preferredBackend: "webgpu",
            chunks: fixture.chunks,
          });
          const indexed = await waitFor(
            (value) => value?.type === "indexed" && value.requestId === requestId,
            600_000
          );
          const elapsed = performance.now() - startedAt;
          if (!firstIndex) {
            // The first fixture pays for model download plus initialization.
            firstIndex = elapsed;
            timings.coldIndexMsIncludingModelLoad = Math.round(elapsed);
          }
          timings[`indexMs.${fixture.id}`] = Math.round(elapsed);
          timings[`indexMsPerChunk.${fixture.id}`] = Number((elapsed / fixture.chunks.length).toFixed(2));
          backend = indexed.backend ?? backend;

          const answers: Record<string, Array<{ chunkId: string; score: number }>> = {};
          const latencies: number[] = [];
          for (const query of fixture.queries) {
            const searchId = `q-${fixture.id}-${query.id}`;
            const queryStart = performance.now();
            worker.postMessage({
              type: "search",
              requestId: searchId,
              transcriptId: fixture.id,
              query: query.text,
              limit: 10,
            });
            const response = await waitFor(
              (value) => value?.type === "results" && value.requestId === searchId,
              120_000
            );
            latencies.push(performance.now() - queryStart);
            answers[query.id] = response.results.map((result: any) => ({
              chunkId: String(result.id).replace(/^semantic-/, ""),
              score: result.score,
            }));
          }
          perFixture[fixture.id] = answers;
          if (latencies.length) {
            const sorted = [...latencies].sort((a, b) => a - b);
            timings[`warmQueryMedianMs.${fixture.id}`] = Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(1));
          }
        }

        worker.terminate();
        return { perFixture, timings, backend };
      },
      { workerAsset: asset, work: payload }
    );

    const byFixture = new Map<string, DenseIndex>();
    for (const fixture of fixtures) {
      const index = indexes.get(fixture.id)!;
      const chunks = embeddableChunks(index);
      const byId = new Map(chunks.map((chunk) => [chunk.id, chunk]));
      const answers = outcome.perFixture[fixture.id] ?? {};
      const byQueryText = new Map(
        queries
          .filter((query) => query.transcriptFixtureId === fixture.id)
          .map((query) => [query.query, answers[query.id] ?? []])
      );

      byFixture.set(fixture.id, {
        resultsFor(queryText: string): SearchResult[] {
          const ranked = byQueryText.get(queryText) ?? [];
          return ranked.flatMap((entry): SearchResult[] => {
            const chunk = byId.get(entry.chunkId);
            if (!chunk) return [];
            return [
              {
                id: `semantic-${chunk.id}`,
                start: chunk.start,
                end: chunk.end,
                text: chunk.text,
                score: entry.score,
                signals: ["semantic"],
                cueStartIndex: chunk.cueStartIndex,
                cueEndIndex: chunk.cueEndIndex,
                highlights: [],
              },
            ];
          });
        },
      });
    }

    await page.close();
    return {
      indexes: byFixture,
      modelId: "Xenova/multilingual-e5-small (q8)",
      backend: outcome.backend,
      timings: outcome.timings,
    };
  } finally {
    await harness.close();
  }
}
