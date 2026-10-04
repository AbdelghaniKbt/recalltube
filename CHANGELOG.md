# Changelog

All notable changes to RecallTube are documented here. This project follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and semantic versioning.

## [0.3.0] — unreleased

### Fixed — independent audit against live YouTube (2026-10-03)

Every item below was found by driving the packaged extension against the real video and playlist
(Chromium 151 and Edge 154, fresh profiles) or by reading the code against that evidence, and each
has a regression test that fails without its fix.

- Pressing Back to a previous video failed every time with "YouTube did not expose usable
  captions". A history navigation is announced by `popstate` about a second before
  `yt-navigate-finish`; acquisition started on `popstate`, the native stage opened the transcript
  panel mid-transition, and YouTube's navigation completion hid every engagement panel, so the
  capture saw no rows and YouTube never fetched the transcript. The same hide follows any SPA
  navigation about half a second after `yt-page-data-updated`, which arrived 0.3–1.4 s after
  `yt-navigate-finish` live, so clicking a related video failed the same way whenever the direct
  stage finished first. History changes now wait for the finish event (bounded fallback 3 s), and
  every navigation-triggered acquisition waits for `yt-page-data-updated` plus a 1 s settle (bounded
  2.5 s) before touching YouTube's UI. The native capture also notices when the page closes the
  panel it opened or when YouTube's request fails, and reopens it once after a pause, re-finding the
  control in case the description was re-rendered.
- After an SPA navigation the expanded transcript panel shows the *previous* video's rows for
  several seconds until YouTube's `get_transcript` replaces them. Those rows could settle as the new
  video's transcript. Row lists that existed in any panel before the open are now accepted only once
  they change or YouTube has made a transcript request since the open; otherwise the attempt ends as
  `stale-rows` (retryable), never as another video's transcript. When YouTube's visibility attribute
  is in use, only a panel marked EXPANDED is readable.
- A page reload after a failed attempt could leave the side panel stuck on the old page's failure:
  generations restart at 1 in a new document, and the panel compared them across documents, so the
  reloaded page's first successful result lost to the replaced page's higher generation. Snapshots
  now carry the page's document id and are compared only within one (`snapshot-policy.ts`).
- A removed, private or not-yet-started video no longer waits up to 90 s for a transcript control
  that never renders and then reports "no captions". The player's own `playabilityStatus` crosses
  the bridge (validated and bounded), fails the item at once with a specific reason
  (`video-unavailable`, `permission-denied`, or `unsupported` for live/premiere), skips the native
  stage, and never shows a playlist worker window for it.
- Opening the side panel while a YouTube tab was still loading flashed "This tab needs a reload":
  the content script registers at `document_idle`, seconds after the panel's three quick retries. The
  panel now keeps asking while Chrome reports the tab as loading (bounded to 12 s) and shows the
  reading state instead.
- A video without captions kept a whole-document `MutationObserver` attached for the life of the
  tab, walking every shadow root 2.5 times a second during playback. The watch now runs only in the
  failed state for a bounded 60 s, is re-armed by a trusted user gesture, checks with a row query
  instead of a full panel-state probe, never runs in a playlist worker, and reports itself in the
  diagnostics (`panel-watch`).
- The current-video and playlist surfaces each created their own semantic worker, so both could
  hold a loaded 118 MB model at once. They now share one client; each subscribes to status.
- The default embedding model's `revision` was `main` while being documented as pinned; it is now
  pinned to a commit hash, so an upstream change cannot alter results under an unchanged cache key.
  Existing embedding caches re-embed once.
- Playlist Ask evidence interleaves across videos in order of first appearance instead of letting
  the first-ranked video fill all six slots, so a multi-video question keeps multi-video evidence.
- The playlist view re-read every cached transcript in the store (`getAll()`) and rebuilt every
  video's retrieval index on each job update; it now reads only the playlist's videos through the
  index and caches per-transcript indexes. The side panel also wrote the same transcript back to the
  cache on every poll; it writes once per transcript.
- A playlist worker streamed and decoded each video it was only reading captions from; the worker's
  playback is paused (bounded, extension-owned tabs only). When the native stage must render, the
  worker is a 720×540 window placed in the bottom-right corner of the window that had focus instead
  of a default-size popup, still unfocused.
- Playlist results gained keyboard navigation (↑/↓/Enter), `listbox`/`option` roles and a polite
  live region, matching the current-video view.
- `npm run test:live:reference` is a full live single-video audit (acquisition, reference-oracle
  alignment, Exact, seek, Meaning, Ask, user-panel preservation, page reload, SPA navigation,
  extension reload) and runs in a plain browser process; it previously used the automation-flagged
  harness the testing docs say produces false failures. `RECALLTUBE_BROWSER` points the live scripts
  at an installed Chrome or Edge, always in a fresh profile. The playlist smoke reports media bytes.

### Added — playlist recall

- Search Exact, Meaning, or Ask across every indexed video in a YouTube playlist, with video title,
  playlist position, timestamp, and playlist-aware links preserved on every result and citation.
- Discover playlist inventory from YouTube's page bootstrap and rendered rows without a YouTube Data
  API key, OAuth, backend, transcript proxy, media download, or internal continuation endpoint.
- Persist playlist inventories and per-video job state in IndexedDB. Jobs reuse cached transcripts,
  expose coverage, and support pause, resume, cancel, retry, and refresh.
- Process missing videos serially with one muted, minimized worker at a time. Each item gets a fresh
  document; only a withheld direct caption briefly foregrounds that worker for native transcript
  rendering, after which its panel/window close and the original focus is restored.
- Add a repeatable live-playlist smoke command and a compiled-extension end-to-end test covering
  cache reuse, acquisition, unavailable items, cross-video search, navigation isolation, and cleanup.

### Hardened

- Parse cold-page `ytInitialPlayerResponse` and `ytInitialData` assignments with a bounded balanced
  JSON reader—never `eval`—when a background page has not initialized its player globals yet.
- Allow only one global playlist acquisition worker. Starting a different playlist explicitly
  hands off and cleans up the previous job.
- Keep the exact worker ids until verified cleanup completes; a completed job can no longer erase
  its ownership metadata before closing the tab.
- Cache up to 1,000 transcripts and 250 embedding sets, with playlist inventories and recent jobs
  independently bounded and visible in privacy/storage settings.

### Fixed — from a user's diagnostics (Chrome 152)

Two playlist items opened YouTube's transcript panel in under a second and then waited 122 s behind
YouTube's loader without a single row.

- Native capture now records YouTube's own `get_transcript`/`get_panel` requests (status, duration,
  size — never URLs or bodies) and whether the page was hidden, and diagnostics report both plus
  every panel's loader/row state when a capture ends empty.
- A failed YouTube request ends the wait at once. A successful one that renders no rows within 30 s
  reopens the panel once and then fails fast for the automatic retry pass, instead of waiting out the
  loader. Neither is reported as `no-captions`.
- If a worker page keeps reporting itself hidden, the worker window is brought to the front — the
  only case where focus is taken — and focus is handed back afterwards.
- The side panel no longer drops from the playlist view to "This video" when one playlist lookup
  fails while the tab still shows that playlist.

### Fixed — playlist coverage that only "Retry failures" could reach

Every click of **Retry failures** made more videos searchable: first passes failed on slower machines
and later attempts, with YouTube's resources cached, succeeded. Reproduced with 4x CPU and 300 ms
latency, where phase timings showed why.

- Items that fail transiently are retried automatically, up to 3 attempts, after the rest of the queue;
  YouTube's own "no captions"/"unavailable" answers are never retried. A manual retry starts a fresh
  budget, and the panel shows "Retrying … (attempt n of 3)".
- Waiting is progress-based. YouTube took 40–114 s to deliver rows there; the page correctly waited
  on YouTube's loader but reported nothing, and the coordinator gave up at a fixed 55 s. The capture
  now reports its phase and a heartbeat while YouTube's loader is shown; the coordinator fails a native
  attempt only after 45 s without progress, bounded by a 4-minute cap.
- A slow watch page is no longer reported as having no captions. The transcript control took up to
  33 s to exist and a 15 s limit produced a terminal `no-captions` for two captioned videos. The wait
  continues while YouTube's watch app is still rendering its description, stops as soon as rows
  appear, and a video whose player advertised a caption track is never classified `no-captions`.
- Settling fingerprints the list (row count and last timestamp) and parses it once, instead of
  re-parsing every row after each quiet period, which dominated capture time on a slow CPU.
- YouTube's `yt-content-loading-renderer` counts as loading; without it a transcript delivered in
  batches could be captured partially.
- A recorded worker window is closed only if every tab in it is a session-owned worker.
- Diagnostics include per-phase timings (control, open, rows, settle, read).

### Fixed — native transcript capture (single video and playlists)

Reproduced in the packaged extension against live YouTube on 2026-09-16.

- The single-video panel sat in "Reading captions…" for ~220 s on `96jN2OCOfLs` while its content
  script could not answer messages. A CPU profile attributed it to the rendered-transcript reader:
  every nested transcript renderer was scanned as its own scope, the structural fallback ran even
  after the known-row reader succeeded and compared all candidate pairs with `Node.contains`
  (70.8 s) while materializing full-text ancestors (45.8 s), and the close loop re-read the whole
  transcript for every renderer lacking a `visibility` attribute. Scopes are now outermost panels,
  the structural scan runs only when known rows found nothing and is linear, text reads are bounded,
  and visibility resolves from the nearest engagement panel. Same page: ready in 12 s.
- Rows are never read from a panel YouTube marks hidden; it keeps a populated hidden copy.
- Waiting uses DOM mutations with bounded timeouts instead of fixed sleeps, so a long transcript that
  takes YouTube several seconds to deliver is no longer cut off at 4.5 s.
- The chaptered "In this video" panel (`get_panel`, no `target-id`) is recognized by the transcript
  rows it holds; `l8pRSuU81PU` now captures 1,813 cues.
- Playlist positions were 1, 3, 5 … because each current `yt-lockup-view-model` row has two watch
  links; one item per video now, positioned by the link's `index`.
- The native stage restores the worker window without focus (a minimized window never builds the
  control; an unfocused one does) and no longer focuses the owner's window after every item. Focus is
  handed back only if the window manager activated the worker.
- Worker role comes from session-owned tab ids, not a `#recalltube-playlist-worker` fragment that any
  link could carry into an ordinary tab and silently disable its native fallback.
- A same-video URL rewrite no longer restarts acquisition, an explicit native request is no longer
  coalesced into an in-flight attempt of another mode, a document replaced during restore gets the
  native request again, and Chrome's transient "Tabs cannot be edited right now" is retried.
- Live scripts launch an ordinary Chromium process: the automation-flagged browser they used made
  YouTube refuse captions entirely, which earlier reports mistook for a YouTube session limit.
- Copy diagnostics now includes page status, video id, load provenance and per-playlist-item adapters.

### Fixed — playlist worker ownership

Found by an independent audit of this release. Each has a regression test that fails without its fix.

- Serialize the runs of a job instead of refusing to start a second one. `processJob` released its
  abort controller *before* closing the worker, so a resume arriving during cleanup passed the guard,
  created a second worker, and the previous run's cleanup then closed the wrong tab and wrote its own
  stale ownership over the new one — two workers for one job, one of them leaked.
- Claim a job only from a fresh read. Stamping `running` from a snapshot loaded before the user acted
  meant the next iteration read back the state this run had just written, resurrecting a paused or
  cancelled job and opening a worker for it.
- Verify a persisted worker tab id against session-scoped ownership before driving or closing it.
  Job records outlive the browser and Chrome restarts its tab-id counter, so a restored id could name
  a tab the *user* opened.
- Close an abandoned worker before resuming. `resetInterruptedItem` cleared the tab and window ids
  without closing them, and the restart sweep never revisits a paused job, so the tab was orphaned
  for good. The reset now leaves ownership alone and the caller closes; the startup sweep also closes
  a worker recorded by any job, whatever its state.
- Drop `openerTabId` when the owner tab is gone. Chrome rejects `tabs.create` outright for a
  missing opener, which failed every remaining item as `network-error` once the user closed their
  own YouTube tab.
- Minimize the promoted worker window explicitly. Chrome silently ignores `state: "minimized"` on
  `windows.create` for a popup — it returns, and stays, `normal` — so the "minimized" worker was a
  visible window appearing on the user's screen for every withheld video.
- Create the worker at `about:blank` and navigate only after Chrome attaches its tab. Starting the
  YouTube URL inside `windows.create` raced window attachment and could leave a metadata-only page
  with no native transcript controls. Native fallback now waits for the rendered document, briefly
  focuses it, captures and closes the panel, then destroys the worker before the next item.
- Own the temporary playlist-inventory tab beyond the side panel's lifetime. Chrome destroys the
  panel without warning, which leaked that tab; it is now recorded in session storage, closed on
  unmount and `pagehide`, and swept on service-worker start.
- Record each playlist transcript as it is embedded. Committing the batch at the end meant a playlist
  still acquiring — where the corpus grows and re-runs the effect — aborted the loop and discarded
  every embedding it had just computed, so meaning search could not converge while indexing ran.
- Keep the side panel attached to the user's playlist when the acquisition worker becomes active in
  its own minimized window. Cross-window activation events are now ignored and overlapping refreshes
  are latest-wins, preventing a stale worker response from replacing playlist mode.
- Make Unicode search normalization idempotent when compatibility decomposition introduces an
  apostrophe (for example, U+0149). The normalizer version is bumped so affected caches rebuild.
- Give the playlist mode tabs `role="tab"`/`aria-selected` and the scope switch `aria-pressed`. The
  playlist view declared `role="tablist"` over plain buttons, so no active mode was announced.
- State the Hugging Face `cdn-lfs` hosts in PRIVACY.md, which called its shorter list complete. A
  build test now fails if any declared host permission is undocumented.
- Give every playlist browser test its own profile, and make the live smoke budget configurable and
  honest about a timeout instead of reporting a still-running worker as "not closed".

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
