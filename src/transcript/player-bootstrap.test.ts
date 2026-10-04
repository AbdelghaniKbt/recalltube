import { describe, expect, it } from "vitest";
import { parseAssignedJson } from "./player-bootstrap";

describe("serialized YouTube player bootstrap", () => {
  it("parses a bounded JSON assignment without evaluating script", () => {
    const value = parseAssignedJson(
      ['window.ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc12345678"},"value":"brace } in string"};'],
      ["ytInitialPlayerResponse"]
    );
    expect(value).toEqual({ videoDetails: { videoId: "abc12345678" }, value: "brace } in string" });
  });

  it("ignores malformed assignments", () => {
    expect(parseAssignedJson(["ytInitialPlayerResponse = {broken}"], ["ytInitialPlayerResponse"])).toBeUndefined();
  });
});
