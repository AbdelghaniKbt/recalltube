import type { CaptionTrackInfo, PageDataPayload } from "../types/messages";
import type {
  AcquisitionFailureReason,
  AcquisitionProgress,
  AdapterDiagnostic,
  CaptionTrackIdentity,
  TranscriptCue,
  TranscriptDocument,
} from "../types/transcript";
import { isAllowedCaptionUrl, parsePageDataPayload, playabilityFailure, trackIdentity } from "./bridge";
import { parseAssignedJson } from "./player-bootstrap";
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
  /** Called as a long capture advances, so callers can wait on progress instead of a fixed clock. */
  onProgress?: (phase: AcquisitionProgress["phase"], rows?: number, hidden?: boolean) => void;
}

export type AcquisitionResult =
  | { ok: true; transcript: TranscriptDocument; diagnostics: AdapterDiagnostic[] }
  | {
      ok: false;
      reason: AcquisitionFailureReason;
      diagnostics: AdapterDiagnostic[];
      /** No later adapter can succeed either (the player says the video is unavailable). */
      terminal?: boolean;
    };

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
export function requestPageData(signal: AbortSignal, timeoutMs = 3_000): Promise<PageDataPayload> {
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

/**
 * Cold inactive tabs sometimes expose their HTML before page JavaScript initializes the player.
 * Re-read that same YouTube watch document and parse its serialized player response without eval.
 */
async function requestSerializedPageData(signal: AbortSignal): Promise<PageDataPayload | undefined> {
  const response = await fetch(location.href, { credentials: "include", signal });
  if (!response.ok) return undefined;
  const html = await response.text();
  const raw = parseAssignedJson([html], ["ytInitialPlayerResponse"]);
  if (!raw || typeof raw !== "object") return undefined;
  const player = raw as Record<string, unknown>;
  const details = player.videoDetails && typeof player.videoDetails === "object"
    ? (player.videoDetails as Record<string, unknown>)
    : undefined;
  const captions = player.captions && typeof player.captions === "object"
    ? (player.captions as Record<string, unknown>)
    : undefined;
  const renderer = captions?.playerCaptionsTracklistRenderer;
  const tracks = renderer && typeof renderer === "object"
    ? (renderer as Record<string, unknown>).captionTracks
    : undefined;
  const captionTracks = Array.isArray(tracks)
    ? tracks.map((track) => {
        if (!track || typeof track !== "object") return undefined;
        const value = track as Record<string, unknown>;
        const name = value.name && typeof value.name === "object" ? (value.name as Record<string, unknown>) : undefined;
        const runs = Array.isArray(name?.runs)
          ? name.runs.map((run) => run && typeof run === "object" ? String((run as Record<string, unknown>).text ?? "") : "").join("")
          : undefined;
        return {
          baseUrl: value.baseUrl,
          languageCode: value.languageCode,
          name: name?.simpleText ?? runs ?? value.languageCode,
          kind: value.kind,
          isTranslatable: value.isTranslatable === true,
        };
      }).filter(Boolean)
    : [];
  const playability = player.playabilityStatus && typeof player.playabilityStatus === "object"
    ? (player.playabilityStatus as Record<string, unknown>)
    : undefined;
  return parsePageDataPayload({
    videoId: details?.videoId,
    title: details?.title,
    captionTracks,
    playability: { status: playability?.status, reason: playability?.reason, isLive: details?.isLive === true },
  });
}

/**
 * Text from the rendered/composed subtree, including open shadow roots.
 *
 * With a `limit`, stops as soon as the text is known to be longer and returns `undefined`. The
 * structural reader asks "is this element's text short enough to be one caption line?" of every
 * element in a panel; answering that by materializing the text of each ancestor — up to the whole
 * transcript for the list container — was a measured half of a 220-second main-thread stall.
 */
function composedText(node: Node): string;
function composedText(node: Node, limit: number): string | undefined;
function composedText(node: Node, limit = Number.POSITIVE_INFINITY): string | undefined {
  const parts: string[] = [];
  let length = 0;
  const visit = (current: Node): boolean => {
    if (current.nodeType === 3) {
      const value = current.nodeValue ?? "";
      parts.push(value);
      length += value.length + 1;
      return length <= limit;
    }
    if (current.nodeType !== 1 && current.nodeType !== 11) return true;

    const element = current.nodeType === 1 ? (current as Element) : undefined;
    if (element?.shadowRoot) return visit(element.shadowRoot);

    // A slot's assigned nodes are the rendered content. Falling back to its children keeps this
    // useful in JSDOM and for slots that have no assignment.
    let children: Node[] = Array.from(current.childNodes);
    if (element?.tagName.toLowerCase() === "slot") {
      const slot = element as HTMLSlotElement;
      const assigned = typeof slot.assignedNodes === "function" ? slot.assignedNodes({ flatten: true }) : [];
      if (assigned.length) children = assigned;
    }
    for (const child of children) {
      if (!visit(child)) return false;
    }
    return true;
  };
  return visit(node) ? parts.join(" ") : undefined;
}

/** Parent across shadow boundaries. */
function composedParent(node: Node): Node | null {
  const parent = node.parentNode;
  if (!parent) return null;
  return parent.nodeType === 11 ? ((parent as ShadowRoot).host ?? null) : parent;
}

function composedContains(ancestor: Node, node: Node): boolean {
  for (let current: Node | null = node; current; current = composedParent(current)) {
    if (current === ancestor) return true;
  }
  return false;
}

/**
 * The engagement-panel visibility governing `element`: its own `visibility` attribute or that of
 * the nearest ancestor carrying one, across shadow boundaries.
 *
 * YouTube nests `ytd-transcript-renderer`, `ytd-transcript-search-panel-renderer` and
 * `ytd-transcript-segment-list-renderer` inside the engagement panel, and only the panel carries
 * the attribute. Answering "is this open?" for those inner renderers used to fall back to a full
 * transcript read — once per renderer, per check, inside the close loop.
 */
function panelVisibility(element: Element): "expanded" | "hidden" | "unknown" {
  for (let current: Node | null = element; current; current = composedParent(current)) {
    if (current.nodeType !== 1) continue;
    const value = (current as Element).getAttribute("visibility");
    if (!value) continue;
    if (/HIDDEN|COLLAPSED/iu.test(value)) return "hidden";
    if (/EXPANDED|VISIBLE/iu.test(value)) return "expanded";
  }
  return "unknown";
}

function readableText(element: HTMLElement): string {
  return composedText(element).replace(/\s+/gu, " ").trim();
}

/**
 * Outermost transcript panels.
 *
 * The selector deliberately matches both the engagement panel and the renderers nested inside it,
 * so a renamed wrapper still leaves something recognizable. Returning every match made each read
 * scan the same rows once per nesting level; only the outermost element of each panel is a scope.
 */
function transcriptPanels(): HTMLElement[] {
  // YouTube's chaptered "In this video" panel (captured on l8pRSuU81PU) is an engagement panel with
  // no target-id and none of the ytd-transcript-* wrappers; it is recognizable only by the
  // transcript rows it holds. Those row components are already trusted by the reader.
  const holdingRows = deepQueryAll(document, "ytd-engagement-panel-section-list-renderer").filter(
    (panel) => deepQueryAll(panel, TRANSCRIPT_ROW_SELECTOR).length > 0
  );
  const matches = [...new Set([...deepQueryAll(document, TRANSCRIPT_PANEL_SELECTOR), ...holdingRows])];
  return matches.filter(
    (candidate) => !matches.some((other) => other !== candidate && composedContains(other, candidate))
  );
}

/**
 * Panels whose rows may be read.
 *
 * YouTube keeps a hidden copy of the transcript panel populated — on 96jN2OCOfLs an identical
 * 893-row list sat in a HIDDEN panel beside the expanded one — and a hidden panel is exactly where a
 * previous video's rows can survive SPA navigation. When YouTube's visibility attribute is present
 * on any panel, therefore, only a panel it marks EXPANDED is readable: live, during an SPA
 * navigation a panel momentarily carried neither value while still holding the previous video's
 * rows, and treating "no signal" as readable accepted those rows as the new video's transcript.
 * Markup with no visibility signal anywhere is still read, so an unrecognized future wrapper does
 * not silently disable capture.
 */
function readableTranscriptPanels(): HTMLElement[] {
  const panels = transcriptPanels().filter((panel) => !panel.hidden && panel.getAttribute("aria-hidden") !== "true");
  const recognized = panels.some((panel) => panelVisibility(panel) !== "unknown");
  return panels.filter((panel) => (recognized ? panelVisibility(panel) === "expanded" : true));
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
  const allPanels = transcriptPanels();
  const scopes: ParentNode[] = readableTranscriptPanels();

  let best: { cues: TranscriptCue[]; strategy: string } = { cues: [], strategy: "none" };

  for (const scope of scopes) {
    const known = deepQueryAll(scope, TRANSCRIPT_ROW_SELECTOR);
    if (!known.length) continue;
    const fromKnown = readKnownRows(scope);
    // Rows matched through YouTube's own component names need no minimum: if
    // `transcript-segment-view-model` matched, that *is* a transcript, however short.
    if (fromKnown.length > best.cues.length) {
      best = { cues: fromKnown, strategy: `known(${fromKnown.length}/${known.length})` };
    }
  }

  // The structural scan exists for a component rename. When YouTube's own row components already
  // produced a transcript it can only add cost — it was the dominant cost of the 220 s stall.
  // It keeps its minimum, because a couple of timestamp-shaped elements are more likely to be
  // page chrome than a transcript.
  if (!best.cues.length) {
    for (const scope of scopes) {
      const structural = structuralRows(scope);
      if (structural.length > best.cues.length) {
        best = { cues: structural, strategy: `structural(${structural.length})` };
      }
    }
  }

  // A component rename can leave the panel wrapper unknown while the row family remains specific
  // and trustworthy. Unlike a whole-document structural scan, this cannot match video cards. It
  // must not run when panels exist but are all hidden: that is where stale rows live.
  if (!allPanels.length) {
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
  // A row is a timestamp plus at most one caption line; anything longer cannot be a row, so its
  // text never needs to be materialized in full. The slack covers the clock and whitespace.
  const textLimit = MAX_STRUCTURAL_ROW_CHARACTERS * 2 + 32;
  for (const element of deepQueryAll(scope, "*")) {
    const raw = composedText(element, textLimit);
    if (raw === undefined) continue;
    const match = ROW_TEXT.exec(raw.replace(/\s+/gu, " ").trim());
    if (!match) continue;
    const start = parseTimestamp(match[1]!);
    if (start === undefined) continue;
    const text = match[2]!.replace(/\s+/gu, " ").trim();
    if (text.length > MAX_STRUCTURAL_ROW_CHARACTERS) continue;
    candidates.push({ element, start, text });
  }

  // Innermost = no other candidate below it. Marking every candidate's ancestors is linear in
  // candidates x depth; the previous all-pairs `contains` test was quadratic and dominated the stall.
  const hasCandidateBelow = new Set<Node>();
  for (const candidate of candidates) {
    for (
      let current = composedParent(candidate.element);
      current && current !== scope && !hasCandidateBelow.has(current);
      current = composedParent(current)
    ) {
      hasCandidateBelow.add(current);
    }
  }
  const innermost = candidates.filter((candidate) => !hasCandidateBelow.has(candidate.element));
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
        const text = composedText(element, MAX_STRUCTURAL_ROW_CHARACTERS * 2 + 32);
        if (text !== undefined && ROW_TEXT.test(text.replace(/\s+/gu, " ").trim())) timestamped += 1;
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
/** Exposed for tests: cleanup must stay bounded on a real-size transcript. */
export const closeTranscriptPanelsForTest = () => closeTranscriptPanelOpenedByRecallTube();

/**
 * Whether YouTube's own transcript panel is open, closed-but-openable, or absent.
 *
 * When the timed-text endpoint withholds captions, this panel is the legitimate remaining source:
 * the rows are already rendered in the page for the user's own session.
 */
/**
 * Whether a readable transcript panel currently holds rows. The cheapest "is it open?" answer:
 * one selector query over the transcript panels, no parsing and no search for the control.
 */
export function transcriptRowsRendered(): boolean {
  return hasKnownRows();
}

export function transcriptPanelState(): "open" | "available" | "unavailable" {
  // Called from a MutationObserver while a page has no transcript, i.e. continuously during
  // playback. A selector query for known rows is enough to say "open"; parsing is the reader's job.
  if (hasKnownRows()) return "open";
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
  const visibility = panelVisibility(panel);
  if (visibility !== "unknown") return visibility === "expanded";
  // Unrecognized markup: rows present in *this* panel are the open signal. A selector query, not a
  // parse — this runs inside the close loop.
  return deepQueryAll(panel, TRANSCRIPT_ROW_SELECTOR).length > 0;
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

/**
 * Resolves `true` once `isDone()` holds, re-checking only when `targets` mutate; `false` if it
 * still does not hold after `timeoutMs` or when `signal` aborts. The check runs because something
 * changed, not on a clock.
 */
function awaitDomCondition(
  targets: Node[],
  isDone: () => boolean,
  timeoutMs: number,
  signal?: AbortSignal,
  throttleMs = 0
): Promise<boolean> {
  if (isDone()) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    let pending: number | undefined;
    const check = () => {
      pending = undefined;
      if (isDone()) finish(true);
    };
    // YouTube mutates the page continuously during playback; a check that queries the whole
    // document must not run on every batch.
    const observer = new window.MutationObserver(() => {
      if (!throttleMs) return check();
      pending ??= window.setTimeout(check, throttleMs);
    });
    const onAbort = () => finish(isDone());
    const timer = window.setTimeout(() => finish(isDone()), timeoutMs);
    function finish(value: boolean) {
      if (settled) return;
      settled = true;
      observer.disconnect();
      window.clearTimeout(timer);
      if (pending !== undefined) window.clearTimeout(pending);
      signal?.removeEventListener("abort", onAbort);
      resolve(value);
    }
    const connected = targets.filter((target) => target.isConnected);
    for (const target of connected.length ? connected : [document.documentElement]) {
      observer.observe(target, { attributes: true, childList: true, subtree: true });
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function closeTranscriptPanelOpenedByRecallTube(): Promise<boolean> {
  const panels = transcriptPanels().filter(isExpandedTranscriptPanel);
  if (!panels.length) return true;
  const closed = () => panels.every((panel) => !panel.isConnected || !isExpandedTranscriptPanel(panel));
  // Observe the parents too, so a panel YouTube removes outright is noticed.
  const observed = panels.map((panel) => composedParent(panel) ?? panel);

  for (const button of findTranscriptCloseButtons().slice(0, 4)) {
    button.click();
    if (await awaitDomCondition(observed, closed, 1_500)) return true;
  }
  return closed();
}

/**
 * Resolves `true` after `quietMs` pass with no mutation inside `targets`, or `false` if `maxMs`
 * elapses first. Rejects on abort.
 */
function awaitQuiet(targets: Node[], quietMs: number, maxMs: number, signal: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let quietTimer = window.setTimeout(() => finish(true), quietMs);
    const maxTimer = window.setTimeout(() => finish(false), Math.max(quietMs, maxMs));
    const observer = new window.MutationObserver(() => {
      window.clearTimeout(quietTimer);
      quietTimer = window.setTimeout(() => finish(true), quietMs);
    });
    const onAbort = () => {
      cleanup();
      reject(new Aborted());
    };
    function cleanup() {
      observer.disconnect();
      window.clearTimeout(quietTimer);
      window.clearTimeout(maxTimer);
      signal.removeEventListener("abort", onAbort);
    }
    function finish(value: boolean) {
      cleanup();
      resolve(value);
    }
    for (const target of targets) {
      observer.observe(target, { attributes: true, characterData: true, childList: true, subtree: true });
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Structure of the readable transcript scopes, for diagnostics: element name, target id,
 * visibility and known-row count. Never caption text.
 */
function describeReadableScopes(): string {
  const scopes = readableTranscriptPanels();
  if (!scopes.length) return "no readable panel";
  return scopes
    .map((scope) => {
      const visibility = (scope.getAttribute("visibility") ?? panelVisibility(scope)).replace("ENGAGEMENT_PANEL_VISIBILITY_", "");
      return `${scope.tagName.toLowerCase()}[${scope.getAttribute("target-id") ?? "-"}] ${visibility} rows=${deepQueryAll(scope, TRANSCRIPT_ROW_SELECTOR).length}`;
    })
    .join("; ");
}

/**
 * Every transcript panel's target id, visibility, known-row count and whether YouTube's loader is in
 * it. Structure only. Used when a capture ends without rows, to show what YouTube actually rendered.
 */
function describePanelsForDiagnostics(): string {
  const panels = transcriptPanels();
  if (!panels.length) return "none";
  return panels
    .map((panel) => {
      const visibility = panelVisibility(panel);
      const rows = deepQueryAll(panel, TRANSCRIPT_ROW_SELECTOR).length;
      const loader = deepQueryAll(panel, "ytd-continuation-item-renderer, tp-yt-paper-spinner[active], yt-content-loading-renderer").length;
      const message = deepQueryAll(panel, "yt-message-renderer, ytd-message-renderer, yt-alert-with-button-renderer").length;
      return `${panel.getAttribute("target-id") ?? "-"} ${visibility} rows=${rows} loader=${loader} message=${message}`;
    })
    .join(" | ");
}

/** Whether any readable panel holds rows of a known component family. A query, not a parse. */
function hasKnownRows(): boolean {
  return readableTranscriptPanels().some((panel) => deepQueryAll(panel, TRANSCRIPT_ROW_SELECTOR).length > 0);
}

/** YouTube's own loading indicators inside a readable transcript panel. */
function transcriptStillLoading(): boolean {
  return readableTranscriptPanels().some(
    (panel) =>
      deepQueryAll(panel, "ytd-continuation-item-renderer, tp-yt-paper-spinner[active], yt-content-loading-renderer").length > 0
  );
}

/**
 * Waiting limits for the native capture are *stall* limits, not fixed durations.
 *
 * Live, a 4x-slower CPU with 300 ms latency took YouTube 28 s to deliver a 1,111-row transcript and
 * the capture 50 s overall; fixed 20 s / 30 s limits there turned a slow but advancing capture into
 * a failure that a manual retry (with YouTube's resources now cached) then "fixed". A limit restarts
 * whenever something advances; a hard cap still bounds the whole capture.
 */
const ROWS_APPEAR_STALL_MS = 25_000;
/** YouTube's own loading indicator is progress; this bounds how long it may spin. */
const ROWS_APPEAR_CAP_MS = 120_000;
/** A panel is settled once its subtree has been silent this long. */
const ROWS_QUIET_MS = 750;

/** Known row elements in readable panels. A query, not a parse. */
function knownRowCount(): number {
  return readableTranscriptPanels().reduce((total, panel) => total + deepQueryAll(panel, TRANSCRIPT_ROW_SELECTOR).length, 0);
}

/**
 * A cheap identity for the rendered list: row count plus the last row's timestamp text.
 *
 * Settling used to fully parse every row after each quiet period — on a slow machine that parse, not
 * YouTube, dominated a 50 s capture. The list is parsed once, after it has stopped changing.
 */
function renderedRowsFingerprint(): string {
  const rows = readableTranscriptPanels().flatMap((panel) => deepQueryAll(panel, TRANSCRIPT_ROW_SELECTOR));
  const last = rows.at(-1);
  const clock = last ? deepQueryAll(last, TIMESTAMP_SELECTOR)[0]?.textContent?.trim() ?? last.textContent?.trim().slice(0, 12) : "";
  return `${rows.length}:${clock}`;
}

/** Waits for the complete transcript, then parses it once. */
/**
 * After YouTube's own transcript request has completed, how long rows may take to render. Live
 * renders took up to 18 s after a sub-second response; a user's session waited 122 s behind the
 * loader with no rows at all, which only the request outcome can tell apart from a slow response.
 */
const ROWS_AFTER_RESPONSE_MS = 30_000;

/**
 * Why a rows wait ended without rows, when something other than YouTube's slowness explains it:
 * its request failed, it answered but rendered nothing, the panel we opened was closed by the page
 * (YouTube's navigation completion hides every engagement panel), or the only rows on offer are a
 * list that already existed before the panel was opened — the previous video's.
 */
type RowsGiveUp = "youtube-request-failed" | "rendered-nothing-after-response" | "panel-closed" | "stale-rows";

interface RowsWaitOptions {
  /**
   * Per-panel fingerprints (row count and last clock) of every transcript panel, hidden ones
   * included, taken before the control was clicked. A readable list matching one of these was not
   * rendered for this open: live, after an SPA navigation the expanded panel showed the previous
   * video's rows for ~3 s until YouTube's `get_transcript` replaced them. Such a list is accepted
   * only once YouTube has made a transcript request since the open, or once it changes.
   */
  staleFingerprints?: Set<string>;
  /** Milliseconds after the capture started at which the panel was opened. */
  openedAtMs?: number;
  /** The panel was opened by RecallTube and must still be expanded; its closing ends the wait. */
  expectOpen?: boolean;
}

/** A panel's rendered list identity: row count plus the last row's clock. */
function panelFingerprint(panel: ParentNode): string {
  const rows = deepQueryAll(panel, TRANSCRIPT_ROW_SELECTOR);
  const last = rows.at(-1);
  const clock = last ? deepQueryAll(last, TIMESTAMP_SELECTOR)[0]?.textContent?.trim() ?? last.textContent?.trim().slice(0, 12) : "";
  return `${rows.length}:${clock}`;
}

/** Fingerprints of every transcript panel that currently holds rows, whatever its visibility. */
function populatedPanelFingerprints(): Set<string> {
  return new Set(transcriptPanels().map(panelFingerprint).filter((fingerprint) => !fingerprint.startsWith("0:")));
}

async function settledRenderedRows(
  signal: AbortSignal,
  capMs: number,
  onProgress?: AcquisitionContext["onProgress"],
  timings?: Record<string, number>,
  /**
   * Requests belonging to this wait: records from `fromIndex` on. `openedAt` stands in for the response
   * time when YouTube re-renders a reopened panel from cache without a new request.
   */
  requests?: { records: TranscriptRequestRecord[]; startedAt: number; fromIndex: number; openedAt?: number },
  giveUp?: { reason?: RowsGiveUp },
  options: RowsWaitOptions = {}
): Promise<{ cues: TranscriptCue[]; strategy: string }> {
  const hardDeadline = performance.now() + capMs;
  const remaining = () => Math.max(0, hardDeadline - performance.now());
  const panelStillOpen = () => !options.expectOpen || transcriptPanels().some(isExpandedTranscriptPanel);
  const requestSinceOpen = () =>
    requests?.records.slice(requests.fromIndex).some((entry) => entry.finishedAtMs >= (options.openedAtMs ?? 0)) ?? false;

  // Rows appear only after YouTube's own transcript request returns. Wait while that is visibly
  // in progress (its spinner) or until nothing has happened for the stall limit.
  const appearStarted = performance.now();
  onProgress?.("native-rows", 0);
  const appearDeadline = appearStarted + Math.min(ROWS_APPEAR_CAP_MS, remaining());
  let stallDeadline = performance.now() + ROWS_APPEAR_STALL_MS;
  while (!hasKnownRows() && performance.now() < Math.min(appearDeadline, stallDeadline)) {
    await awaitDomCondition(
      [document.documentElement],
      hasKnownRows,
      Math.min(2_000, Math.max(0, appearDeadline - performance.now())),
      signal,
      250
    );
    throwIfAborted(signal);
    if (!panelStillOpen()) {
      if (giveUp) giveUp.reason = "panel-closed";
      break;
    }
    if (requests) {
      const relevant = requests.records.slice(requests.fromIndex);
      if (relevant.some((entry) => entry.status !== undefined && entry.status >= 400)) {
        if (giveUp) giveUp.reason = "youtube-request-failed";
        break;
      }
      const lastResponse = relevant.filter((entry) => entry.status === undefined || entry.status < 400).at(-1);
      const respondedAt = lastResponse ? requests.startedAt + lastResponse.finishedAtMs : requests.openedAt;
      if (respondedAt !== undefined && performance.now() - respondedAt > ROWS_AFTER_RESPONSE_MS) {
        if (giveUp) giveUp.reason = "rendered-nothing-after-response";
        break;
      }
    }
    if (transcriptStillLoading()) {
      if (timings) timings.loaderSeen = Math.round(performance.now() - appearStarted);
      stallDeadline = performance.now() + ROWS_APPEAR_STALL_MS;
      // Tell a waiting caller this is still advancing: live, the page was correctly waiting on
      // YouTube's spinner for 40-114 s while the coordinator saw no change and gave up at 45 s.
      onProgress?.("native-rows", 0, document.visibilityState === "hidden");
    } else if (document.visibilityState === "hidden") {
      onProgress?.("native-rows", 0, true);
    }
  }
  if (timings) timings.rows = Math.round(performance.now() - appearStarted);

  const settleStarted = performance.now();
  let fingerprint = hasKnownRows() ? renderedRowsFingerprint() : "";
  if (fingerprint) {
    onProgress?.("native-settle", knownRowCount());
    while (remaining() > 0) {
      const panels = readableTranscriptPanels();
      const quiet = await awaitQuiet(
        panels.length ? panels : [document.documentElement],
        ROWS_QUIET_MS,
        Math.min(remaining(), ROWS_APPEAR_STALL_MS),
        signal
      );
      const next = renderedRowsFingerprint();
      const unchanged = next === fingerprint;
      if (!unchanged) onProgress?.("native-settle", knownRowCount());
      fingerprint = next;
      if (!panelStillOpen()) {
        if (giveUp) giveUp.reason = "panel-closed";
        if (timings) timings.settle = Math.round(performance.now() - settleStarted);
        return { cues: [], strategy: "panel-closed" };
      }
      if (!(quiet && unchanged && !transcriptStillLoading())) continue;
      // A settled list identical to one that existed before the open is the previous video's unless
      // YouTube has fetched a transcript since. Keep waiting for it to change, bounded; a user would
      // rather see "not yet" than another video's transcript.
      if (options.staleFingerprints?.has(next) && !requestSinceOpen()) {
        if (performance.now() - settleStarted > ROWS_APPEAR_STALL_MS) {
          if (giveUp) giveUp.reason = "stale-rows";
          if (timings) timings.settle = Math.round(performance.now() - settleStarted);
          return { cues: [], strategy: "stale-rows" };
        }
        onProgress?.("native-settle", knownRowCount());
        continue;
      }
      break;
    }
  }
  if (timings) timings.settle = Math.round(performance.now() - settleStarted);

  const readStarted = performance.now();
  onProgress?.("native-read", knownRowCount());
  const read = readRenderedRows();
  if (timings) timings.read = Math.round(performance.now() - readStarted);
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
    // Inactive playlist worker tabs initialize YouTube's player more slowly than a foreground tab.
    // Keep polling the already-loaded page data for a few seconds before concluding there is no
    // track; this performs no extra network request and also hardens cold single-video loads.
    const playerAttempts = 10;
    for (let attempt = 0; attempt < playerAttempts && !pageData?.captionTracks.length; attempt += 1) {
      throwIfAborted(signal);
      try {
        pageData = await requestPageData(signal);
      } catch (error) {
        if (error instanceof Aborted) throw error;
        pageData = undefined;
      }
      if (!pageData?.captionTracks.length && attempt < playerAttempts - 1) {
        await delay(Math.min(1_000, 250 * (attempt + 1)), signal);
      }
    }

    if (!pageData?.captionTracks.length) {
      const serialized = await requestSerializedPageData(signal).catch(() => undefined);
      if (serialized?.captionTracks.length) pageData = serialized;
    }

    if (!pageData) return fail("not-ready", "The YouTube player did not answer the page bridge.");
    if (!pageData.captionTracks.length) {
      // A removed, private or not-yet-started video advertises no track *and* will never build a
      // transcript control. Without this verdict the native stage waited up to 90 s for one on a page
      // that YouTube itself had already declared unplayable, then reported "no captions".
      const unavailable = playabilityFailure(pageData.playability);
      if (unavailable) {
        diagnostics.push({ adapter: this.id, outcome: "failed", detail: unavailable.detail, elapsedMs: performance.now() - started });
        return { ok: false, reason: unavailable.reason, diagnostics, terminal: true };
      }
      return fail("no-captions", "The player exposed no caption tracks.");
    }

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
    const initiallyOpen = hasKnownRows() || transcriptPanels().some(isExpandedTranscriptPanel);
    let openedByRecallTube = false;
    let controlFound = initiallyOpen;
    let scopeDescription = "not read";
    let closed = true;
    let read: { cues: TranscriptCue[]; strategy: string } = { cues: [], strategy: "none" };
    const timings: Record<string, number> = {};
    const mark = (name: string, since: number) => {
      timings[name] = Math.round(performance.now() - since);
    };
    const requests = observeTranscriptRequests(started);
    let panelAtEnd = "not described";
    let rowsGiveUp: RowsGiveUp | undefined;
    let reopened = false;
    let buttons: HTMLElement[] = [];
    let staleFingerprints: Set<string> | undefined;
    let openedAtMs: number | undefined;
    // Whether the page was hidden while it waited. An occluded or minimized window reports "hidden",
    // and YouTube may defer work in a hidden page.
    const visibility = { atStart: document.visibilityState, changes: 0, hiddenMs: 0, hiddenSince: document.visibilityState === "hidden" ? performance.now() : undefined as number | undefined };
    const onVisibility = () => {
      visibility.changes += 1;
      if (document.visibilityState === "hidden") visibility.hiddenSince = performance.now();
      else if (visibility.hiddenSince !== undefined) {
        visibility.hiddenMs += performance.now() - visibility.hiddenSince;
        visibility.hiddenSince = undefined;
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    const describeVisibility = () => {
      const hiddenMs = Math.round(visibility.hiddenMs + (visibility.hiddenSince !== undefined ? performance.now() - visibility.hiddenSince : 0));
      return `page ${visibility.atStart} at start, ${document.visibilityState} at end, hidden ${hiddenMs}ms, ${visibility.changes} changes`;
    };

    try {
      if (!initiallyOpen) {
        const controlStarted = performance.now();
        context.onProgress?.("native-control");
        // Lists that exist before this attempt touches anything belong to an earlier open or an
        // earlier video. Taken now, not at the click: rows that YouTube (or the user) renders while
        // the control is still awaited are new and must stay acceptable.
        staleFingerprints = populatedPanelFingerprints();
        deepQueryAll(
          document,
          "ytd-text-inline-expander #expand, tp-yt-paper-button#expand, #description-inline-expander #expand"
        )[0]?.click();

        // The control is built after the description expands; wait for it rather than sleeping.
        //
        // On a slow machine the watch page itself can take longer than any fixed limit to build:
        // live at 4x CPU the control took up to 33 s, and a 15 s limit reported videos with captions
        // as having none. While YouTube is still building the page — no watch metadata or description
        // yet — that is progress; the stall limit applies once the page is built and the control is
        // still absent.
        buttons = findTranscriptButtons();
        const controlCap = controlStarted + TRANSCRIPT_CONTROL_CAP_MS;
        let controlStall = performance.now() + TRANSCRIPT_CONTROL_TIMEOUT_MS;
        // Rows that appear meanwhile (a panel the page opened itself) end the wait: they are the transcript.
        while (!buttons.length && !hasKnownRows() && performance.now() < Math.min(controlCap, controlStall)) {
          await awaitDomCondition(
            [document.documentElement],
            () => findTranscriptButtons().length > 0 || hasKnownRows(),
            Math.min(2_000, Math.max(0, controlCap - performance.now())),
            signal,
            200
          );
          throwIfAborted(signal);
          buttons = findTranscriptButtons();
          if (!buttons.length && !hasKnownRows()) {
            deepQueryAll(
              document,
              "ytd-text-inline-expander #expand, tp-yt-paper-button#expand, #description-inline-expander #expand"
            )[0]?.click();
            if (watchPageStillBuilding()) {
              controlStall = performance.now() + TRANSCRIPT_CONTROL_TIMEOUT_MS;
              context.onProgress?.("native-control");
            }
          }
        }
        controlFound = buttons.length > 0;
        mark("control", controlStarted);

        const openStarted = performance.now();
        context.onProgress?.("native-open");
        const panelOpen = () => transcriptPanels().some(isExpandedTranscriptPanel);
        // Rows already rendered need no control; opening one would create a panel we then close.
        for (const button of hasKnownRows() ? [] : buttons.slice(0, 4)) {
          throwIfAborted(signal);
          // If the user opened it while we waited, their panel is not ours to close.
          if (panelOpen()) break;
          openedByRecallTube = true;
          button.click();
          if (await awaitDomCondition([document.documentElement], panelOpen, PANEL_OPEN_TIMEOUT_MS, signal, 100)) break;
          throwIfAborted(signal);
        }
        openedAtMs = performance.now() - started;
        mark("open", openStarted);
      }

      if (transcriptPanels().some(isExpandedTranscriptPanel) || hasKnownRows()) {
        const giveUp: { reason?: RowsGiveUp } = {};
        read = await settledRenderedRows(
          signal,
          NATIVE_CAPTURE_CAP_MS,
          context.onProgress,
          timings,
          { records: requests.records, startedAt: started, fromIndex: 0 },
          giveUp,
          { staleFingerprints, openedAtMs, expectOpen: openedByRecallTube }
        );
        rowsGiveUp = giveUp.reason;
        // YouTube answered but rendered nothing, closed the panel we opened (its navigation
        // completion hides every engagement panel), or left only a previous video's rows in it:
        // close what is left and open it once more, which makes YouTube render (and if needed
        // request) the list again — after a pause, so a navigation still finishing can do so first.
        const reopenable: RowsGiveUp[] = ["rendered-nothing-after-response", "panel-closed", "stale-rows"];
        if (!read.cues.length && giveUp.reason && reopenable.includes(giveUp.reason) && openedByRecallTube && buttons.length) {
          reopened = true;
          await closeTranscriptPanelOpenedByRecallTube().catch(() => false);
          await delay(REOPEN_PAUSE_MS, signal);
          const reopenIndex = requests.records.length;
          const reopenedAt = performance.now();
          const panelOpen = () => transcriptPanels().some(isExpandedTranscriptPanel);
          // YouTube may have re-rendered the description meanwhile; a stored button can be detached.
          const current = findTranscriptButtons();
          for (const button of (current.length ? current : buttons).slice(0, 4)) {
            if (!button.isConnected) continue;
            button.click();
            if (await awaitDomCondition([document.documentElement], panelOpen, PANEL_OPEN_TIMEOUT_MS, signal, 100)) break;
          }
          throwIfAborted(signal);
          if (panelOpen()) {
            const retryGiveUp: { reason?: RowsGiveUp } = {};
            read = await settledRenderedRows(
              signal,
              NATIVE_CAPTURE_CAP_MS,
              context.onProgress,
              timings,
              { records: requests.records, startedAt: started, fromIndex: reopenIndex, openedAt: reopenedAt },
              retryGiveUp,
              { staleFingerprints, openedAtMs: reopenedAt - started, expectOpen: true }
            );
            rowsGiveUp = retryGiveUp.reason;
          }
        }
        // Described while still open; cleanup below hides it.
        scopeDescription = describeReadableScopes();
      }
      panelAtEnd = describePanelsForDiagnostics();
    } finally {
      requests.stop();
      document.removeEventListener("visibilitychange", onVisibility);
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
        detail: `Native transcript capture produced no rows (control ${controlFound ? "found" : "not found"}, opened ${
          openedByRecallTube ? "by RecallTube" : initiallyOpen ? "by user" : "no"
        }, panel ${finalPanelState}, ${describeTimings(timings)}${rowsGiveUp ? `, stopped: ${rowsGiveUp}` : ""}${reopened ? ", reopened once" : ""}; ${describeTranscriptRequests(requests.records)}; ${describeVisibility()}; panels: ${panelAtEnd}); cleanup ${closed ? "completed" : "could not find a close control"}.`,
        elapsedMs: performance.now() - started,
      });
      return {
        ok: false,
        // A failed or unrendered YouTube response is transient, never evidence of missing captions.
        reason: rowsGiveUp ? "not-ready" : finalPanelState === "unavailable" ? "no-captions" : "not-ready",
        diagnostics,
      };
    }

    const transcript = await transcriptFromRenderedCues(context, read.cues);
    diagnostics.push({
      adapter: this.id,
      outcome: "ok",
      detail: `${transcript.cues.length} cues captured from ${read.cues.length} rendered rows via ${read.strategy} (${scopeDescription}; ${describeTimings(timings)}; ${describeTranscriptRequests(requests.records)}; ${describeVisibility()}); panel ${
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
    // Only a panel that is already open is read here; this adapter never opens YouTube UI. Do not
    // snapshot the first rows that appear: components populate in batches on long videos.
    if (readableTranscriptPanels().length && (read.cues.length || hasKnownRows())) {
      read = await settledRenderedRows(signal, 5_000, context.onProgress);
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

/**
 * YouTube's own transcript requests made while a native capture runs, observed through Resource
 * Timing: endpoint, HTTP status, duration and body size only — never URLs, headers or bodies.
 *
 * A user's diagnostics showed two videos whose panel opened in under a second and then waited 122 s
 * behind YouTube's loader without a single row. Whether YouTube's request failed, was never sent, or
 * succeeded without rendering cannot be told from the DOM; this records it.
 */
export interface TranscriptRequestRecord {
  endpoint: "get_transcript" | "get_panel";
  status?: number;
  durationMs: number;
  bytes?: number;
  /** Milliseconds after the capture started that the response finished. */
  finishedAtMs: number;
}

function observeTranscriptRequests(startedAt: number): { records: TranscriptRequestRecord[]; stop: () => void } {
  const records: TranscriptRequestRecord[] = [];
  const record = (entry: PerformanceEntry) => {
    const endpoint = /\/youtubei\/v1\/get_transcript/u.test(entry.name)
      ? "get_transcript"
      : /\/youtubei\/v1\/get_panel/u.test(entry.name)
        ? "get_panel"
        : undefined;
    if (!endpoint || entry.startTime + entry.duration < startedAt) return;
    const timing = entry as PerformanceResourceTiming & { responseStatus?: number };
    records.push({
      endpoint,
      status: typeof timing.responseStatus === "number" && timing.responseStatus > 0 ? timing.responseStatus : undefined,
      durationMs: Math.round(entry.duration),
      bytes: typeof timing.encodedBodySize === "number" && timing.encodedBodySize > 0 ? timing.encodedBodySize : undefined,
      finishedAtMs: Math.round(entry.startTime + entry.duration - startedAt),
    });
  };
  let observer: PerformanceObserver | undefined;
  try {
    const Observer = (window as unknown as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
    if (Observer) {
      observer = new Observer((list) => list.getEntries().forEach(record));
      observer.observe({ type: "resource", buffered: false });
    }
  } catch {
    observer = undefined;
  }
  return { records, stop: () => observer?.disconnect() };
}

export function describeTranscriptRequests(records: TranscriptRequestRecord[]): string {
  if (!records.length) return "YouTube transcript requests: none observed";
  return `YouTube transcript requests: ${records
    .map((entry) => `${entry.endpoint} ${entry.status ?? "status?"} ${entry.durationMs}ms ${entry.bytes ?? 0}B at ${entry.finishedAtMs}ms`)
    .join("; ")}`;
}

/** Measured phase durations, e.g. "control 900ms, open 120ms, rows 12000ms, settle 2300ms, read 180ms". */
function describeTimings(timings: Record<string, number>): string {
  const order = ["control", "open", "rows", "settle", "read", "loaderSeen"];
  const entries = Object.entries(timings).sort(([left], [right]) => order.indexOf(left) - order.indexOf(right));
  return entries.length ? entries.map(([name, ms]) => `${name} ${ms}ms`).join(", ") : "no timings";
}

/** Once the watch page is built, how long its transcript control may stay absent. */
const TRANSCRIPT_CONTROL_TIMEOUT_MS = 15_000;
/** Absolute bound on waiting for the control, however slowly the page is still being built. */
const TRANSCRIPT_CONTROL_CAP_MS = 90_000;

/**
 * Whether this is YouTube’s watch app still rendering the area the transcript control lives in.
 *
 * Only a page that *is* the watch app (`ytd-watch-flexy`) and has not yet rendered its description
 * counts. A page that never builds a description is not "still building", and waiting on it would
 * only delay reading rows that are already there.
 */
function watchPageStillBuilding(): boolean {
  if (!deepQueryAll(document, "ytd-watch-flexy").length) return false;
  return !deepQueryAll(document, "ytd-watch-metadata #description, ytd-text-inline-expander, #description-inline-expander").length;
}
const PANEL_OPEN_TIMEOUT_MS = 5_000;
/** Before reopening a panel YouTube closed or left stale, so a navigation still finishing can settle. */
const REOPEN_PAUSE_MS = 1_500;
/** Hard cap on waiting for rows plus settling. The stall limits above normally end it far sooner. */
const NATIVE_CAPTURE_CAP_MS = 150_000;

/** Ordered strongest-first; native UI is touched only after the direct caption route fails. */
export const DEFAULT_ADAPTERS: TranscriptAdapter[] = [
  new PlayerTrackAdapter(),
  new NativePanelTranscriptAdapter(),
  new RenderedTranscriptAdapter(),
];

/** Which failure to report when every adapter failed: the most specific one wins. */
const REASON_PRIORITY: AcquisitionFailureReason[] = [
  "permission-denied",
  "video-unavailable",
  "captions-withheld",
  "network-error",
  "parse-error",
  "track-unavailable",
  "unsupported",
  "no-captions",
  "not-ready",
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
      // The player has said the video is unavailable: opening its transcript UI cannot help.
      if (result.terminal) return { ok: false, reason: result.reason, diagnostics, terminal: true };
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
