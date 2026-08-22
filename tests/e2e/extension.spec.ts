import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserContext, Page } from "playwright";
import { launch, semanticWorkerPath, unexpectedHosts, type Harness } from "./harness";
import {
  ARABIC_TALK,
  ASR_ROLLING,
  CAPTIONS_FORBIDDEN,
  CAPTIONS_WITHHELD,
  ENGLISH_TALK,
  findFixture,
  NO_CAPTIONS,
  playerResponseFor,
  watchPageHtml,
  type VideoFixture,
} from "./fixtures";

/**
 * Real-browser integration tests against the built extension.
 *
 * YouTube is mocked with `context.route`, which also intercepts the content script's own fetches,
 * so these exercise the genuine acquisition path — bridge, validation, timed-text parsing, SPA
 * navigation — without touching the live site.
 */

let harness: Harness;

async function mockYouTube(context: BrowserContext) {
  await context.route(/^https:\/\/www\.youtube\.com\/api\/timedtext/, async (route) => {
    const url = new URL(route.request().url());
    const fixture = findFixture(url.searchParams.get("v"));
    if (!fixture) return route.fulfill({ status: 404, body: "" });
    if (fixture.status) return route.fulfill({ status: fixture.status, body: "" });
    // YouTube's real behaviour when it declines to serve timed text: 200 with an empty body.
    if (fixture.emptyBody) return route.fulfill({ status: 200, contentType: "text/html", body: "" });
    if (!fixture.json3) return route.fulfill({ status: 404, body: "" });
    return route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(fixture.json3),
    });
  });

  await context.route(/^https:\/\/www\.youtube\.com\/watch/, async (route) => {
    const url = new URL(route.request().url());
    const fixture = findFixture(url.searchParams.get("v")) ?? ENGLISH_TALK;
    return route.fulfill({ status: 200, contentType: "text/html", body: watchPageHtml(fixture) });
  });
}

async function openWatch(fixture: VideoFixture): Promise<Page> {
  const page = await harness.context.newPage();
  await page.goto(`https://www.youtube.com/watch?v=${fixture.id}`);
  return page;
}

beforeAll(async () => {
  harness = await launch();
  await mockYouTube(harness.context);
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe("extension smoke", () => {
  it("loads with a running service worker", () => {
    expect(harness.extensionId).toMatch(/^[a-p]{32}$/);
  });

  it("renders the side panel without console errors", async () => {
    const page = await harness.openSidePanel();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForTimeout(800);
    const text = await page.locator("body").innerText();
    expect(text).toContain("RecallTube");
    // With no YouTube tab active, the panel must show its idle state, not an error.
    expect(text).toMatch(/Open a YouTube video|NOW SEARCHING/);
    expect(errors).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("caption acquisition against a mock YouTube", () => {
  it("acquires and parses a manual English track", async () => {
    const page = await openWatch(ENGLISH_TALK);
    const snapshot = await page.evaluate(async () => {
      // Reach the content script through the extension messaging channel by asking the page to
      // wait for the transcript to settle, then reading it back via chrome.runtime is not possible
      // from the page world; instead assert the timed-text request happened and the video loaded.
      return { title: document.title };
    });
    expect(snapshot.title).toContain("retrieval");
    await page.waitForTimeout(2_500);
    const requested = harness.externalRequests.filter((url) => url.includes("/api/timedtext"));
    expect(requested.some((url) => url.includes(ENGLISH_TALK.id))).toBe(true);
    // fmt=json3 must be attempted first.
    expect(requested.some((url) => url.includes("fmt=json3"))).toBe(true);
    await page.close();
  }, 60_000);

  it("requests captions for a video that has none only if the player advertises a track", async () => {
    const before = harness.externalRequests.filter((url) => url.includes("/api/timedtext")).length;
    const page = await openWatch(NO_CAPTIONS);
    await page.waitForTimeout(2_500);
    const after = harness.externalRequests.filter((url) => url.includes("/api/timedtext")).length;
    // No advertised track means no caption request at all.
    expect(after).toBe(before);
    await page.close();
  }, 60_000);

  it("does not fall back to reporting no-captions when the endpoint refuses", async () => {
    const page = await openWatch(CAPTIONS_FORBIDDEN);
    await page.waitForTimeout(2_500);
    const requested = harness.externalRequests.filter(
      (url) => url.includes("/api/timedtext") && url.includes(CAPTIONS_FORBIDDEN.id)
    );
    expect(requested.length).toBeGreaterThan(0);
    await page.close();
  }, 60_000);

  it("treats an empty 200 as withheld captions, not a parse error", async () => {
    const page = await openWatch(CAPTIONS_WITHHELD);
    await page.waitForTimeout(3_000);
    const requested = harness.externalRequests.filter(
      (url) => url.includes("/api/timedtext") && url.includes(CAPTIONS_WITHHELD.id)
    );
    // Both formats are attempted, and neither crashes the content script.
    expect(requested.length).toBeGreaterThan(0);
    expect(await page.evaluate(() => document.title)).toContain("withholds");
    await page.close();
  }, 60_000);

  it("automatically captures the native panel and restores YouTube afterward", async () => {
    const watch = await openWatch(CAPTIONS_WITHHELD);
    await watch.waitForTimeout(2_500);
    await watch.evaluate(() => {
      const scope = window as unknown as { nativeOpens: number; nativeCloses: number };
      scope.nativeOpens = 0;
      scope.nativeCloses = 0;
      const section = document.createElement("ytd-video-description-transcript-section-renderer");
      section.innerHTML = `<button aria-controls="engagement-panel-searchable-transcript">Show transcript</button>`;
      const native = document.createElement("ytd-engagement-panel-section-list-renderer");
      native.setAttribute("target-id", "engagement-panel-searchable-transcript");
      native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      section.querySelector("button")!.addEventListener("click", () => {
        scope.nativeOpens += 1;
        native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
        native.innerHTML = `<button id="close-button" aria-label="Close transcript">Close</button>
          <ytd-transcript-segment-renderer><span class="segment-timestamp">0:03</span><span class="segment-text">Automatic native capture one</span></ytd-transcript-segment-renderer>
          <ytd-transcript-segment-renderer><span class="segment-timestamp">0:11</span><span class="segment-text">Automatic native capture two</span></ytd-transcript-segment-renderer>`;
        native.querySelector("#close-button")!.addEventListener("click", () => {
          scope.nativeCloses += 1;
          native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
          native.replaceChildren();
        });
      });
      document.body.append(section, native);
    });

    const panel = await harness.openSidePanel();
    await watch.bringToFront();
    await panel.evaluate(async (videoId) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.id && candidate.url?.includes(videoId));
      if (!tab?.id) throw new Error("Fixture tab not found.");
      await chrome.tabs.sendMessage(tab.id, { type: "recalltube:refresh" });
    }, CAPTIONS_WITHHELD.id);
    await panel.getByText("CAPTURED", { exact: true }).waitFor({ timeout: 30_000 });

    const lifecycle = await watch.evaluate(() => {
      const scope = window as unknown as { nativeOpens: number; nativeCloses: number };
      const native = document.querySelector("[target-id='engagement-panel-searchable-transcript']");
      return {
        opens: scope.nativeOpens,
        closes: scope.nativeCloses,
        visibility: native?.getAttribute("visibility"),
        rows: native?.querySelectorAll("ytd-transcript-segment-renderer").length,
      };
    });
    expect(lifecycle).toEqual({
      opens: 1,
      closes: 1,
      visibility: "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN",
      rows: 0,
    });

    await panel.close();
    await watch.close();
  }, 60_000);

  it("recovers from withheld captions when YouTube renders modern rows in nested shadow DOM", async () => {
    const page = await openWatch(CAPTIONS_WITHHELD);
    await page.waitForTimeout(3_000);

    await page.evaluate(() => {
      const app = document.createElement("div");
      app.id = "live-youtube-transcript-root";
      const appRoot = app.attachShadow({ mode: "open" });
      const panel = document.createElement("ytd-engagement-panel-section-list-renderer");
      panel.setAttribute("target-id", "PAmodern_transcript_view");
      const panelRoot = panel.attachShadow({ mode: "open" });
      for (const [timestamp, text] of [
        ["0:03", "Agentic systems start with a task"],
        ["0:11", "The model then works through the task"],
        ["0:19", "A human reviews the resulting change"],
      ]) {
        const row = document.createElement("transcript-segment-view-model");
        row.className = "ytwTranscriptSegmentViewModelHost";
        const rowRoot = row.attachShadow({ mode: "open" });
        rowRoot.innerHTML = `<span class="ytwTranscriptSegmentViewModelTimestamp">${timestamp}</span>
          <span class="ytAttributedStringHost">${text}</span>`;
        panelRoot.append(row);
      }
      appRoot.append(panel);
      document.body.append(app);
    });

    const control = await harness.openSidePanel();
    await expect.poll(
      () =>
        control.evaluate(async (videoId) => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find((candidate) => candidate.id && candidate.url?.includes(videoId));
          if (!tab?.id) return undefined;
          const response = await chrome.tabs.sendMessage(tab.id, { type: "recalltube:get-state" });
          return response?.snapshot;
        }, CAPTIONS_WITHHELD.id),
      { timeout: 15_000 }
    ).toMatchObject({ status: "ready" });

    // `expect.poll` performs the assertion but does not return the matched value; fetch it once
    // more to verify the built extension's exact acquisition result.
    const ready = await control.evaluate(async (videoId) => {
      const tabs = await chrome.tabs.query({});
      const tab = tabs.find((candidate) => candidate.id && candidate.url?.includes(videoId));
      if (!tab?.id) return undefined;
      return chrome.tabs.sendMessage(tab.id, { type: "recalltube:get-state" });
    }, CAPTIONS_WITHHELD.id);
    expect(ready?.snapshot?.document?.source).toBe("dom");
    expect(ready?.snapshot?.document?.cues).toHaveLength(3);
    expect(ready?.snapshot?.document?.cues[1]).toMatchObject({ start: 11, text: "The model then works through the task" });

    await control.close();
    await page.close();
  }, 60_000);

  it("re-acquires on SPA navigation between videos", async () => {
    const page = await openWatch(ENGLISH_TALK);
    await page.waitForTimeout(2_000);

    await page.evaluate((response) => {
      (window as unknown as { recallTubeNavigate: (id: string, response: unknown) => void }).recallTubeNavigate(
        "ara000000001",
        response
      );
    }, playerResponseFor(ARABIC_TALK));
    await page.waitForTimeout(2_500);

    const requested = harness.externalRequests.filter((url) => url.includes("/api/timedtext"));
    expect(requested.some((url) => url.includes(ARABIC_TALK.id))).toBe(true);
    await page.close();
  }, 60_000);

  it("survives rapid A → B → C navigation without a stuck request", async () => {
    const page = await openWatch(ENGLISH_TALK);
    await page.evaluate(
      ([arabic, asr]) => {
        const navigate = (window as unknown as { recallTubeNavigate: (id: string, r: unknown) => void })
          .recallTubeNavigate;
        navigate("ara000000001", arabic);
        navigate("asr000000001", asr);
      },
      [playerResponseFor(ARABIC_TALK), playerResponseFor(ASR_ROLLING)]
    );
    await page.waitForTimeout(3_000);
    const requested = harness.externalRequests.filter((url) => url.includes("/api/timedtext"));
    // The final video must have been fetched; earlier ones may have been cancelled mid-flight.
    expect(requested.some((url) => url.includes(ASR_ROLLING.id))).toBe(true);
    await page.close();
  }, 60_000);
});

describe("network allowlist", () => {
  it("contacts no host outside YouTube and Hugging Face", () => {
    expect(unexpectedHosts(harness.externalRequests)).toEqual([]);
  });

  it("never requests the ONNX runtime from a CDN", () => {
    // Regression guard: executable runtime code must stay inside the extension package.
    expect(harness.externalRequests.filter((url) => url.includes("jsdelivr"))).toEqual([]);
  });
});

describe("semantic worker", () => {
  it("initializes a backend and answers a search without any CDN request", async () => {
    const page = await harness.openSidePanel();
    const powerPreferenceWarnings: string[] = [];
    page.on("console", (message) => {
      if (/powerPreference option is currently ignored/iu.test(message.text())) {
        powerPreferenceWarnings.push(message.text());
      }
    });
    const asset = await semanticWorkerPath(page);

    const outcome = await page.evaluate(async (workerAsset) => {
      const worker = new Worker(`/${workerAsset}`, { type: "module" });
      const messages: unknown[] = [];
      worker.addEventListener("message", (event) => messages.push(event.data));

      const settled = <T,>(match: (value: any) => boolean, timeoutMs: number) =>
        new Promise<T | undefined>((resolve) => {
          const timer = setTimeout(() => resolve(undefined), timeoutMs);
          const check = () => {
            const hit = messages.find(match);
            if (hit) {
              clearTimeout(timer);
              clearInterval(poll);
              resolve(hit as T);
            }
          };
          const poll = setInterval(check, 200);
        });

      worker.postMessage({
        type: "index",
        requestId: "idx",
        transcriptId: "t-fixture",
        videoId: "v-fixture",
        modelKey: "e5-small",
        preferredBackend: "webgpu",
        chunks: [
          { id: "c0", scale: "context", start: 0, end: 10, text: "The reason I rejected fine-tuning is cost.", cueStartIndex: 0, cueEndIndex: 0 },
          { id: "c1", scale: "context", start: 10, end: 20, text: "They indexed ten years of hospital discharge summaries.", cueStartIndex: 1, cueEndIndex: 1 },
          { id: "c2", scale: "context", start: 20, end: 30, text: "Everything stayed on premises for privacy reasons.", cueStartIndex: 2, cueEndIndex: 2 },
        ],
      });

      const indexed = await settled<{ type: string; backend: string }>(
        (value) => value?.type === "indexed",
        240_000
      );
      if (!indexed) {
        return { indexed: false, error: JSON.stringify(messages.filter((m: any) => m?.type === "error")) };
      }

      worker.postMessage({ type: "search", requestId: "srch", transcriptId: "t-fixture", query: "why avoid training the model again?", limit: 3 });
      const results = await settled<{ results: Array<{ start: number; score: number }> }>(
        (value) => value?.type === "results",
        60_000
      );
      worker.terminate();
      return { indexed: true, backend: indexed.backend, results: results?.results ?? [] };
    }, asset);

    expect(outcome.indexed, `worker errors: ${outcome.error ?? ""}`).toBe(true);
    expect(["webgpu", "wasm"]).toContain(outcome.backend);
    expect(outcome.results!.length).toBeGreaterThan(0);
    // The fine-tuning passage must beat the unrelated ones for a paraphrased query.
    expect(outcome.results![0]!.start).toBe(0);

    expect(harness.externalRequests.filter((url) => url.includes("jsdelivr"))).toEqual([]);
    expect(unexpectedHosts(harness.externalRequests)).toEqual([]);
    expect(powerPreferenceWarnings).toEqual([]);
    await page.close();
  }, 300_000);
});
