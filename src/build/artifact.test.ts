import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Inspects the built browser artifact.
 *
 * The packaged extension must contain no reference to a third-party CDN, must not attempt
 * to load remote executable JavaScript, and must not carry Node-only dependencies.
 *
 * The suite skips itself when `.output/chrome-mv3` is absent so `npm test` works before a build;
 * CI runs `npm run build` first, and `verify:artifact` fails loudly if the directory is missing.
 */

const ARTIFACT = path.resolve(__dirname, "../../.output/chrome-mv3");
const built = existsSync(ARTIFACT);
const suite = built ? describe : describe.skip;

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(full) : [full];
  });
}

const files = built ? walk(ARTIFACT) : [];
const scripts = files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));

/** Hosts the extension is allowed to reference. Model weights are data, fetched after consent. */
const ALLOWED_HOSTS = [
  "huggingface.co",
  "hf.co",
  "www.youtube.com",
  "youtube.com",
  "m.youtube.com",
  // Documentation links inside vendored code: inert strings, never fetched.
  "developer.mozilla.org",
  "github.com",
  "web.dev",
  "gist.github.com",
  "www.w3.org",
  "developer.chrome.com",
  "react.dev",
  "reactjs.org",
];

suite("built artifact", () => {
  it("was produced", () => {
    expect(files.length).toBeGreaterThan(0);
    expect(existsSync(path.join(ARTIFACT, "manifest.json"))).toBe(true);
  });

  it("packages the ONNX runtime instead of fetching it from a CDN", () => {
    // The alpha downloaded 23.5 MB of runtime plus a .mjs it then tried to import — remote
    // executable code, from an undeclared host, which CSP refused.
    expect(existsSync(path.join(ARTIFACT, "ort/ort-wasm-simd-threaded.asyncify.wasm"))).toBe(true);
    expect(existsSync(path.join(ARTIFACT, "ort/ort-wasm-simd-threaded.asyncify.mjs"))).toBe(true);
  });

  it("references no unexpected remote host", () => {
    const offenders: string[] = [];
    for (const file of scripts) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
        const host = match[1]!.toLowerCase();
        if (!ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
          offenders.push(`${path.basename(file)} -> ${host}`);
        }
      }
    }
    expect([...new Set(offenders)]).toEqual([]);
  });

  it("never resolves the ONNX runtime from jsdelivr at runtime", () => {
    // transformers.js assigns a jsdelivr default at import time; src/ai/runtime/ort-env.ts must
    // overwrite it. The literal may remain in vendored code, but nothing may point wasmPaths there.
    for (const file of scripts) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/wasmPaths\s*=\s*\{[^}]*jsdelivr/);
    }
  });

  it("contains no Node-only dependency", () => {
    // sharp and onnxruntime-node carry every open npm advisory in this tree; they must not ship.
    for (const file of scripts) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toContain("onnxruntime-node");
      expect(source).not.toContain("require('sharp')");
      expect(source).not.toContain('require("sharp")');
    }
  });

  it("ships no source maps or stray development files", () => {
    const strays = files.filter(
      (file) => file.endsWith(".map") || file.endsWith(".ts") || file.endsWith(".tsx") || file.includes(".DS_Store")
    );
    expect(strays.map((file) => path.relative(ARTIFACT, file))).toEqual([]);
  });

  it("declares only the permissions the extension actually uses", () => {
    const manifest = JSON.parse(readFileSync(path.join(ARTIFACT, "manifest.json"), "utf8")) as {
      permissions: string[];
      host_permissions: string[];
      content_security_policy: { extension_pages: string };
    };
    expect(manifest.permissions.sort()).toEqual(["sidePanel", "storage", "tabs"]);
    // No broad <all_urls>, no scripting, no webRequest, no cookies.
    for (const host of manifest.host_permissions) {
      expect(host).toMatch(/^https:\/\/([a-z0-9*.-]+\.)?(youtube\.com|huggingface\.co|hf\.co)\/\*$/);
    }
    const csp = manifest.content_security_policy.extension_pages;
    expect(csp).toContain("script-src 'self'");
    // 'wasm-unsafe-eval' is required by ONNX Runtime; plain 'unsafe-eval' must never appear.
    expect(csp).not.toMatch(/(^|[\s;])'unsafe-eval'/);
    expect(csp).toContain("object-src 'self'");
  });

  it("stays within a sane package size", () => {
    const total = files.reduce((sum, file) => sum + statSync(file).size, 0);
    // Almost all of this is the ONNX runtime; a jump means something unexpected got bundled.
    expect(total).toBeLessThan(30 * 1024 * 1024);
  });
});
