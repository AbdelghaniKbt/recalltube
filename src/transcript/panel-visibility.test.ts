import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { readRenderedRowsForTest } from "./acquire";

/**
 * Which transcript panels the reader may take rows from.
 *
 * Live, during an SPA navigation to a related video, a panel momentarily carried no visibility
 * value while still holding the previous video's rows. "No signal means readable" accepted those
 * rows as the new video's transcript. Once YouTube's visibility attribute is present on any panel,
 * only a panel it marks EXPANDED is readable.
 */

async function withDom<T>(html: string, run: () => T): Promise<T> {
  const dom = new JSDOM(`<body>${html}</body>`, { url: "https://www.youtube.com/watch?v=abc" });
  const globals = globalThis as unknown as Record<string, unknown>;
  const saved = { document: globals.document, window: globals.window };
  globals.document = dom.window.document;
  globals.window = dom.window;
  try {
    return run();
  } finally {
    Object.assign(globals, saved);
  }
}

const rows = (prefix: string) =>
  [1, 2, 3]
    .map(
      (index) =>
        `<ytd-transcript-segment-renderer><div class="segment-timestamp">0:0${index}</div><yt-formatted-string class="segment-text">${prefix} ${index}</yt-formatted-string></ytd-transcript-segment-renderer>`
    )
    .join("");

const panel = (visibility: string | undefined, content: string) =>
  `<ytd-engagement-panel-section-list-renderer target-id="engagement-panel-searchable-transcript"${
    visibility ? ` visibility="ENGAGEMENT_PANEL_VISIBILITY_${visibility}"` : ""
  }>${content}</ytd-engagement-panel-section-list-renderer>`;

describe("readable transcript panels", () => {
  it("reads only the panel YouTube marks expanded when its visibility attribute is in use", async () => {
    const read = await withDom(
      panel("EXPANDED", rows("current")) + panel(undefined, rows("stale")) + panel("HIDDEN", rows("copy")),
      () => readRenderedRowsForTest()
    );
    expect(read.cues).toHaveLength(3);
    expect(read.cues.every((cue) => cue.text.startsWith("current"))).toBe(true);
  });

  it("reads nothing while the only populated panel has lost its visibility value", async () => {
    // A hidden panel exists, so the markup is recognized; the unmarked panel must not be trusted.
    const read = await withDom(panel("HIDDEN", "") + panel(undefined, rows("stale")), () => readRenderedRowsForTest());
    expect(read.cues).toHaveLength(0);
  });

  it("still reads markup that carries no visibility signal at all", async () => {
    const read = await withDom(panel(undefined, rows("unknown markup")), () => readRenderedRowsForTest());
    expect(read.cues).toHaveLength(3);
  });
});
