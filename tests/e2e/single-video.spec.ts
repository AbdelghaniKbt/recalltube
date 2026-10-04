import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launch, type Harness } from "./harness";
import { watchPageHtml, type VideoFixture } from "./fixtures";

/**
 * The ordinary single-video path, at the scale and timing YouTube actually uses.
 *
 * Modelled on video 96jN2OCOfLs as rendered on 2026-09-16 with no extension loaded: the player
 * advertises an English track, timed text answers 200 with an empty body, and YouTube's own
 * transcript request takes several seconds before the panel fills. The expanded panel then holds
 * the 893-row list twice, and a second, HIDDEN transcript panel holds a populated copy.
 *
 * On that page the packaged extension sat in "Reading captions…" for ~220 s with its content script
 * too busy to answer messages. The other browser tests used two-row panels and never saw it.
 */

const ROWS = 893;
const VIDEO: VideoFixture = {
  id: "bigwithheld1",
  title: "A long talk whose timed text YouTube withholds",
  tracks: [{ lang: "en", name: "English" }],
  emptyBody: true,
};

function nativeTranscriptScript(): string {
  return `<script>
  (() => {
    const ROWS = ${ROWS};
    const clock = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
    const list = () => {
      let html = "";
      for (let i = 0; i < ROWS; i += 1) {
        html += '<ytd-transcript-segment-renderer class="style-scope ytd-transcript-segment-list-renderer">' +
          '<div class="segment" role="button"><div class="segment-start-offset"><div class="segment-timestamp">' + clock(i * 3) + '</div></div>' +
          '<yt-formatted-string class="segment-text">talk line ' + i + ' about retrieval</yt-formatted-string></div>' +
          '</ytd-transcript-segment-renderer>';
      }
      return '<ytd-transcript-renderer><ytd-transcript-search-panel-renderer><ytd-transcript-segment-list-renderer>' +
        '<div id="segments-container">' + html + '</div></ytd-transcript-segment-list-renderer></ytd-transcript-search-panel-renderer></ytd-transcript-renderer>';
    };
    window.nativeOpens = 0;
    window.nativeCloses = 0;

    const hiddenCopy = document.createElement("ytd-engagement-panel-section-list-renderer");
    hiddenCopy.setAttribute("target-id", "engagement-panel-searchable-transcript");
    hiddenCopy.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    hiddenCopy.innerHTML = list();

    const native = document.createElement("ytd-engagement-panel-section-list-renderer");
    native.setAttribute("target-id", "engagement-panel-searchable-transcript");
    native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");

    const section = document.createElement("ytd-video-description-transcript-section-renderer");
    section.innerHTML = '<button aria-label="Show transcript">Show transcript</button>';
    section.querySelector("button").addEventListener("click", () => {
      window.nativeOpens += 1;
      native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      native.innerHTML = '<div id="header"><button aria-label="Close">x</button></div><yt-content-loading-renderer></yt-content-loading-renderer>';
      native.querySelector("button[aria-label='Close']").addEventListener("click", () => {
        window.nativeCloses += 1;
        native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      });
      // YouTube's own transcript request: rows arrive seconds after the click, in two passes.
      setTimeout(() => {
        native.querySelector("yt-content-loading-renderer")?.remove();
        native.insertAdjacentHTML("beforeend", list());
      }, 2500);
      setTimeout(() => native.insertAdjacentHTML("beforeend", list()), 3200);
    });
    document.body.append(section, native, hiddenCopy);
  })();
  </script>`;
}

let harness: Harness;

beforeAll(async () => {
  harness = await launch();
  await harness.context.route(/^https:\/\/www\.youtube\.com\/api\/timedtext/, (route) =>
    route.fulfill({ status: 200, contentType: "text/html", body: "" })
  );
  await harness.context.route(/^https:\/\/www\.youtube\.com\/watch/, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: watchPageHtml(VIDEO).replace("</body>", `${nativeTranscriptScript()}</body>`),
    })
  );
}, 120_000);

afterAll(async () => harness?.close());

describe("ordinary single video with withheld timed text", () => {
  it("captures a real-size native transcript automatically, stays responsive, restores YouTube, and searches", async () => {
    const watch = await harness.context.newPage();
    await watch.goto(`https://www.youtube.com/watch?v=${VIDEO.id}`);
    const panel = await harness.openSidePanel();
    await watch.bringToFront();

    // A normal watch tab: no playlist-worker marker, no playlist context.
    expect(new URL(watch.url()).hash).toBe("");
    expect(new URL(watch.url()).searchParams.get("list")).toBeNull();

    // Automatic acquisition: nothing sends `recalltube:refresh`. While it runs, the content script
    // must keep answering; the defect made every message wait behind a multi-minute scan.
    const latencies: number[] = [];
    let status = "";
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && status !== "ready" && status !== "failed") {
      const started = Date.now();
      const response = await panel.evaluate(async (videoId) => {
        const tab = (await chrome.tabs.query({})).find((candidate) => candidate.url?.includes(videoId));
        return tab?.id === undefined ? undefined : chrome.tabs.sendMessage(tab.id, { type: "recalltube:get-state" });
      }, VIDEO.id);
      latencies.push(Date.now() - started);
      status = response?.snapshot?.status ?? "";
      await panel.waitForTimeout(250);
    }
    expect(status).toBe("ready");
    expect(Math.max(...latencies)).toBeLessThan(2_000);

    await panel.getByText(`${ROWS} captions`).waitFor({ timeout: 15_000 });
    await panel.getByText("CAPTURED", { exact: true }).waitFor({ timeout: 15_000 });

    const lifecycle = await watch.evaluate(() => {
      const scope = window as unknown as { nativeOpens: number; nativeCloses: number };
      const panels = [...document.querySelectorAll("[target-id='engagement-panel-searchable-transcript']")];
      return {
        opens: scope.nativeOpens,
        closes: scope.nativeCloses,
        visibilities: panels.map((element) => element.getAttribute("visibility")),
      };
    });
    expect(lifecycle).toEqual({
      opens: 1,
      closes: 1,
      visibilities: ["ENGAGEMENT_PANEL_VISIBILITY_HIDDEN", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"],
    });

    // Search through the real side-panel input and get a timestamped moment from the late rows.
    await panel.getByRole("textbox").first().fill("talk line 850");
    const firstResult = panel.locator(".result-card").first();
    await firstResult.waitFor({ timeout: 15_000 });
    // Row 850 starts at 850 x 3 s = 42:30.
    await expect.poll(() => firstResult.locator(".timestamp").first().innerText(), { timeout: 10_000 }).toContain("42:30");

    expect(watch.url()).toBe(`https://www.youtube.com/watch?v=${VIDEO.id}`);
    await panel.close();
    await watch.close();
  }, 120_000);
});
