// Live single-video audit of the packaged extension against real YouTube, with an optional
// reference transcript used purely as a test oracle.
//
//   npm run build
//   npm run test:live:reference -- "https://www.youtube.com/watch?v=96jN2OCOfLs" \
//       --reference="path/to/transcript.txt" --phrase="vibe coding" [--skip-semantic] [--skip-ask]
//
// Launches a plain Chromium process (scripts/plain-chromium.mjs; an automation-flagged browser
// makes YouTube refuse captions and produced false failures before). Set RECALLTUBE_BROWSER to the
// path of an installed Chrome or Edge to run the same audit in that build, in a fresh profile.
//
// What it exercises, in order: automatic acquisition and content-script responsiveness, captured
// cues against the reference oracle (count, timestamp alignment, text agreement, phrase positions),
// Exact search (phrase, cross-cue phrase, highlights), click-to-seek, Meaning search with the real
// local model, Ask with citation validation, preservation of a user-opened transcript panel, page
// reload (cache first, then re-acquisition), SPA navigation away and back, and an extension reload
// with the tab still open. Output is structure only: counts, timestamps, statuses — never transcript
// text, URLs with tokens, or request bodies. The only quoted text is the short search phrase itself.
import fs from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { launchPlainChromium, recordCaptionTraffic } from "./plain-chromium.mjs";
import { parseReferenceTranscript } from "../src/testing/reference-transcript";
import { buildRetrievalIndex, search } from "../src/search/engine";
import { normalizeForSearch, tokenize } from "../src/transcript/normalize";
import type { TranscriptCue } from "../src/types/transcript";

const args = process.argv.slice(2);
const rawTarget = args.find((argument) => !argument.startsWith("--"));
if (!rawTarget) {
  throw new Error(
    'Usage: npm run test:live:reference -- <watch-url> [--reference=<transcript.txt>] [--phrase="..."] [--skip-semantic] [--skip-ask]'
  );
}
const option = (name: string) => args.find((argument) => argument.startsWith(`--${name}=`))?.slice(name.length + 3);
const referencePath = option("reference");
const phrase = option("phrase") ?? "vibe coding";
const skipSemantic = args.includes("--skip-semantic");
const skipAsk = args.includes("--skip-ask");

const target = new URL(rawTarget);
const videoId = target.searchParams.get("v");
if (
  target.protocol !== "https:" ||
  !/(^|\.)youtube\.com$/u.test(target.hostname) ||
  target.pathname !== "/watch" ||
  !videoId ||
  !/^[A-Za-z0-9_-]{6,24}$/u.test(videoId)
) {
  throw new Error("The live reference audit only accepts an HTTPS YouTube watch URL.");
}

const startedAt = Date.now();
const seconds = () => Math.round((Date.now() - startedAt) / 100) / 10;
const log = (message: string) => console.error(`[${seconds()}s] ${message}`);

function clockToSeconds(value: string): number {
  return value
    .replace(/[^\d:]/gu, "")
    .split(":")
    .map(Number)
    .reduce((total, part) => total * 60 + part, 0);
}

interface Snapshot {
  status?: string;
  reason?: string;
  videoId?: string;
  generation?: number;
  document?: { cues: TranscriptCue[]; source: string; video: { id: string } };
  diagnostics?: Array<{ adapter: string; outcome: string; detail: string; elapsedMs: number }>;
}

const session = await launchPlainChromium();
const report: Record<string, unknown> = {
  browser: session.browserVersion,
  executable: process.env.RECALLTUBE_BROWSER ? "RECALLTUBE_BROWSER override" : "Playwright Chromium",
  launch: "plain browser process (navigator.webdriver false), fresh temporary profile",
  videoId,
  date: new Date().toISOString(),
};
const failures: string[] = [];
const check = (condition: unknown, message: string) => {
  if (!condition) failures.push(message);
  return Boolean(condition);
};
/** A step that throws is recorded and the audit continues, so the report is always printed. */
const stepErrors: string[] = [];
const step = async (name: string, run: () => Promise<void>) => {
  try {
    await run();
  } catch (error) {
    stepErrors.push(`${name}: ${error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200)}`);
    failures.push(`step "${name}" threw`);
  }
};

/**
 * esbuild (via tsx) rewrites named functions inside `page.evaluate` callbacks to call a `__name`
 * helper that exists only in the Node bundle. Define it in every page we evaluate in.
 */
const shimEvaluateHelpers = (page: Page) =>
  page.addInitScript(() => {
    const scope = globalThis as unknown as { __name?: (value: unknown) => unknown };
    scope.__name ??= (value: unknown) => value;
  });

try {
  const traffic = recordCaptionTraffic(session.context, startedAt);
  const watch = await session.context.newPage();
  await shimEvaluateHelpers(watch);
  const watchErrors: string[] = [];
  watch.on("pageerror", (error) => watchErrors.push(error.message.slice(0, 160)));

  await watch.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  // Long tasks on the page's main thread, which the content script shares. Attribution is coarse,
  // but a multi-second task during acquisition is the symptom the smoke test flags as "unanswered".
  await watch.evaluate(() => {
    const scope = window as unknown as { __rtLongTasks: Array<{ start: number; duration: number }> };
    scope.__rtLongTasks = [];
    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          scope.__rtLongTasks.push({ start: Math.round(entry.startTime), duration: Math.round(entry.duration) });
        }
      }).observe({ type: "longtask", buffered: true });
    } catch {
      // Not every build exposes longtask timing.
    }
  });
  const signedIn = await watch.evaluate(() => Boolean(document.querySelector("#avatar-btn"))).catch(() => false);
  report.signedIn = signedIn;

  let panel = await session.context.newPage();
  const panelErrors: string[] = [];
  const panelHosts = new Set<string>();
  const attachPanelListeners = (page: Page) => {
    page.on("pageerror", (error) => panelErrors.push(error.message.slice(0, 160)));
    page.on("console", (message) => {
      if (message.type() === "error") panelErrors.push(`console: ${message.text().slice(0, 160)}`);
    });
    page.on("request", (request) => {
      try {
        const host = new URL(request.url()).hostname;
        if (host) panelHosts.add(host);
      } catch {
        // Not a URL we can classify.
      }
    });
  };
  attachPanelListeners(panel);
  await shimEvaluateHelpers(panel);
  await panel.goto(`chrome-extension://${session.extensionId}/sidepanel.html`);
  await watch.bringToFront();
  log("watch page and side panel open");

  const ask = (message: Record<string, unknown>, timeoutMs = 4_000): Promise<any> =>
    Promise.race([
      panel.evaluate(
        async ({ id, payload }) => {
          const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.includes(`v=${id}`));
          if (!tab?.id) return { error: "tab not found" };
          return new Promise((resolve) =>
            chrome.tabs.sendMessage(tab.id!, payload, (response) =>
              resolve(chrome.runtime.lastError ? { lastError: chrome.runtime.lastError.message } : response)
            )
          );
        },
        { id: videoId, payload: message }
      ),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs)),
    ]);

  /** Polls the content script until it settles, recording reply latency and what the panel showed. */
  const waitForSettled = async (budgetMs: number, accept: (snapshot: Snapshot | undefined) => boolean) => {
    let snapshot: Snapshot | undefined;
    let slowestReplyMs = 0;
    let unanswered = 0;
    const panelHeadings: string[] = [];
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
      const asked = Date.now();
      const reply = await ask({ type: "recalltube:get-state" });
      slowestReplyMs = Math.max(slowestReplyMs, Date.now() - asked);
      if (reply?.timedOut || reply?.lastError) unanswered += 1;
      snapshot = reply?.snapshot ?? snapshot;
      const heading = await panel.locator("h1").first().innerText().catch(() => "");
      if (heading && panelHeadings.at(-1) !== heading) panelHeadings.push(heading);
      if (accept(snapshot)) break;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    return { snapshot, slowestReplyMs, unanswered, panelHeadings, elapsedSeconds: seconds() };
  };
  const terminal = (snapshot: Snapshot | undefined) => snapshot?.status === "ready" || snapshot?.status === "failed";

  // ── 1. Automatic acquisition ───────────────────────────────────────────────────────────────────
  const acquisition = await waitForSettled(180_000, terminal);
  const snapshot = acquisition.snapshot;
  const longTasks = await watch
    .evaluate(() => (window as unknown as { __rtLongTasks: Array<{ start: number; duration: number }> }).__rtLongTasks)
    .catch(() => [] as Array<{ start: number; duration: number }>);
  const nativeDiagnostic = snapshot?.diagnostics?.find((entry) => entry.adapter === "native-panel");
  report.acquisition = {
    finalStatus: snapshot?.status,
    reason: snapshot?.reason,
    secondsToFinalState: acquisition.elapsedSeconds,
    contentScript: { slowestReplyMs: acquisition.slowestReplyMs, unanswered: acquisition.unanswered },
    panelHeadingsWhileWaiting: acquisition.panelHeadings,
    adaptersAttempted: (snapshot?.diagnostics ?? []).map((entry) => ({
      adapter: entry.adapter,
      outcome: entry.outcome,
      elapsedMs: Math.round(entry.elapsedMs),
      detail: entry.detail,
    })),
    nativeControlAppeared: nativeDiagnostic ? !/control not found/u.test(nativeDiagnostic.detail) : null,
    nativeRowsRendered: Number(nativeDiagnostic?.detail.match(/from (\d+) rendered rows/u)?.[1] ?? 0),
    cuesCaptured: snapshot?.document?.cues.length ?? 0,
    source: snapshot?.document?.source,
    longTasks: {
      count: longTasks.length,
      over1s: longTasks.filter((task) => task.duration >= 1_000).length,
      longestMs: Math.max(0, ...longTasks.map((task) => task.duration)),
      totalMs: longTasks.reduce((sum, task) => sum + task.duration, 0),
    },
  };
  check(snapshot?.status === "ready", "automatic acquisition did not reach ready");
  check(acquisition.unanswered === 0, `content script left ${acquisition.unanswered} state requests unanswered`);
  const transcriptPanelsExpanded = await watch.evaluate(() =>
    [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")]
      .map((element) => element.getAttribute("visibility"))
      .filter((visibility) => /EXPANDED/u.test(visibility ?? "")).length
  );
  check(transcriptPanelsExpanded === 0, "a transcript panel was left expanded after acquisition");
  (report.acquisition as Record<string, unknown>).transcriptPanelsLeftExpanded = transcriptPanelsExpanded;
  log(`acquisition ${snapshot?.status}: ${snapshot?.document?.cues.length ?? 0} cues`);

  const captured = snapshot?.document?.cues ?? [];

  // ── 2. Reference oracle ────────────────────────────────────────────────────────────────────────
  if (referencePath && captured.length) {
    const reference = parseReferenceTranscript(fs.readFileSync(path.resolve(referencePath), "utf8"));
    const capturedStarts = captured.map((cue) => cue.start).sort((left, right) => left - right);
    const nearest = (value: number) => {
      let low = 0;
      let high = capturedStarts.length - 1;
      while (low < high) {
        const middle = (low + high) >> 1;
        if (capturedStarts[middle]! < value) low = middle + 1;
        else high = middle;
      }
      const candidates = [capturedStarts[low], capturedStarts[low - 1]].filter((v): v is number => v !== undefined);
      return Math.min(...candidates.map((candidate) => Math.abs(candidate - value)));
    };
    const alignedWithin1s = reference.filter((cue) => nearest(cue.start) <= 1).length;
    const byStart = new Map(captured.map((cue) => [Math.round(cue.start), normalizeForSearch(cue.text)]));
    let identicalRows = 0;
    for (const cue of reference) {
      if (byStart.get(Math.round(cue.start)) === normalizeForSearch(cue.text)) identicalRows += 1;
    }
    const referenceTokens = new Set(tokenize(reference.map((cue) => cue.text).join(" ")));
    const capturedTokens = new Set(tokenize(captured.map((cue) => cue.text).join(" ")));
    let shared = 0;
    for (const token of referenceTokens) if (capturedTokens.has(token)) shared += 1;
    const phraseIn = (cues: TranscriptCue[]) =>
      search(buildRetrievalIndex("oracle", cues), phrase, { mode: "exact", limit: 50 }).map((result) =>
        Math.round(result.start)
      );
    const referencePhrase = phraseIn(reference);
    const capturedPhrase = phraseIn(captured);
    const phraseAligned =
      referencePhrase.length === capturedPhrase.length &&
      referencePhrase.every((start, index) => Math.abs(start - capturedPhrase[index]!) <= 2);
    report.reference = {
      file: path.basename(referencePath),
      referenceCues: reference.length,
      capturedCues: captured.length,
      referenceStartsAlignedWithin1s: `${alignedWithin1s}/${reference.length}`,
      rowsIdenticalAfterNormalization: `${identicalRows}/${reference.length}`,
      vocabularyShared: `${shared}/${referenceTokens.size}`,
      phrase,
      phraseStartsReference: referencePhrase,
      phraseStartsCaptured: capturedPhrase,
      phraseAligned,
    };
    check(alignedWithin1s / Math.max(1, reference.length) >= 0.95, "fewer than 95% of reference cue starts align");
    check(phraseAligned, "phrase occurrences differ between the reference and the captured transcript");
    log(`oracle: ${alignedWithin1s}/${reference.length} starts aligned, phrase ${phraseAligned ? "aligned" : "MISMATCH"}`);
  }

  // ── 3. Exact search through the real UI ────────────────────────────────────────────────────────
  const input = panel.getByRole("textbox", { name: "Search transcript" });
  // One evaluation, not one locator round-trip per field: a locator for an element that is absent
  // waits out its full timeout before failing, which turned four cards into two minutes.
  const readCards = async () =>
    panel.evaluate(() => {
      const cards = Array.from(document.querySelectorAll(".result-card"));
      return {
        count: cards.length,
        entries: cards.slice(0, 10).map((card) => ({
          timestamp: (card.querySelector(".timestamp")?.textContent ?? "").replace(/[^\d:]/gu, ""),
          label: card.querySelector(".match-kind")?.textContent ?? "",
          marks: Array.from(card.querySelectorAll("mark")).map((mark) => mark.textContent ?? ""),
          explanation: card.querySelector(".explanation")?.textContent ?? "",
        })),
      };
    });
  const exactSearches: Record<string, unknown> = {};
  if (captured.length) {
    await input.waitFor({ timeout: 30_000 });
    await panel.getByRole("tab", { name: "Exact" }).click();
    await input.fill(phrase);
    await panel.waitForTimeout(800);
    const repeated = await readCards();
    exactSearches.phrase = {
      query: phrase,
      moments: repeated.count,
      timestamps: repeated.entries.map((entry) => entry.timestamp),
      allHighlightsMatch: repeated.entries.every((entry) =>
        entry.marks.length > 0 && normalizeForSearch(entry.marks.join(" ")).includes(normalizeForSearch(phrase))
      ),
    };
    check(repeated.count > 0, `exact search found no moments for the phrase`);

    // A phrase that straddles a caption boundary: the last two words of one cue plus the first two
    // of the next, chosen from the captured transcript itself so it exists by construction.
    let crossCue: { from: number; query: string } | undefined;
    for (let index = 0; index + 1 < captured.length && !crossCue; index += 1) {
      const left = tokenize(captured[index]!.text);
      const right = tokenize(captured[index + 1]!.text);
      if (left.length >= 3 && right.length >= 3) {
        const query = [...left.slice(-2), ...right.slice(0, 2)].join(" ");
        if (query.length >= 12) crossCue = { from: index, query };
      }
    }
    if (crossCue) {
      await input.fill(crossCue.query);
      await panel.waitForTimeout(800);
      const result = await readCards();
      const first = result.entries[0];
      exactSearches.crossCue = {
        moments: result.count,
        firstTimestamp: first?.timestamp,
        expectedTimestamp: Math.floor(captured[crossCue.from]!.start),
        label: first?.label,
        explanation: first?.explanation,
        highlightCount: first?.marks.length,
      };
      check(result.count > 0 && /spanning a caption break/u.test(first?.explanation ?? ""), "cross-cue phrase was not found as a boundary-spanning exact match");
    }
    report.exactSearch = exactSearches;
    log(`exact: ${repeated.count} moments for the phrase`);

    // ── 4. Click-to-seek ─────────────────────────────────────────────────────────────────────────
    await input.fill(phrase);
    await panel.waitForTimeout(800);
    const firstCard = panel.locator(".result-card").first();
    const target = clockToSeconds(await firstCard.locator(".timestamp").first().innerText());
    const adDeadline = Date.now() + 60_000;
    while ((await watch.locator("#movie_player.ad-showing").count()) && Date.now() < adDeadline) {
      const skip = watch.locator(".ytp-ad-skip-button-modern, .ytp-ad-skip-button, .ytp-skip-ad-button").first();
      if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => undefined);
      await watch.waitForTimeout(500);
    }
    await firstCard.locator(".result-main").click();
    const seekLanded = await watch
      .waitForFunction(
        (expected) => {
          const video = document.querySelector<HTMLVideoElement>("video.html5-main-video, video");
          return video !== null && Math.abs(video.currentTime - expected) < 3;
        },
        target,
        { timeout: 15_000 }
      )
      .then(() => true)
      .catch(() => false);
    const playerTime = await watch
      .locator("video.html5-main-video, video")
      .first()
      .evaluate((video) => (video as HTMLVideoElement).currentTime)
      .catch(() => null);
    report.seek = { requestedSeconds: target, playerTime, landed: seekLanded };
    check(seekLanded, "clicking a result did not seek the player");
    await watch.locator("video.html5-main-video, video").first().evaluate((video) => (video as HTMLVideoElement).pause()).catch(() => undefined);
    log(`seek to ${target}s ${seekLanded ? "landed" : "missed"}`);
  }

  // ── 5. Meaning search with the real local model ────────────────────────────────────────────────
  if (captured.length && !skipSemantic) {
    await panel.getByRole("tab", { name: "Meaning" }).click();
    const consent = panel.getByRole("button", { name: "Download the model and enable" });
    if (await consent.count()) await consent.click();
    const modelDeadline = Date.now() + 300_000;
    let status = "";
    while (Date.now() < modelDeadline) {
      status = await panel.locator(".ai-status").first().innerText().catch(() => "");
      if (/Ready|ready/u.test(status) && !/Downloading|Understanding|Preparing/u.test(status)) break;
      if (/failed|No usable/u.test(status)) break;
      await panel.waitForTimeout(1_000);
    }
    const backend = /WebGPU/u.test(status) ? "webgpu" : /CPU/u.test(status) ? "wasm" : undefined;
    const paraphrase = option("meaning") ?? "why does he feel he is lagging behind as a developer";
    await input.fill(paraphrase);
    await panel.waitForTimeout(2_500);
    const meaning = await readCards();
    report.meaningSearch = {
      modelStatus: status.replace(/\s+/gu, " ").slice(0, 160),
      backend,
      query: paraphrase,
      moments: meaning.count,
      top: meaning.entries.slice(0, 5).map((entry) => `${entry.timestamp} ${entry.label}`),
      hostsContactedByPanel: [...panelHosts].filter((host) => !host.endsWith("youtube.com")),
    };
    check(backend !== undefined, "the local model did not report a backend");
    check(meaning.count > 0, "meaning search returned no moments");
    log(`meaning: ${meaning.count} moments on ${backend ?? "no backend"}`);
  }

  // ── 6. Ask ─────────────────────────────────────────────────────────────────────────────────────
  if (captured.length && !skipAsk) {
    await panel.getByRole("tab", { name: "Ask" }).click();
    const question = option("ask") ?? "Why did he say he felt behind as a programmer?";
    await input.fill(question);
    await panel.getByRole("button", { name: "Answer from this video" }).click();
    await panel.locator(".answer-card").first().waitFor({ timeout: 60_000 }).catch(() => undefined);
    const answerText = await panel.locator(".answer-text").first().innerText().catch(() => "");
    const citations = panel.locator(".citations .citation");
    const citationCount = await citations.count();
    const citationTimes: string[] = [];
    for (let index = 0; index < citationCount; index += 1) {
      citationTimes.push((await citations.nth(index).locator(".timestamp").innerText()).replace(/[^\d:]/gu, ""));
    }
    const generative = !(await panel.getByText("Showing the strongest passages verbatim").count());
    report.ask = {
      question,
      status: /could not find enough evidence/u.test(answerText) ? "insufficient-evidence" : "answered",
      generative,
      citations: citationTimes,
      everyCitationHasEvidenceText: citationCount > 0 && (await panel.locator(".citations .citation span[dir='auto']").allInnerTexts()).every((text) => text.trim().length > 0),
    };
    check(citationCount > 0, "Ask produced no citations");
    log(`ask: ${citationCount} citations, ${generative ? "generative" : "extractive"}`);
  }

  // ── 7. A transcript panel the user opened must be preserved ──────────────────────────────────
  if (captured.length) await step("user panel preservation", async () => {
    const opened = await watch.evaluate(async () => {
      const deep = (root: ParentNode, selector: string): HTMLElement[] => {
        const found: HTMLElement[] = [];
        const roots: ParentNode[] = [root];
        const seen = new Set<ParentNode>();
        while (roots.length) {
          const current = roots.pop()!;
          if (seen.has(current)) continue;
          seen.add(current);
          for (const element of current.querySelectorAll<HTMLElement>(selector)) found.push(element);
          for (const element of current.querySelectorAll<HTMLElement>("*")) if (element.shadowRoot) roots.push(element.shadowRoot);
        }
        return found;
      };
      deep(document, "ytd-text-inline-expander #expand, tp-yt-paper-button#expand")[0]?.click();
      await new Promise((resolve) => setTimeout(resolve, 800));
      const button = deep(document, "ytd-video-description-transcript-section-renderer button")[0];
      if (!button) return false;
      button.click();
      for (let attempt = 0; attempt < 40; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 250));
        const expanded = [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")].some(
          (element) => /EXPANDED/u.test(element.getAttribute("visibility") ?? "") && /transcript/u.test(element.getAttribute("target-id") ?? "")
        );
        if (expanded) return true;
      }
      return false;
    });
    let preserved: unknown = { userPanelOpened: opened };
    if (opened) {
      await ask({ type: "recalltube:refresh" });
      const refreshed = await waitForSettled(150_000, terminal);
      const stillExpanded = await watch.evaluate(() =>
        [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")].some(
          (element) => /EXPANDED/u.test(element.getAttribute("visibility") ?? "") && /transcript/u.test(element.getAttribute("target-id") ?? "")
        )
      );
      const native = refreshed.snapshot?.diagnostics?.find((entry) => entry.adapter === "native-panel");
      preserved = {
        userPanelOpened: true,
        refreshStatus: refreshed.snapshot?.status,
        nativeDetail: native?.detail.replace(/\(.*\)/u, "(…)").slice(0, 200),
        panelStillOpenAfterRefresh: stillExpanded,
        preservedPerDiagnostic: /preserved/u.test(native?.detail ?? ""),
      };
      check(stillExpanded, "RecallTube closed a transcript panel the user had opened");
      // Leave the page as the user had it: close the panel we opened for this check.
      await watch.evaluate(() => {
        for (const element of document.querySelectorAll("ytd-engagement-panel-section-list-renderer")) {
          if (!/EXPANDED/u.test(element.getAttribute("visibility") ?? "")) continue;
          (element.querySelector("button[aria-label*='Close' i], #dismiss button, yt-icon-button#close-button button") as HTMLElement | null)?.click();
        }
      }).catch(() => undefined);
    }
    report.userPanelPreserved = preserved;
    log(`user panel preservation: ${JSON.stringify(preserved)}`);
  });

  // ── 8. Page reload: the panel keeps the transcript it has, then the page re-acquires ────────
  if (captured.length) await step("page reload", async () => {
    await watch.reload({ waitUntil: "domcontentloaded" });
    const reloadedAt = Date.now();
    // The panel must keep showing a transcript throughout (the one it had, or the cached copy).
    const panelShapes: string[] = [];
    let transcriptAlwaysShown = true;
    const reacquired = await waitForSettled(150_000, (snapshot) => {
      return terminal(snapshot);
    });
    for (const heading of reacquired.panelHeadings) {
      panelShapes.push(heading);
      // A failure state or the idle state during a reload means the transcript was lost; the
      // reading state is not counted, because it is what the page legitimately reports first.
      if (/needs a reload|No captions|Open a YouTube video|unavailable|did not expose/u.test(heading)) transcriptAlwaysShown = false;
    }
    report.pageReload = {
      panelHeadingsDuringReload: panelShapes,
      transcriptAlwaysShown,
      reacquisitionStatus: reacquired.snapshot?.status,
      reacquisitionSeconds: Math.round((Date.now() - reloadedAt) / 100) / 10,
      cues: reacquired.snapshot?.document?.cues.length,
      unanswered: reacquired.unanswered,
    };
    check(reacquired.snapshot?.status === "ready", "re-acquisition after reload did not reach ready");
    check(transcriptAlwaysShown, "the panel lost the transcript while the page reloaded");
    log(`reload: transcript kept=${transcriptAlwaysShown}, reacquired ${reacquired.snapshot?.status}`);
  });

  // ── 9. SPA navigation away and back ────────────────────────────────────────────────────────────
  if (captured.length) await step("spa navigation", async () => {
    const navigated = await watch.evaluate(() => {
      const anchor = [...document.querySelectorAll<HTMLAnchorElement>("#secondary a[href*='/watch?v='], #related a[href*='/watch?v=']")].find(
        (candidate) => candidate.offsetParent !== null
      );
      if (!anchor) return undefined;
      const next = new URL(anchor.href).searchParams.get("v");
      anchor.click();
      return next;
    });
    if (navigated && navigated !== videoId) {
      const away = await (async () => {
        const deadline = Date.now() + 120_000;
        let snapshot: Snapshot | undefined;
        while (Date.now() < deadline) {
          const reply: any = await panel.evaluate(async (id) => {
            const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.includes(`v=${id}`));
            return tab?.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, { type: "recalltube:get-state" }).catch(() => undefined);
          }, navigated);
          snapshot = reply?.snapshot ?? snapshot;
          if (snapshot?.videoId === navigated && terminal(snapshot)) break;
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
        return snapshot;
      })();
      const awayUrl = watch.url();
      await watch.goBack({ waitUntil: "commit" }).catch(() => undefined);
      const back = await waitForSettled(150_000, (snapshot) => snapshot?.videoId === videoId && terminal(snapshot));
      const adapters = (snapshot: Snapshot | undefined) =>
        snapshot?.diagnostics?.map((entry) => (entry.adapter === "content-script" ? `[${entry.detail}]` : `${entry.adapter}:${entry.outcome}`));
      report.spaNavigation = {
        awayVideoId: navigated,
        awayUrlWasWatchPage: /\/watch\?/u.test(awayUrl),
        awayUrlPath: new URL(awayUrl).pathname,
        awayStatus: away?.status,
        awayReason: away?.reason,
        awayCues: away?.document?.cues.length,
        awayAdapters: adapters(away),
        awayNativeDetail: away?.diagnostics?.find((entry) => entry.adapter === "native-panel")?.detail.slice(0, 400),
        backUrlPath: new URL(watch.url()).pathname,
        backStatus: back.snapshot?.status,
        backReason: back.snapshot?.reason,
        backVideoId: back.snapshot?.videoId,
        backCues: back.snapshot?.document?.cues.length,
        backAdapters: adapters(back.snapshot),
        backNativeDetail: back.snapshot?.diagnostics?.find((entry) => entry.adapter === "native-panel")?.detail.slice(0, 400),
      };
      check(away?.videoId === navigated && terminal(away), "SPA navigation away did not settle on the new video");
      check(back.snapshot?.videoId === videoId && back.snapshot?.status === "ready", "navigating back did not restore the original transcript");
      log(`spa: away ${away?.status}, back ${back.snapshot?.status}`);
    } else {
      report.spaNavigation = { skipped: "no visible related-video link" };
    }
  });

  // ── 10. Extension reload with the tab still open ───────────────────────────────────────────────
  if (captured.length) await step("extension reload", async () => {
    const workersBefore = new Set(session.context.serviceWorkers());
    await panel.evaluate(() => chrome.runtime.reload()).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 4_000));
    // A *new* service worker instance is the proof the extension restarted. A command-line-loaded
    // extension may be disabled by `runtime.reload()` instead; that is a harness limit, not a
    // product result, and the manual steps in docs/TESTING.md cover it.
    let reloadedExtensionId = "";
    for (let attempt = 0; attempt < 60 && !reloadedExtensionId; attempt += 1) {
      for (const worker of session.context.serviceWorkers()) {
        if (workersBefore.has(worker)) continue;
        const name = await worker.evaluate(() => chrome.runtime.getManifest().name).catch(() => "");
        if (name.includes("RecallTube")) reloadedExtensionId = new URL(worker.url()).host;
      }
      if (!reloadedExtensionId) await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!reloadedExtensionId) {
      report.extensionReload = {
        serviceWorkerRestarted: false,
        harnessLimitation:
          "chrome.runtime.reload() did not restart the command-line-loaded extension in this browser; verify manually (docs/TESTING.md, cases 19a/19b)",
      };
      log("extension reload: not restartable in this harness");
      return;
    }
    panel = await session.context.newPage();
    attachPanelListeners(panel);
    await shimEvaluateHelpers(panel);
    // The extension page is unreachable for a moment while Chrome re-registers the extension.
    for (let attempt = 0; ; attempt += 1) {
      try {
        await panel.goto(`chrome-extension://${reloadedExtensionId || session.extensionId}/sidepanel.html`);
        break;
      } catch (error) {
        if (attempt >= 15) throw error;
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    await watch.bringToFront();
    const needsReload = await panel
      .getByText("This tab needs a reload")
      .waitFor({ timeout: 15_000 })
      .then(() => true)
      .catch(() => false);
    let reconnected: Snapshot | undefined;
    if (needsReload) {
      await panel.getByRole("button", { name: "Reload this YouTube tab" }).click();
      reconnected = (await waitForSettled(150_000, terminal)).snapshot;
    }
    report.extensionReload = {
      serviceWorkerRestarted: Boolean(reloadedExtensionId),
      panelOfferedTabReload: needsReload,
      reconnectedStatus: reconnected?.status,
      reconnectedCues: reconnected?.document?.cues.length,
    };
    check(needsReload, "after an extension reload the panel did not offer to reload the orphaned tab");
    check(reconnected?.status === "ready", "the tab did not reconnect after being reloaded");
    log(`extension reload: offered=${needsReload}, reconnected=${reconnected?.status}`);
  });

  report.stepErrors = stepErrors;
  report.errors = { watchPageErrors: watchErrors, panelErrors };
  report.captionTraffic = traffic;
  report.hostsContactedByPanel = [...panelHosts];
  report.failures = failures;
  console.log(JSON.stringify(report, null, 2));
  if (failures.length) process.exitCode = 2;
} finally {
  await session.close();
}
