import { describe, expect, it } from "vitest";
import { isAllowedCaptionUrl, parsePageDataPayload, trackIdentity } from "./bridge";
import { transcriptIdentitySync } from "./identity";
import { parseContentRequest, parseStateChanged } from "../types/messages";

/**
 * These cover forged bridge payloads, message spoofing, and cache-identity collisions.
 */

describe("caption URL allowlist", () => {
  it("accepts YouTube's timed-text endpoint", () => {
    expect(isAllowedCaptionUrl("https://www.youtube.com/api/timedtext?v=abc&lang=en")).toBe(true);
    expect(isAllowedCaptionUrl("https://youtube.com/api/timedtext?v=abc")).toBe(true);
  });

  it("refuses every URL a hostile page script would want us to fetch with credentials", () => {
    const hostile = [
      "https://evil.example/api/timedtext",
      "https://www.youtube.com.evil.example/api/timedtext",
      "https://evil.example/?x=https://www.youtube.com/api/timedtext",
      "http://www.youtube.com/api/timedtext",
      "javascript:fetch('/steal')",
      "data:text/xml,<transcript/>",
      "file:///etc/passwd",
      "https://www.youtube.com/account",
      "https://www.youtube.com/api/stats/watchtime",
      "",
      "not a url",
    ];
    for (const url of hostile) expect(isAllowedCaptionUrl(url)).toBe(false);
  });
});

describe("parsePageDataPayload", () => {
  it("keeps a well-formed track", () => {
    const payload = parsePageDataPayload({
      videoId: "dQw4w9WgXcQ",
      title: "A video",
      captionTracks: [
        { baseUrl: "https://www.youtube.com/api/timedtext?v=a&lang=en", languageCode: "en", name: "English" },
      ],
    });
    expect(payload?.captionTracks).toHaveLength(1);
  });

  it("drops tracks whose URL is not a YouTube timed-text endpoint", () => {
    const payload = parsePageDataPayload({
      captionTracks: [
        { baseUrl: "https://evil.example/steal", languageCode: "en", name: "English" },
        { baseUrl: "https://www.youtube.com/api/timedtext?v=a", languageCode: "en", name: "English" },
      ],
    });
    expect(payload?.captionTracks).toHaveLength(1);
    expect(payload?.captionTracks[0]?.baseUrl).toContain("timedtext");
  });

  it("survives hostile shapes without throwing", () => {
    expect(parsePageDataPayload(null)).toBeUndefined();
    expect(parsePageDataPayload("string")).toBeUndefined();
    expect(parsePageDataPayload({ captionTracks: "nope" })?.captionTracks).toEqual([]);
    expect(parsePageDataPayload({ captionTracks: [null, 1, {}] })?.captionTracks).toEqual([]);
  });

  it("caps oversized payloads", () => {
    const tracks = Array.from({ length: 5_000 }, () => ({
      baseUrl: "https://www.youtube.com/api/timedtext?v=a",
      languageCode: "en",
      name: "x".repeat(10_000),
    }));
    const payload = parsePageDataPayload({ captionTracks: tracks, title: "y".repeat(100_000) });
    expect(payload!.captionTracks.length).toBeLessThanOrEqual(200);
    expect(payload!.title!.length).toBeLessThanOrEqual(500);
    expect(payload!.captionTracks[0]!.name.length).toBeLessThanOrEqual(200);
  });
});

describe("trackIdentity", () => {
  it("ignores per-request signature parameters so a reload is not a new transcript", () => {
    const base = { languageCode: "en", name: "English", kind: undefined };
    const first = trackIdentity({
      ...base,
      baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en&signature=AAA&expire=1",
    });
    const second = trackIdentity({
      ...base,
      baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en&signature=BBB&expire=2",
    });
    expect(first.id).toBe(second.id);
  });

  it("distinguishes languages and auto-generated tracks", () => {
    const english = trackIdentity({
      baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=en",
      languageCode: "en",
      name: "English",
    });
    const arabic = trackIdentity({
      baseUrl: "https://www.youtube.com/api/timedtext?v=abc&lang=ar",
      languageCode: "ar",
      name: "Arabic",
    });
    expect(english.id).not.toBe(arabic.id);
    expect(english.kind).toBe("manual");
  });
});

describe("transcript identity", () => {
  const cues = [
    { start: 0, end: 5, text: "alpha bravo charlie" },
    { start: 5, end: 10, text: "delta echo foxtrot" },
  ];

  it("distinguishes transcripts the alpha's signature collided on", () => {
    // The old signature was "chunkCount:firstLen:lastLen:endTime" — identical for both of these.
    const a = transcriptIdentitySync({ videoId: "v", cues });
    const b = transcriptIdentitySync({
      videoId: "v",
      cues: [
        { start: 0, end: 5, text: "zulu yankee xrayyyy" },
        { start: 5, end: 10, text: "whisky victor unisom" },
      ],
    });
    expect(a).not.toBe(b);
  });

  it("changes when the caption language changes on the same video", () => {
    const english = transcriptIdentitySync({
      videoId: "v",
      track: { id: "v:en", languageCode: "en", languageName: "English", kind: "manual" },
      cues,
    });
    const arabic = transcriptIdentitySync({
      videoId: "v",
      track: { id: "v:ar", languageCode: "ar", languageName: "Arabic", kind: "manual" },
      cues,
    });
    expect(english).not.toBe(arabic);
  });

  it("changes when cue timings change even if the words do not", () => {
    const shifted = cues.map((cue) => ({ ...cue, start: cue.start + 1 }));
    expect(transcriptIdentitySync({ videoId: "v", cues })).not.toBe(
      transcriptIdentitySync({ videoId: "v", cues: shifted })
    );
  });

  it("is stable for identical input", () => {
    expect(transcriptIdentitySync({ videoId: "v", cues })).toBe(transcriptIdentitySync({ videoId: "v", cues }));
  });
});

describe("message validation", () => {
  it("does not expose a command that opens YouTube's transcript panel", () => {
    expect(parseContentRequest({ type: "recalltube:open-transcript-panel" })).toBeUndefined();
  });

  it("accepts well-formed requests", () => {
    expect(parseContentRequest({ type: "recalltube:get-state" })).toEqual({ type: "recalltube:get-state" });
    expect(parseContentRequest({ type: "recalltube:seek", seconds: 42 })).toEqual({
      type: "recalltube:seek",
      seconds: 42,
    });
  });

  it("rejects malformed and hostile messages instead of dereferencing them", () => {
    for (const value of [
      null,
      undefined,
      42,
      "recalltube:seek",
      {},
      { type: 12 },
      { type: "other:type" },
      // RecallTube deliberately has no command that can open YouTube's transcript UI.
      { type: "recalltube:open-transcript-panel" },
      { type: "recalltube:seek" },
      { type: "recalltube:seek", seconds: "12" },
      { type: "recalltube:seek", seconds: Number.NaN },
      { type: "recalltube:seek", seconds: -1 },
      { type: "recalltube:seek", seconds: Number.POSITIVE_INFINITY },
    ]) {
      expect(parseContentRequest(value)).toBeUndefined();
    }
  });

  it("caps a language code from an untrusted sender", () => {
    const parsed = parseContentRequest({ type: "recalltube:refresh", languageCode: "x".repeat(500) });
    expect(parsed?.type).toBe("recalltube:refresh");
    expect((parsed as { languageCode?: string }).languageCode!.length).toBeLessThanOrEqual(16);
  });

  it("rejects snapshots with an invalid status or generation", () => {
    expect(parseStateChanged({ type: "recalltube:state-changed", snapshot: { status: "ready", generation: 1 } })).toBeDefined();
    expect(parseStateChanged({ type: "recalltube:state-changed", snapshot: { status: "hacked", generation: 1 } })).toBeUndefined();
    expect(parseStateChanged({ type: "recalltube:state-changed", snapshot: { status: "ready" } })).toBeUndefined();
    expect(parseStateChanged({ type: "recalltube:state-changed" })).toBeUndefined();
    expect(parseStateChanged(null)).toBeUndefined();
  });
});
