import { describe, expect, it } from "vitest";
import { isWindowsPlatform } from "./ort-env";

describe("ONNX runtime platform configuration", () => {
  it("recognizes Windows from userAgentData", () => {
    expect(isWindowsPlatform({ userAgentData: { platform: "Windows" } })).toBe(true);
  });

  it("recognizes older Windows navigators", () => {
    expect(isWindowsPlatform({ platform: "Win32" })).toBe(true);
    expect(isWindowsPlatform({ userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" })).toBe(true);
  });

  it("keeps the upstream preference on other platforms", () => {
    expect(isWindowsPlatform({ userAgentData: { platform: "macOS" }, platform: "MacIntel" })).toBe(false);
    expect(isWindowsPlatform({ platform: "Linux x86_64" })).toBe(false);
  });
});
