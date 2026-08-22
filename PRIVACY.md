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
| Caption tracks for the video you are watching | `https://www.youtube.com/api/timedtext` | When you open a YouTube video with the panel open |
| Embedding model weights and tokenizer (~118 MB) | `huggingface.co`, served via `*.hf.co` | **Only after you explicitly enable meaning search**, once |

Caption requests are made with your existing YouTube session so that captions you are already
entitled to are readable. RecallTube does not bypass any access control and does not request
captions for videos the page has not offered.

The model download is a plain file fetch. It reveals your IP address and User-Agent to Hugging
Face, exactly as visiting their site would. It does **not** include your query, the video, or any
transcript. Nothing is sent to Hugging Face at search time — inference runs entirely on your
device.

**Exact search never triggers any model download.** RecallTube is fully usable without ever
enabling AI.

### Hosts the extension may contact

`www.youtube.com`, `youtube.com`, `huggingface.co`, `*.hf.co`. That is the complete list, and it is
enforced at build time and asserted in tests.

## What is stored locally

In **IndexedDB** (database `recalltube`):

- **Transcripts** — cues, timings, video id and title, caption track and language. Capped at 200
  transcripts, oldest evicted first.
- **Embeddings** — one `Float32Array` per indexed transcript plus the chunk text it was computed
  from. Capped at 40 records, oldest evicted first.

In **CacheStorage**: the downloaded model weights, cached by `transformers.js`.

In **extension storage**: two booleans — whether you enabled meaning search, and whether you allowed
Ask to use the browser's built-in model.

**Queries are never stored.**

## Deleting your data

Open the panel and click the gear icon. You can:

- **Clear this video** — its transcripts and embeddings.
- **Clear all transcripts**.
- **Clear embeddings**.
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
| `tabs` | Identifies which tab holds the YouTube video and sends it seek/refresh messages. `activeTab` is not sufficient: the panel must follow tab switches and SPA navigation without a user gesture per video. |
| `https://*.youtube.com/*` | Read caption tracks for the video you are watching. |
| `https://huggingface.co/*`, `https://*.hf.co/*` | Download model weights after consent. |

There is no `<all_urls>`, no `scripting`, no `webRequest`, no `cookies`, and no host permission
beyond the four above. `src/build/artifact.test.ts` fails the build if that changes.

## Caption access is an unofficial integration

YouTube publishes no caption API for extensions. RecallTube reads the caption-track list the page
itself exposes and fetches those tracks from YouTube's own timed-text endpoint, using your existing
session. This is the same data the page has. It can break whenever YouTube changes its page.

RecallTube does **not** attempt to bypass authorization, access controls or Proof-of-Origin
protections, does not reconstruct captions the session is not entitled to, and does not download
video or audio streams.

In practice YouTube now frequently answers the timed-text endpoint with an empty body unless the
request carries proof-of-origin context that only its own player attaches. RecallTube does not
reconstruct that. Instead it offers — on an explicit click, never silently — to open YouTube's own
transcript panel in the page you already have open, and reads the caption rows YouTube itself
renders there. No extra network request is made for those rows.

## Ask mode limitations

- Ask answers only from passages retrieved from the current video's transcript. It has no access to
  the wider internet and is instructed not to use general knowledge.
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
