import type { CaptionTrackIdentity, TranscriptCue } from "../types/transcript";
import { NORMALIZER_VERSION } from "./normalize";
import { PARSER_VERSION } from "./parsers";

/**
 * Content-addressed identity for an acquired transcript.
 *
 * The old cache keyed embeddings on `${MODEL_ID}:${videoId}` and validated them with a "signature"
 * of chunk count plus two text lengths. Two entirely different transcripts produced the identical
 * signature `1:38:38:20`, so switching a video's caption language silently answered Arabic queries
 * with English vectors.
 *
 * Identity therefore covers everything that can change the meaning of the stored bytes: the video,
 * the exact track, its language, whether it was machine-translated, the parser and normalizer
 * versions, and a hash of the cue content itself.
 */

function hex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** FNV-1a, used only where `crypto.subtle` is unavailable (non-secure contexts, some tests). */
function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `fnv${hash.toString(16).padStart(8, "0")}`;
}

export interface TranscriptIdentityInput {
  videoId: string;
  track?: CaptionTrackIdentity;
  cues: TranscriptCue[];
}

function identityPreimage(input: TranscriptIdentityInput): string {
  const track = input.track;
  return [
    `v${PARSER_VERSION}`,
    `n${NORMALIZER_VERSION}`,
    input.videoId,
    track?.id ?? "-",
    track?.languageCode ?? "-",
    track?.kind ?? "-",
    track?.translatedFrom ?? "-",
    String(input.cues.length),
    // Cue timings matter: the same words at different timestamps are a different transcript.
    input.cues.map((cue) => `${cue.start.toFixed(2)}|${cue.text}`).join("\n"),
  ].join("\u0000");
}

export async function transcriptIdentity(input: TranscriptIdentityInput): Promise<string> {
  const preimage = identityPreimage(input);
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) return fnv1a(preimage);
  try {
    const digest = await subtle.digest("SHA-256", new TextEncoder().encode(preimage));
    return hex(digest).slice(0, 32);
  } catch {
    return fnv1a(preimage);
  }
}

/** Synchronous identity for tests and benchmarks where a real digest is unnecessary. */
export function transcriptIdentitySync(input: TranscriptIdentityInput): string {
  return fnv1a(identityPreimage(input));
}
