// Launches the packaged extension in a *plain* Chromium process and attaches over CDP.
//
// Why not `chromium.launchPersistentContext`: Playwright starts Chromium with automation enabled
// (`navigator.webdriver === true`). On 2026-09-16 YouTube refused captions to such a browser even
// for its own player — its proof-of-origin timed-text request returned 0 bytes and 12 s of playback
// with captions on showed no caption line — while the same Chromium build launched normally
// received a 539 KB caption body. Every earlier "YouTube withholds captions in this session"
// result from these scripts was produced by the harness, not by the product.
//
// This helper adds no stealth: it starts an ordinary browser with a remote-debugging port, as a
// developer would, and loads the unpacked extension from `.output/chrome-mv3`.
import { chromium } from "playwright";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The browser to launch: `RECALLTUBE_BROWSER=<path to chrome.exe|msedge.exe>` when set, otherwise
 * Playwright's Chromium. The override exists so the live checks can run in the same browser build a
 * user actually has — always in a fresh temporary profile, never in the user's own profile.
 */
export function bundledChromium() {
  const override = process.env.RECALLTUBE_BROWSER;
  if (override) {
    if (!fs.existsSync(override)) throw new Error(`RECALLTUBE_BROWSER does not exist: ${override}`);
    return override;
  }
  const base = path.join(os.homedir(), "AppData/Local/ms-playwright");
  const roots = [base, path.join(os.homedir(), ".cache/ms-playwright"), path.join(os.homedir(), "Library/Caches/ms-playwright")];
  for (const root of roots) {
    if (!fs.existsSync(root)) continue;
    const build = fs
      .readdirSync(root)
      .filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
      .sort()
      .at(-1);
    if (!build) continue;
    for (const candidate of [
      "chrome-win64/chrome.exe",
      "chrome-win/chrome.exe",
      "chrome-linux/chrome",
      "chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ]) {
      const executable = path.join(root, build, candidate);
      if (fs.existsSync(executable)) return executable;
    }
  }
  throw new Error("Playwright's Chromium was not found. Run `npx playwright install chromium`.");
}

/** Chromium spawns renderer and GPU processes; on Windows killing the parent leaves them holding the profile. */
function killTree(child) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill();
}

/** Every CDP await here can otherwise hang forever on an unresponsive target. */
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} did not answer within ${ms} ms`)), ms)),
  ]);
}

export async function launchPlainChromium({ extensionPath = path.resolve(".output/chrome-mv3") } = {}) {
  if (!fs.existsSync(path.join(extensionPath, "manifest.json"))) {
    throw new Error("Build the extension first with npm run build.");
  }
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "recalltube-live-"));
  const port = 9400 + Math.floor(Math.random() * 500);
  const child = spawn(
    bundledChromium(),
    [
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${port}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--mute-audio",
      // Recent Chromium gates --load-extension behind this feature; Playwright disables it for you.
      "--disable-features=DisableLoadExtensionCommandLineSwitch",
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "about:blank",
    ],
    { stdio: "ignore" }
  );

  let browser;
  for (let attempt = 0; attempt < 60 && !browser; attempt += 1) {
    try {
      browser = await withTimeout(chromium.connectOverCDP(`http://127.0.0.1:${port}`), 10_000, "CDP connection");
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  if (!browser) {
    killTree(child);
    throw new Error("Chromium did not expose its debugging port.");
  }
  const context = browser.contexts()[0];

  // Component extensions also run a background.js; identify ours by manifest name.
  let serviceWorker;
  for (let attempt = 0; attempt < 80 && !serviceWorker; attempt += 1) {
    for (const worker of context.serviceWorkers()) {
      const name = await withTimeout(worker.evaluate(() => chrome.runtime.getManifest().name), 2_000, "service worker").catch(() => "");
      if (name.includes("RecallTube")) {
        serviceWorker = worker;
        break;
      }
    }
    if (!serviceWorker) await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!serviceWorker) {
    await browser.close().catch(() => undefined);
    killTree(child);
    throw new Error("The RecallTube service worker never started; the unpacked extension did not load.");
  }

  return {
    browser,
    context,
    serviceWorker,
    extensionId: new URL(serviceWorker.url()).host,
    browserVersion: browser.version(),
    async close() {
      await browser.close().catch(() => undefined);
      // Wait for the process to exit: on Windows the profile stays locked until it does, and a
      // cleanup exception must never replace the error that ended the run.
      const exited = new Promise((resolve) => {
        if (child.exitCode !== null) resolve(undefined);
        else child.once("exit", () => resolve(undefined));
      });
      killTree(child);
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
      const resolved = path.resolve(profile);
      if (resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`)) {
        try {
          fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
        } catch (error) {
          console.error(`[live] could not remove temporary profile ${resolved}: ${error instanceof Error ? error.message : error}`);
        }
      }
    },
  };
}

/**
 * Counts media (`videoplayback`) responses by number and declared size only. A worker page that
 * streams the video it is only reading captions from is a bandwidth cost worth measuring; bodies
 * are never read.
 */
export function recordMediaTraffic(context) {
  const summary = { responses: 0, declaredBytes: 0 };
  context.on("response", (response) => {
    if (!/googlevideo\.com\/videoplayback/u.test(response.url())) return;
    summary.responses += 1;
    const declared = Number(response.headers()["content-length"]);
    if (Number.isFinite(declared)) summary.declaredBytes += declared;
  });
  return summary;
}

/** Records caption-related responses by kind, status and size only — never URLs, tokens or bodies. */
export function recordCaptionTraffic(context, startedAt) {
  const entries = [];
  context.on("response", async (response) => {
    const url = response.url();
    const kind = url.includes("/youtubei/v1/get_transcript")
      ? "get_transcript"
      : url.includes("/youtubei/v1/get_panel")
        ? "get_panel"
        : url.includes("/api/timedtext")
          ? url.includes("pot=")
            ? "timedtext (YouTube player, with proof-of-origin)"
            : "timedtext (no proof-of-origin)"
          : undefined;
    if (!kind) return;
    let bytes;
    try {
      bytes = (await response.body()).byteLength;
    } catch {
      bytes = null;
    }
    entries.push({ atSeconds: Math.round((Date.now() - startedAt) / 100) / 10, kind, status: response.status(), bytes });
  });
  return entries;
}
