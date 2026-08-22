# Testing RecallTube

## Automated

| Command | What it covers |
| --- | --- |
| `npm run typecheck` | Strict TypeScript, `noUncheckedIndexedAccess` |
| `npm test` | 177 unit, property and fuzz tests across 14 files |
| `npm run test:e2e` | 13 browser tests against the built extension |
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

## Manual live-YouTube matrix

Fixtures cannot represent an unofficial integration. Run this against real YouTube before any
release, and record the date, Chrome version and results in the pull request.

Load the unpacked extension from `.output/chrome-mv3`, then reload any open YouTube tabs.

### Caption acquisition

| # | Case | Expected |
| --- | --- | --- |
| 1 | Manually captioned video | Transcript loads, language shown, no `AUTO` pill |
| 2 | Auto-captioned video | Loads, `AUTO` pill shown, no duplicated phrases in results |
| 3 | Video with several caption languages | Language selector appears; switching re-indexes |
| 4 | Machine-translated track selected | `TRANSLATED` pill shown |
| 5 | Video with captions disabled | "No captions for this video", not an error |
| 6 | Age-restricted video (signed in) | Loads, or a specific permission message — never a silent "no captions" |
| 7 | Unavailable / private video | A specific failure state |
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
| 14 | Click a related video (SPA navigation) | New transcript; the old one never shows |
| 15 | Rapid A → B → C within ~2 s | Ends on C; no stale results, no stuck spinner |
| 16 | Two YouTube tabs, switch between them | Panel follows the active tab |
| 17 | Switch to a non-YouTube tab | Panel shows the idle state |
| 18 | Browser back/forward | Transcript follows |
| 19 | Reload the page mid-index | Recovers without a stuck state |
| 19a | Reload the extension with a YouTube tab already open | "This tab needs a reload" — **not** "the player is still loading" |
| 19b | From 19a, click "Reload this YouTube tab" | Tab reloads, panel reconnects, transcript loads |
| 19c | Open the panel while a video is still loading | Reconnects on its own within ~1 s, no error state |

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
