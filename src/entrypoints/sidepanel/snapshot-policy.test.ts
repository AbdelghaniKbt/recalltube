import { describe, expect, it } from "vitest";
import { shouldAdopt } from "./snapshot-policy";
import type { PageSnapshot } from "../../types/transcript";

const snapshot = (overrides: Partial<PageSnapshot>): PageSnapshot => ({
  status: "failed",
  videoId: "abc12345678",
  generation: 1,
  ...overrides,
});

describe("side-panel snapshot adoption", () => {
  it("drops an older generation from the same document", () => {
    expect(
      shouldAdopt(
        { snapshot: snapshot({ generation: 3, status: "ready" }), documentId: "doc-a" },
        { snapshot: snapshot({ generation: 2 }), documentId: "doc-a" }
      )
    ).toBe(false);
  });

  it("accepts the same or a newer generation from the same document", () => {
    expect(shouldAdopt({ snapshot: snapshot({ generation: 2 }), documentId: "doc-a" }, { snapshot: snapshot({ generation: 2 }), documentId: "doc-a" })).toBe(true);
    expect(shouldAdopt({ snapshot: snapshot({ generation: 2 }), documentId: "doc-a" }, { snapshot: snapshot({ generation: 3 }), documentId: "doc-a" })).toBe(true);
  });

  it("accepts a replaced document's first result even when the old document had reached a higher generation", () => {
    // Reload after two failed attempts: the new page succeeds at generation 1. This used to be dropped.
    expect(
      shouldAdopt(
        { snapshot: snapshot({ generation: 2, status: "failed", reason: "captions-withheld" }), documentId: "doc-a" },
        { snapshot: snapshot({ generation: 1, status: "ready" }), documentId: "doc-b" }
      )
    ).toBe(true);
  });

  it("always accepts a snapshot for a different video", () => {
    expect(
      shouldAdopt(
        { snapshot: snapshot({ generation: 5 }), documentId: "doc-a" },
        { snapshot: snapshot({ generation: 1, videoId: "xyz12345678" }), documentId: "doc-a" }
      )
    ).toBe(true);
  });

  it("lets a real page snapshot replace one the panel synthesized itself", () => {
    expect(
      shouldAdopt(
        { snapshot: snapshot({ generation: 0, status: "loading" }) },
        { snapshot: snapshot({ generation: 1, status: "loading" }), documentId: "doc-a" }
      )
    ).toBe(true);
  });
});
