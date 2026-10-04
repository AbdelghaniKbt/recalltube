# Testing RecallTube

## Automated

| Command | What it covers |
| --- | --- |
| `npm run typecheck` | Strict TypeScript, `noUncheckedIndexedAccess` |
| `npm test` | 251 unit, property and fuzz tests across 24 files |
| `npm run test:e2e` | 27 browser tests against the built extension |
| `npm run build` | Production build, artifact hardening and host allowlist |
| `npm run bench` | Retrieval quality, driving the real worker in a browser |
| `npm run bench:perf` | Per-keystroke latency against a 50 ms budget |

Property tests (`fast-check`) cover normalization offset mapping, exact-search highlight bounds and
cue coalescing invariants. They found four real Unicode bugs during this release; keep them.

The browser suite mocks YouTube with Playwright request interception, which also intercepts the
content script's fetches, so the real acquisition path runs without touching the live site.

## Reference-video workflow

Use a locally saved transcript to exercise long-video retrieval without committing copyrighted
caption text. The UI command drives the packaged extension, verifies native-panel ownership and
cleanup, and can regenerate the three README screens:

```bash
npm run test:reference -- path/to/transcript.txt
npm run test:reference:ui -- path/to/transcript.txt --skip-semantic --screenshots=artifacts/readme
```

Omit `--skip-semantic` to run the real multilingual embedding worker as well. The checked-in README
screens use video `96jN2OCOfLs` and its 884-cue reference transcript.

**One browser test is not hermetic.** `semantic worker > initializes a backend and answers a search`
drives the real packaged worker, and each run starts from a fresh browser profile, so it downloads
the ~118 MB model from Hugging Face every time. It needs network and takes ~15 s, and it can fail
transiently if that download is interrupted — observed once in five runs during development. A
failure there is a network result until proven otherwise; re-run before investigating. Every other
browser test is offline and deterministic.

## Live YouTube checks

```bash
npm run build
npm run test:live -- "https://www.youtube.com/watch?v=96jN2OCOfLs" "vibe coding"
npm run test:live:playlist -- "https://www.youtube.com/playlist?list=PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ" "gradient"
npm run test:live:reference -- "https://www.youtube.com/watch?v=96jN2OCOfLs" --reference="path/to/transcript.txt" --phrase="vibe coding"
```

All three scripts start a browser as an **ordinary process** with a debugging port and attach over
CDP (`scripts/plain-chromium.mjs`). By default that is Playwright's Chromium; set
`RECALLTUBE_BROWSER` to the path of an installed browser to run the same checks in that build, always
in a fresh temporary profile (Google Chrome stable no longer accepts `--load-extension`; Microsoft
Edge does). They must not use `launchPersistentContext`: that sets
`navigator.webdriver`, and YouTube then refuses captions to the browser altogether — its own player's
proof-of-origin timed-text request returned 0 bytes and 12 s of playback with captions on showed no
caption line, while the same Chromium launched normally received a 539 KB caption body. The
2026-09-15 results below were produced by that harness defect and are superseded.

The single-video script reports every adapter attempted, caption request status and size (never URLs
or tokens), whether the native control appeared, rows rendered, cues captured, panels left expanded,
the slowest content-script reply, and an Exact search. The playlist script samples once a second: job
state, worker windows and their state, which window has focus, the user's tab URL, the side panel's
scope, and each worker's status and generation transitions, then reports coverage per video.
`RECALLTUBE_LIVE_BUDGET_MINUTES` (default 35) bounds a playlist run; a timeout is reported as a
harness result, never as a product result. The reference audit (`test:live:reference`) additionally
compares the captured cues with a locally saved reference transcript used purely as an oracle (cue
starts aligned within 1 s, rows identical after normalization, phrase positions), then exercises
Exact search and highlights, click-to-seek, Meaning with the real local model, Ask with citation
checks, preservation of a transcript panel the user opened, a page reload, SPA navigation away and
back, and an extension reload with the tab still open. Every step reports structure only; the
reference file is never imported by the extension.

Recorded 2026-10-03 on the audited build, fresh signed-out profiles, Chromium 151.0.7922.34
(Playwright) and Microsoft Edge 154.0.4258.53 (`RECALLTUBE_BROWSER`); Google Chrome 154 stable
refused `--load-extension`, so it could only be covered by the manual signed-in check above:

| Check | Chromium 151 | Edge 154 |
| --- | --- | --- |
| `96jN2OCOfLs` acquisition | direct 200 / 0 B → native panel 893 rows → 893 cues in 13.4 s; 0 unanswered state requests (slowest reply 2.3 s); longest main-thread task 2.4 s; no panel left open | same path, 893 cues in 12.0 s; slowest reply 2.0 s; longest task 2.3 s |
| Reference oracle (884-cue local transcript) | 883/884 cue starts within 1 s; all vocabulary present; "vibe coding" at 31, 96, 947, 957 s vs 32, 96, 948, 957 s | identical |
| Exact | 4 moments (0:31, 1:36, 15:47, 15:57), all highlighted; a 4-word phrase across a caption break found with 2 highlights, labelled as spanning a break | identical |
| Click-to-seek | player at 31.0 s | player at 31.0 s |
| Meaning | model downloaded from huggingface.co / `*.hf.co`, WebGPU; paraphrase → 18 moments, top 0:33 | WebGPU; 18 moments, top 0:33 |
| Ask | extractive (no Prompt API); 3 citations at 0:31, 0:49, 12:53, each with evidence text | identical |
| User-opened panel | preserved through a refresh | preserved |
| Page reload | transcript kept on screen; re-acquired in 16 s | kept; 8.1 s |
| SPA to a related video and Back | away 245 cues, back 893 cues, both via native panel | away 533 cues, back 893 cues |
| Extension reload with the tab open | not testable: `runtime.reload()` does not restart a command-line-loaded extension here | panel offered "Reload this YouTube tab"; reconnected with 893 cues |
| Console errors / unexpected hosts | none / none (panel contacted only the extension origin, huggingface.co, us.aws.cdn.hf.co) | none / none |
| `PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ` | 10 / 10 indexed on the first attempt in 277 s (1408, 1138, 732, 1111, 1102, 550, 1106, 400, 1269, 1813 cues); 1 worker at a time, 720×540 corner window, closed at the end; user tab unchanged; user window unfocused in 1 of 115 samples, focused at the end; side panel never left the playlist; "gradient" → 50 results | 10 / 10 in 164 s, same cue counts; unfocused in 20 of 105 samples (Edge activates the restored window), focused at the end |

One earlier Chromium playlist run on the same day stopped after 7 s: the coordinator answered `playlist-get` without a job from 13 s on and the browser process exited at 659 s. It did not reproduce (two further runs completed); the smoke now prints why a sample has no job (no answer, error, or no record) so a recurrence can be attributed.

Recorded 2026-09-16, Chromium 151.0.7922.34, fresh signed-out profile:

| Check | Result |
| --- | --- |
| `96jN2OCOfLs` | direct timed text 200 / 0 B → native panel: 893 rows, 893 cues, ready in 12 s, no panel left open; "vibe coding" → 4 moments, first at 0:31 |
| `PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ` | 10 / 10 indexed through the native panel (1408, 1138, 732, 1111, 1102, 550, 1106, 400, 1269, 1813 cues); 1 worker at a time, closed at the end; user tab URL unchanged; user window unfocused in 1 of 108 samples and focused at the end; side panel never left the playlist; "gradient" → 50 results |

Two options reproduce conditions a small idle test window hides:

- `RECALLTUBE_LIVE_REALISTIC=1` maximizes and focuses the user's window and plays a video in it.
- `RECALLTUBE_LIVE_THROTTLE="cpu=4,latency=300"` slows every YouTube page, including each worker as
  it opens (never the harness's own extension page).

Each item's report includes its attempts, worker status/generation/progress transitions and the
native capture's phase timings (control, open, rows, settle, read).

Recorded 2026-09-17 with `cpu=4,latency=300` and the realistic user window, same playlist:

| Build | Searchable at the end | Notes |
| --- | --- | --- |
| Before progress-based waiting | 6 / 10 after 3 attempts each | two captioned videos reported `no-captions`; YouTube's rows took 40–114 s and the coordinator stopped waiting at 55 s |
| After | 10 / 10 | one video recovered on its automatic second attempt; rows took up to 89 s and were captured; 16.5 min |

Unthrottled on the same day: 10 / 10 on the first attempt in 232 s.

Before the 2026-09-16 reader fix the same video stayed in "Reading captions…" for ~220 s with the
content script unable to answer messages: the structural fallback scanned every nested renderer and
compared all candidate pairs with `Node.contains`. `src/transcript/rendered-transcript-scale.test.ts`
and `tests/e2e/single-video.spec.ts` reproduce that scale.

The chaptered "In this video" panel (e.g. `l8pRSuU81PU`) is filled by `get_panel` into an engagement
panel with no `target-id`; it is recognized by the transcript rows it holds.

Each browser test launches its own disposable profile. Sharing one profile let a second navigation to
a mocked watch URL escape `context.route`, reach real YouTube, and be redirected.

## Manual live-YouTube matrix

Fixtures cannot represent an unofficial integration. Run this against real YouTube before any
release, and record the date, Chrome version and results in the pull request.

Load the unpacked extension from `.output/chrome-mv3`, then reload any open YouTube tabs.

### Signed-in profile check (manual, your own Chrome)

The automated live checks run in a fresh, signed-out, disposable profile — never in your own. Caption
availability can differ for a signed-in session, so verify there by hand; this takes about five
minutes and records nothing but structure.

1. `npm run build`. In your Chrome open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked** and pick `.output/chrome-mv3`. Note the Chrome version from `chrome://version`.
2. Open `https://www.youtube.com/watch?v=96jN2OCOfLs` in a new tab and click the RecallTube toolbar
   icon. Expected within about 10–40 s: the title, "893 captions" (or close to it), a `CAPTURED`
   pill, and YouTube's own transcript panel closed again. If the panel stays open, that is a defect.
3. Type `vibe coding` in **Exact**. Expected: 4 moments at about 0:31, 1:36, 15:47 and 15:57 with
   the words highlighted. Click the first; the player seeks to about 0:31.
4. Switch to **Meaning**, accept the model download (118 MB, from huggingface.co), type
   `felt behind as a programmer`. Expected: a moment near 0:36–0:57 labelled "Exact phrase" or
   "Same meaning", and a `WebGPU` or `CPU (WASM)` pill.
5. Switch to **Ask**, type `Why did he say he felt behind as a programmer?`, click **Answer from this
   video**. Expected: an answer with at least one clickable timestamp citation; clicking it seeks.
6. Click a related video in YouTube's sidebar (an in-page navigation). Expected: the panel reads the
   new video's transcript or reports a specific reason; the transcript panel RecallTube opens is
   closed again. Press the browser's Back button: the original transcript returns.
7. Open `https://www.youtube.com/playlist?list=PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ`, open RecallTube,
   choose **Entire playlist**, **Index this playlist**. Expected: one small muted window appears in
   the bottom-right corner of your window for 10–30 s per video without taking focus, and closes
   each time; coverage reaches "10 of 10 videos searchable" (count what YouTube shows for the
   playlist that day); `gradient` in **Exact** returns moments with titles and positions; clicking
   one opens that video with `&list=` and `&t=` in the URL. No worker window remains afterwards.
8. Click the gear icon, **Copy diagnostics (no transcript text)**, and keep the JSON with the date
   and Chrome version. It contains adapter outcomes, request statuses and sizes, panel structure and
   playlist item states — no caption text, URLs with tokens, cookies or titles.

If step 2 ends in "YouTube did not expose usable captions" while the signed-out automated run
succeeded the same day, the difference is the session, not the build; the diagnostics JSON shows
which stage stopped.

### Caption acquisition

| # | Case | Expected |
| --- | --- | --- |
| 1 | Manually captioned video | Transcript loads, language shown, no `AUTO` pill |
| 2 | Auto-captioned video | Loads, `AUTO` pill shown, no duplicated phrases in results |
| 3 | Video with several caption languages | Language selector appears; switching re-indexes |
| 4 | Machine-translated track selected | `TRANSLATED` pill shown |
| 5 | Video with captions disabled | "No captions for this video", not an error |
| 6 | Age-restricted video (signed in) | Loads, or a specific permission message — never a silent "no captions" |
| 7 | Unavailable / private video | "This video is unavailable" or "Captions are not accessible" within ~10 s; the transcript panel is **not** opened and a playlist worker is never shown for it |
| 8 | Live stream | Honest state; no crash |
| 9 | Premiere before it starts | Honest state; no crash |
| 10 | Music video with `[Music]` markers | Markers do not corrupt highlighting or offsets |
| 11 | Video over 2 hours | Loads; typing stays responsive |
| 12 | YouTube Shorts | Loads or reports unsupported cleanly |
| 13 | Captions panel already open, player track failing | DOM fallback engages; source shows `CAPTURED`; the user's panel remains open |
| 13a | Timed-text returns an empty 200 (common) | RecallTube automatically opens the native transcript, captures it, and closes it |
| 13b | Watch-tab focus while 13a runs | No focus switch; native panel may appear briefly and is then restored to hidden |
| 13c | Video with no transcript action or panel | Clear failure with retry; no paste workflow or misleading "no captions" state |
| 13d | Navigate away while automatic capture is running | Acquisition cancels and RecallTube still closes the panel it opened |
| 13e | Revisit a video whose transcript was captured earlier, with captions now failing | Loads from cache, badge shows `SAVED` |

### Navigation and tabs

| # | Case | Expected |
| --- | --- | --- |
| 14 | Click a related video (SPA navigation) | New transcript; the old one never shows; rows left over from the previous video in a panel YouTube has not marked expanded are never read |
| 14a | Back button after 14 | The original transcript returns |
| 15 | Rapid A → B → C within ~2 s | Ends on C; no stale results, no stuck spinner |
| 16 | Two YouTube tabs, switch between them | Panel follows the active tab |
| 17 | Switch to a non-YouTube tab | Panel shows the idle state |
| 18 | Browser back/forward | Transcript follows |
| 19 | Reload the page mid-index | Recovers without a stuck state |
| 19a | Reload the extension with a YouTube tab already open | "This tab needs a reload" — **not** "the player is still loading" |
| 19b | From 19a, click "Reload this YouTube tab" | Tab reloads, panel reconnects, transcript loads |
| 19c | Open the panel while a video is still loading | Shows "Reading captions…", never "This tab needs a reload", and connects once the page finishes loading |
| 19d | Reload the page after a failed attempt | The reloaded page's transcript is adopted; the panel does not stay on the old failure |

### Playlists

| # | Case | Expected |
| --- | --- | --- |
| P1 | Open `/playlist?list=…` | Entire playlist scope appears with the complete video count |
| P2 | Open `/watch?v=…&list=…` | Both This video and Entire playlist scopes are available |
| P3 | Start indexing | One muted, minimized worker runs at a time; focus never moves to it |
| P4 | Cached plus uncached items | Cached videos become searchable immediately; only missing videos are acquired |
| P5 | Pause, then resume | Worker closes on pause; only interrupted/pending items resume |
| P6 | Cancel | Worker closes and completed transcripts remain searchable |
| P7 | Service worker suspension/restart | Job resumes from persisted state without duplicating completed work |
| P8 | No-caption / private / failed item | Coverage shows the exact state and the queue continues |
| P9 | Exact search while indexing | Partial results appear with title, playlist position and timestamp |
| P10 | Click a playlist result | Opens that video with `list` and `t`, preserving playlist context |
| P11 | Finish or terminal failure | No extension-owned YouTube worker tab/window remains |
| P12 | Refresh playlist | Inventory is re-read and a new job includes newly added videos |
| P13 | Direct captions withheld | Worker window is restored unfocused, native panel opens/captures/closes, worker closes, your window keeps focus |

### Search

| # | Case | Expected |
| --- | --- | --- |
| 20 | Exact phrase within one caption line | Found; matched words highlighted |
| 21 | Phrase spanning two caption lines | Found; both halves highlighted; labelled "Exact phrase" |
| 22 | Repeated phrase | Every occurrence listed, in time order |
| 23 | Arabic query with different diacritics | Found; **highlight covers the diacritics in the original** |
| 24 | Accented Latin query without accents (`cafe` → `Café`) | Found and highlighted |
| 25 | Misspelled query | Found in Meaning mode |
| 26 | Paraphrase | Found in Meaning mode; seeks to the sentence, not the chunk start |
| 27 | Cross-language (ask in Arabic about an English video) | Found; labelled "Same meaning" |
| 28 | One-character query | Nothing; no error |
| 29 | `↑` / `↓` then `Enter` | Moves the active result and seeks to it |
| 30 | `Escape` | Clears the query |
| 31 | Copy link / Copy quote | Clipboard contains a correct `&t=NNs` link |
| 32 | −15 s | Seeks 15 s earlier |
| 33 | Context toggle | Shows surrounding cues |

### Model lifecycle

| # | Case | Expected |
| --- | --- | --- |
| 34 | Meaning mode, consent not yet given | Consent card states size and host; no download begins |
| 35 | Decline consent (stay in Exact) | No network request to Hugging Face at all |
| 36 | Accept consent | Progress shown; backend reported (WebGPU or CPU) |
| 37 | Cancel during download or indexing | Stops; UI returns to a usable state |
| 38 | Search while indexing | Input stays responsive; Exact results still work |
| 39 | Reopen the same video later | Indexes from cache, materially faster |
| 40 | Switch caption language after indexing | **Re-indexes** — must not reuse the other language's vectors |
| 41 | Disable WebGPU (`chrome://flags`) | Falls back to CPU with an honest label |
| 42 | Go offline with the model cached | Meaning search still works |
| 43 | Go offline without the model | Exact works; Meaning explains why it cannot |
| 44 | Settings → Delete downloaded model | Storage figure drops; next use re-downloads |
| 45 | Settings → Turn off meaning search | Consent revoked; model released |

### Ask

| # | Case | Expected |
| --- | --- | --- |
| 46 | Question the video answers | Answer with clickable citations; passages shown beneath |
| 47 | Question the video does not answer | "I could not find enough evidence in this transcript." |
| 48 | Click a citation | Seeks to that timestamp |
| 49 | Browser without the Prompt API | Extractive passages, with an explanation |

### Accessibility

| # | Case | Expected |
| --- | --- | --- |
| 50 | Keyboard only, no mouse | Every action reachable; focus always visible |
| 51 | Screen reader | Mode tabs, result list and status changes announced |
| 52 | Arabic transcript | Results render right-to-left correctly |
| 53 | Panel dragged to its narrowest | No horizontal scrolling; no clipped controls |
| 54 | OS "reduce motion" enabled | No pulsing animation |
| 55 | OS high-contrast / increased contrast | Text and borders remain legible |

### Privacy verification

| # | Case | Expected |
| --- | --- | --- |
| 56 | DevTools → Network, whole session in Exact mode | Only `youtube.com` requests |
| 57 | DevTools → Network during a Meaning session | Only `youtube.com` and `huggingface.co` / `*.hf.co` |
| 58 | Search anything, inspect the network log | The query appears in **no** request |
| 59 | Settings → Copy diagnostics | Report contains adapter outcomes, **no transcript text** |

## Reporting a failure

Use **Settings → Copy diagnostics**. It deliberately excludes transcript content. Include the video
URL only if it is public, plus your Chrome version and OS.
