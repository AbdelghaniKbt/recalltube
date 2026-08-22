# RecallTube architecture

## The shape of the problem

A user remembers something from a video and describes it in their own words, possibly in a
different language from the one spoken. RecallTube has to turn that description into a timestamp.

Everything below follows from three constraints:

1. **Nothing leaves the device.** No server means retrieval must run in a browser tab, over one
   transcript, within a keystroke's worth of time.
2. **Captions are unofficial and hostile-adjacent.** YouTube does not offer a caption API for
   extensions. What we can read is page state, which any script on the page can also write.
3. **The product must be useful without AI.** A 118 MB model download cannot be the price of entry.

## Surfaces

```
  YouTube page (untrusted)
  ┌──────────────────────────────────────────┐
  │ MAIN world: youtube-main.content.ts      │  reads the player's caption-track list
  │   no privileges, no fetches              │  and posts it to the isolated world
  └───────────────┬──────────────────────────┘
                  │ window.postMessage — readable by every page script
  ┌───────────────▼──────────────────────────┐
  │ ISOLATED world: youtube.content.ts       │  validates the payload, allowlists the
  │   host permissions, AbortController      │  caption URL, fetches and parses timed text,
  │   navigation generation counter          │  owns the transcript state for its tab
  └───────────────┬──────────────────────────┘
                  │ typed, runtime-validated extension messages
  ┌───────────────▼──────────────────────────┐
  │ SIDE PANEL: entrypoints/sidepanel        │  retrieval, UI, storage, Ask
  │   ┌────────────────────────────────────┐ │
  │   │ semantic.worker.ts (dedicated)     │ │  owns the model; the only place
  │   │   transformers.js + ONNX Runtime   │ │  embeddings are computed
  │   └────────────────────────────────────┘ │
  └──────────────────────────────────────────┘
```

The background service worker does one thing: make the toolbar action open the side panel.

## Module map

| Path | Responsibility |
| --- | --- |
| `src/transcript/normalize.ts` | Normalization **with an offset map** back to the original text |
| `src/transcript/parsers.ts` | JSON3 / timed-text XML, entity decoding, ASR rolling-window merge |
| `src/transcript/bridge.ts` | Validation and URL allowlisting for the main-world payload |
| `src/transcript/identity.ts` | Content-addressed transcript identity |
| `src/transcript/flatten.ts` | Cross-cue flattened index + offset-mapped highlight resolution |
| `src/transcript/chunk.ts` | Multi-scale, sentence-aware chunking |
| `src/transcript/acquire.ts` | Player-track → owned native-panel → rendered-row adapters, with cancellation, cleanup and diagnostics |
| `src/search/exact-search.ts` | All-occurrence phrase matching with highlights |
| `src/search/lexical-search.ts` | BM25 + character n-grams |
| `src/search/hybrid-ranker.ts` | Weighted RRF, temporal diversification, match labels |
| `src/search/refine.ts` | Timestamp refinement, gated on lexical evidence |
| `src/search/token-match.ts` | Shared term weighting and inflection-tolerant matching |
| `src/search/engine.ts` | Per-transcript index; the one place retrieval is composed |
| `src/ai/provider.ts` | `EmbeddingProvider` — the runtime boundary |
| `src/ai/model-manager` (in worker) | Single model instance, backend selection, cancellation |
| `src/ai/runtime/ort-env.ts` | Pins ONNX Runtime to the packaged copies |
| `src/ask/` | Evidence-grounded answers, prompt construction, schema validation |
| `src/storage/indexeddb.ts` | Transcript and embedding caches, eviction, user data controls |

`src/transcript`, `src/search` and `src/ask` contain no browser-extension APIs, which is why the
benchmark and the performance harness can import them directly under Node.

## The retrieval pipeline

```
query
  │
  ├─► exact      normalized phrase match over the flattened transcript   weight 1.6
  ├─► lexical    BM25 + character n-grams over context chunks            weight 0.7
  └─► dense      cosine over L2-normalized E5 embeddings (worker)        weight 1.0
                                    │
                    weighted Reciprocal Rank Fusion
                    (grouped into fixed temporal buckets, not
                     "whichever overlapping result I saw first")
                                    │
                    timestamp refinement, per result
                    (only when a distinctive query term is present)
                                    │
                    temporal diversification
                                    │
                              ranked moments
```

Three deliberate choices:

**RRF rather than a weighted score sum.** Exact, BM25 and cosine scores are not on comparable
scales, and calibrating them would invent precision we cannot justify. RRF only needs rank order.

**Fuse, then refine, then diversify.** Diversifying before refinement lets a 45-second context
chunk swallow the precise result sitting inside it. Refining before diversification means
suppression operates on the spans the user will actually see.

**Refinement is gated.** Refinement scores windows lexically. For a paraphrase or a cross-language
query there is no lexical signal to score, so an ungated refiner picks arbitrarily and destroys the
result dense retrieval found — measured at 18 points of Recall@1. See `docs/RETRIEVAL_BENCHMARK.md`.

## Why offset-mapped normalization is load-bearing

Normalization folds Arabic Alef forms, strips diacritics and tatweel, decomposes ligatures, removes
punctuation and lowercases — every one of which changes string length. `normalize()` therefore
returns the normalized string *plus* two `Uint32Array`s mapping each normalized character back to
the span of the original it came from.

Without that mapping a match can be found but never shown: the alpha highlighted by running a regex
of the raw query against the original text, so an Arabic query that matched via normalization
rendered zero highlights. With it, matching `ان الذكاء` highlights `إِنَّ الذكاء` — diacritics
included — and the same machinery drives sub-cue evidence extraction and timestamp refinement.

Property tests over random Unicode assert the mapping stays in bounds and monotonic. They found
four real bugs during development: punctuation introduced by NFKD decomposition (`⑴` → `(1)`),
array desynchronization on astral code points, Arabic presentation forms needing folding *after*
decomposition, and NFKD destroying Japanese dakuten (`で` → `て`).

## Identity and caching

```
transcriptId = SHA-256(parserVersion | normalizerVersion | videoId | trackId |
                       language | translatedFrom | cue timings + text)

embeddingKey = transcriptId | modelId | revision | dtype | pooling |
               dimension | chunkerVersion | normalizerVersion
```

Everything that can change the meaning of a stored vector is in the key. The alpha keyed on
`model:videoId` and validated with a "signature" of chunk count plus two string lengths, which
collided across entirely different transcripts — switching a video's caption language silently
answered Arabic queries with English vectors.

## Cancellation and staleness

Three independent generation mechanisms, because there are three ways to end up looking at the
wrong video:

- **Acquisition** — an `AbortController` per attempt; a new navigation aborts the previous one
  rather than merely ignoring its eventual result.
- **Panel ↔ tab** — snapshots carry `{ tabId, videoId, generation }`; the panel drops anything that
  does not match what it currently wants.
- **Worker** — every request has an id; search results carry the `transcriptId` they were computed
  for and are rejected if it does not match, and cancellation is a message the worker acts on.

## Runtime packaging

`@huggingface/transformers` defaults ONNX Runtime's `wasmPaths` to a jsdelivr URL and dynamically
imports a `.mjs` from it. Inside MV3 that blob import is refused by `script-src 'self'`, so both
backends failed — after leaking a request to an undeclared CDN and downloading 23.5 MB already
present in the package.

RecallTube therefore:

1. copies the ORT `asyncify` `.mjs`/`.wasm` into `public/ort/` at build time
   (`scripts/sync-ort-assets.mjs`);
2. sets `wasmPaths` to those `chrome-extension://` URLs and `useWasmCache = false` before any
   session is created (`src/ai/runtime/ort-env.ts`);
3. aliases `onnxruntime-web/webgpu` to the non-bundled entry so Vite does not emit a duplicate;
4. rewrites the CDN literal out of the artifact and fails the build on any unexpected host
   (`scripts/harden-artifact.mjs`);
5. asserts all of the above in `src/build/artifact.test.ts` and in a real browser in
   `tests/e2e/extension.spec.ts`.

## Ask mode

Retrieval runs first and always. The generative step receives only the selected passages, each
fenced and labelled untrusted, never the transcript. The response is schema-validated and every
citation is checked against the evidence actually supplied — an answer citing something we did not
provide is rejected and downgraded to "insufficient evidence", which is what makes the defence
independent of the model's cooperation.

Providers: Chrome's on-device Prompt API when feature detection succeeds and the user has enabled
it, otherwise an extractive provider that returns the strongest passages verbatim. There is no
cloud fallback.
