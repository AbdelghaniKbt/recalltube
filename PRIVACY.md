# RecallTube privacy

RecallTube has no server, no account, no analytics and no telemetry. This document states exactly
what happens on your device and what leaves it.

## What never leaves your device

- Transcripts of the videos you watch.
- Your search queries and Ask questions.
- Embedding vectors derived from transcripts.
- Any answer or evidence Ask produces.

There is no code path that uploads any of these. The build fails if the packaged extension
references a host outside the allowlist below (`scripts/harden-artifact.mjs`), and a browser test
asserts the same at runtime (`tests/e2e/extension.spec.ts`).

## What is downloaded, and when

| What | From | When |
| --- | --- | --- |
| Caption tracks for the current video or a playlist item | `https://www.youtube.com/api/timedtext` | When RecallTube acquires a transcript |
| Embedding model weights and tokenizer (~118 MB) | `huggingface.co`, served via its `cdn-lfs` hosts and `*.hf.co` | **Only after you explicitly enable meaning search**, once |

Caption requests are made with your existing YouTube session so that captions you are already
entitled to are readable. For an explicitly indexed playlist, RecallTube requests only the videos
YouTube listed on that playlist page. It processes one item at a time in a fresh muted, minimized
extension-owned worker whose playback is paused. If the native transcript fallback must render, that
worker is shown as a small unfocused window in a corner of your window, then its panel and window are
closed. A video the player reports as removed, private or not yet started is never shown. RecallTube
decides which tabs are its workers from the tab ids it created in this browser session, never from a
URL. RecallTube does not bypass access control.

The model download is a plain file fetch. It reveals your IP address and User-Agent to Hugging
Face, exactly as visiting their site would. It does **not** include your query, the video, or any
transcript. Nothing is sent to Hugging Face at search time — inference runs entirely on your
device.

**Exact search never triggers any model download.** RecallTube is fully usable without ever
enabling AI.

### Hosts the extension may contact

`www.youtube.com`, `youtube.com`, `huggingface.co`, `cdn-lfs.huggingface.co`,
`cdn-lfs-us-1.huggingface.co`, `*.hf.co`. That is the complete list — it is exactly the
`host_permissions` array in `manifest.json` — and it is
enforced at build time and asserted in tests.

## What is stored locally

In **IndexedDB** (database `recalltube`):

- **Transcripts** — cues, timings, video id and title, caption track and language. Capped at 1,000
  transcripts, oldest evicted first.
- **Embeddings** — one `Float32Array` per indexed transcript plus the chunk text it was computed
  from. Capped at 250 records, oldest evicted first.
- **Playlist inventories and jobs** — video ids, titles, ordering, indexing state, failures and
  coverage for up to 100 playlists / 25 recent jobs. No query history is stored.

In **CacheStorage**: the downloaded model weights, cached by `transformers.js`.

In **extension storage**: two booleans — whether you enabled meaning search, and whether you allowed
Ask to use the browser's built-in model.

**Queries are never stored.**

## Deleting your data

Open the panel and click the gear icon. You can:

- **Clear this video** — its transcripts and embeddings.
- **Clear all transcripts**.
- **Clear embeddings**.
- **Clear all local indexes** — transcripts, embeddings, playlist inventories and jobs.
- **Delete downloaded model** — removes the cached weights; meaning search will re-download if you
  use it again.
- **Turn off meaning search** — revokes consent and disposes the model from memory.

The same screen shows how many records are stored and how much browser storage RecallTube is using.
Removing the extension deletes all of it.

## Permissions

| Permission | Why |
| --- | --- |
| `sidePanel` | The RecallTube UI is a side panel. |
| `storage` | Remembers the two consent booleans. |
| `tabs` | Follows YouTube navigation, seeks to results, and creates one temporary muted worker tab after you explicitly index a playlist. `activeTab` cannot support resumable playlist work or tab switches. |
| `https://*.youtube.com/*` | Read playlist inventory and caption tracks already exposed by YouTube pages. |
| `https://huggingface.co/*`, `https://cdn-lfs.huggingface.co/*`, `https://cdn-lfs-us-1.huggingface.co/*`, `https://*.hf.co/*` | Download model weights after consent. Hugging Face serves the weight files themselves from its `cdn-lfs` hosts. |

There is no `<all_urls>`, no `scripting`, no `webRequest`, no `cookies`, and no host permission
beyond the YouTube and Hugging Face entries above. `src/build/artifact.test.ts` fails the build if that changes.

## Caption access is an unofficial integration

YouTube publishes no caption API for extensions. RecallTube reads the caption-track list the page
itself exposes and fetches those tracks from YouTube's own timed-text endpoint, using your existing
session. This is the same data the page has. It can break whenever YouTube changes its page.

RecallTube does **not** attempt to bypass authorization, access controls or Proof-of-Origin
protections, does not reconstruct captions the session is not entitled to, and does not download
video or audio streams.

In practice YouTube now frequently answers the timed-text endpoint with an empty body unless the
request carries proof-of-origin context that only its own player attaches. RecallTube does not
reconstruct that. It falls back to YouTube's own transcript control and reads the rows YouTube
renders. For a single video this happens in the current watch page. For an explicitly indexed
playlist it happens in a separate extension-owned worker, which is briefly foregrounded when
rendering is required and then closed. No extra transcript service is contacted.

## Ask mode limitations

- Ask answers only from passages retrieved from the current video or indexed playlist. It has no
  access to the wider internet and is instructed not to use general knowledge.
- When the browser provides an on-device language model **and you enable it**, Ask can write a short
  prose answer. That model runs locally; nothing is sent anywhere. There is no cloud fallback.
- Otherwise Ask returns the strongest transcript passages verbatim, with timestamps.
- Every answer is checked against the evidence supplied. An answer that cites something RecallTube
  did not provide is discarded and reported as insufficient evidence.
- **Transcript text is untrusted.** A video's captions can contain text designed to manipulate a
  language model. RecallTube fences evidence, instructs the model to treat it as quoted content,
  and validates citations — but you should treat an Ask answer as a pointer to the cited passages,
  which are always displayed beneath it, not as an authority.

## Reporting a privacy problem

See [SECURITY.md](SECURITY.md). Please report privately.
