import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { buildPlaylistInventory, extractPlaylistBootstrap, mergePlaylistInventories } from "./inventory";
import { playlistContextFromUrl, playlistPageUrl, playlistWatchUrl, videoWatchUrl } from "./url";

const PLAYLIST = "PL1234567890abcdef";

describe("playlist URLs", () => {
  it("detects playlist and watch contexts without accepting lookalike hosts", () => {
    expect(playlistContextFromUrl(`https://www.youtube.com/watch?v=abc12345678&list=${PLAYLIST}`)).toEqual({
      playlistId: PLAYLIST,
      videoId: "abc12345678",
      isPlaylistPage: false,
    });
    expect(playlistContextFromUrl(`https://youtube.com/playlist?list=${PLAYLIST}`)?.isPlaylistPage).toBe(true);
    expect(playlistContextFromUrl(`https://youtube.example/watch?v=abc12345678&list=${PLAYLIST}`)).toBeUndefined();
    expect(playlistContextFromUrl("not a url")).toBeUndefined();
  });

  it("builds canonical playlist navigation links", () => {
    expect(playlistPageUrl(PLAYLIST)).toContain(`list=${PLAYLIST}`);
    expect(playlistWatchUrl(PLAYLIST, "abc12345678", 62)).toBe(
      `https://www.youtube.com/watch?v=abc12345678&list=${PLAYLIST}&t=62s`
    );
  });

  it("opens worker pages as plain watch URLs, with no playlist context and no role marker", () => {
    // Worker role comes from session-scoped tab ownership; a URL marker could be carried by any link.
    expect(videoWatchUrl("abc12345678")).toBe("https://www.youtube.com/watch?v=abc12345678");
  });
});

describe("playlist inventory", () => {
  it("extracts known bootstrap renderer shapes and detects continuation", () => {
    const result = extractPlaylistBootstrap({
      header: { playlistHeaderRenderer: { playlistTitle: { simpleText: "Agentic Engineering" }, numVideosText: { simpleText: "2 videos" } } },
      contents: [
        { playlistVideoRenderer: { videoId: "abc12345678", title: { runs: [{ text: "First" }] }, index: { simpleText: "1" } } },
        { playlistPanelVideoRenderer: { videoId: "def12345678", title: { simpleText: "Second" }, index: { simpleText: "2" } } },
        { continuationItemRenderer: { trigger: "CONTINUATION_TRIGGER_ON_ITEM_SHOWN" } },
      ],
    });
    expect(result.title).toBe("Agentic Engineering");
    expect(result.totalVideos).toBe(2);
    expect(result.items.map((item) => item.videoId)).toEqual(["abc12345678", "def12345678"]);
    expect(result.hasContinuation).toBe(true);
  });

  it("merges bootstrap and DOM rows, deduplicates videos, and preserves order", () => {
    const dom = new JSDOM(`<!doctype html><body>
      <ytd-playlist-header-renderer><h1>Agentic Engineering</h1><div id="stats">3 videos</div></ytd-playlist-header-renderer>
      <ytd-playlist-video-renderer><span id="index">2</span><a id="video-title" title="Second, better title" href="/watch?v=def12345678&list=${PLAYLIST}"></a></ytd-playlist-video-renderer>
      <ytd-playlist-video-renderer><span id="index">3</span><a id="video-title" title="Third" href="/watch?v=ghi12345678&list=${PLAYLIST}"></a></ytd-playlist-video-renderer>
    </body>`, { url: `https://www.youtube.com/playlist?list=${PLAYLIST}` });
    const inventory = buildPlaylistInventory({
      href: dom.window.location.href,
      document: dom.window.document,
      bootstrap: {
        playlistTitle: { simpleText: "Agentic Engineering" },
        numVideosText: { simpleText: "3 videos" },
        rows: [
          { playlistVideoRenderer: { videoId: "abc12345678", title: { simpleText: "First" }, index: { simpleText: "1" } } },
          { playlistVideoRenderer: { videoId: "def12345678", title: { simpleText: "Second" }, index: { simpleText: "2" } } },
        ],
      },
      collectedAt: 123,
    });
    expect(inventory).toMatchObject({ playlistId: PLAYLIST, title: "Agentic Engineering", totalVideos: 3, complete: true });
    expect(inventory?.items.map((item) => [item.position, item.title])).toEqual([
      [0, "First"],
      [1, "Second, better title"],
      [2, "Third"],
    ]);
    expect(inventory?.sources).toEqual(["bootstrap", "dom"]);
  });

  it("merges partial passes and becomes complete when expected count is reached", () => {
    const base = {
      playlistId: PLAYLIST,
      title: "Series",
      totalVideos: 2,
      complete: false,
      sources: ["dom" as const],
      collectedAt: 1,
    };
    const merged = mergePlaylistInventories(
      { ...base, items: [{ videoId: "abc12345678", title: "First", position: 0 }] },
      { ...base, items: [{ videoId: "def12345678", title: "Second", position: 1 }], collectedAt: 2 }
    );
    expect(merged?.complete).toBe(true);
    expect(merged?.items).toHaveLength(2);
  });

  it("uses public page metadata when YouTube's current header markup has no legacy heading", () => {
    const dom = new JSDOM(`<!doctype html><head><meta property="og:title" content="Neural Networks: Zero to Hero"></head><body>
      <a id="video-title" title="Lecture" href="/watch?v=abc12345678&list=${PLAYLIST}"></a>
    </body>`, { url: `https://www.youtube.com/playlist?list=${PLAYLIST}` });
    expect(buildPlaylistInventory({ href: dom.window.location.href, document: dom.window.document })?.title)
      .toBe("Neural Networks: Zero to Hero");
  });
});

describe("current playlist page markup", () => {
  // Captured 2026-09-16 on PLAqhIrjkxbuWI23v9cThsA9GvCAUhRvKZ with no extension loaded: bootstrap
  // data holds `lockupViewModel` (no playlistVideoRenderer), the DOM holds 10 `yt-lockup-view-model`
  // rows with no #index, and each row has TWO watch links — thumbnail and title — both carrying the
  // 1-based `index` parameter. Counting links as rows produced positions 1, 3, 5 … 19 in the UI.
  function lockups(count: number): string {
    let html = "";
    for (let index = 1; index <= count; index += 1) {
      const id = `vid${String(index).padStart(8, "0")}`;
      html += `<yt-lockup-view-model>
        <a class="ytLockupViewModelContentImage" href="/watch?v=${id}&list=${PLAYLIST}&index=${index}&pp=x"><span>1:23:45</span></a>
        <div><a class="ytLockupMetadataViewModelTitle" href="/watch?v=${id}&list=${PLAYLIST}&index=${index}&pp=x">Lecture ${index}</a></div>
      </yt-lockup-view-model>`;
    }
    return html;
  }

  it("gives each lockup row one item, its real playlist position, and its title rather than its duration", () => {
    const href = `https://www.youtube.com/playlist?list=${PLAYLIST}`;
    const document = new JSDOM(`<body>${lockups(10)}</body>`, { url: href }).window.document;
    const inventory = buildPlaylistInventory({ href, document, bootstrap: {} });
    expect(inventory?.items.map((item) => [item.position, item.title])).toEqual(
      Array.from({ length: 10 }, (_, index) => [index, `Lecture ${index + 1}`])
    );
  });

  it("uses the link's index even when YouTube renders only part of a long playlist", () => {
    const href = `https://www.youtube.com/playlist?list=${PLAYLIST}`;
    const document = new JSDOM(
      `<body><yt-lockup-view-model><a href="/watch?v=late00000001&list=${PLAYLIST}&index=41">Late</a></yt-lockup-view-model></body>`,
      { url: href }
    ).window.document;
    expect(buildPlaylistInventory({ href, document, bootstrap: {} })?.items[0]?.position).toBe(40);
  });
});
