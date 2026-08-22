import type { TranscriptCue } from "../types/transcript";

/** Bumped whenever parsing output changes, so transcript identities and caches invalidate. */
export const PARSER_VERSION = 2;

/** Guards against a hostile or pathological caption payload. */
export const LIMITS = {
  maxCues: 200_000,
  maxCueCharacters: 4_000,
  maxTotalCharacters: 4_000_000,
} as const;

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * Decodes HTML entities without going through the DOM, so the same code runs in a worker, in the
 * content script and in tests.
 *
 * YouTube's timed-text XML double-escapes caption text (`&amp;#39;` for an apostrophe), so a
 * single decode leaves a literal `&#39;` in the transcript, which normalization then mangles into
 * a bare `39` — searching for "don't" fails. Two passes handle the
 * double escaping; the loop is bounded so a crafted `&amp;amp;amp;…` chain cannot spin.
 */
export function decodeEntities(value: string, passes = 2): string {
  let result = value;
  for (let pass = 0; pass < passes; pass += 1) {
    const next = result.replace(/&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (match, body: string) => {
      if (body[0] === "#") {
        const hex = body[1] === "x" || body[1] === "X";
        const code = Number.parseInt(hex ? body.slice(2) : body.slice(1), hex ? 16 : 10);
        return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
      }
      return NAMED_ENTITIES[body.toLowerCase()] ?? match;
    });
    if (next === result) break;
    result = next;
  }
  return result;
}

function cleanText(value: string): string {
  return decodeEntities(value).replace(/\s+/gu, " ").trim().slice(0, LIMITS.maxCueCharacters);
}

interface Json3Segment {
  utf8?: string;
  tOffsetMs?: number;
}

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Json3Segment[];
  /** Present on the "append to previous" events emitted by rolling ASR tracks. */
  aAppend?: number;
}

/**
 * Parses YouTube's JSON3 timed-text format.
 *
 * Auto-generated tracks emit `aAppend` continuation events and newline-only segments as part of
 * their rolling presentation; both are dropped here so they never become cues.
 */
export function parseJson3(payload: unknown): TranscriptCue[] {
  const events = (payload as { events?: Json3Event[] } | null | undefined)?.events;
  if (!Array.isArray(events)) return [];

  const cues: TranscriptCue[] = [];
  let totalCharacters = 0;

  for (const event of events) {
    if (cues.length >= LIMITS.maxCues || totalCharacters >= LIMITS.maxTotalCharacters) break;
    if (!event || typeof event !== "object") continue;
    if (event.aAppend === 1) continue;

    const startMs = Number(event.tStartMs);
    if (!Number.isFinite(startMs) || startMs < 0) continue;

    const text = Array.isArray(event.segs)
      ? cleanText(event.segs.map((segment) => segment?.utf8 ?? "").join(""))
      : "";
    if (!text) continue;

    const durationMs = Number(event.dDurationMs);
    const start = startMs / 1000;
    const duration = Number.isFinite(durationMs) && durationMs > 0 ? durationMs / 1000 : 2;
    cues.push({ start, end: start + duration, text });
    totalCharacters += text.length;
  }

  return cues;
}

/**
 * Parses YouTube's timed-text XML, in both shapes it serves.
 *
 * Legacy (`fmt` unset):    <transcript><text start="1.5" dur="2">…</text></transcript>   seconds
 * Current (`fmt=srv3`/3):  <timedtext><body><p t="1500" d="2000">…</p></body></timedtext>  milliseconds
 *
 * The `<p>` shape was previously unsupported, so any track served in it parsed to zero cues and was
 * reported as a parse error. Regex rather than `DOMParser` so the same code path works in a worker,
 * in Node tests and in the content script, and so a malformed document degrades to "no cues"
 * instead of throwing.
 */
export function parseTimedTextXml(xml: string): TranscriptCue[] {
  const legacy = parseElements(xml, /<text\b([^>]*)>([\s\S]*?)<\/text>/g, "start", "dur", 1);
  if (legacy.length) return legacy;
  // `t`/`d` are milliseconds. Self-closing <p .../> markers carry no text and are skipped.
  return parseElements(xml, /<p\b([^>]*)>([\s\S]*?)<\/p>/g, "t", "d", 1000);
}

function parseElements(
  xml: string,
  pattern: RegExp,
  startAttribute: string,
  durationAttribute: string,
  divisor: number
): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  let totalCharacters = 0;

  for (const match of xml.matchAll(pattern)) {
    if (cues.length >= LIMITS.maxCues || totalCharacters >= LIMITS.maxTotalCharacters) break;
    const attributes = match[1] ?? "";
    const start = Number(new RegExp(`\\b${startAttribute}="([^"]*)"`).exec(attributes)?.[1]);
    if (!Number.isFinite(start) || start < 0) continue;
    const duration = Number(new RegExp(`\\b${durationAttribute}="([^"]*)"`).exec(attributes)?.[1]);
    // Strip nested markup (both shapes wrap words in <s> elements) before decoding entities.
    const text = cleanText((match[2] ?? "").replace(/<[^>]*>/g, ""));
    if (!text) continue;
    const seconds = start / divisor;
    const length = Number.isFinite(duration) && duration > 0 ? duration / divisor : 2;
    cues.push({ start: seconds, end: seconds + length, text });
    totalCharacters += text.length;
  }

  return cues;
}

/**
 * A structural fingerprint of a caption response, for diagnostics.
 *
 * Deliberately describes only *shape*, never content: a diagnostics report a user pastes into an
 * issue must not contain what was said in the video.
 */
export function describePayload(body: string): string {
  if (!body) return "empty";
  const head = body.slice(0, 400);
  if (/^\s*\{/.test(head)) {
    try {
      const events = (JSON.parse(body) as { events?: unknown[] } | null)?.events;
      return Array.isArray(events) ? `json:${events.length} events` : "json:no events array";
    } catch {
      return "json:unparseable";
    }
  }
  if (/<timedtext/i.test(head)) return `xml:timedtext (${(body.match(/<p\b/g) ?? []).length} <p>)`;
  if (/<transcript/i.test(head)) return `xml:transcript (${(body.match(/<text\b/g) ?? []).length} <text>)`;
  if (/^\s*</.test(head)) return "xml:unrecognised root";
  return "unrecognised";
}

/** Length of the longest suffix of `previous` that is also a prefix of `next`. */
function overlapWords(previous: string[], next: string[]): number {
  for (let size = Math.min(previous.length, next.length); size > 0; size -= 1) {
    let same = true;
    for (let offset = 0; offset < size; offset += 1) {
      if (previous[previous.length - size + offset]!.toLowerCase() !== next[offset]!.toLowerCase()) {
        same = false;
        break;
      }
    }
    if (same) return size;
  }
  return 0;
}

/**
 * Collapses YouTube's rolling auto-caption windows.
 *
 * ASR tracks restate the tail of the previous cue in the next one:
 *
 *   "we started using" / "we started using machine" / "machine learning today"
 *
 * Keeping all three duplicates text in the flattened index, so boundary-spanning phrase search
 * matches nonsense like "using we started using", exact search returns near-identical hits, and
 * every chunk is embedded over repeated content. We strip the
 * repeated prefix and drop cues fully contained in their predecessor.
 */
export function mergeRollingCaptions(cues: TranscriptCue[]): TranscriptCue[] {
  const merged: TranscriptCue[] = [];

  for (const cue of cues) {
    const previous = merged.at(-1);
    if (!previous) {
      merged.push({ ...cue });
      continue;
    }

    const previousWords = previous.text.split(" ").filter(Boolean);
    const nextWords = cue.text.split(" ").filter(Boolean);
    const overlap = overlapWords(previousWords, nextWords);

    if (overlap > 0 && overlap === nextWords.length) {
      previous.end = Math.max(previous.end, cue.end);
      continue;
    }

    if (overlap > 0) {
      const remainder = nextWords.slice(overlap).join(" ");
      merged.push({ start: Math.max(cue.start, previous.start), end: cue.end, text: remainder });
      continue;
    }

    merged.push({ ...cue });
  }

  return merged;
}

/**
 * Orders, de-duplicates and repairs cue timing.
 *
 * Beyond dropping malformed rows this clamps each cue's end to the next cue's start: caption
 * durations routinely overlap, and an overlapping cue makes "which cue is playing at time t"
 * ambiguous for both seeking and timestamp refinement.
 */
export function coalesceCues(cues: TranscriptCue[]): TranscriptCue[] {
  const valid = cues
    .filter(
      (cue) =>
        !!cue &&
        typeof cue.text === "string" &&
        Number.isFinite(cue.start) &&
        Number.isFinite(cue.end) &&
        cue.start >= 0 &&
        cue.end >= cue.start &&
        cue.text.trim().length > 0
    )
    .map((cue) => ({ start: cue.start, end: cue.end, text: cue.text.trim() }))
    .sort((left, right) => left.start - right.start || left.end - right.end);

  const deduplicated: TranscriptCue[] = [];
  for (const cue of valid) {
    const previous = deduplicated.at(-1);
    if (previous && previous.start === cue.start && previous.text === cue.text) {
      previous.end = Math.max(previous.end, cue.end);
      continue;
    }
    deduplicated.push(cue);
  }

  const rolled = mergeRollingCaptions(deduplicated);

  for (let index = 0; index < rolled.length - 1; index += 1) {
    const current = rolled[index]!;
    const next = rolled[index + 1]!;
    if (current.end > next.start) current.end = Math.max(current.start, next.start);
  }

  const last = rolled.at(-1);
  if (last && last.end <= last.start) last.end = last.start + 2;

  return rolled;
}
