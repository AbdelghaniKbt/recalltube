# RecallTube retrieval benchmark

Reproduce with:

```bash
npm run build          # the dense systems drive the real packaged worker
npm run bench          # all systems (downloads the model once, ~118 MB)
npm run bench -- --fast   # baselines only, no model
npm run bench:perf     # CPU-side performance harness
```

Raw machine-readable output: [`benchmarks/results/results.json`](../benchmarks/results/results.json),
[`benchmarks/results/results.csv`](../benchmarks/results/results.csv),
[`benchmarks/results/performance.json`](../benchmarks/results/performance.json).

Measured 2026-07-31 on Windows 11, Chromium 143 (Playwright bundle), WebGPU backend available.

---

## 1. What this benchmark is, and what it is not

It is a **regression detector and a decision tool**. Every retrieval change in this release was
accepted or rejected on these numbers, and two of them were rejected — see §5.

It is **not** evidence that RecallTube is better than any other system. The dataset is 31 labelled
queries over 4 transcripts written for this purpose. That is large enough to catch a pipeline
regression and to separate clearly different configurations; it is far too small to support a
claim of state of the art, and several systems already sit at or near the ceiling on Recall@3.
No such claim is made anywhere in this repository.

Labels are **timestamp ranges**, not chunk ids, so they stay valid when chunking changes. A
benchmark that must be relabelled whenever the system changes cannot detect regressions.

## 2. Dataset

| Fixture | Language | Captions | Cues | Duration |
| --- | --- | --- | --- | --- |
| `en-rag-talk` | English | manual | 25 | 146 s |
| `ar-privacy-talk` | Arabic | manual | 13 | 78 s |
| `fr-ml-talk` | French | manual | 11 | 66 s |
| `en-asr-talk` | English | auto-generated | 12 | 60 s |

All four are hand-written for this benchmark. Nothing was captured from a user session; there is no
personal data and no signed URL, so the dataset is committed and diffable. The ASR fixture
deliberately reproduces real auto-caption failure modes: homophones (`know patient data` for "no
patient data"), spelled-out acronyms (`h and s w`, `g d p r`), missing punctuation and run-on cues.

31 queries across these categories:

`exact` · `boundary` · `paraphrase` · `vague` · `misspelling` · `asr-error` · `homophone` ·
`missing-punctuation` · `named-entity` · `acronym` · `repeated` · `negation` · `short` ·
`long-question` · `normalization` · `arabic` · `cross-language` (`ar-over-en`, `en-over-ar`,
`en-over-fr`, `fr-over-en`) · `mixed-language` · `no-answer`

## 3. Systems compared

| System | What it is |
| --- | --- |
| `exact-only` | Normalized phrase matching over the flattened transcript. |
| `lexical-only` | BM25 + character n-grams over context chunks. |
| `hybrid-no-dense` | Exact + lexical, weighted RRF, timestamp-refined. **What a user gets with no model downloaded.** |
| `dense-only` | `Xenova/multilingual-e5-small` (q8), mean-pooled, L2-normalized, `query:`/`passage:` prefixes. |
| `hybrid-full` | Exact + lexical + dense, weighted RRF, timestamp-refined. **The shipped default.** |
| `hybrid-full-no-refinement` | Identical, but seeks to the retrieved chunk start. Isolates refinement. |

Dense retrieval runs in a real browser driving the **actual packaged worker** from
`.output/chrome-mv3`, not a Node reimplementation — measuring ONNX under Node would measure a
runtime RecallTube does not ship.

## 4. Results

| System | R@1 | R@3 | R@5 | MRR | nDCG@5 | median ts error | P95 ts error |
| --- | --- | --- | --- | --- | --- | --- | --- |
| exact-only | 0.28 | 0.28 | 0.28 | 0.28 | 0.26 | 0.0 s | 0.0 s |
| lexical-only | 0.76 | 0.79 | 0.83 | 0.78 | 0.77 | 9.0 s | 27.0 s |
| hybrid-no-dense | 0.76 | 0.83 | 0.83 | 0.79 | 0.76 | 0.0 s | 27.0 s |
| dense-only | 0.93 | 1.00 | 1.00 | 0.97 | 0.95 | 3.0 s | 22.0 s |
| **hybrid-full** | **0.97** | **1.00** | **1.00** | **0.98** | 0.95 | **0.0 s** | **9.0 s** |
| hybrid-full-no-refinement | 0.97 | 1.00 | 1.00 | 0.98 | 0.97 | 2.0 s | 22.0 s |

Timestamp error tolerates up to 3 s of lead-in: the engine deliberately seeks slightly *before* the
matched moment so the viewer hears the run-up instead of starting mid-sentence. Counting that as
error would report a perfectly-seeking system as having a 1.5 s median error and would make
chunk-start seeking look artificially competitive. Seeking *after* the moment is always counted as
error, because the user has to scrub backwards.

### Recall@1 by category, `hybrid-full`

| Category | n | hybrid-full | dense-only | hybrid-no-dense |
| --- | --- | --- | --- | --- |
| exact | 5 | 1.00 | 1.00 | 1.00 |
| boundary | 1 | 1.00 | 1.00 | 1.00 |
| paraphrase | 5 | 1.00 | 0.80 | 1.00 |
| arabic | 3 | 1.00 | 0.67 | 1.00 |
| cross-language | 7 | 1.00 | 1.00 | **0.29** |
| — `en-over-ar` | 2 | 1.00 | 1.00 | 0.00 |
| — `ar-over-en` | 2 | 1.00 | 1.00 | 0.00 |
| — `en-over-fr` | 2 | 1.00 | 1.00 | 0.50 |
| misspelling | 2 | 1.00 | 1.00 | 1.00 |
| asr-error | 3 | 1.00 | 1.00 | 1.00 |
| acronym | 3 | 1.00 | 1.00 | 1.00 |
| repeated | 2 | 1.00 | 1.00 | 1.00 |
| negation | 1 | 1.00 | 1.00 | 1.00 |
| long-question | 1 | 1.00 | 1.00 | 1.00 |
| mixed-language | 1 | 1.00 | 1.00 | 1.00 |
| **vague** | 2 | **0.50** | 0.50 | 0.00 |

### What the numbers say

- **Exact search alone answers about a quarter of real memories** (R@1 0.28). It is precise when it
  fires — 0 s timestamp error, by construction — but most remembered queries are not verbatim.
  This is the entire justification for the rest of the pipeline.
- **Cross-language retrieval is what the model buys.** Without it, R@1 on cross-language queries is
  0.29 and *zero* for Arabic-over-English and English-over-Arabic. With it, 1.00. No amount of
  lexical cleverness substitutes for a multilingual embedding here.
- **Hybrid beats dense alone** on R@1 (0.97 vs 0.93) and markedly on Arabic (1.00 vs 0.67), where
  Arabic normalization lets exact and lexical retrieval contribute what the model misses.
- **Refinement is worth 13 s of P95 timestamp error** (22 s → 9 s) at zero recall cost.
- **Without any model, RecallTube is still useful**: `hybrid-no-dense` reaches R@1 0.76 with a
  0.0 s median timestamp error. Exact mode remains fully functional with no download at all.

## 5. Decisions this benchmark forced

Two changes were adopted because of it, and one was very nearly shipped broken.

**Timestamp refinement was hurting recall.** The first working implementation refined every
non-exact result unconditionally. Measured: R@1 fell from 0.97 to **0.79**. Refinement scores
candidate windows *lexically*; a paraphrased or cross-language query has almost no lexical signal
inside the retrieved passage by definition, so the refiner picked an essentially arbitrary sentence
and dragged the result off the passage dense retrieval had correctly found. It now refines only
when a sufficiently distinctive query term actually appears in the chosen window.

**The confidence threshold was chosen by sweeping, not by intuition:**

| `MIN_REFINE_EVIDENCE` | R@1 | median ts error | P95 ts error |
| --- | --- | --- | --- |
| 0.8 | 0.93 | 0.0 s | 16.5 s |
| **1.5** | **0.97** | **0.0 s** | **9.0 s** |
| 2.2 | 0.97 | 0.0 s | 9.0 s |

1.5 is the start of the plateau, so it is the value that applies refinement most often without
costing anything. This is captured by regression tests in `src/search/retrieval.test.ts`.

## 6. Model tournament

The brief asked for a comparison against a compact multilingual alternative, specifically IBM
Granite Embedding multilingual. **That comparison was not completed, and the default is unchanged.**
The honest reason: a browser-usable ONNX export with a verified `transformers.js` configuration
(pooling, prefix convention, `q8` numerics) could not be produced and validated within this release
without shipping a model whose correctness on WebGPU *and* WASM had not been checked. Adopting a
default on that basis would violate the project's own rule about unmeasured claims.

The registry in [`src/ai/models.ts`](../src/ai/models.ts) already carries the candidate with
`availability: "benchmark-only"` and the correct pooling (`cls`) and prefix (none) metadata, and
`benchmarks/dense.ts` takes a `modelKey`, so the comparison is a configuration change plus an
export-verification step rather than new architecture.

**Current default: `Xenova/multilingual-e5-small`, q8, 384 dimensions, mean pooling, L2-normalized,
asymmetric `query: ` / `passage: ` prefixes** as required by the model card. It is retained because
it is measurably sufficient on this benchmark at a device cost the product can defend, not because
it leads any leaderboard.

| Property | Value |
| --- | --- |
| Download (observed over the wire) | ~118 MB (`model_quantized.onnx` + `tokenizer.json`) |
| Embedding dimension | 384 |
| Browser artifact impact | 0 bytes — weights are downloaded after consent, never bundled |
| Backend used in this run | WebGPU |
| Cold start (model load + first transcript indexed) | 15.8 s |
| Warm indexing, 14-chunk transcript | 0.60–0.76 s |
| Warm query latency (median) | 306–313 ms |
| Indexed vector storage | 4 bytes × 384 × chunks (`Float32Array`) — ≈ 0.5 MB per 350-chunk video |

## 7. Performance (CPU side, main thread)

From `npm run bench:perf`. The budget is 50 ms — the long-task threshold — for anything on the
per-keystroke path.

| Scenario | Cues | Context chunks | Exact ready | Meaning ready | Exact query | Meaning query |
| --- | --- | --- | --- | --- | --- | --- |
| 5 minutes | 100 | 14 | 13 ms | 113 ms | 0.25 ms | 8.0 ms |
| 30 minutes | 600 | 86 | 42 ms | 451 ms | 0.22 ms | 15.7 ms |
| 2 hours | 2,400 | 343 | 205 ms | 1,947 ms | 0.22 ms | 28.3 ms |
| 1,000 cues | 1,000 | 143 | 69 ms | 689 ms | 0.10 ms | 20.3 ms |
| 5,000 cues | 5,000 | 714 | 350 ms | 3,615 ms | 0.54 ms | 34.3 ms |
| 10,000 cues | 10,000 | 1,429 | 459 ms | 6,243 ms | 1.12 ms | 40.7 ms |

"Exact ready" is what the panel pays before the first Exact search; "Meaning ready" additionally
materializes the lexical index, corpus statistics and per-cue term sets, which are built lazily on
first Meaning-mode use.

These are single-run figures from one machine and vary with load by roughly a factor of two — an
earlier, quieter run of the same harness recorded 23 ms rather than 41 ms for the 10,000-cue
Meaning query. Treat them as order-of-magnitude, and treat the 50 ms budget as the assertion that
matters; the harness exits non-zero when it is breached.

Three measured regressions were fixed here, each found by this harness rather than by inspection:

- Meaning queries cost **110 ms regardless of transcript size** because refinement re-tokenized the
  joined text of every candidate window. Precomputing per-cue token and n-gram sets and unioning
  them incrementally fixed the scaling.
- Refinement then derived the **query's** own tokens and n-grams once per candidate — up to 75
  times per keystroke. Hoisting that out of the loop took the 10,000-cue case from 52 ms (over
  budget) to 31–46 ms under the same load.
- Building the lexical index and term sets eagerly cost ~3 s on a 10,000-cue transcript and froze
  the panel for a user who never left Exact mode. Those members are now lazy: Exact readiness on a
  2-hour transcript dropped by roughly 7×.

Known remaining cost: "Meaning ready" is several seconds for a 10,000-cue transcript (an 8-hour
video) and runs on the main thread. It is one-time per transcript and overlaps the model download,
and remains intentionally isolated from the panel's interactive search path.

## 8. Known weaknesses this benchmark exposes

- **No system abstains.** Both `no-answer` queries ("what is the capital city of Peru", a cake
  recipe in Arabic) return results from every configuration — correct abstentions: **0 of 2**.
  RecallTube always shows something. A score floor would fix it, but 2 negative queries cannot
  validate a threshold, and an unmeasured one could suppress correct results. Recorded as a
  limitation rather than patched blind; the fix needs a larger negative set first.
- **Vague conceptual memories are the weakest category** (R@1 0.50, n=2). This is the hardest and
  most important category for the product's promise, and it is under-sampled.
- **The dataset is small and synthetic.** Several systems are at ceiling on R@3, which compresses
  the differences between them. Growing the dataset — particularly vague, negative and non-Latin
  queries — is the highest-value next step for measurement.
- **One machine, one run.** No variance is reported. Latency figures in §6 and §7 are indicative,
  not distributional.
