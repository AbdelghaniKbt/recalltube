# Changelog

All notable changes to RecallTube are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.

## [0.2.0] — unreleased

The 0.1 alpha was audited against its own claims. Three load-bearing ones were false in the built
artifact; this release fixes them and adds the measurement needed to keep them honest.

### Changed — focused side-panel experience

- Redesigned the side panel around a calm, search-first interface with a generated RecallTube icon,
  consistent controls, clearer video context, stronger result hierarchy, and responsive narrow-panel
  behavior.
- Caption recovery is automatic and stays out of the side-panel UI. RecallTube first tries the
  player's signed caption track; if YouTube withholds it, the content script briefly opens the
  native transcript renderer, captures its rows, and closes only the panel it opened. A transcript
  panel the user already had open is preserved.

### Fixed — critical

- **Meaning search did not work at all in the packaged extension.** `@huggingface/transformers`
  defaults ONNX Runtime's `wasmPaths` to jsdelivr and dynamically imports a `.mjs` from it. Inside
  MV3 that import is refused by `script-src 'self'`, so both the WebGPU and WASM backends failed
  with `no available backend found` — after downloading 23.5 MB of runtime already present in the
  package and contacting an undeclared third-party CDN. The runtime is now shipped inside the
  extension, `wasmPaths` points at it, and the build fails on any unexpected host.
- **Matches could not be shown in the original text.** Normalization discarded the mapping back to
  the source, so highlighting fell back to a regex of the raw query — which rendered *zero*
  highlights for any Arabic query that matched via normalization. Normalization now returns an
  offset map and results carry real highlight spans.
- **The embedding cache could answer with another transcript's vectors.** Keys were
  `model:videoId`, validated by a "signature" of chunk count plus two string lengths that collided
  across entirely different transcripts. Switching a video's caption language silently answered
  Arabic queries with English vectors. Identity is now a content hash over the transcript, track,
  language, parser and normalizer versions.
- **A page script could steer a credentialed fetch.** The main-world bridge's request id travels by
  `window.postMessage` and is readable by every script on the page, so a hostile one could forge the
  reply and supply any `baseUrl`, which was fetched with `credentials: "include"` and no validation.
  Payloads are now validated field by field and caption URLs allowlisted to YouTube's timed-text
  endpoint.

### Fixed — from the latest live-YouTube test

- **Native-panel ownership was ambiguous.** The fallback now records whether RecallTube or the user
  opened the panel, preserves user-owned UI, and runs bounded cleanup even when navigation aborts
  acquisition.
- **Modern transcript controls and panels could be hidden behind multiple shadow roots.** Panel
  discovery now crosses the composed tree from the document root, reads composed text and
  accessibility timestamps, selects the fullest valid panel, and clicks the nested native button
  rather than an inert YouTube renderer wrapper.

### Fixed — from the first live-YouTube test

- **An empty caption response was reported as a parse error.** YouTube answers its timed-text
  endpoint with `HTTP 200`, `Content-Type: text/html` and a **zero-length body** when it declines to
  serve a track — verified directly against a fully-signed `baseUrl` taken from the page. The
  extension treated `response.ok` as success, parsed nothing, and told the user its captions were
  malformed. There is now a distinct `captions-withheld` state that says what actually happened.
- **The `<timedtext format="3">` shape was unsupported.** The XML parser only understood
  `<text start dur>` in seconds; YouTube also serves `<p t d>` in milliseconds, which parsed to zero
  cues. Both shapes are now handled.
- **Acquisition diagnostics were unusable.** A failure reported only "parsed to zero cues"; it now
  records HTTP status, content type, byte length and a structural fingerprint of the payload —
  shape only, never caption text.
- **The DOM fallback depended on element names that cannot be verified.** YouTube's served HTML
  contains no `ytd-transcript-*` markup at all — those components are created client-side after a
  `get_transcript` call — so the selectors were guesses, and their internals live in shadow DOM.
  The reader now queries through open shadow roots and, when the known markup does not match, falls
  back to a structural scan: within the transcript panel, any innermost element whose text begins
  with a timestamp is a row, whatever it is called. The diagnostic reports which strategy was used.
- **The DOM fallback gave up too early** and used narrow selectors. It now waits for the panel to
  populate, matches current YouTube markup more broadly, and reports whether the panel is open,
  closed-but-available, or absent.

- **A disconnected tab was reported as "the player is still loading".** When the extension is
  installed or updated while a YouTube tab is open, that tab keeps an orphaned content script and
  the side panel cannot reach it. The panel reused the `not-ready` state, so it blamed the YouTube
  player for something that had nothing to do with it. There is now a `tab-not-connected` state
  that says what happened, the panel retries three times first to absorb the `document_idle` race,
  and it offers a one-click tab reload (using the `tabs` permission already held — no new
  permission).

### Fixed

- **Ask created Prompt API sessions without declaring an output language**, which Chrome warns about
  and which degrades output quality. Sessions now declare expected input and output languages. Since
  Chrome supports only `de`/`en`/`es`/`fr`/`ja`, questions in other languages — Arabic among them —
  are routed to the extractive provider instead of being answered in the wrong language, and the UI
  says so.

### Added — resilient acquisition

- **Automatic native-panel capture.** When the direct caption response is empty or blocked,
  RecallTube locates YouTube's own transcript action across open shadow roots, waits for the native
  rows to settle, captures them, and restores the previous page state. Cleanup also runs when a
  navigation cancels acquisition. The action does not switch or focus tabs.
- **Captured transcripts are now authoritative.** A transcript captured once is served from
  IndexedDB whenever acquisition later fails, instead of showing an error for a video that was
  already searchable. Badges distinguish `CAPTURED` and `SAVED` sources.
- **The transcript panel is detected automatically.** Opening YouTube's own transcript is noticed
  within about half a second and indexed, rather than depending on RecallTube locating YouTube's
  control or the user pressing "Try again" at the right moment. The observer only runs while there
  is no transcript and disconnects once there is one.

### Added — from the first live-YouTube test

- **"Reload this YouTube tab"** for the `tab-not-connected` state.

### Fixed — reliability

- Windows now reuses RecallTube's option-free WebGPU adapter probe for ONNX inference. This removes
  Chromium's ignored `powerPreference` warning and avoids a redundant adapter request.
- Apostrophes inside words are now folded rather than treated as separators, while hyphens remain
  token boundaries. Queries such as `thats where were starting today` and
  `its a well known problem` now match punctuated caption text with source-accurate highlights.
- Semantic indexing now uses length-aware inference batches (at most four passages / roughly 6,000
  characters) instead of fixed 16-passage batches. This avoids the padded-tensor performance cliff
  seen on the 884-cue Karpathy reference transcript while retaining cooperative cancellation.
- Auto-generated captions were ingested with YouTube's rolling-window duplication intact, so
  boundary-spanning search matched text like "using we started using". Rolling windows are merged
  and `aAppend` continuations dropped.
- Timed-text XML entities were decoded once, leaving a literal `&#39;` that normalization mangled
  into a bare `39` — searching for `don't` failed.
- Acquisition failures all became "No captions found", including network errors and 403s. There are
  now seven typed failure reasons, each with its own message and per-adapter diagnostics.
- Nothing was cancellable. Acquisition, indexing and search now take abort signals; navigation
  aborts in-flight work instead of ignoring its result.
- Every keystroke did 59 ms of synchronous main-thread work on a 2-hour transcript, including 52 ms
  of lexical scoring that Exact mode discarded. Indexes are built once per transcript and lazily.
- IndexedDB writes resolved before the transaction committed, so a quota failure looked like
  success. Writes now resolve on `oncomplete`, with eviction and a storage estimate.
- A document-wide `MutationObserver` fired on every DOM change during playback to compare one
  string; `tabs.onUpdated` triggered a full refresh for every update in every tab.

### Added

- **Hybrid retrieval.** BM25 + character n-grams alongside exact and dense retrieval, fused with
  weighted Reciprocal Rank Fusion over stable temporal buckets.
- **Timestamp refinement**, gated on lexical evidence — the gate matters: an ungated refiner cost
  18 points of Recall@1. P95 timestamp error: 22 s → 9 s.
- **Multi-scale sentence-aware chunking** (fine evidence chunks, broad context chunks).
- **Caption language selection**, with original / auto-generated / translated clearly distinguished.
- **Ask mode** — evidence-grounded answers with verified citations, an optional Chrome Prompt API
  provider and an always-available extractive fallback. No cloud fallback.
- **Retrieval benchmark** — 31 labelled queries over 4 multilingual transcripts, six systems, raw
  JSON/CSV output. ([docs/RETRIEVAL_BENCHMARK.md](docs/RETRIEVAL_BENCHMARK.md))
- **Performance harness** with a 50 ms per-keystroke budget, 100 → 10,000 cues.
- **Browser test suite** — 11 Playwright tests against the built extension with a mocked YouTube.
- **Property and fuzz tests** — found four real Unicode bugs (punctuation introduced by NFKD,
  astral-plane offset desync, Arabic presentation forms, Japanese dakuten destruction).
- **Data controls** — clear this video, all transcripts, embeddings, or the downloaded model;
  storage estimate; revocable AI consent.
- **Diagnostics report** that deliberately excludes transcript text.
- Runtime validation for every extension message; `sender.id` checks.
- Accessibility: keyboard result navigation, `aria-live` status, tab semantics, RTL support,
  reduced-motion and high-contrast handling, narrow-panel layout.
- `PRIVACY.md`, `SECURITY.md`, `docs/ARCHITECTURE.md`, `docs/TESTING.md`,
  `docs/RETRIEVAL_BENCHMARK.md`, this changelog, and CI.

### Changed

- Normalization now folds teh marbuta and Persian kaf/yeh (matching Lucene's Arabic and Persian
  normalization), uses locale-independent lowercasing so cache keys are machine-independent, and
  leaves kana and Hangul composed.
- Tokenization uses `Intl.Segmenter` and adds CJK bigrams for every spaceless run, not only when the
  whole query was one token.
- Vectors are stored as `Float32Array` rather than `number[][]`.
- Match labels are words ("Exact phrase", "Close wording", "Same meaning", "Cross-language match"),
  never invented percentages.

### Known limitations

- No configuration abstains on a question the video does not answer — RecallTube always shows
  something. Recorded rather than patched: two negative queries cannot validate a score threshold.
- The planned IBM Granite embedding comparison was **not** completed; the default is unchanged and
  the reason is documented in the benchmark.
- Building the lexical index for a 10,000-cue transcript costs ~3.2 s on the main thread on first
  Meaning-mode use.
- `npm audit` reports 4 high advisories via `sharp` / `onnxruntime-node` / `adm-zip`, all reached
  through `@huggingface/transformers`' Node-only optional dependencies. Verified absent from the
  browser artifact by an automated test. Build-tree only; tracked, not suppressed.

## [0.1.0]

Initial alpha: side panel, exact and meaning modes, YouTube caption acquisition, IndexedDB caches,
Apache-2.0.
