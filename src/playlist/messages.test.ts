import { describe, expect, it } from "vitest";
import { parsePlaylistCommand } from "./messages";

describe("playlist command validation", () => {
  it("accepts a bounded valid inventory", () => {
    expect(
      parsePlaylistCommand({
        type: "recalltube:playlist-start",
        ownerTabId: 42,
        inventory: {
          playlistId: "PL1234567890abcdef",
          items: [{ videoId: "abc12345678", title: "One", position: 0 }],
          complete: true,
          sources: ["dom"],
          collectedAt: 1,
        },
      })
    ).toMatchObject({ type: "recalltube:playlist-start", ownerTabId: 42 });
  });

  it("rejects malformed commands and strips untrusted thumbnail hosts", () => {
    const parsed = parsePlaylistCommand({
      type: "recalltube:playlist-start",
      inventory: {
        playlistId: "PL1234567890abcdef",
        items: [{ videoId: "abc12345678", title: "One", position: 0, thumbnailUrl: "https://evil.test/pixel" }],
        complete: true,
        sources: ["dom"],
        collectedAt: 1,
      },
    });
    expect(parsed?.type === "recalltube:playlist-start" ? parsed.inventory.items[0]?.thumbnailUrl : "bad").toBeUndefined();
    expect(parsePlaylistCommand({ type: "recalltube:playlist-get", playlistId: "../bad" })).toBeUndefined();
    expect(parsePlaylistCommand({ type: "recalltube:playlist-pause", jobId: "x" })).toBeUndefined();
  });
});
