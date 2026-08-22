import { chromium, type BrowserContext, type Page } from "playwright";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Shared Playwright harness for RecallTube's browser tests.
 *
 * Two constraints shape it:
 *
 *   - Stable Chrome refuses `--load-extension`, so we use Playwright's bundled Chromium.
 *   - MV3 extension pages need a real extension origin, so everything runs in a persistent context
 *     with the built `.output/chrome-mv3` loaded unpacked.
 *
 * YouTube is mocked with `context.route`, which intercepts the content script's fetches as well as
 * the page's, so no certificate handling or host-file editing is needed.
 */

// `import.meta.url` rather than `__dirname`: this module is imported by both the Vitest suite
// and the ESM benchmark runner.
const here = path.dirname(fileURLToPath(import.meta.url));
export const EXTENSION_PATH = path.resolve(here, "../../.output/chrome-mv3");

function bundledChromium(): string | undefined {
  const base = path.join(os.homedir(), "AppData/Local/ms-playwright");
  if (!fs.existsSync(base)) return undefined;
  const build = fs
    .readdirSync(base)
    .filter((name) => name.startsWith("chromium-") && !name.includes("headless"))
    .sort()
    .at(-1);
  if (!build) return undefined;
  for (const candidate of ["chrome-win64/chrome.exe", "chrome-win/chrome.exe", "chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]) {
    const full = path.join(base, build, candidate);
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

export interface Harness {
  context: BrowserContext;
  extensionId: string;
  /** Every non-extension URL the browser requested, for network-allowlist assertions. */
  externalRequests: string[];
  openSidePanel(): Promise<Page>;
  close(): Promise<void>;
}

export async function launch(options: { headless?: boolean } = {}): Promise<Harness> {
  if (!fs.existsSync(EXTENSION_PATH)) {
    throw new Error(`Build the extension first (npm run build): ${EXTENSION_PATH} is missing.`);
  }

  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "recalltube-e2e-"));
  const context = await chromium.launchPersistentContext(userDataDir, {
    executablePath: bundledChromium(),
    // Extensions do not load in Chromium's headless mode; CI runs this under xvfb.
    headless: options.headless ?? false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      // The side panel is represented by an extension tab in Playwright. Keep its worker at the
      // same scheduling priority it has when visibly docked beside YouTube in real Chrome.
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
  });

  const externalRequests: string[] = [];
  context.on("request", (request) => {
    const url = request.url();
    if (!url.startsWith("chrome-extension://") && !url.startsWith("devtools")) externalRequests.push(url);
  });

  let extensionId = "";
  for (let attempt = 0; attempt < 40 && !extensionId; attempt += 1) {
    const worker = context.serviceWorkers()[0];
    if (worker) extensionId = new URL(worker.url()).host;
    else await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!extensionId) throw new Error("The extension service worker never started.");

  return {
    context,
    extensionId,
    externalRequests,
    async openSidePanel() {
      const page = await context.newPage();
      // esbuild (via tsx) rewrites named functions inside `page.evaluate` callbacks to call a
      // `__name` helper that only exists in the Node bundle. Shim it so evaluated code runs.
      await page.addInitScript(() => {
        const scope = globalThis as unknown as { __name?: (value: unknown) => unknown };
        scope.__name ??= (value: unknown) => value;
      });
      await page.goto(`chrome-extension://${extensionId}/sidepanel.html`);
      return page;
    },
    async close() {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    },
  };
}

/** Hosts the extension is allowed to contact at runtime. */
export const ALLOWED_RUNTIME_HOSTS = [/(^|\.)youtube\.com$/, /(^|\.)huggingface\.co$/, /(^|\.)hf\.co$/];

export function unexpectedHosts(urls: string[]): string[] {
  const hosts = new Set<string>();
  for (const url of urls) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!ALLOWED_RUNTIME_HOSTS.some((pattern) => pattern.test(host))) hosts.add(host);
  }
  return [...hosts];
}

/** Path of the built semantic worker inside the extension, discovered from the side-panel chunk. */
export async function semanticWorkerPath(page: Page): Promise<string> {
  const asset = await page.evaluate(async () => {
    const html = await (await fetch("/sidepanel.html")).text();
    const chunk = html.match(/chunks\/[A-Za-z0-9._-]+\.js/);
    if (!chunk) return null;
    const source = await (await fetch(`/${chunk[0]}`)).text();
    return source.match(/assets\/semantic\.worker-[A-Za-z0-9_-]+\.js/)?.[0] ?? null;
  });
  if (!asset) throw new Error("Could not locate the built semantic worker.");
  return asset;
}
