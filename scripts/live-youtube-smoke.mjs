import { chromium } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const rawTarget = process.argv[2];
if (!rawTarget) {
  throw new Error("Usage: npm run test:live -- https://www.youtube.com/watch?v=VIDEO_ID");
}

const target = new URL(rawTarget);
if (target.protocol !== "https:" || !/(^|\.)youtube\.com$/u.test(target.hostname) || target.pathname !== "/watch") {
  throw new Error("The live smoke test only accepts an HTTPS YouTube watch URL.");
}

const extensionPath = path.resolve(".output/chrome-mv3");
if (!fs.existsSync(path.join(extensionPath, "manifest.json"))) {
  throw new Error("Build the extension first with npm run build.");
}

function bundledChromium() {
  const base = path.join(os.homedir(), "AppData/Local/ms-playwright");
  if (!fs.existsSync(base)) return undefined;
  const build = fs
    .readdirSync(base)
    .filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
    .sort()
    .at(-1);
  if (!build) return undefined;
  for (const candidate of [
    "chrome-win64/chrome.exe",
    "chrome-win/chrome.exe",
    "chrome-linux/chrome",
    "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
  ]) {
    const executable = path.join(base, build, candidate);
    if (fs.existsSync(executable)) return executable;
  }
  return undefined;
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recalltube-live-"));
let context;

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: bundledChromium(),
    headless: false,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
    ],
  });

  let extensionId = "";
  for (let attempt = 0; attempt < 60 && !extensionId; attempt += 1) {
    const worker = context.serviceWorkers()[0];
    if (worker) extensionId = new URL(worker.url()).host;
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!extensionId) throw new Error("The unpacked extension service worker did not start.");

  const watch = await context.newPage();
  const transcriptResponses = [];
  const pageErrors = [];
  watch.on("pageerror", (error) => pageErrors.push(error.message));
  watch.on("response", (response) => {
    if (/timedtext|get_transcript/iu.test(response.url())) {
      transcriptResponses.push({ status: response.status(), url: response.url().replace(/([?&](?:sig|signature|pot|ei))=[^&]+/giu, "$1=<redacted>") });
    }
  });
  await watch.goto(target.href, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await watch.waitForTimeout(7_000);

  const control = await context.newPage();
  await control.goto(`chrome-extension://${extensionId}/sidepanel.html`, { waitUntil: "domcontentloaded" });

  const send = (message) =>
    control.evaluate(
      async ({ watchUrl, payload }) => {
        const tabs = await chrome.tabs.query({});
        const tab = tabs.find((candidate) => candidate.id && candidate.url?.startsWith(watchUrl));
        if (!tab?.id) throw new Error("The YouTube test tab was not found.");
        return new Promise((resolve, reject) => {
          chrome.tabs.sendMessage(tab.id, payload, (response) => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve(response);
          });
        });
      },
      { watchUrl: `${target.origin}${target.pathname}?v=${target.searchParams.get("v")}`, payload: message }
    );

  await watch.bringToFront();
  await watch.waitForTimeout(1_500);
  const sidePanelText = await control.locator("body").innerText();
  const initial = await send({ type: "recalltube:get-state" });
  let final = initial;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    final = await send({ type: "recalltube:get-state" });
    if (final?.snapshot?.status === "ready") break;
    await watch.waitForTimeout(500);
  }

  const snapshot = final?.snapshot;
  const report = {
    url: target.href,
    title: await watch.title(),
    extensionId,
    rawInitial: initial,
    initialStatus: initial?.snapshot?.status,
    finalStatus: snapshot?.status,
    reason: snapshot?.reason,
    transcriptPanel: snapshot?.transcriptPanel,
    source: snapshot?.document?.source,
    cueCount: snapshot?.document?.cues?.length ?? 0,
    firstCues: snapshot?.document?.cues?.slice(0, 2) ?? [],
    diagnostics: snapshot?.diagnostics ?? [],
    sidePanelText: sidePanelText.slice(0, 1_500),
    pageErrors,
    transcriptResponses,
  };
  console.log(JSON.stringify(report, null, 2));

  if (snapshot?.status !== "ready" || !snapshot.document?.cues?.length) process.exitCode = 2;
} finally {
  await context?.close();
  const resolvedProfile = path.resolve(profile);
  const resolvedTemp = path.resolve(os.tmpdir());
  if (resolvedProfile.startsWith(`${resolvedTemp}${path.sep}`)) {
    fs.rmSync(resolvedProfile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
}
