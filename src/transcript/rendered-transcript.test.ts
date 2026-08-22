import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The rendered-transcript reader is the only caption source left when YouTube's timed-text
 * endpoint withholds a body, so it must survive component renames and shadow DOM. The served
 * YouTube HTML contains none of these element names — they are created client-side — so they
 * cannot be verified ahead of time and must not be depended on.
 */

async function withDom(html: string, run: () => Promise<void> | void) {
  const dom = new JSDOM(html, { url: "https://www.youtube.com/watch?v=abc" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, window: globals.window, location: globals.location };
  globals.document = dom.window.document;
  globals.window = dom.window;
  try {
    await run();
  } finally {
    Object.assign(globals, saved);
  }
}

function panel(rows: string): string {
  return `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript">
    ${rows}
  </ytd-engagement-panel-section-list-renderer>`;
}

afterEach(() => {
  // Modules read `document` lazily, so nothing to reset beyond withDom's restore.
});

describe("rendered transcript reader", () => {
  it("reads YouTube's known markup", async () => {
    await withDom(
      panel(`
        <ytd-transcript-segment-renderer>
          <div class="segment-timestamp">0:04</div>
          <yt-formatted-string class="segment-text">Welcome back to the show</yt-formatted-string>
        </ytd-transcript-segment-renderer>
        <ytd-transcript-segment-renderer>
          <div class="segment-timestamp">1:12</div>
          <yt-formatted-string class="segment-text">and today we talk about retrieval</yt-formatted-string>
        </ytd-transcript-segment-renderer>`),
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        const read = readRenderedRowsForTest();
        expect(read.strategy).toMatch(/^known/);
        expect(read.cues).toEqual([
          { start: 4, end: 4, text: "Welcome back to the show" },
          { start: 72, end: 72, text: "and today we talk about retrieval" },
        ]);
      }
    );
  });

  it("falls back to a structural scan when the components have been renamed", async () => {
    await withDom(
      panel(`
        <yt-brand-new-row><span>0:00</span><span>First line of the transcript</span></yt-brand-new-row>
        <yt-brand-new-row><span>0:15</span><span>Second line of the transcript</span></yt-brand-new-row>
        <yt-brand-new-row><span>1:02:30</span><span>A line more than an hour in</span></yt-brand-new-row>`),
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        const read = readRenderedRowsForTest();
        expect(read.strategy).toMatch(/^structural/);
        expect(read.cues).toEqual([
          { start: 0, end: 0, text: "First line of the transcript" },
          { start: 15, end: 15, text: "Second line of the transcript" },
          { start: 3750, end: 3750, text: "A line more than an hour in" },
        ]);
      }
    );
  });

  it("keeps only innermost rows, so a container is not read as one giant cue", async () => {
    await withDom(
      panel(`
        <div id="all">
          <div class="row">0:00 alpha line</div>
          <div class="row">0:10 bravo line</div>
          <div class="row">0:20 charlie line</div>
        </div>`),
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        const read = readRenderedRowsForTest();
        expect(read.cues).toHaveLength(3);
        expect(read.cues.map((cue) => cue.text)).toEqual(["alpha line", "bravo line", "charlie line"]);
      }
    );
  });

  it("does not mistake a couple of timestamped chrome elements for a transcript", async () => {
    await withDom(panel(`<div class="row">0:00 only one row</div>`), async () => {
      const { readRenderedRowsForTest } = await import("./acquire");
      expect(readRenderedRowsForTest().cues).toEqual([]);
    });
  });

  it("returns nothing when there is no transcript panel at all", async () => {
    await withDom(`<div id="content">Just a page, 12:34 is a time but there is no panel</div>`, async () => {
      const { readRenderedRowsForTest } = await import("./acquire");
      expect(readRenderedRowsForTest().cues).toEqual([]);
    });
  });
});

describe("modern transcript UI", () => {
  // YouTube ships a second, view-model based transcript UI whose element and class names share
  // nothing with the Polymer one. Verified against CaptionClip's content script, which handles
  // both families: https://github.com/atarantino/CaptionClip
  it("reads the transcript-segment-view-model family", async () => {
    await withDom(
      `<ytd-engagement-panel-section-list-renderer target-id="PAmodern_transcript_view">
        <transcript-segment-view-model>
          <div class="ytwTranscriptSegmentViewModelTimestamp">0:07</div>
          <span class="ytAttributedStringHost">Modern UI first line</span>
        </transcript-segment-view-model>
        <transcript-segment-view-model>
          <div class="ytwTranscriptSegmentViewModelTimestamp">2:30</div>
          <span class="ytAttributedStringHost">Modern UI second line</span>
        </transcript-segment-view-model>
      </ytd-engagement-panel-section-list-renderer>`,
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        const read = readRenderedRowsForTest();
        expect(read.strategy).toMatch(/^known/);
        expect(read.cues).toEqual([
          { start: 7, end: 7, text: "Modern UI first line" },
          { start: 150, end: 150, text: "Modern UI second line" },
        ]);
      }
    );
  });

  it("reads rows that expose their text through role=text", async () => {
    await withDom(
      `<div target-id="PAmodern_transcript_view">
        <div class="ytwTranscriptSegmentViewModelHost">
          <div class="ytwTranscriptSegmentViewModelTimestamp">10:05</div>
          <div role="text">Text exposed only through a role attribute</div>
        </div>
        <div class="ytwTranscriptSegmentViewModelHost">
          <div class="ytwTranscriptSegmentViewModelTimestamp">11:00</div>
          <div role="text">A second such row</div>
        </div>
      </div>`,
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        const read = readRenderedRowsForTest();
        expect(read.cues.map((cue) => cue.start)).toEqual([605, 660]);
      }
    );
  });

  it("crosses nested open shadow roots for both the panel and its rows", async () => {
    await withDom(`<div id="youtube-app"></div>`, async () => {
      const app = document.querySelector<HTMLElement>("#youtube-app")!;
      const appRoot = app.attachShadow({ mode: "open" });
      const transcript = document.createElement("ytd-engagement-panel-section-list-renderer");
      transcript.setAttribute("target-id", "PAmodern_transcript_view");
      appRoot.append(transcript);

      const panelRoot = transcript.attachShadow({ mode: "open" });
      for (const [label, text] of [
        ["7 seconds", "A caption inside nested shadow DOM"],
        ["1 minute, 5 seconds", "The second nested caption"],
      ]) {
        const row = document.createElement("transcript-segment-view-model");
        row.className = "ytwTranscriptSegmentViewModelHost";
        const rowRoot = row.attachShadow({ mode: "open" });
        rowRoot.innerHTML = `<span class="ytwTranscriptSegmentViewModelTimestamp" aria-label="${label}"></span>
          <span class="ytAttributedStringHost">${text}</span>`;
        panelRoot.append(row);
      }

      const { readRenderedRowsForTest } = await import("./acquire");
      expect(readRenderedRowsForTest()).toMatchObject({
        cues: [
          { start: 7, text: "A caption inside nested shadow DOM" },
          { start: 65, text: "The second nested caption" },
        ],
      });
    });
  });

  it("uses specific transcript rows even when YouTube renames the panel wrapper", async () => {
    await withDom(
      `<yt-new-panel-name>
        <transcript-segment-view-model>
          <span class="ytwTranscriptSegmentViewModelTimestamp">0:02</span>
          <span class="ytAttributedStringHost">Known row in an unknown panel</span>
        </transcript-segment-view-model>
      </yt-new-panel-name>`,
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        const read = readRenderedRowsForTest();
        expect(read.strategy).toBe("known-global(1)");
        expect(read.cues[0]).toMatchObject({ start: 2, text: "Known row in an unknown panel" });
      }
    );
  });

  it("chooses the fullest valid panel instead of the first non-empty panel", async () => {
    await withDom(
      `${panel(`<ytd-transcript-segment-renderer><span class="segment-timestamp">0:00</span><span class="segment-text">stale row</span></ytd-transcript-segment-renderer>`)}
       ${panel(`
         <ytd-transcript-segment-renderer><span class="segment-timestamp">0:00</span><span class="segment-text">first full row</span></ytd-transcript-segment-renderer>
         <ytd-transcript-segment-renderer><span class="segment-timestamp">0:10</span><span class="segment-text">second full row</span></ytd-transcript-segment-renderer>
         <ytd-transcript-segment-renderer><span class="segment-timestamp">0:20</span><span class="segment-text">third full row</span></ytd-transcript-segment-renderer>`)} `,
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        expect(readRenderedRowsForTest().cues.map((cue) => cue.text)).toEqual([
          "first full row",
          "second full row",
          "third full row",
        ]);
      }
    );
  });

  it("discovers the transcript control inside a shadow-root description", async () => {
    await withDom(`<div id="primary"></div>`, async () => {
      const primary = document.querySelector<HTMLElement>("#primary")!;
      const root = primary.attachShadow({ mode: "open" });
      const section = document.createElement("ytd-video-description-transcript-section-renderer");
      const sectionRoot = section.attachShadow({ mode: "open" });
      sectionRoot.innerHTML = `<button aria-controls="engagement-panel-searchable-transcript">Show it</button>`;
      root.append(section);

      const { transcriptPanelState } = await import("./acquire");
      expect(transcriptPanelState()).toBe("available");
    });
  });

  it("opens, captures, and closes the native panel when direct captions fail", async () => {
    await withDom(`<div id="primary"></div>`, async () => {
      const primary = document.querySelector<HTMLElement>("#primary")!;
      const root = primary.attachShadow({ mode: "open" });
      const section = document.createElement("ytd-video-description-transcript-section-renderer");
      const sectionRoot = section.attachShadow({ mode: "open" });
      sectionRoot.innerHTML = `<button aria-controls="engagement-panel-searchable-transcript">Show transcript</button>`;
      root.append(section);

      let opens = 0;
      let closes = 0;
      sectionRoot.querySelector("button")!.addEventListener("click", () => {
        opens += 1;
        const native = document.createElement("ytd-engagement-panel-section-list-renderer");
        native.setAttribute("target-id", "engagement-panel-searchable-transcript");
        native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
        native.innerHTML = `<button id="close-button" aria-label="Close transcript">Close</button>
          <ytd-transcript-segment-renderer><span class="segment-timestamp">0:03</span><span class="segment-text">First captured row</span></ytd-transcript-segment-renderer>
          <ytd-transcript-segment-renderer><span class="segment-timestamp">0:11</span><span class="segment-text">Second captured row</span></ytd-transcript-segment-renderer>`;
        native.querySelector("#close-button")!.addEventListener("click", () => {
          closes += 1;
          native.remove();
        });
        document.body.append(native);
      });

      const { NativePanelTranscriptAdapter } = await import("./acquire");
      const result = await new NativePanelTranscriptAdapter().acquire(
        { videoId: "abc", generation: 1 },
        new AbortController().signal
      );
      expect(result.ok).toBe(true);
      expect(result.ok && result.transcript.cues.map((cue) => cue.text)).toEqual([
        "First captured row",
        "Second captured row",
      ]);
      expect({ opens, closes }).toEqual({ opens: 1, closes: 1 });
      expect(document.querySelector("[target-id='engagement-panel-searchable-transcript']")).toBeNull();
    });
  });

  it("preserves a transcript panel that the user already had open", async () => {
    await withDom(
      `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript"
          visibility="ENGAGEMENT_PANEL_VISIBILITY_EXPANDED">
        <button id="close-button" aria-label="Close transcript">Close</button>
        <ytd-transcript-segment-renderer><span class="segment-timestamp">0:04</span><span class="segment-text">User-owned panel row</span></ytd-transcript-segment-renderer>
      </ytd-engagement-panel-section-list-renderer>`,
      async () => {
        let closes = 0;
        document.querySelector("#close-button")!.addEventListener("click", () => { closes += 1; });
        const { NativePanelTranscriptAdapter } = await import("./acquire");
        const result = await new NativePanelTranscriptAdapter().acquire(
          { videoId: "abc", generation: 1 },
          new AbortController().signal
        );
        expect(result.ok).toBe(true);
        expect(closes).toBe(0);
        expect(document.querySelector("[target-id='engagement-panel-searchable-transcript']")).not.toBeNull();
      }
    );
  });

  it("closes a panel it opened even when acquisition is cancelled", async () => {
    await withDom(`<div id="primary"></div>`, async () => {
      const primary = document.querySelector<HTMLElement>("#primary")!;
      const root = primary.attachShadow({ mode: "open" });
      root.innerHTML = `<ytd-video-description-transcript-section-renderer>
        <button aria-controls="engagement-panel-searchable-transcript">Show transcript</button>
      </ytd-video-description-transcript-section-renderer>`;
      let closes = 0;
      root.querySelector("button")!.addEventListener("click", () => {
        const native = document.createElement("ytd-engagement-panel-section-list-renderer");
        native.setAttribute("target-id", "engagement-panel-searchable-transcript");
        native.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
        native.innerHTML = `<button id="close-button" aria-label="Close transcript">Close</button>`;
        native.querySelector("button")!.addEventListener("click", () => {
          closes += 1;
          native.remove();
        });
        document.body.append(native);
      });

      const controller = new AbortController();
      window.setTimeout(() => controller.abort(), 30);
      const { NativePanelTranscriptAdapter } = await import("./acquire");
      await expect(
        new NativePanelTranscriptAdapter().acquire({ videoId: "abc", generation: 1 }, controller.signal)
      ).rejects.toThrow(/cancelled/iu);
      expect(closes).toBe(1);
    });
  });

});

describe("does not mistake YouTube's own UI for a transcript", () => {
  // Reported from a live session: the reader returned 8 "captions" that were sidebar
  // recommendations. YouTube stamps each card with a duration badge, so "12:27" followed by a
  // video title matches a timestamped row exactly. Searching then matched video titles instead of
  // anything the speaker said.
  const sidebar = `
    <div id="secondary">
      <ytd-compact-video-renderer>
        <span>12:27</span><span>The Vibe Coding Era: Why AI Won't Replace Software Engineers</span>
        <span>Bloomberg Television</span><span>497k views</span><span>2 months ago</span>
      </ytd-compact-video-renderer>
      <ytd-compact-video-renderer>
        <span>8:04</span><span>Another recommended video entirely</span>
        <span>Some Channel</span><span>120k views</span><span>1 year ago</span>
      </ytd-compact-video-renderer>
      <ytd-compact-video-renderer>
        <span>45:10</span><span>A third recommendation</span>
        <span>Third Channel</span><span>3.4M views</span><span>3 weeks ago</span>
      </ytd-compact-video-renderer>
    </div>`;

  it("returns nothing when only the sidebar has timestamps", async () => {
    await withDom(sidebar, async () => {
      const { readRenderedRowsForTest } = await import("./acquire");
      // No transcript panel exists, so there is nothing legitimate to read.
      expect(readRenderedRowsForTest().cues).toEqual([]);
    });
  });

  it("ignores the sidebar even when an empty transcript panel is present", async () => {
    await withDom(
      `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript"
         visibility="ENGAGEMENT_PANEL_VISIBILITY_HIDDEN"></ytd-engagement-panel-section-list-renderer>
       ${sidebar}`,
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        expect(readRenderedRowsForTest().cues).toEqual([]);
      }
    );
  });

  it("rejects rows whose timestamps are not in playback order", async () => {
    await withDom(
      `<div target-id="engagement-panel-searchable-transcript">
        <div class="row">5:00 later moment</div>
        <div class="row">1:00 earlier moment</div>
        <div class="row">9:00 latest moment</div>
      </div>`,
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        expect(readRenderedRowsForTest().cues).toEqual([]);
      }
    );
  });

  it("rejects rows far too long to be a caption line", async () => {
    const long = "x".repeat(400);
    await withDom(
      `<div target-id="engagement-panel-searchable-transcript">
        <div class="row">0:00 ${long}</div>
        <div class="row">0:10 ${long}</div>
        <div class="row">0:20 ${long}</div>
      </div>`,
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        expect(readRenderedRowsForTest().cues).toEqual([]);
      }
    );
  });

  it("still reads a genuine transcript inside the panel while the sidebar is present", async () => {
    await withDom(
      `<div target-id="engagement-panel-searchable-transcript">
        <div class="row">0:00 the speaker begins</div>
        <div class="row">0:12 and continues talking</div>
        <div class="row">0:25 and finishes the point</div>
      </div>
      ${sidebar}`,
      async () => {
        const { readRenderedRowsForTest } = await import("./acquire");
        const read = readRenderedRowsForTest();
        expect(read.cues.map((cue) => cue.text)).toEqual([
          "the speaker begins",
          "and continues talking",
          "and finishes the point",
        ]);
      }
    );
  });
});
