import { describe, expect, it } from "vitest";
import { parsePageDataPayload, playabilityFailure } from "./bridge";

/**
 * A removed, private or not-yet-started video advertises no caption track and never builds a
 * transcript control. Before the player's verdict was read, such a page spent the full native-stage
 * wait (up to 90 s) looking for that control and then reported "no captions" — the misleading state
 * the product promises not to show.
 */
describe("playability verdict from the player", () => {
  it("survives the bridge with its strings bounded", () => {
    const payload = parsePageDataPayload({
      videoId: "abc",
      captionTracks: [],
      playability: { status: "ERROR", reason: "x".repeat(500), isLive: "yes" },
    });
    expect(payload?.playability?.status).toBe("ERROR");
    expect(payload?.playability?.reason).toHaveLength(120);
    // Only a real boolean true counts as live; a truthy string from a hostile page does not.
    expect(payload?.playability?.isLive).toBe(false);
  });

  it("is absent when the page sent nothing useful", () => {
    expect(parsePageDataPayload({ captionTracks: [], playability: {} })?.playability).toBeUndefined();
    expect(parsePageDataPayload({ captionTracks: [], playability: "ERROR" })?.playability).toBeUndefined();
  });

  it("classifies removed and unplayable videos as terminal unavailability", () => {
    expect(playabilityFailure({ status: "ERROR", reason: "Video unavailable" })).toMatchObject({ reason: "video-unavailable" });
    expect(playabilityFailure({ status: "unplayable" })).toMatchObject({ reason: "video-unavailable" });
  });

  it("classifies sign-in and age checks as permission problems, not missing captions", () => {
    expect(playabilityFailure({ status: "LOGIN_REQUIRED", reason: "Private video" })).toMatchObject({ reason: "permission-denied" });
    expect(playabilityFailure({ status: "AGE_CHECK_REQUIRED" })).toMatchObject({ reason: "permission-denied" });
  });

  it("classifies live streams and unstarted premieres as unsupported for now", () => {
    expect(playabilityFailure({ status: "LIVE_STREAM_OFFLINE" })).toMatchObject({ reason: "unsupported" });
    expect(playabilityFailure({ status: "OK", isLive: true })).toMatchObject({ reason: "unsupported" });
  });

  it("stays silent for a playable video, so a genuinely captionless one still reaches the native stage", () => {
    expect(playabilityFailure({ status: "OK" })).toBeUndefined();
    expect(playabilityFailure(undefined)).toBeUndefined();
  });

  it("caps the player's own message inside the diagnostic", () => {
    const detail = playabilityFailure({ status: "ERROR", reason: "y".repeat(120) })?.detail ?? "";
    expect(detail.length).toBeLessThan(140);
    expect(detail).toContain("ERROR");
  });
});
