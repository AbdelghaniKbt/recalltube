import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildRetrievalIndex, embeddableChunks } from "../src/search/engine";
import { parseReferenceTranscript } from "../src/testing/reference-transcript";
import { launch, semanticWorkerPath } from "../tests/e2e/harness";
import { watchPageHtml, type VideoFixture } from "../tests/e2e/fixtures";

const transcriptSource = process.argv.slice(2).find((argument) => !argument.startsWith("--"));
if (!transcriptSource) {
  throw new Error(
    "Usage: npm run test:reference:ui -- <transcript.txt> [--skip-semantic] [--screenshots=<directory>]"
  );
}

const transcript = fs.readFileSync(path.resolve(transcriptSource), "utf8");
const skipSemantic = process.argv.includes("--skip-semantic");
const screenshotArgument = process.argv.find((argument) => argument.startsWith("--screenshots="));
const screenshotDirectory = screenshotArgument
  ? path.resolve(screenshotArgument.slice("--screenshots=".length))
  : undefined;
if (screenshotDirectory) fs.mkdirSync(screenshotDirectory, { recursive: true });
const semanticLimitArgument = process.argv.find((argument) => argument.startsWith("--semantic-limit="));
const semanticLimit = semanticLimitArgument
  ? Number.parseInt(semanticLimitArgument.slice("--semantic-limit=".length), 10)
  : undefined;
const referenceCues = parseReferenceTranscript(transcript);
const allReferenceChunks = embeddableChunks(buildRetrievalIndex("reference-ui", referenceCues));
const referenceChunks = semanticLimit ? allReferenceChunks.slice(0, semanticLimit) : allReferenceChunks;
const fixture: VideoFixture = {
  id: "96jN2OCOfLs",
  title: "Andrej Karpathy: From Vibe Coding to Agentic Engineering w/ Stephanie Zhan",
  tracks: [{ lang: "en", name: "English", kind: "asr" }],
  emptyBody: true,
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const harness = await launch();
const report: Record<string, unknown> = { videoId: fixture.id };
const progressFile = path.join(os.tmpdir(), "recalltube-reference-ui-progress.log");
fs.writeFileSync(progressFile, "");
const stage = (message: string) => {
  const line = `[${new Date().toISOString()}] ${message}`;
  fs.appendFileSync(progressFile, `${line}\n`);
  console.error(`[reference-ui] ${message}`);
};
stage(`started; progress log: ${progressFile}`);

try {
  let nativeCaptureAvailable = true;
  await harness.context.route(/^https:\/\/www\.youtube\.com\/api\/timedtext/, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "" })
  );
  await harness.context.route(/^https:\/\/www\.youtube\.com\/watch/, (route) => {
    const nativeSetup = nativeCaptureAvailable
      ? `
        window.__recalltubeNativeOpens = 0;
        window.__recalltubeNativeCloses = 0;
        const transcriptSection = document.createElement('ytd-video-description-transcript-section-renderer');
        const transcriptButton = document.createElement('button');
        transcriptButton.setAttribute('aria-controls', 'engagement-panel-searchable-transcript');
        transcriptButton.textContent = 'Show transcript';
        transcriptSection.append(transcriptButton);
        document.body.append(transcriptSection);
        const nativePanel = document.createElement('ytd-engagement-panel-section-list-renderer');
        nativePanel.setAttribute('target-id', 'engagement-panel-searchable-transcript');
        nativePanel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
        document.body.append(nativePanel);
        const referenceCues = ${JSON.stringify(referenceCues)};
        transcriptButton.addEventListener('click', () => {
          window.__recalltubeNativeOpens += 1;
          nativePanel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_EXPANDED');
          const close = document.createElement('button');
          close.id = 'close-button';
          close.setAttribute('aria-label', 'Close transcript');
          close.textContent = 'Close';
          close.addEventListener('click', () => {
            window.__recalltubeNativeCloses += 1;
            nativePanel.setAttribute('visibility', 'ENGAGEMENT_PANEL_VISIBILITY_HIDDEN');
            nativePanel.replaceChildren();
          });
          nativePanel.replaceChildren(close);
          for (const cue of referenceCues) {
            const row = document.createElement('ytd-transcript-segment-renderer');
            const timestamp = document.createElement('span');
            timestamp.className = 'segment-timestamp';
            const total = Math.floor(cue.start);
            timestamp.textContent = Math.floor(total / 60) + ':' + String(total % 60).padStart(2, '0');
            const text = document.createElement('span');
            text.className = 'segment-text';
            text.textContent = cue.text;
            row.append(timestamp, text);
            nativePanel.append(row);
          }
        });
      `
      : "";
    const html = watchPageHtml(fixture).replace(
      "</script>",
      `
        window.__recalltubeSeek = 0;
        const recalltubeVideo = document.querySelector('video');
        Object.defineProperty(recalltubeVideo, 'currentTime', {
          configurable: true,
          get: () => window.__recalltubeSeek,
          set: (value) => { window.__recalltubeSeek = Number(value); },
        });
        recalltubeVideo.play = () => Promise.resolve();
        ${nativeSetup}
      </script>`
    );
    return route.fulfill({ status: 200, contentType: "text/html", body: html });
  });

  const watch = await harness.context.newPage();
  await watch.goto(`https://www.youtube.com/watch?v=${fixture.id}`);
  const panel = await harness.openSidePanel();
  await panel.setViewportSize({ width: 420, height: 900 });
  // Playwright represents the side panel as a background extension tab, which has no clipboard
  // user activation. Capture writes in memory so the test still verifies the exact generated text.
  await panel.evaluate(() => {
    const scope = globalThis as unknown as { __recalltubeClipboard?: string };
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (value: string) => {
          scope.__recalltubeClipboard = value;
        },
        readText: async () => scope.__recalltubeClipboard ?? "",
      },
    });
  });
  await watch.bringToFront();

  await panel.getByText("CAPTURED", { exact: true }).waitFor({ timeout: 30_000 });
  const nativeLifecycle = await watch.evaluate(() => {
    const scope = window as unknown as { __recalltubeNativeOpens: number; __recalltubeNativeCloses: number };
    const native = document.querySelector("[target-id='engagement-panel-searchable-transcript']");
    return {
      opens: scope.__recalltubeNativeOpens,
      closes: scope.__recalltubeNativeCloses,
      visibility: native?.getAttribute("visibility"),
      renderedRowsAfterCleanup: native?.querySelectorAll("ytd-transcript-segment-renderer").length ?? 0,
    };
  });
  assert(nativeLifecycle.opens === 1, `Native panel opened ${nativeLifecycle.opens} times.`);
  assert(nativeLifecycle.closes === 1, `Native panel closed ${nativeLifecycle.closes} times.`);
  assert(/HIDDEN/iu.test(nativeLifecycle.visibility ?? ""), "Native panel was not restored to hidden.");
  assert(nativeLifecycle.renderedRowsAfterCleanup === 0, "Native transcript rows remained rendered after capture.");
  stage("884-cue native-panel capture completed and restored YouTube UI");
  report.nativePanelCapture = { bytes: Buffer.byteLength(transcript), cues: 884, ...nativeLifecycle };

  const input = panel.getByRole("textbox", { name: "Search transcript" });
  await input.fill("first special guest");
  await panel.getByText("1 moment", { exact: true }).waitFor();
  const boundaryCard = panel.locator(".result-card").first();
  const boundaryTimestamp = await boundaryCard.locator(".timestamp").innerText();
  const highlighted = await boundaryCard.locator("mark").allInnerTexts();
  assert(boundaryTimestamp === "0:02", `Boundary result sought ${boundaryTimestamp}, expected 0:02.`);
  assert(highlighted.join(" ").toLowerCase().includes("first special guest"), "Boundary highlight is incomplete.");
  await boundaryCard.locator(".result-main").click();
  report.exactBoundary = { timestamp: boundaryTimestamp, highlighted, seekActionDispatched: true };

  await boundaryCard.getByRole("button", { name: "Show more context" }).click();
  assert((await boundaryCard.locator(".context").innerText()).length > 20, "Context expansion rendered no context.");
  await boundaryCard.getByRole("button", { name: "Copy link at 0:02" }).click();
  const copiedLink = await panel.evaluate(() => navigator.clipboard.readText());
  assert(copiedLink === `https://www.youtube.com/watch?v=${fixture.id}&t=2s`, `Unexpected copied link: ${copiedLink}`);
  await boundaryCard.getByRole("button", { name: "Copy quote with timestamp" }).click();
  const copiedQuote = await panel.evaluate(() => navigator.clipboard.readText());
  assert(copiedQuote.includes("first special guest") && copiedQuote.includes("&t=2s"), "Copied quote lost text or timestamp.");
  report.resultActions = { context: true, copiedLink, copiedQuote: true };
  stage("exact search, highlighting, context and copy actions passed");

  await input.fill("vibe coding");
  await panel.getByText("4 moments", { exact: true }).waitFor();
  if (screenshotDirectory) {
    await panel.evaluate(() => window.scrollTo(0, 0));
    await panel.screenshot({ path: path.join(screenshotDirectory, "andrej-search.png") });
  }
  await input.press("ArrowDown");
  const selectedTimestamp = await panel.locator('.result-card[data-active="true"] .timestamp').innerText();
  assert(selectedTimestamp !== "0:32", "ArrowDown did not select the next result.");
  await input.press("Enter");
  report.keyboardNavigation = { resultCount: 4, selectedTimestamp, enterActionDispatched: true };

  // Remove the native route on reload; the side panel must restore the transcript captured above.
  nativeCaptureAvailable = false;
  await watch.reload();
  await panel.getByText("SAVED", { exact: true }).waitFor({ timeout: 20_000 });
  report.cacheRecovery = true;
  stage("cached transcript restored after reload");

  await panel.getByRole("tab", { name: "Meaning" }).click();
  await input.fill("programer feeling behnd");
  await panel.locator(".result-card").first().waitFor({ timeout: 20_000 });
  const lexicalMeaning = await panel.locator(".result-card").first().innerText();
  assert(/programmer|feeling|behind/iu.test(lexicalMeaning), "Offline typo-tolerant Meaning search missed its evidence.");
  report.offlineMeaning = lexicalMeaning.slice(0, 240);
  if (screenshotDirectory) {
    await panel.evaluate(() => window.scrollTo(0, 0));
    await panel.screenshot({ path: path.join(screenshotDirectory, "andrej-meaning.png") });
  }
  stage("offline typo-tolerant Meaning search passed");

  await panel.getByRole("tab", { name: "Ask" }).click();
  await input.fill("Why did he say he felt behind as a programmer?");
  stage("starting grounded Ask UI check");
  await panel.getByRole("button", { name: "Answer from this video" }).click();
  const answerCard = panel.locator(".answer-card");
  await answerCard.waitFor({ timeout: 60_000 });
  const citations = answerCard.locator(".citation");
  assert((await citations.count()) > 0, "Ask returned no timestamp citations.");
  const answerText = await answerCard.locator(".answer-text").innerText();
  const firstCitationTimestamp = await citations.first().locator(".timestamp").innerText();
  report.ask = {
    answer: answerText,
    citations: await citations.count(),
    firstCitationTimestamp,
    citationActionDispatched: true,
  };
  if (screenshotDirectory) {
    await panel.evaluate(() => window.scrollTo(0, 0));
    await panel.screenshot({ path: path.join(screenshotDirectory, "andrej-ask.png") });
    report.screenshots = {
      directory: screenshotDirectory,
      files: ["andrej-search.png", "andrej-meaning.png", "andrej-ask.png"],
    };
  }
  await citations.first().click();
  stage("grounded Ask with timestamp citations passed");

  await panel.getByRole("button", { name: "Privacy and storage" }).click();
  stage("starting settings and diagnostics check");
  await panel.getByRole("dialog", { name: "Privacy and storage" }).waitFor();
  await panel.getByRole("button", { name: /Copy diagnostics/iu }).click();
  const diagnostics = await panel.evaluate(() => navigator.clipboard.readText());
  assert(diagnostics.includes('"version"'), "Diagnostics copy is not JSON-like.");
  assert(!diagnostics.includes("first special guest"), "Diagnostics leaked transcript text.");
  report.settings = { privacyDialog: true, diagnosticsCopiedWithoutTranscript: true };

  if (!skipSemantic) {
    // The Playwright side panel is represented by a tab. Run the expensive model worker with that
    // tab foregrounded, matching the scheduling priority of Chrome's real visible docked panel.
    await panel.getByRole("button", { name: "Close settings" }).click();
    const workerAsset = await semanticWorkerPath(panel);
    await panel.bringToFront();
    const semantic = await panel.evaluate(
    async ({ asset, chunks, videoId }) => {
      const worker = new Worker(`/${asset}`, { type: "module" });
      const messages: any[] = [];
      worker.addEventListener("message", (event) => messages.push(event.data));
      const waitFor = <T,>(match: (value: any) => boolean, timeoutMs: number) =>
        new Promise<T>((resolve, reject) => {
          const started = performance.now();
          const poll = window.setInterval(() => {
            const hit = messages.find(match);
            if (hit) {
              window.clearInterval(poll);
              resolve(hit as T);
            } else if (performance.now() - started > timeoutMs) {
              window.clearInterval(poll);
              reject(new Error(`Worker timeout: ${JSON.stringify(messages.slice(-5))}`));
            }
          }, 100);
        });

      worker.postMessage({
        type: "index",
        requestId: "reference-index",
        transcriptId: "reference-ui",
        videoId,
        modelKey: "e5-small",
        preferredBackend: "webgpu",
        chunks,
      });
      const indexed = await waitFor<any>((value) => value?.type === "indexed", 300_000);

      const runSearch = async (requestId: string, query: string) => {
        worker.postMessage({ type: "search", requestId, transcriptId: "reference-ui", query, limit: 10 });
        return waitFor<any>((value) => value?.type === "results" && value.requestId === requestId, 60_000);
      };
      const english = await runSearch(
        "reference-search-en",
        "programmer struggling to keep up with rapidly changing AI coding tools"
      );
      const arabic = await runSearch("reference-search-ar", "لماذا شعر أنه متأخر كمبرمج؟");
      worker.terminate();
      return {
        backend: indexed.backend,
        chunks: indexed.chunks,
        elapsedMs: indexed.elapsedMs,
        english: english.results.slice(0, 5),
        arabic: arabic.results.slice(0, 5),
      };
    },
    { asset: workerAsset, chunks: referenceChunks, videoId: fixture.id }
  );
    assert(
      semantic.english.some((result: { text?: string }) => /behind|programmer|tools/iu.test(result.text ?? "")),
      "Dense English retrieval missed the programmer-behind evidence."
    );
    assert(
      semantic.arabic.some((result: { text?: string }) => /behind|programmer/iu.test(result.text ?? "")),
      "Arabic-to-English retrieval missed the programmer-behind evidence."
    );
    report.semantic = semantic;
    stage(`full semantic index and cross-language retrieval passed on ${semantic.backend}`);
  }

  assert(harness.externalRequests.every((url) => !url.includes("jsdelivr")), "The extension contacted jsdelivr.");
  report.network = { jsdelivrRequests: 0 };

  console.log(JSON.stringify(report, null, 2));
} finally {
  await harness.close();
}
