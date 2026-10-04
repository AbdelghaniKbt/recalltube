// Live single-video check of the packaged extension against real YouTube.
//
//   npm run build
//   npm run test:live -- "https://www.youtube.com/watch?v=96jN2OCOfLs" "vibe coding"
//
// Uses a plain Chromium launch (see scripts/plain-chromium.mjs for why automation-flagged browsers
// produce false failures). Prints only structure: adapter outcomes, caption request status/size,
// cue counts and timings. No caption text, URLs or tokens are printed.
import { launchPlainChromium, recordCaptionTraffic } from "./plain-chromium.mjs";

const rawTarget = process.argv[2];
const phrase = process.argv[3] ?? "";
if (!rawTarget) {
  throw new Error('Usage: npm run test:live -- https://www.youtube.com/watch?v=VIDEO_ID ["known phrase"]');
}
const target = new URL(rawTarget);
const videoId = target.searchParams.get("v");
if (
  target.protocol !== "https:" ||
  !/(^|\.)youtube\.com$/u.test(target.hostname) ||
  target.pathname !== "/watch" ||
  !videoId ||
  !/^[A-Za-z0-9_-]{6,24}$/u.test(videoId)
) {
  throw new Error("The live smoke test only accepts an HTTPS YouTube watch URL.");
}

const startedAt = Date.now();
const seconds = () => Math.round((Date.now() - startedAt) / 100) / 10;
const session = await launchPlainChromium();

try {
  const traffic = recordCaptionTraffic(session.context, startedAt);
  const watch = await session.context.newPage();
  const pageErrors = [];
  watch.on("pageerror", (error) => pageErrors.push(error.message.slice(0, 200)));
  await watch.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  const signedIn = await watch
    .evaluate(() => Boolean(document.querySelector("#avatar-btn")))
    .catch(() => false);

  const panel = await session.context.newPage();
  await panel.goto(`chrome-extension://${session.extensionId}/sidepanel.html`);
  await watch.bringToFront();

  const ask = (message, timeoutMs = 4_000) =>
    Promise.race([
      panel.evaluate(
        async ({ id, payload }) => {
          const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.includes(`v=${id}`));
          if (!tab?.id) return { error: "tab not found" };
          return new Promise((resolve) =>
            chrome.tabs.sendMessage(tab.id, payload, (response) =>
              resolve(chrome.runtime.lastError ? { lastError: chrome.runtime.lastError.message } : response)
            )
          );
        },
        { id: videoId, payload: message }
      ),
      new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), timeoutMs)),
    ]);

  // The content script must stay responsive while it acquires; a stalled main thread is the
  // failure this check exists to catch.
  let snapshot;
  let slowestReplyMs = 0;
  let unanswered = 0;
  const deadline = Date.now() + 150_000;
  while (Date.now() < deadline) {
    const asked = Date.now();
    const reply = await ask({ type: "recalltube:get-state" });
    slowestReplyMs = Math.max(slowestReplyMs, Date.now() - asked);
    if (reply?.timedOut || reply?.lastError) unanswered += 1;
    snapshot = reply?.snapshot ?? snapshot;
    if (snapshot?.status === "ready" || snapshot?.status === "failed") break;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  const readyAtSeconds = seconds();

  const panelsAfter = await watch.evaluate(() =>
    [...document.querySelectorAll("ytd-engagement-panel-section-list-renderer")]
      .map((element) => element.getAttribute("visibility"))
      .filter((visibility) => /EXPANDED/u.test(visibility ?? "")).length
  );
  const nativeDiagnostic = snapshot?.diagnostics?.find((entry) => entry.adapter === "native-panel");

  let search;
  if (snapshot?.status === "ready" && phrase) {
    await panel.getByText(`${snapshot.document.cues.length.toLocaleString()} captions`).waitFor({ timeout: 15_000 }).catch(() => undefined);
    await panel.getByRole("textbox").first().fill(phrase);
    await panel.waitForTimeout(1_500);
    const count = (await panel.locator("body").innerText()).match(/(\d+) moments? found/u)?.[1];
    search = {
      phrase,
      moments: count ? Number(count) : 0,
      firstTimestamp: await panel.locator(".result-card .timestamp").first().innerText().catch(() => null),
    };
  }

  const report = {
    browser: session.browserVersion,
    launch: "plain Chromium process (navigator.webdriver false), fresh profile",
    signedIn,
    videoId,
    finalStatus: snapshot?.status,
    reason: snapshot?.reason,
    secondsToFinalState: readyAtSeconds,
    contentScript: { slowestReplyMs, unanswered },
    adaptersAttempted: (snapshot?.diagnostics ?? []).map((entry) => ({
      adapter: entry.adapter,
      outcome: entry.outcome,
      elapsedMs: Math.round(entry.elapsedMs),
      detail: entry.detail,
    })),
    nativeControlAppeared: nativeDiagnostic ? !/control not found/u.test(nativeDiagnostic.detail) : null,
    nativeRowsRendered: Number(nativeDiagnostic?.detail.match(/from (\d+) rendered rows/u)?.[1] ?? 0),
    cuesCaptured: snapshot?.document?.cues?.length ?? 0,
    source: snapshot?.document?.source,
    transcriptPanelsLeftExpanded: panelsAfter,
    search,
    captionTraffic: traffic,
    pageErrors,
  };
  console.log(JSON.stringify(report, null, 2));

  if (snapshot?.status !== "ready" || !report.cuesCaptured || panelsAfter > 0 || unanswered > 0) process.exitCode = 2;
  if (phrase && !search?.moments) process.exitCode = 2;
} finally {
  await session.close();
}
