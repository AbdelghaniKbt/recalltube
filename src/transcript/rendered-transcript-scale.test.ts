import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/**
 * Scale regressions for the native-transcript reader, built from the structure YouTube actually
 * rendered for video 96jN2OCOfLs on 2026-09-16 (captured with no extension loaded):
 *
 *   ytd-engagement-panel-section-list-renderer[target-id=engagement-panel-searchable-transcript]
 *     [visibility=ENGAGEMENT_PANEL_VISIBILITY_EXPANDED]  (8,332 descendants)
 *     ytd-transcript-renderer > ytd-transcript-search-panel-renderer >
 *     ytd-transcript-segment-list-renderer > div#segments-container >
 *     ytd-transcript-segment-renderer × 893 > div.segment >
 *       div.segment-start-offset > div.segment-timestamp ("M:SS" / "MM:SS")
 *       yt-formatted-string.segment-text
 *
 * plus a second, HIDDEN `engagement-panel-searchable-transcript` panel holding an identical copy.
 *
 * In a real browser the reader took ~220 s to finish on that page: the structural fallback ran even
 * after the known-row reader succeeded, did an O(n²) `Node.contains` pass over every ancestor of
 * every row, scanned each nested renderer as its own scope, and `isExpandedTranscriptPanel` re-ran
 * the entire read for every nested renderer lacking a `visibility` attribute on every close check.
 */

const ROWS = 900;

function clock(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function rows(prefix: string): string {
  let html = "";
  for (let index = 0; index < ROWS; index += 1) {
    const seconds = index * 3;
    html += `<ytd-transcript-segment-renderer class="style-scope ytd-transcript-segment-list-renderer">
      <div class="segment style-scope ytd-transcript-segment-renderer" role="button">
        <div class="segment-start-offset style-scope ytd-transcript-segment-renderer">
          <div class="segment-timestamp style-scope ytd-transcript-segment-renderer">${clock(seconds)}</div>
        </div>
        <yt-formatted-string class="segment-text style-scope ytd-transcript-segment-renderer">${prefix} line ${index} of the talk</yt-formatted-string>
      </div>
    </ytd-transcript-segment-renderer>`;
  }
  return html;
}

function panel(visibility: string, prefix: string): string {
  return `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="${visibility}">
    <div id="header"><button aria-label="Close">x</button></div>
    <ytd-transcript-renderer><div id="content">
      <ytd-transcript-search-panel-renderer><div id="body">
        <ytd-transcript-segment-list-renderer><div id="segments-container">${rows(prefix)}</div></ytd-transcript-segment-list-renderer>
      </div></ytd-transcript-search-panel-renderer>
    </div></ytd-transcript-renderer>
  </ytd-engagement-panel-section-list-renderer>`;
}

async function withDom<T>(html: string, run: () => Promise<T>): Promise<T> {
  const dom = new JSDOM(`<body>${html}</body>`, { url: "https://www.youtube.com/watch?v=96jN2OCOfLs" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, window: globals.window };
  globals.document = dom.window.document;
  globals.window = dom.window;
  try {
    return await run();
  } finally {
    Object.assign(globals, saved);
  }
}

describe("native transcript reader at real YouTube scale", () => {
  it("reads a 900-row expanded panel once, quickly, through the known-row path", async () => {
    await withDom(panel("ENGAGEMENT_PANEL_VISIBILITY_EXPANDED", "current") + panel("ENGAGEMENT_PANEL_VISIBILITY_HIDDEN", "current"), async () => {
      const { readRenderedRowsForTest } = await import("./acquire");
      const started = performance.now();
      const read = readRenderedRowsForTest();
      const elapsed = performance.now() - started;
      expect(read.cues).toHaveLength(ROWS);
      expect(read.strategy).toMatch(/^known/);
      expect(read.cues.at(-1)).toMatchObject({ start: (ROWS - 1) * 3, text: `current line ${ROWS - 1} of the talk` });
      // Generous for jsdom on a slow CI machine; the defect took minutes.
      expect(elapsed).toBeLessThan(3_000);
    });
  }, 60_000);

  it("never reads rows out of a panel YouTube marks hidden", async () => {
    // A hidden panel can still hold another video's rows after SPA navigation.
    await withDom(panel("ENGAGEMENT_PANEL_VISIBILITY_HIDDEN", "stale"), async () => {
      const { readRenderedRowsForTest } = await import("./acquire");
      expect(readRenderedRowsForTest().cues).toEqual([]);
    });
  }, 60_000);

  it("opens nothing, captures the expanded panel and closes it within a bounded time", async () => {
    await withDom(panel("ENGAGEMENT_PANEL_VISIBILITY_EXPANDED", "current"), async () => {
      const { closeTranscriptPanelsForTest } = await import("./acquire");
      const closeButton = document.querySelector<HTMLButtonElement>("button[aria-label='Close']")!;
      const expanded = document.querySelector("ytd-engagement-panel-section-list-renderer")!;
      closeButton.addEventListener("click", () =>
        expanded.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN")
      );
      const started = performance.now();
      const closed = await closeTranscriptPanelsForTest();
      expect(closed).toBe(true);
      expect(expanded.getAttribute("visibility")).toBe("ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      expect(performance.now() - started).toBeLessThan(3_000);
    });
  }, 60_000);
});

describe("the chaptered 'In this video' transcript panel", () => {
  // Captured 2026-09-16 on l8pRSuU81PU (4 h, chapters) with no extension loaded. "Show transcript"
  // sends `get_panel`, not `get_transcript`, and fills an engagement panel that has NO target-id
  // and none of the ytd-transcript-* wrappers:
  //   ytd-engagement-panel-section-list-renderer[is-sync-scroll-panel][visibility=EXPANDED]
  //     > div#content > yt-section-list-renderer > div > yt-item-section-renderer > div#contents
  //     > div > macro-markers-panel-item-view-model > timeline-item-view-model > div
  //     > transcript-segment-view-model (div.ytwTranscriptSegmentViewModelTimestamp,
  //       div.ytwTranscriptSegmentViewModelTimestampA11yLabel, span.ytAttributedStringHost)
  // 1,813 rows. A hidden `engagement-panel-searchable-transcript` panel also exists, so the reader's
  // "no panel at all" fallback never ran and capture failed with "panel available".
  const MODERN_ROWS = 1_813;

  function modernPanel(visibility: string): string {
    let items = "";
    for (let index = 0; index < MODERN_ROWS; index += 1) {
      if (index % 60 === 0) {
        items += `<macro-markers-panel-item-view-model><timeline-item-view-model><div><span class="ytAttributedStringHost">Chapter ${index / 60}</span></div></timeline-item-view-model></macro-markers-panel-item-view-model>`;
      }
      items += `<div><macro-markers-panel-item-view-model><timeline-item-view-model><div>
        <transcript-segment-view-model>
          <div class="ytwTranscriptSegmentViewModelTimestamp">${clock(index * 8)}</div>
          <div class="ytwTranscriptSegmentViewModelTimestampA11yLabel">${index * 8} seconds</div>
          <span class="ytAttributedStringHost ytAttributedStringLinkInheritColor">modern line ${index}</span>
        </transcript-segment-view-model>
      </div></timeline-item-view-model></macro-markers-panel-item-view-model></div>`;
    }
    return `<ytd-engagement-panel-section-list-renderer class="match-content-theme" is-sync-scroll-panel visibility="${visibility}">
      <div id="header"><button aria-label="Close">x</button><button aria-label="Chapters">c</button><button aria-label="Transcript">t</button></div>
      <div id="content"><yt-section-list-renderer><div><yt-item-section-renderer><div id="contents">${items}</div></yt-item-section-renderer></div></yt-section-list-renderer></div>
    </ytd-engagement-panel-section-list-renderer>`;
  }

  const hiddenSearchable = `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript" visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"></ytd-engagement-panel-section-list-renderer>`;

  it("reads rows from an untargeted engagement panel that holds transcript rows", async () => {
    await withDom(hiddenSearchable + modernPanel("ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"), async () => {
      const { readRenderedRowsForTest } = await import("./acquire");
      const read = readRenderedRowsForTest();
      expect(read.strategy).toMatch(/^known/);
      expect(read.cues).toHaveLength(MODERN_ROWS);
      expect(read.cues[1]).toEqual({ start: 8, end: 8, text: "modern line 1" });
      expect(read.cues.at(-1)?.text).toBe(`modern line ${MODERN_ROWS - 1}`);
    });
  }, 60_000);

  it("still ignores that panel while YouTube keeps it hidden", async () => {
    await withDom(hiddenSearchable + modernPanel("ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"), async () => {
      const { readRenderedRowsForTest } = await import("./acquire");
      expect(readRenderedRowsForTest().cues).toEqual([]);
    });
  }, 60_000);

  it("closes the untargeted panel it captured from", async () => {
    await withDom(hiddenSearchable + modernPanel("ENGAGEMENT_PANEL_VISIBILITY_EXPANDED"), async () => {
      const { closeTranscriptPanelsForTest } = await import("./acquire");
      const modern = document.querySelector("[is-sync-scroll-panel]")!;
      modern.querySelector("button[aria-label='Close']")!.addEventListener("click", () =>
        modern.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN")
      );
      expect(await closeTranscriptPanelsForTest()).toBe(true);
      expect(modern.getAttribute("visibility")).toBe("ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    });
  }, 60_000);
});

describe("slow transcript delivery", () => {
  it("keeps waiting while YouTube's loader is shown, captures every batch, and reports progress", async () => {
    await withDom(`<div id="primary"></div>`, async () => {
      const section = document.createElement("ytd-video-description-transcript-section-renderer");
      section.innerHTML = `<button aria-label="Show transcript">Show transcript</button>`;
      document.querySelector("#primary")!.append(section);
      const native = document.createElement("ytd-engagement-panel-section-list-renderer");
      native.setAttribute("target-id", "engagement-panel-searchable-transcript");
      native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
      document.body.append(native);

      const batch = (from: number, to: number) => {
        let html = "";
        for (let index = from; index < to; index += 1) {
          html += `<ytd-transcript-segment-renderer><div class="segment-timestamp">${clock(index * 3)}</div><yt-formatted-string class="segment-text">slow line ${index}</yt-formatted-string></ytd-transcript-segment-renderer>`;
        }
        return html;
      };
      section.querySelector("button")!.addEventListener("click", () => {
        native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
        native.innerHTML = `<button aria-label="Close">x</button><yt-content-loading-renderer></yt-content-loading-renderer><div id="list"></div>`;
        native.querySelector("button")!.addEventListener("click", () =>
          native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN")
        );
        // First batch, then a pause longer than the quiet window while the loader is still shown.
        window.setTimeout(() => native.querySelector("#list")!.insertAdjacentHTML("beforeend", batch(0, 200)), 300);
        window.setTimeout(() => {
          native.querySelector("#list")!.insertAdjacentHTML("beforeend", batch(200, 400));
          native.querySelector("yt-content-loading-renderer")?.remove();
        }, 2_200);
      });

      const phases: string[] = [];
      const { NativePanelTranscriptAdapter } = await import("./acquire");
      const result = await new NativePanelTranscriptAdapter().acquire(
        { videoId: "slowvideo01", generation: 1, onProgress: (phase) => phases.push(phase) },
        new AbortController().signal
      );
      expect(result.ok).toBe(true);
      expect(result.ok && result.transcript.cues.at(-1)?.text).toBe("slow line 399");
      expect([...new Set(phases)]).toEqual(["native-control", "native-open", "native-rows", "native-settle", "native-read"]);
      expect(result.diagnostics.at(-1)?.detail).toMatch(/control \d+ms, open \d+ms, rows \d+ms, settle \d+ms, read \d+ms/u);
      expect(native.getAttribute("visibility")).toBe("ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    });
  }, 60_000);
});

describe("slow watch pages", () => {
  function nativePanelOnClick(section: Element, rowsDelayMs: number) {
    const native = document.createElement("ytd-engagement-panel-section-list-renderer");
    native.setAttribute("target-id", "engagement-panel-searchable-transcript");
    native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    document.body.append(native);
    section.querySelector("button")!.addEventListener("click", () => {
      native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      native.innerHTML = `<button aria-label="Close">x</button><yt-content-loading-renderer></yt-content-loading-renderer>`;
      native.querySelector("button")!.addEventListener("click", () =>
        native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN")
      );
      window.setTimeout(() => {
        native.querySelector("yt-content-loading-renderer")?.remove();
        native.insertAdjacentHTML(
          "beforeend",
          `<ytd-transcript-segment-renderer><div class="segment-timestamp">0:01</div><yt-formatted-string class="segment-text">late page line</yt-formatted-string></ytd-transcript-segment-renderer>`
        );
      }, rowsDelayMs);
    });
    return native;
  }

  it("waits for a watch page that is still being built instead of reporting no transcript", async () => {
    // Live at 4x CPU the control took up to 33 s to exist; a fixed 15 s wait called those videos
    // "no captions". Here the watch app shell exists from the start, as on YouTube, while the
    // description and its control appear only after 17 s.
    await withDom(`<ytd-app><ytd-watch-flexy><div id="primary"></div></ytd-watch-flexy></ytd-app>`, async () => {
      window.setTimeout(() => {
        document.querySelector("#primary")!.innerHTML = `<ytd-watch-metadata><div id="description"></div></ytd-watch-metadata>`;
      }, 17_000);
      window.setTimeout(() => {
        const section = document.createElement("ytd-video-description-transcript-section-renderer");
        section.innerHTML = `<button aria-label="Show transcript">Show transcript</button>`;
        document.querySelector("#primary")!.append(section);
        nativePanelOnClick(section, 200);
      }, 17_500);

      const { NativePanelTranscriptAdapter } = await import("./acquire");
      const result = await new NativePanelTranscriptAdapter().acquire(
        { videoId: "slowpage001", generation: 1 },
        new AbortController().signal
      );
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
    });
  }, 60_000);

  it("reports a heartbeat while YouTube's own loader is still shown", async () => {
    await withDom(`<div id="primary"></div>`, async () => {
      const section = document.createElement("ytd-video-description-transcript-section-renderer");
      section.innerHTML = `<button aria-label="Show transcript">Show transcript</button>`;
      document.querySelector("#primary")!.append(section);
      nativePanelOnClick(section, 5_000);

      const heartbeats: number[] = [];
      const { NativePanelTranscriptAdapter } = await import("./acquire");
      const result = await new NativePanelTranscriptAdapter().acquire(
        { videoId: "loader00001", generation: 1, onProgress: (phase) => phase === "native-rows" && heartbeats.push(Date.now()) },
        new AbortController().signal
      );
      expect(result.ok).toBe(true);
      expect(heartbeats.length).toBeGreaterThanOrEqual(2);
    });
  }, 60_000);
});

describe("YouTube's transcript request decides how long to wait", () => {
  // A user's session (Chrome 152): the panel opened in under a second, then YouTube's loader spun
  // for 122 s and no row ever rendered. These tests replay that with the request outcome observed.
  type FakeEntry = { name: string; startTime: number; duration: number; responseStatus: number; encodedBodySize: number };

  function installRequestTimeline() {
    const observers: Array<(entries: FakeEntry[]) => void> = [];
    (window as unknown as { PerformanceObserver: unknown }).PerformanceObserver = class {
      private readonly callback: (list: { getEntries(): FakeEntry[] }) => void;
      constructor(callback: (list: { getEntries(): FakeEntry[] }) => void) {
        this.callback = callback;
      }
      observe() {
        observers.push((entries) => this.callback({ getEntries: () => entries }));
      }
      disconnect() {}
    };
    return (status: number) => {
      // The adapter reads the global performance clock; in a browser the page and window share it.
      const now = performance.now();
      const entry = { name: "https://www.youtube.com/youtubei/v1/get_transcript?prettyPrint=false", startTime: now - 300, duration: 300, responseStatus: status, encodedBodySize: status < 400 ? 40_000 : 274 };
      for (const notify of observers) notify([entry]);
    };
  }

  function stuckPanel(onOpen: (native: Element, opens: number) => void) {
    const section = document.createElement("ytd-video-description-transcript-section-renderer");
    section.innerHTML = `<button aria-label="Show transcript">Show transcript</button>`;
    document.querySelector("#primary")!.append(section);
    const native = document.createElement("ytd-engagement-panel-section-list-renderer");
    native.setAttribute("target-id", "engagement-panel-searchable-transcript");
    native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
    document.body.append(native);
    let opens = 0;
    section.querySelector("button")!.addEventListener("click", () => {
      opens += 1;
      native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      native.innerHTML = `<button aria-label="Close">x</button><yt-content-loading-renderer></yt-content-loading-renderer>`;
      native.querySelector("button")!.addEventListener("click", () => {
        native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_HIDDEN");
        native.replaceChildren();
      });
      onOpen(native, opens);
    });
    return { opens: () => opens };
  }

  it("stops promptly when YouTube's own transcript request fails, without calling it no-captions", async () => {
    await withDom(`<div id="primary"></div>`, async () => {
      const respond = installRequestTimeline();
      stuckPanel(() => window.setTimeout(() => respond(400), 500));
      const started = Date.now();
      const { NativePanelTranscriptAdapter } = await import("./acquire");
      const result = await new NativePanelTranscriptAdapter().acquire({ videoId: "failreq0001", generation: 1 }, new AbortController().signal);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.reason).toBe("not-ready");
      expect(result.diagnostics.at(-1)?.detail).toMatch(/stopped: youtube-request-failed/u);
      expect(result.diagnostics.at(-1)?.detail).toMatch(/get_transcript 400/u);
      // The defect waited 120 s behind the loader.
      expect(Date.now() - started).toBeLessThan(10_000);
    });
  }, 60_000);

  it("reopens the panel once when YouTube answered but rendered nothing, and captures the second render", async () => {
    await withDom(`<div id="primary"></div>`, async () => {
      const respond = installRequestTimeline();
      const panel = stuckPanel((native, opens) => {
        window.setTimeout(() => respond(200), 300);
        if (opens === 2) {
          window.setTimeout(() => {
            native.querySelector("yt-content-loading-renderer")?.remove();
            native.insertAdjacentHTML(
              "beforeend",
              `<ytd-transcript-segment-renderer><div class="segment-timestamp">0:05</div><yt-formatted-string class="segment-text">rendered on reopen</yt-formatted-string></ytd-transcript-segment-renderer>`
            );
          }, 1_000);
        }
      });
      const { NativePanelTranscriptAdapter } = await import("./acquire");
      const result = await new NativePanelTranscriptAdapter().acquire({ videoId: "reopen00001", generation: 1 }, new AbortController().signal);
      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true);
      expect(result.ok && result.transcript.cues[0]?.text).toBe("rendered on reopen");
      expect(panel.opens()).toBe(2);
    });
  }, 90_000);
});
