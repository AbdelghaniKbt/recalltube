import type { CaptionTrackInfo, PageDataPayload } from "../types/messages";
import type {
  AcquisitionFailureReason,
  AdapterDiagnostic,
  CaptionTrackIdentity,
  TranscriptCue,
  TranscriptDocument,
} from "../types/transcript";
import { isAllowedCaptionUrl, parsePageDataPayload, trackIdentity } from "./bridge";
import { transcriptIdentity } from "./identity";
import { coalesceCues, describePayload, PARSER_VERSION, parseJson3, parseTimedTextXml } from "./parsers";

/**
 * Transcript acquisition.
 *
 * Built around three reliability requirements:
 *
 *   - Every attempt is cancellable. The old path could spend ~20 s in a retry loop plus two
 *     uncancellable fetches, and rapid navigation left several acquisitions racing.
 *   - Failures are typed. The old code funnelled network errors, 403s and parse failures into the
 *     DOM fallback and then reported "No captions found" — telling the user a captioned video has
 *     no captions.
 *   - Every adapter records a diagnostic, so a user can report *why* acquisition failed without
 *     us collecting anything.
 */

export interface AcquisitionContext {
  videoId: string;
  /** Language the user explicitly asked for, if any. */
  preferredLanguage?: string;
  /** Navigation generation; results from an older generation are discarded. */
  generation: number;
}

export type AcquisitionResult =
  | { ok: true; transcript: TranscriptDocument; diagnostics: AdapterDiagnostic[] }
  | { ok: false; reason: AcquisitionFailureReason; diagnostics: AdapterDiagnostic[] };

export interface TranscriptAdapter {
  id: string;
  canHandle(context: AcquisitionContext): Promise<boolean>;
  acquire(context: AcquisitionContext, signal: AbortSignal): Promise<AcquisitionResult>;
}

class Aborted extends Error {
  constructor() {
    super("Acquisition cancelled.");
    this.name = "Aborted";
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Aborted();
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Aborted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export function currentVideoId(href: string = location.href): string | undefined {
  try {
    const url = new URL(href);
    if (url.pathname === "/watch") return url.searchParams.get("v") ?? undefined;
    if (url.pathname.startsWith("/shorts/")) return url.pathname.split("/")[2] || undefined;
  } catch {
    // Fall through.
  }
  return undefined;
}

/**
 * Asks the main-world bridge for the player's caption-track list.
 *
 * The payload is validated by `parsePageDataPayload`, which also allowlists every `baseUrl` to
 * YouTube's timed-text endpoint, so a forged page response cannot steer a credentialed fetch.
 */
function requestPageData(signal: AbortSignal, timeoutMs = 3_000): Promise<PageDataPayload> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      window.clearTimeout(timeout);
      window.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
    };
    const timeout = window.setTimeout(() => {
      cleanup();
      reject(new Error("timeout"));
    }, timeoutMs);
    const onAbort = () => {
      cleanup();
      reject(new Aborted());
    };

    function onMessage(event: MessageEvent<unknown>) {
      if (event.source !== window) return;
      const data = event.data as { type?: unknown; requestId?: unknown; payload?: unknown } | null;
      if (!data || data.type !== "recalltube:page-data" || data.requestId !== requestId) return;
      const payload = parsePageDataPayload(data.payload);
      if (!payload) return; // Ignore malformed responses; a valid one may still arrive.
      cleanup();
      resolve(payload);
    }

    signal.addEventListener("abort", onAbort, { once: true });
    window.addEventListener("message", onMessage);
    window.postMessage({ type: "recalltube:request-page-data", requestId }, location.origin);
  });
}

/**
 * Chooses a caption track.
 *
 * Preference order: the language the user explicitly selected, then their browser languages, then
 * anything. Within a language, human-authored captions beat auto-generated ones, and original
 * tracks beat machine translations.
 */
export function preferredTrack(
  tracks: CaptionTrackInfo[],
  preferredLanguage?: string
): CaptionTrackInfo | undefined {
  if (!tracks.length) return undefined;
  const browserLanguages = (typeof navigator !== "undefined" ? navigator.languages : []) ?? [];
  const preferences = [preferredLanguage, ...browserLanguages]
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .map((value) => value.toLowerCase());

  const languageRank = (track: CaptionTrackInfo): number => {
    const code = track.languageCode.toLowerCase();
    for (let index = 0; index < preferences.length; index += 1) {
      const preference = preferences[index]!;
      if (preference === code) return index;
      if (preference.split("-")[0] === code.split("-")[0]) return index + 0.5;
    }
    return Number.MAX_SAFE_INTEGER;
  };

  return [...tracks].sort((left, right) => {
    const byLanguage = languageRank(left) - languageRank(right);
    if (byLanguage !== 0) return byLanguage;
    const byTranslation = Number(Boolean(left.translatedFrom)) - Number(Boolean(right.translatedFrom));
    if (byTranslation !== 0) return byTranslation;
    return Number(left.kind === "asr") - Number(right.kind === "asr");
  })[0];
}

/** 8 MB is far beyond any legitimate caption track. */
const MAX_CAPTION_BYTES = 8 * 1024 * 1024;

async function readCapped(response: Response): Promise<string> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > MAX_CAPTION_BYTES) {
    throw new Error("Caption response too large.");
  }
  const text = await response.text();
  if (text.length > MAX_CAPTION_BYTES) throw new Error("Caption response too large.");
  return text;
}

type FetchOutcome =
  | { ok: true; cues: TranscriptCue[] }
  | { ok: false; reason: AcquisitionFailureReason; detail: string };

/** Describes a response by shape only — never by content. */
function describeResponse(response: Response, body: string): string {
  return `HTTP ${response.status} ${response.headers.get("content-type") ?? "?"} ${body.length}B ${describePayload(body)}`;
}

async function fetchCaptionTrack(track: CaptionTrackInfo, signal: AbortSignal): Promise<FetchOutcome> {
  if (!isAllowedCaptionUrl(track.baseUrl)) {
    return { ok: false, reason: "unsupported", detail: "Caption URL is not a YouTube timed-text endpoint." };
  }

  const attempts: Array<{ url: string; format: "json3" | "xml" }> = [];
  try {
    const jsonUrl = new URL(track.baseUrl);
    jsonUrl.searchParams.set("fmt", "json3");
    attempts.push({ url: jsonUrl.toString(), format: "json3" });
  } catch {
    return { ok: false, reason: "unsupported", detail: "Caption URL could not be parsed." };
  }
  attempts.push({ url: track.baseUrl, format: "xml" });

  let lastDetail = "No caption format produced cues.";
  let sawEmptyBody = false;

  for (const attempt of attempts) {
    throwIfAborted(signal);
    let response: Response;
    try {
      response = await fetch(attempt.url, { credentials: "include", signal });
    } catch (error) {
      if (signal.aborted) throw new Aborted();
      lastDetail = error instanceof Error ? error.message : "Network request failed.";
      continue;
    }

    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: "permission-denied", detail: `Caption request refused (${response.status}).` };
    }
    if (!response.ok) {
      lastDetail = `Caption request failed (${response.status}).`;
      continue;
    }

    let body: string;
    try {
      body = await readCapped(response);
    } catch (error) {
      lastDetail = error instanceof Error ? error.message : "Caption body could not be read.";
      continue;
    }

    // YouTube answers 200 with a zero-length body when it declines to serve timed text to a
    // request lacking the player's proof-of-origin context. That is not a parse failure, and
    // reporting it as one sent users looking for a bug in their captions.
    if (!body.trim()) {
      sawEmptyBody = true;
      lastDetail = describeResponse(response, body);
      continue;
    }

    // YouTube sometimes ignores `fmt=json3` and returns XML, so try both parsers on both bodies.
    let cues: TranscriptCue[] = [];
    if (attempt.format === "json3") {
      try {
        cues = parseJson3(JSON.parse(body) as unknown);
      } catch {
        cues = parseTimedTextXml(body);
      }
    } else {
      cues = parseTimedTextXml(body);
      if (!cues.length) {
        try {
          cues = parseJson3(JSON.parse(body) as unknown);
        } catch {
          // Leave `cues` empty; the DOM adapter may still succeed.
        }
      }
    }

    const coalesced = coalesceCues(cues);
    if (coalesced.length) return { ok: true, cues: coalesced };
    lastDetail = `Parsed to zero cues — ${describeResponse(response, body)}`;
  }

  if (sawEmptyBody) {
    return {
      ok: false,
      reason: "captions-withheld",
      detail: `YouTube returned an empty caption body — ${lastDetail}`,
    };
  }
  return { ok: false, reason: "parse-error", detail: lastDetail };
}

/**
 * Selectors for YouTube's rendered transcript panel.
 *
 * Kept together and deliberately broad: this is the only caption source left when the timed-text
 * endpoint withholds a body, and YouTube renames these elements without notice.
 */
const TRANSCRIPT_ROW_SELECTOR = [
  // Modern view-model UI.
  "transcript-segment-view-model",
  ".ytwTranscriptSegmentViewModelHost",
  // Legacy Polymer UI.
  "ytd-transcript-segment-renderer",
  "yt-transcript-segment-renderer",
  "[class*='segment-list'] [role='button']",
].join(", ");

const TRANSCRIPT_PANEL_SELECTOR = [
  "ytd-engagement-panel-section-list-renderer[target-id='PAmodern_transcript_view']",
  "ytd-engagement-panel-section-list-renderer[target-id='engagement-panel-searchable-transcript']",
  "[target-id*='transcript']",
  "ytd-transcript-search-panel-renderer",
  "ytd-transcript-renderer",
  "ytd-transcript-segment-list-renderer",
].join(", ");

const TIMESTAMP_SELECTOR = [
  ".ytwTranscriptSegmentViewModelTimestamp",
  ".segment-timestamp",
  "[class*='Timestamp']",
  "[class*='timestamp']",
].join(", ");

const SEGMENT_TEXT_SELECTOR = [
  ".ytAttributedStringHost",
  "[role='text']",
  ".segment-text",
  "yt-formatted-string.segment-text",
  "[class*='segment-text']",
].join(", ");

/**
 * `M:SS`, `MM:SS` or `H:MM:SS` followed by the cue text.
 *
 * The separator is optional, because a row built from sibling elements —
 * `<span>0:04</span><span>text</span>` — concatenates to `0:04text` with nothing between them.
 * Without a separator the next character must not be a digit or a colon, otherwise backtracking
 * splits a bare `1:02:30` into the timestamp `1:02` plus the "text" `:30`, and a lone timestamp
 * element is read as a cue.
 */
const ROW_TEXT = /^\s*(\d{1,3}:\d{2}(?::\d{2})?)(?:\s+|(?=[^\s:\d]))([\s\S]*\S)$/;

/** Bounds the structural scan so a pathological page cannot stall the content script. */
const MAX_SCANNED_NODES = 20_000;

/**
 * Queries `selector`, descending into open shadow roots.
 *
 * YouTube's transcript rows are Polymer components whose internals live in shadow DOM, and the
 * element names are created client-side — the served HTML contains none of them, so they cannot be
 * verified ahead of time and have been renamed before.
 */
function deepQueryAll(root: ParentNode, selector: string): HTMLElement[] {
  const found = new Set<HTMLElement>();
  const roots: ParentNode[] = [root];
  const visitedRoots = new Set<ParentNode>();
  let scanned = 0;

  while (roots.length && scanned < MAX_SCANNED_NODES) {
    const current = roots.shift()!;
    if (visitedRoots.has(current)) continue;
    visitedRoots.add(current);
    // `querySelectorAll` never includes the root itself. When callers pass a custom-element host,
    // explicitly enqueue its shadow root or the host's internals remain an accidental blind spot.
    if (current.nodeType === 1 && (current as Element).shadowRoot) {
      roots.push((current as Element).shadowRoot!);
    }
    for (const element of current.querySelectorAll<HTMLElement>(selector)) found.add(element);
    for (const element of current.querySelectorAll<HTMLElement>("*")) {
      scanned += 1;
      if (scanned >= MAX_SCANNED_NODES) break;
      if (element.shadowRoot) roots.push(element.shadowRoot);
    }
  }
  return [...found];
}

/** Text from the rendered/composed subtree, including open shadow roots. */
function composedText(node: Node): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node.nodeType !== 1 && node.nodeType !== 11) return "";

  const element = node.nodeType === 1 ? (node as Element) : undefined;
  if (element?.shadowRoot) return composedText(element.shadowRoot);

  // A slot's assigned nodes are the rendered content. Falling back to its children keeps this
  // useful in JSDOM and for slots that have no assignment.
  if (element?.tagName.toLowerCase() === "slot") {
    const slot = element as HTMLSlotElement;
    const assigned = typeof slot.assignedNodes === "function" ? slot.assignedNodes({ flatten: true }) : [];
    const children = assigned.length ? assigned : Array.from(slot.childNodes);
    return children.map(composedText).join(" ");
  }

  return Array.from(node.childNodes).map(composedText).join(" ");
}

function readableText(element: HTMLElement): string {
  return composedText(element).replace(/\s+/gu, " ").trim();
}

function transcriptPanels(): HTMLElement[] {
  return deepQueryAll(document, TRANSCRIPT_PANEL_SELECTOR);
}

function parseTimestampLike(value: string): number | undefined {
  const clock = value.match(/(?:^|\s)(\d{1,3}:\d{2}(?::\d{2})?)(?=\s|$)/u)?.[1];
  if (clock) return parseTimestamp(clock);

  // Current YouTube accessibility labels use English unit names even when the visible clock is
  // inside a component. This is a fallback only; the locale-independent clock is preferred.
  const hours = Number(value.match(/(\d+)\s*hours?/iu)?.[1] ?? 0);
  const minutes = Number(value.match(/(\d+)\s*minutes?/iu)?.[1] ?? 0);
  const seconds = Number(value.match(/(\d+)\s*seconds?/iu)?.[1] ?? 0);
  if (hours || minutes || seconds || /\b0\s*seconds?\b/iu.test(value)) {
    return hours * 3600 + minutes * 60 + seconds;
  }
  return undefined;
}

function timestampFromElement(element: HTMLElement): number | undefined {
  return (
    parseTimestampLike(readableText(element)) ??
    parseTimestampLike(element.getAttribute("aria-label") ?? "") ??
    parseTimestampLike(element.getAttribute("title") ?? "")
  );
}

function normalizeRenderedCues(cues: TranscriptCue[], minimum: number): TranscriptCue[] {
  const normalized: TranscriptCue[] = [];
  const seen = new Set<string>();

  for (const cue of cues) {
    const text = cue.text.replace(/\s+/gu, " ").trim();
    if (!text || text.length > 2_000 || !Number.isFinite(cue.start) || cue.start < 0) continue;
    const key = `${cue.start}\u0000${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ start: cue.start, end: cue.start, text });
  }

  if (normalized.length < minimum) return [];
  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index]!.start < normalized[index - 1]!.start) return [];
  }
  return normalized;
}

function textFromKnownRow(row: HTMLElement): string {
  const timestampElements = new Set(deepQueryAll(row, TIMESTAMP_SELECTOR));
  const candidates = deepQueryAll(row, SEGMENT_TEXT_SELECTOR)
    .filter((element) => !timestampElements.has(element))
    .map((element) => readableText(element))
    .map((text) => {
      const match = ROW_TEXT.exec(text);
      return match ? match[2]!.replace(/\s+/gu, " ").trim() : text;
    })
    .filter(Boolean);

  // The most specific text node is normally shortest; wrappers often repeat the timestamp and
  // the entire row. Prefer a candidate that is not just a clock, then fall back to row parsing.
  candidates.sort((left, right) => left.length - right.length);
  return candidates.find((text) => parseTimestampLike(text) === undefined) ?? rowTextFromText(row);
}

function readKnownRows(scope: ParentNode): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  for (const row of deepQueryAll(scope, TRANSCRIPT_ROW_SELECTOR)) {
    const timeElements = deepQueryAll(row, TIMESTAMP_SELECTOR);
    const start = timeElements.map(timestampFromElement).find((value) => value !== undefined) ?? rowStartFromText(row);
    const text = textFromKnownRow(row);
    if (start === undefined || !text) continue;
    cues.push({ start, end: start, text });
  }
  return normalizeRenderedCues(cues, 1);
}

/**
 * Reads the rendered transcript rows.
 *
 * Tries YouTube's known markup first, then falls back to a structural scan: any innermost element
 * whose text begins with a timestamp is a row, whatever it happens to be called. That keeps the
 * fallback working across component renames, which matters because this is the only caption source
 * left when the timed-text endpoint withholds a body.
 */
function readRenderedRows(): { cues: TranscriptCue[]; strategy: string } {
  // Every transcript-ish panel is tried, because `querySelector` returns whichever comes first in
  // document order and that is regularly the empty hidden one.
  //
  // The document is deliberately NOT a fallback scope. YouTube stamps every sidebar recommendation
  // with a duration badge, so "12:27" followed by a video title matches a timestamped row exactly;
  // scanning the whole page read eight recommended videos as an eight-cue "transcript". Failing
  // honestly is far better than searching the sidebar.
  const scopes: ParentNode[] = transcriptPanels();

  let best: { cues: TranscriptCue[]; strategy: string } = { cues: [], strategy: "none" };

  for (const scope of scopes) {
    const known = deepQueryAll(scope, TRANSCRIPT_ROW_SELECTOR);
    const fromKnown = readKnownRows(scope);
    // Rows matched through YouTube's own component names need no minimum: if
    // `transcript-segment-view-model` matched, that *is* a transcript, however short.
    if (fromKnown.length > best.cues.length) {
      best = { cues: fromKnown, strategy: `known(${fromKnown.length}/${known.length})` };
    }

    // The structural scan keeps its minimum, because a couple of timestamp-shaped elements are
    // more likely to be page chrome than a transcript.
    const structural = structuralRows(scope);
    if (structural.length > best.cues.length) {
      best = { cues: structural, strategy: `structural(${structural.length})` };
    }
  }

  // A component rename can leave the panel wrapper unknown while the row family remains specific
  // and trustworthy. Unlike a whole-document structural scan, this cannot match video cards.
  if (!scopes.length) {
    const globalKnown = readKnownRows(document);
    if (globalKnown.length > best.cues.length) {
      best = { cues: globalKnown, strategy: `known-global(${globalKnown.length})` };
    }
  }

  return best;
}

function rowStartFromText(row: HTMLElement): number | undefined {
  const match = ROW_TEXT.exec(readableText(row));
  return match ? parseTimestamp(match[1]!) : undefined;
}

function rowTextFromText(row: HTMLElement): string {
  const match = ROW_TEXT.exec(readableText(row));
  return match ? match[2]!.replace(/\s+/gu, " ").trim() : "";
}

/** Longest plausible caption line. Sidebar cards and descriptions run far longer. */
const MAX_STRUCTURAL_ROW_CHARACTERS = 300;

/** Any innermost element whose text begins with a timestamp is a row, whatever it is called. */
function structuralRows(scope: ParentNode): TranscriptCue[] {
  const candidates: Array<{ element: HTMLElement; start: number; text: string }> = [];
  for (const element of deepQueryAll(scope, "*")) {
    const match = ROW_TEXT.exec(readableText(element));
    if (!match) continue;
    const start = parseTimestamp(match[1]!);
    if (start === undefined) continue;
    const text = match[2]!.replace(/\s+/gu, " ").trim();
    if (text.length > MAX_STRUCTURAL_ROW_CHARACTERS) continue;
    candidates.push({ element, start, text });
  }

  const innermost = candidates.filter(
    (candidate) => !candidates.some((other) => other !== candidate && candidate.element.contains(other.element))
  );
  if (innermost.length < 3) return [];

  // A transcript is rendered in playback order. A grid of unrelated cards carrying duration badges
  // is not, so ordering is a cheap and reliable way to tell them apart.
  for (let index = 1; index < innermost.length; index += 1) {
    if (innermost[index]!.start < innermost[index - 1]!.start) return [];
  }

  return normalizeRenderedCues(
    innermost.map(({ start, text }) => ({ start, end: start, text })),
    3
  );
}

/**
 * A privacy-safe structural description of what the transcript panels actually contain.
 *
 * Reports element names, class-name fragments and counts — never caption text. After several
 * rounds of guessing at selectors against markup that cannot be inspected from the served HTML,
 * this replaces guessing with evidence a user can paste into an issue.
 */
export function describeTranscriptDom(): string {
  const panels = transcriptPanels();
  if (!panels.length) return "no transcript panel element in the DOM";

  return panels
    .map((panel, index) => {
      const descendants = deepQueryAll(panel, "*");
      const tags = new Map<string, number>();
      const classes = new Map<string, number>();
      let shadowRoots = 0;
      let timestamped = 0;

      for (const element of descendants) {
        const tag = element.tagName.toLowerCase();
        tags.set(tag, (tags.get(tag) ?? 0) + 1);
        if (element.shadowRoot) shadowRoots += 1;
        if (ROW_TEXT.test(readableText(element))) timestamped += 1;
        for (const name of Array.from(element.classList)) {
          if (/segment|transcript|caption|timestamp/i.test(name)) {
            classes.set(name, (classes.get(name) ?? 0) + 1);
          }
        }
      }

      const top = (map: Map<string, number>, count: number) =>
        [...map.entries()]
          .sort((left, right) => right[1] - left[1])
          .slice(0, count)
          .map(([name, total]) => `${name}×${total}`)
          .join(" ") || "none";

      return [
        `panel[${index}] target-id=${panel.getAttribute("target-id") ?? panel.tagName.toLowerCase()}`,
        `  visibility=${panel.getAttribute("visibility") ?? "?"} descendants=${descendants.length} shadowRoots=${shadowRoots} timestampedElements=${timestamped}`,
        `  tags: ${top(tags, 12)}`,
        `  classes: ${top(classes, 12)}`,
      ].join("\n");
    })
    .join("\n");
}

/** Exposed for tests: the reader must be provable against markup we cannot inspect in advance. */
export const readRenderedRowsForTest = readRenderedRows;

/**
 * Whether YouTube's own transcript panel is open, closed-but-openable, or absent.
 *
 * When the timed-text endpoint withholds captions, this panel is the legitimate remaining source:
 * the rows are already rendered in the page for the user's own session.
 */
export function transcriptPanelState(): "open" | "available" | "unavailable" {
  if (readRenderedRows().cues.length) return "open";
  // The engagement panel is rendered into the DOM up front with
  // visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN", so it is a reliable availability signal that
  // does not depend on the description being expanded. Checking only for the button reported
  // "unavailable" for videos that plainly do have a transcript, because Polymer had not yet
  // rendered the description's transcript section.
  if (transcriptPanels().length) return "available";
  return findTranscriptButton() ? "available" : "unavailable";
}

/**
 * YouTube's "Show transcript" label, across the locales we can reasonably enumerate.
 *
 * Matching on roots rather than whole phrases: "transcri" covers English, French, Spanish,
 * Portuguese and Italian at once. A miss here is not fatal — the caller also finds the button
 * structurally — but the user's UI language is not something we get to assume.
 */
const TRANSCRIPT_LABEL =
  /transcri|transkri|расшифров|文字起こし|字幕|轉錄|转录|스크립트|النص|النسخة النصية|ट्रांसक्रिप्ट/i;

/** Regions of the watch page that can legitimately hold the control. */
const BUTTON_SCOPES = [
  "ytd-video-description-transcript-section-renderer",
  "ytd-watch-metadata",
  "#below",
  "#primary",
];

/** Matches YouTube's "Show transcript" control structurally first, then by label. */
function findTranscriptButtons(): HTMLElement[] {
  const found = new Set<HTMLElement>();
  const section = deepQueryAll(document, "ytd-video-description-transcript-section-renderer")[0];
  if (section) {
    for (const button of deepQueryAll(section, "button, [role='button'], yt-button-shape, ytd-button-renderer")) {
      found.add(button);
    }
  }

  for (const scope of BUTTON_SCOPES) {
    for (const root of deepQueryAll(document, scope)) {
      for (const button of deepQueryAll(root, "button, ytd-button-renderer, yt-button-shape, [role='button']")) {
        const target = `${button.getAttribute("aria-controls") ?? ""} ${button.getAttribute("target-id") ?? ""}`;
        if (/transcript/i.test(target)) found.add(button);
        const label = `${button.getAttribute("aria-label") ?? ""} ${readableText(button)}`;
        if (TRANSCRIPT_LABEL.test(label)) found.add(button);
      }
    }
  }

  // YouTube nests a native <button> inside yt-button-shape and ytd-button-renderer. Clicking the
  // outer renderer is a no-op in current Chromium, so put genuinely interactive elements first.
  return [...found].sort((left, right) => {
    const score = (element: HTMLElement) => {
      const tag = element.tagName.toLowerCase();
      const target = `${element.getAttribute("aria-controls") ?? ""} ${element.getAttribute("target-id") ?? ""}`;
      const label = `${element.getAttribute("aria-label") ?? ""} ${readableText(element)}`;
      return (
        (tag === "button" ? 100 : 0) +
        (element.getAttribute("role") === "button" ? 60 : 0) +
        (/transcript/i.test(target) ? 40 : 0) +
        (TRANSCRIPT_LABEL.test(label) ? 20 : 0)
      );
    };
    return score(right) - score(left);
  });
}

function findTranscriptButton(): HTMLElement | undefined {
  return findTranscriptButtons()[0];
}

/** YouTube's engagement-panel visibility value is more reliable than layout in background tabs. */
function isExpandedTranscriptPanel(panel: HTMLElement): boolean {
  if (panel.hidden || panel.getAttribute("aria-hidden") === "true") return false;
  const style = panel.ownerDocument.defaultView?.getComputedStyle(panel);
  if (style?.display === "none" || style?.visibility === "hidden") return false;
  const visibility = panel.getAttribute("visibility") ?? "";
  if (/HIDDEN|COLLAPSED/iu.test(visibility)) return false;
  if (/EXPANDED|VISIBLE/iu.test(visibility)) return true;
  return readRenderedRows().cues.length > 0;
}

const CLOSE_LABEL =
  /close|dismiss|fermer|cerrar|fechar|schlie|chiudi|sluit|закры|閉じる|关闭|關閉|닫기|إغلاق|बंद/iu;

function findTranscriptCloseButtons(): HTMLElement[] {
  const found = new Set<HTMLElement>();
  for (const panel of transcriptPanels().filter(isExpandedTranscriptPanel)) {
    for (const candidate of deepQueryAll(
      panel,
      "#dismiss, #close-button, button[aria-label], [role='button'][aria-label], yt-icon-button[aria-label]"
    )) {
      const structural = `${candidate.id} ${candidate.className}`;
      const label = `${candidate.getAttribute("aria-label") ?? ""} ${candidate.getAttribute("title") ?? ""}`;
      if (/close|dismiss/iu.test(structural) || CLOSE_LABEL.test(label)) found.add(candidate);
    }
  }

  return [...found].sort((left, right) => {
    const score = (element: HTMLElement) =>
      (element.tagName.toLowerCase() === "button" ? 100 : 0) +
      (/close|dismiss/iu.test(`${element.id} ${element.className}`) ? 50 : 0) +
      (CLOSE_LABEL.test(element.getAttribute("aria-label") ?? "") ? 25 : 0);
    return score(right) - score(left);
  });
}

async function closeTranscriptPanelOpenedByRecallTube(): Promise<boolean> {
  const panels = transcriptPanels().filter(isExpandedTranscriptPanel);
  if (!panels.length) return true;

  for (const button of findTranscriptCloseButtons().slice(0, 4)) {
    button.click();
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await new Promise((resolve) => window.setTimeout(resolve, 100));
      if (panels.every((panel) => !panel.isConnected || !isExpandedTranscriptPanel(panel))) return true;
    }
  }
  return panels.every((panel) => !panel.isConnected || !isExpandedTranscriptPanel(panel));
}

async function settledRenderedRows(
  signal: AbortSignal,
  maximumAttempts: number
): Promise<{ cues: TranscriptCue[]; strategy: string }> {
  let read = readRenderedRows();
  let previousFingerprint = "";
  let stableReads = 0;

  for (let attempt = 0; attempt < maximumAttempts; attempt += 1) {
    await delay(150, signal);
    const next = readRenderedRows();
    if (next.cues.length > read.cues.length) read = next;
    const fingerprint = `${next.strategy}:${next.cues.length}:${next.cues.at(-1)?.start ?? -1}`;
    stableReads = fingerprint === previousFingerprint ? stableReads + 1 : 0;
    previousFingerprint = fingerprint;
    if (read.cues.length && stableReads >= 3) break;
  }
  return read;
}

async function transcriptFromRenderedCues(
  context: AcquisitionContext,
  raw: TranscriptCue[]
): Promise<TranscriptDocument> {
  const timed = raw.map((cue, index) => ({
    ...cue,
    end: raw[index + 1]?.start ?? cue.start + 4,
  }));
  const cues = coalesceCues(timed);
  return {
    transcriptId: await transcriptIdentity({ videoId: context.videoId, cues }),
    video: {
      id: context.videoId,
      title: videoTitle(),
      url: `https://www.youtube.com/watch?v=${context.videoId}`,
    },
    cues,
    source: "dom",
    fetchedAt: Date.now(),
    parserVersion: PARSER_VERSION,
  };
}

function videoTitle(pageTitle?: string): string {
  return pageTitle ?? document.title.replace(/\s+-\s+YouTube$/u, "");
}

/** Primary adapter: the player's own caption-track list plus YouTube's timed-text endpoint. */
export class PlayerTrackAdapter implements TranscriptAdapter {
  readonly id = "player-track";

  async canHandle(context: AcquisitionContext): Promise<boolean> {
    return Boolean(context.videoId);
  }

  async acquire(context: AcquisitionContext, signal: AbortSignal): Promise<AcquisitionResult> {
    const started = performance.now();
    const diagnostics: AdapterDiagnostic[] = [];
    const fail = (reason: AcquisitionFailureReason, detail: string): AcquisitionResult => {
      diagnostics.push({ adapter: this.id, outcome: "failed", detail, elapsedMs: performance.now() - started });
      return { ok: false, reason, diagnostics };
    };

    let pageData: PageDataPayload | undefined;
    // The player response can lag a frame or two behind yt-navigate-finish.
    for (let attempt = 0; attempt < 3 && !pageData?.captionTracks.length; attempt += 1) {
      throwIfAborted(signal);
      try {
        pageData = await requestPageData(signal);
      } catch (error) {
        if (error instanceof Aborted) throw error;
        pageData = undefined;
      }
      if (!pageData?.captionTracks.length && attempt < 2) await delay(250 * (attempt + 1), signal);
    }

    if (!pageData) return fail("not-ready", "The YouTube player did not answer the page bridge.");
    if (!pageData.captionTracks.length) return fail("no-captions", "The player exposed no caption tracks.");

    const track = preferredTrack(pageData.captionTracks, context.preferredLanguage);
    if (!track) return fail("track-unavailable", "No caption track matched the requested language.");

    const outcome = await fetchCaptionTrack(track, signal);
    if (!outcome.ok) return fail(outcome.reason, `[${track.languageCode}] ${outcome.detail}`);

    const identity = trackIdentity(track);
    const availableTracks: CaptionTrackIdentity[] = pageData.captionTracks.map(trackIdentity);
    const transcriptId = await transcriptIdentity({
      videoId: pageData.videoId ?? context.videoId,
      track: identity,
      cues: outcome.cues,
    });

    diagnostics.push({
      adapter: this.id,
      outcome: "ok",
      detail: `${outcome.cues.length} cues from ${identity.languageCode} (${identity.kind}).`,
      elapsedMs: performance.now() - started,
    });

    return {
      ok: true,
      diagnostics,
      transcript: {
        transcriptId,
        video: {
          id: pageData.videoId ?? context.videoId,
          title: videoTitle(pageData.title),
          url: `https://www.youtube.com/watch?v=${pageData.videoId ?? context.videoId}`,
        },
        track: identity,
        availableTracks,
        cues: outcome.cues,
        source: "player",
        fetchedAt: Date.now(),
        parserVersion: PARSER_VERSION,
      },
    };
  }
}

function parseTimestamp(value: string): number | undefined {
  const parts = value.trim().split(":").map(Number);
  if (!parts.length || parts.length > 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return undefined;
  }
  return parts.reduce((seconds, part) => seconds * 60 + part, 0);
}

/**
 * Last-resort adapter: briefly opens YouTube's native transcript UI, reads its rendered rows, and
 * restores the page afterward. It uses only captions exposed in the user's watch page.
 */
export class NativePanelTranscriptAdapter implements TranscriptAdapter {
  readonly id = "native-panel";

  async canHandle(context: AcquisitionContext): Promise<boolean> {
    // The native control can be created only after the description expands, so the absence of a
    // button during capability probing is not evidence that this adapter cannot handle the page.
    return typeof document !== "undefined" && Boolean(context.videoId);
  }

  async acquire(context: AcquisitionContext, signal: AbortSignal): Promise<AcquisitionResult> {
    const started = performance.now();
    const diagnostics: AdapterDiagnostic[] = [];
    const initiallyOpen =
      readRenderedRows().cues.length > 0 || transcriptPanels().some(isExpandedTranscriptPanel);
    let openedByRecallTube = false;
    let closed = true;
    let read = readRenderedRows();

    try {
      if (!initiallyOpen) {
        deepQueryAll(
          document,
          "ytd-text-inline-expander #expand, tp-yt-paper-button#expand, #description-inline-expander #expand"
        )[0]?.click();

        let buttons: HTMLElement[] = [];
        for (let attempt = 0; attempt < 12 && !buttons.length; attempt += 1) {
          throwIfAborted(signal);
          buttons = findTranscriptButtons();
          if (!buttons.length) await delay(200, signal);
        }

        for (const button of buttons.slice(0, 4)) {
          throwIfAborted(signal);
          // If the user opened it while we waited, their panel is not ours to close.
          if (transcriptPanels().some(isExpandedTranscriptPanel)) break;
          openedByRecallTube = true;
          button.click();
          for (let attempt = 0; attempt < 12; attempt += 1) {
            await delay(150, signal);
            read = readRenderedRows();
            if (read.cues.length || transcriptPanels().some(isExpandedTranscriptPanel)) break;
          }
          if (read.cues.length || transcriptPanels().some(isExpandedTranscriptPanel)) break;
        }
      }

      if (read.cues.length || transcriptPanels().some(isExpandedTranscriptPanel)) {
        read = await settledRenderedRows(signal, 30);
      }
    } finally {
      // Cleanup must survive cancellation, so it deliberately does not use the caller's signal.
      if (openedByRecallTube) {
        closed = await closeTranscriptPanelOpenedByRecallTube().catch(() => false);
      }
    }

    if (!read.cues.length) {
      const finalPanelState = transcriptPanelState();
      diagnostics.push({
        adapter: this.id,
        outcome: "failed",
        detail: `Native transcript capture produced no rows (panel ${finalPanelState}); cleanup ${
          closed ? "completed" : "could not find a close control"
        }.`,
        elapsedMs: performance.now() - started,
      });
      return { ok: false, reason: finalPanelState === "unavailable" ? "no-captions" : "not-ready", diagnostics };
    }

    const transcript = await transcriptFromRenderedCues(context, read.cues);
    diagnostics.push({
      adapter: this.id,
      outcome: "ok",
      detail: `${transcript.cues.length} cues captured via ${read.strategy}; panel ${
        initiallyOpen ? "was already open and was preserved" : closed ? "was restored" : "cleanup failed"
      }.`,
      elapsedMs: performance.now() - started,
    });
    return { ok: true, transcript, diagnostics };
  }
}

/**
 * Fallback adapter: caption rows already rendered in YouTube's transcript panel.
 *
 * Only usable when the user has opened that panel, so it reports `not-ready` rather than
 * `no-captions` when it finds nothing — the distinction matters for what we tell the user.
 */
export class RenderedTranscriptAdapter implements TranscriptAdapter {
  readonly id = "rendered-dom";

  async canHandle(): Promise<boolean> {
    return typeof document !== "undefined";
  }

  async acquire(context: AcquisitionContext, signal: AbortSignal): Promise<AcquisitionResult> {
    const started = performance.now();
    throwIfAborted(signal);

    // The panel populates asynchronously after it opens, so give it a moment before concluding
    // there is nothing there — but only if it looks like it is on its way.
    let read = readRenderedRows();
    if (transcriptPanels().length) {
      let previousFingerprint = "";
      let stableReads = 0;
      // Do not snapshot the first row that appears. Transcript components populate in batches,
      // especially on long videos; keep the fullest valid read until the DOM settles briefly.
      for (let attempt = 0; attempt < 12; attempt += 1) {
        await delay(150, signal);
        const next = readRenderedRows();
        if (next.cues.length > read.cues.length) read = next;
        const fingerprint = `${next.strategy}:${next.cues.length}:${next.cues.at(-1)?.start ?? -1}`;
        stableReads = fingerprint === previousFingerprint ? stableReads + 1 : 0;
        previousFingerprint = fingerprint;
        if (read.cues.length && stableReads >= 2) break;
      }
    }
    const raw = read.cues;

    const diagnostics: AdapterDiagnostic[] = [];
    if (!raw.length) {
      // Report what was actually in the DOM: "no rows" alone gave no way to tell a video without
      // a transcript from a selector that stopped matching.
      const present = [
        transcriptPanels().length ? "engagement-panel" : null,
        deepQueryAll(document, "ytd-video-description-transcript-section-renderer").length
          ? "description-section"
          : null,
        findTranscriptButton() ? "button" : null,
        deepQueryAll(document, "ytd-text-inline-expander, #description-inline-expander").length ? "expander" : null,
      ].filter(Boolean);
      diagnostics.push({
        adapter: this.id,
        outcome: "failed",
        detail: `No transcript rows rendered (panel ${transcriptPanelState()}, reader ${read.strategy}, present: ${
          present.length ? present.join("+") : "none"
        }).`,
        elapsedMs: performance.now() - started,
      });
      return { ok: false, reason: "not-ready", diagnostics };
    }

    // Rendered rows carry no duration; derive it from the next row and give the last row a
    // nominal tail rather than inventing a fixed 4 s for every cue.
    const timed = raw.map((cue, index) => ({
      ...cue,
      end: raw[index + 1]?.start ?? cue.start + 4,
    }));
    const cues = coalesceCues(timed);

    const transcriptId = await transcriptIdentity({ videoId: context.videoId, cues });
    diagnostics.push({
      adapter: this.id,
      outcome: "ok",
      detail: `${cues.length} cues read from the rendered transcript panel via ${read.strategy}.`,
      elapsedMs: performance.now() - started,
    });

    return {
      ok: true,
      diagnostics,
      transcript: {
        transcriptId,
        video: {
          id: context.videoId,
          title: videoTitle(),
          url: `https://www.youtube.com/watch?v=${context.videoId}`,
        },
        cues,
        source: "dom",
        fetchedAt: Date.now(),
        parserVersion: PARSER_VERSION,
      },
    };
  }
}

/** Ordered strongest-first; native UI is touched only after the direct caption route fails. */
export const DEFAULT_ADAPTERS: TranscriptAdapter[] = [
  new PlayerTrackAdapter(),
  new NativePanelTranscriptAdapter(),
  new RenderedTranscriptAdapter(),
];

/** Which failure to report when every adapter failed: the most specific one wins. */
const REASON_PRIORITY: AcquisitionFailureReason[] = [
  "permission-denied",
  "captions-withheld",
  "network-error",
  "parse-error",
  "track-unavailable",
  "unsupported",
  "not-ready",
  "no-captions",
];

export async function acquireTranscript(
  context: AcquisitionContext,
  signal: AbortSignal,
  adapters: TranscriptAdapter[] = DEFAULT_ADAPTERS
): Promise<AcquisitionResult> {
  const diagnostics: AdapterDiagnostic[] = [];
  const reasons: AcquisitionFailureReason[] = [];

  for (const adapter of adapters) {
    if (signal.aborted) return { ok: false, reason: "navigation-cancelled", diagnostics };
    let handles = false;
    try {
      handles = await adapter.canHandle(context);
    } catch {
      handles = false;
    }
    if (!handles) {
      diagnostics.push({ adapter: adapter.id, outcome: "skipped", detail: "Adapter declined.", elapsedMs: 0 });
      continue;
    }

    try {
      const result = await adapter.acquire(context, signal);
      diagnostics.push(...result.diagnostics);
      if (result.ok) return { ...result, diagnostics };
      reasons.push(result.reason);
    } catch (error) {
      if (error instanceof Aborted || signal.aborted) {
        return { ok: false, reason: "navigation-cancelled", diagnostics };
      }
      diagnostics.push({
        adapter: adapter.id,
        outcome: "failed",
        detail: error instanceof Error ? error.message : "Adapter threw.",
        elapsedMs: 0,
      });
      reasons.push("network-error");
    }
  }

  const reason = REASON_PRIORITY.find((candidate) => reasons.includes(candidate)) ?? "no-captions";
  return { ok: false, reason, diagnostics };
}
