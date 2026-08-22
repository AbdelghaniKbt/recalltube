import { launch } from "../tests/e2e/harness";

const rawTarget = process.argv[2];
if (!rawTarget) {
  throw new Error("Usage: npm run test:live:reference -- <youtube-watch-url>");
}

const target = new URL(rawTarget);
if (target.protocol !== "https:" || !/(^|\.)youtube\.com$/u.test(target.hostname) || target.pathname !== "/watch") {
  throw new Error("The live reference test only accepts an HTTPS YouTube watch URL.");
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function timestampSeconds(value: string): number {
  const parts = value.trim().split(":").map(Number);
  assert(parts.length >= 2 && parts.every(Number.isFinite), `Invalid result timestamp: ${value}`);
  return parts.reduce((total, part) => total * 60 + part, 0);
}

const harness = await launch();
const youtubeConsoleErrors: string[] = [];
const extensionConsoleErrors: string[] = [];
const powerPreferenceWarnings: string[] = [];

try {
  const watch = await harness.context.newPage();
  watch.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") youtubeConsoleErrors.push(text);
    if (/powerPreference option is currently ignored/iu.test(text)) powerPreferenceWarnings.push(text);
  });
  await watch.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await watch.locator("video").first().waitFor({ state: "attached", timeout: 30_000 });

  const panel = await harness.openSidePanel();
  panel.on("console", (message) => {
    const text = message.text();
    if (message.type() === "error") extensionConsoleErrors.push(text);
    if (/powerPreference option is currently ignored/iu.test(text)) powerPreferenceWarnings.push(text);
  });
  await watch.bringToFront();

  const watchUrl = `${target.origin}${target.pathname}?v=${target.searchParams.get("v")}`;
  const readState = () =>
    panel.evaluate(async (prefix) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.id && candidate.url?.startsWith(prefix));
      if (!tab?.id) throw new Error("The live YouTube tab was not found.");
      return chrome.tabs.sendMessage(tab.id, { type: "recalltube:get-state" });
    }, watchUrl);

  let acquisition = await readState();
  for (let attempt = 0; attempt < 180 && acquisition?.snapshot?.status === "loading"; attempt += 1) {
    await watch.waitForTimeout(500);
    acquisition = await readState();
  }
  if (acquisition?.snapshot?.status !== "ready") {
    throw new Error(
      `Automatic caption acquisition failed on the live page: ${JSON.stringify(
        {
          status: acquisition?.snapshot?.status,
          reason: acquisition?.snapshot?.reason,
          transcriptPanel: acquisition?.snapshot?.transcriptPanel,
          diagnostics: acquisition?.snapshot?.diagnostics,
        },
        null,
        2
      )}`
    );
  }

  const input = panel.getByRole("textbox", { name: "Search transcript" });
  await input.waitFor({ timeout: 30_000 });

  const sourcePills = await panel.locator(".pill").allInnerTexts();
  const seekQuery = "agentic engineering when I call it that";
  await input.fill(seekQuery);
  const result = panel.locator(".result-card").first();
  await result.waitFor({ timeout: 20_000 });
  const timestamp = await result.locator(".timestamp").innerText();
  const resultSeconds = timestampSeconds(timestamp);
  assert(Math.abs(resultSeconds - 986) <= 2, `Expected the result near 16:26, received ${timestamp}.`);

  const nativePanelState = await watch.evaluate(() => {
    const roots: ParentNode[] = [document];
    const visited = new Set<ParentNode>();
    const panels: Element[] = [];
    while (roots.length) {
      const root = roots.pop();
      if (!root || visited.has(root)) continue;
      visited.add(root);
      for (const element of root.querySelectorAll<HTMLElement>("*")) {
        if (element.shadowRoot) roots.push(element.shadowRoot);
        const identity = `${element.tagName} ${element.id} ${element.getAttribute("target-id") ?? ""}`;
        if (/transcript/iu.test(identity) && /engagement-panel|transcript-search-panel/iu.test(identity)) {
          panels.push(element);
        }
      }
    }
    return panels.map((panel) => ({
      identity: `${panel.tagName.toLowerCase()}#${panel.id}`,
      visibility: panel.getAttribute("visibility"),
      ariaHidden: panel.getAttribute("aria-hidden"),
      hidden: (panel as HTMLElement).hidden,
      rowCount: panel.querySelectorAll("ytd-transcript-segment-renderer, [class*='segment']").length,
    }));
  });
  const leftExpanded = nativePanelState.some(
    (panel) =>
      !panel.hidden &&
      panel.ariaHidden !== "true" &&
      !/HIDDEN|COLLAPSED/iu.test(panel.visibility ?? "") &&
      (/EXPANDED|VISIBLE/iu.test(panel.visibility ?? "") || panel.rowCount > 0)
  );
  assert(!leftExpanded, `RecallTube left YouTube's transcript panel open: ${JSON.stringify(nativePanelState)}`);

  // Avoid measuring an ad player's clock when YouTube happens to serve an advertisement.
  const adDeadline = Date.now() + 90_000;
  while (await watch.locator("#movie_player.ad-showing").count()) {
    const skip = watch.locator(".ytp-ad-skip-button-modern, .ytp-ad-skip-button, .ytp-skip-ad-button").first();
    if (await skip.isVisible().catch(() => false)) await skip.click().catch(() => undefined);
    if (Date.now() >= adDeadline) throw new Error("YouTube's advertisement did not finish within 90 seconds.");
    await watch.waitForTimeout(500);
  }
  await watch.locator("video.html5-main-video, video").first().evaluate((video) => (video as HTMLVideoElement).pause());
  await watch.bringToFront();
  const seekResponse = await panel.evaluate(
    async ({ watchUrl, seconds }) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.id && candidate.url?.startsWith(watchUrl));
      if (!tab?.id) throw new Error("The live YouTube tab was not found.");
      return chrome.tabs.sendMessage(tab.id, { type: "recalltube:seek", seconds });
    },
    { watchUrl, seconds: resultSeconds }
  );
  assert(seekResponse?.ok === true, `The live content script rejected seek: ${JSON.stringify(seekResponse)}`);
  await watch.waitForFunction(
    (expected) => {
      const video = document.querySelector<HTMLVideoElement>("video.html5-main-video, video");
      return video !== null && Math.abs(video.currentTime - expected) < 3;
    },
    resultSeconds,
    { timeout: 15_000 }
  );
  const playerTime = await watch
    .locator("video.html5-main-video, video")
    .first()
    .evaluate((video) => (video as HTMLVideoElement).currentTime);

  assert(extensionConsoleErrors.length === 0, `The extension logged a console error: ${extensionConsoleErrors[0]}`);
  console.log(
    JSON.stringify(
      {
        url: target.href,
        title: await watch.title(),
        acquisition: {
          sourcePills,
          nativePanelRestored: true,
          nativePanelState,
        },
        search: { query: seekQuery, timestamp },
        liveSeek: {
          requestedSeconds: resultSeconds,
          contentScriptAccepted: true,
          playerTime,
          passed: Math.abs(playerTime - resultSeconds) < 3,
        },
        extensionConsoleErrorCount: extensionConsoleErrors.length,
        youtubeConsoleErrorCount: youtubeConsoleErrors.length,
        ignoredChromiumPowerPreferenceWarnings: powerPreferenceWarnings.length,
      },
      null,
      2
    )
  );
} finally {
  await harness.close();
}
