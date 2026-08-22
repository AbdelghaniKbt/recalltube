import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  coalesceCues,
  decodeEntities,
  describePayload,
  mergeRollingCaptions,
  parseJson3,
  parseTimedTextXml,
} from "./parsers";

describe("decodeEntities", () => {
  it("decodes double-escaped entities the way YouTube emits them", () => {
    // A single decode leaves a literal "&#39;", which normalization then mangles to a bare "39".
    expect(decodeEntities("don&amp;#39;t")).toBe("don't");
  });

  it("decodes named, decimal and hex forms", () => {
    expect(decodeEntities("&quot;a&quot; &lt;b&gt; &#65; &#x42;")).toBe('"a" <b> A B');
  });

  it("leaves unknown entities alone rather than corrupting them", () => {
    expect(decodeEntities("100 &widget; 200")).toBe("100 &widget; 200");
  });

  it("terminates on a crafted entity chain", () => {
    expect(() => decodeEntities("&".repeat(5_000) + "amp;")).not.toThrow();
  });
});

describe("parseJson3", () => {
  it("parses events and joins segments", () => {
    expect(
      parseJson3({ events: [{ tStartMs: 1500, dDurationMs: 2500, segs: [{ utf8: "hello " }, { utf8: "world" }] }] })
    ).toEqual([{ start: 1.5, end: 4, text: "hello world" }]);
  });

  it("drops rolling-caption continuation events", () => {
    const cues = parseJson3({
      events: [
        { tStartMs: 0, dDurationMs: 2000, segs: [{ utf8: "real cue" }] },
        { tStartMs: 1000, dDurationMs: 500, aAppend: 1, segs: [{ utf8: "continuation" }] },
      ],
    });
    expect(cues).toHaveLength(1);
  });

  it("drops newline-only and empty events", () => {
    expect(parseJson3({ events: [{ tStartMs: 0, dDurationMs: 5000, segs: [{ utf8: "\n" }] }] })).toEqual([]);
  });

  it("survives malformed payloads", () => {
    expect(parseJson3(null)).toEqual([]);
    expect(parseJson3({ events: "nope" })).toEqual([]);
    expect(parseJson3({ events: [null, 42, { tStartMs: "x" }] })).toEqual([]);
    expect(parseJson3({ events: [{ tStartMs: -5, segs: [{ utf8: "negative" }] }] })).toEqual([]);
  });
});

describe("parseTimedTextXml", () => {
  it("parses text elements and decodes entities", () => {
    const xml = `<transcript><text start="1.5" dur="2">don&amp;#39;t stop</text></transcript>`;
    expect(parseTimedTextXml(xml)).toEqual([{ start: 1.5, end: 3.5, text: "don't stop" }]);
  });

  it("strips nested markup used by some tracks", () => {
    const xml = `<transcript><text start="0" dur="1"><s>hello</s> <s>there</s></text></transcript>`;
    expect(parseTimedTextXml(xml)[0]?.text).toBe("hello there");
  });

  it("handles RTL and CJK bodies", () => {
    const xml = `<transcript><text start="0" dur="2">مرحبا بالعالم</text><text start="2" dur="2">機械学習</text></transcript>`;
    expect(parseTimedTextXml(xml).map((cue) => cue.text)).toEqual(["مرحبا بالعالم", "機械学習"]);
  });

  it("returns nothing for malformed XML rather than throwing", () => {
    expect(parseTimedTextXml("<transcript><text start=")).toEqual([]);
    expect(parseTimedTextXml("not xml at all")).toEqual([]);
  });

  it("skips elements with an unusable start", () => {
    const xml = `<transcript><text dur="2">no start</text><text start="abc" dur="2">bad start</text></transcript>`;
    expect(parseTimedTextXml(xml)).toEqual([]);
  });
});

describe("mergeRollingCaptions", () => {
  it("collapses YouTube's rolling auto-caption windows", () => {
    const merged = mergeRollingCaptions([
      { start: 0, end: 2, text: "we started using" },
      { start: 1.5, end: 3.5, text: "we started using machine" },
      { start: 3, end: 5, text: "machine learning today" },
    ]);
    expect(merged.map((cue) => cue.text).join(" ")).toBe("we started using machine learning today");
  });

  it("drops a cue entirely contained in its predecessor", () => {
    const merged = mergeRollingCaptions([
      { start: 0, end: 4, text: "the whole sentence here" },
      { start: 2, end: 6, text: "the whole sentence here" },
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.end).toBe(6);
  });

  it("leaves unrelated cues untouched", () => {
    const cues = [
      { start: 0, end: 2, text: "first thing" },
      { start: 2, end: 4, text: "second thing" },
    ];
    expect(mergeRollingCaptions(cues)).toEqual(cues);
  });
});

describe("coalesceCues", () => {
  it("rejects malformed cues and duplicate rows", () => {
    const valid = { start: 2, end: 4, text: "valid" };
    expect(coalesceCues([valid, valid, { start: Number.NaN, end: 1, text: "bad" }])).toEqual([valid]);
  });

  it("clamps overlapping cue ends so timestamps stay unambiguous", () => {
    const coalesced = coalesceCues([
      { start: 0, end: 9, text: "alpha" },
      { start: 3, end: 12, text: "beta" },
    ]);
    expect(coalesced[0]?.end).toBe(3);
    expect(coalesced[1]).toMatchObject({ start: 3, end: 12 });
  });

  it("gives a zero-length final cue a usable duration", () => {
    expect(coalesceCues([{ start: 5, end: 5, text: "last" }])[0]?.end).toBe(7);
  });

  it("always returns ordered, finite, non-overlapping cues", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            start: fc.double({ min: -10, max: 10_000, noNaN: false }),
            end: fc.double({ min: -10, max: 10_000, noNaN: false }),
            text: fc.string(),
          }),
          { maxLength: 40 }
        ),
        (raw) => {
          const cues = coalesceCues(raw);
          for (let index = 0; index < cues.length; index += 1) {
            const cue = cues[index]!;
            expect(Number.isFinite(cue.start)).toBe(true);
            expect(Number.isFinite(cue.end)).toBe(true);
            expect(cue.start).toBeGreaterThanOrEqual(0);
            expect(cue.end).toBeGreaterThanOrEqual(cue.start);
            expect(cue.text.trim().length).toBeGreaterThan(0);
            const next = cues[index + 1];
            if (next) {
              expect(next.start).toBeGreaterThanOrEqual(cue.start);
              expect(cue.end).toBeLessThanOrEqual(next.start);
            }
          }
        }
      ),
      { numRuns: 300 }
    );
  });
});

describe("timedtext <p> format", () => {
  // Reported from a live video: YouTube serves this shape, the parser only knew <text start dur>,
  // so the track parsed to zero cues and was misreported as a parse error.
  const xml = `<?xml version="1.0" encoding="utf-8"?>
<timedtext format="3"><body>
<p t="0" d="4000">Welcome back</p>
<p t="4000" d="3500">to the show</p>
<p t="7500" d="2000"><s>split</s> <s>into segments</s></p>
</body></timedtext>`;

  it("parses <p t= d=> with millisecond timings", () => {
    expect(parseTimedTextXml(xml)).toEqual([
      { start: 0, end: 4, text: "Welcome back" },
      { start: 4, end: 7.5, text: "to the show" },
      { start: 7.5, end: 9.5, text: "split into segments" },
    ]);
  });

  it("still prefers the legacy <text> shape when both could match", () => {
    const legacy = `<transcript><text start="1.5" dur="2">legacy wins</text></transcript>`;
    expect(parseTimedTextXml(legacy)[0]).toEqual({ start: 1.5, end: 3.5, text: "legacy wins" });
  });

  it("ignores self-closing <p/> markers that carry no text", () => {
    expect(parseTimedTextXml(`<timedtext><body><p t="0" d="1"/></body></timedtext>`)).toEqual([]);
  });
});

describe("describePayload", () => {
  it("reports shape, never content", () => {
    expect(describePayload("")).toBe("empty");
    expect(describePayload('{"events":[{"tStartMs":0}]}')).toBe("json:1 events");
    expect(describePayload("{not json")).toBe("json:unparseable");
    expect(describePayload(`<timedtext><body><p t="0">hi</p></body></timedtext>`)).toBe("xml:timedtext (1 <p>)");
    expect(describePayload(`<transcript><text start="0">hi</text></transcript>`)).toBe("xml:transcript (1 <text>)");
    expect(describePayload("<html><body>nope</body></html>")).toBe("xml:unrecognised root");
    expect(describePayload("plain words")).toBe("unrecognised");
  });

  it("never echoes caption text back to the user", () => {
    const secret = "a very private thing that was said";
    for (const body of [`<transcript><text start="0">${secret}</text></transcript>`, `{"events":[{"segs":[{"utf8":"${secret}"}]}]}`]) {
      expect(describePayload(body)).not.toContain(secret);
    }
  });
});
