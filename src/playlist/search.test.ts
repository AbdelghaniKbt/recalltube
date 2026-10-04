import { describe, expect, it } from "vitest";
import type { PlaylistTranscript } from "../types/playlist";
import { buildPlaylistRetrieval, searchPlaylist } from "./search";

const entry = (videoId: string, title: string, position: number, phrase: string): PlaylistTranscript => ({
  item: { videoId, title, position },
  transcript: {
    transcriptId: `t-${videoId}`,
    video: { id: videoId, title, url: `https://www.youtube.com/watch?v=${videoId}` },
    cues: [{ start: position * 10, end: position * 10 + 5, text: phrase }],
    source: "player",
    fetchedAt: 1,
    parserVersion: 1,
  },
});

describe("playlist search", () => {
  it("ranks across videos and preserves provenance", () => {
    const corpus = buildPlaylistRetrieval([
      entry("aaa12345678", "First", 0, "A general introduction."),
      entry("bbb12345678", "Second", 1, "Agentic engineering uses tools and feedback loops."),
    ]);
    const results = searchPlaylist("PL1234567890abcdef", corpus, "agentic engineering", { mode: "exact" });
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      playlistId: "PL1234567890abcdef",
      item: { videoId: "bbb12345678", title: "Second", position: 1 },
      result: { start: 10 },
    });
    expect(results[0]?.result.id).toContain("bbb12345678:");
  });

  it("orders equally strong exact evidence by playlist position and time", () => {
    const corpus = buildPlaylistRetrieval([
      entry("bbb12345678", "Second", 1, "gradient descent appears here"),
      entry("aaa12345678", "First", 0, "gradient descent appears earlier"),
    ]);
    const results = searchPlaylist("PL1234567890abcdef", corpus, "gradient descent", { mode: "exact" });
    expect(results.map((result) => result.item.videoId)).toEqual(["aaa12345678", "bbb12345678"]);
  });
  it("reuses a transcript's index across rebuilds and drops indexes for transcripts that left", () => {
    // The playlist view rebuilds on every job update while indexing runs; without a cache every
    // unchanged video's flattened index was rebuilt on the UI thread each time.
    const cache = new Map();
    const first = buildPlaylistRetrieval([entry("aaa12345678", "First", 0, "one")], cache);
    const second = buildPlaylistRetrieval(
      [entry("aaa12345678", "First", 0, "one"), entry("bbb12345678", "Second", 1, "two")],
      cache
    );
    expect(second[0]!.index).toBe(first[0]!.index);
    expect(second[1]!.index).not.toBe(first[0]!.index);
    expect(cache.size).toBe(2);
    buildPlaylistRetrieval([entry("bbb12345678", "Second", 1, "two")], cache);
    expect([...cache.keys()]).toEqual(["t-bbb12345678"]);
  });
});
