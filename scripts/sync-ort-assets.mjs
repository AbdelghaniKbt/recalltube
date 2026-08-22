// Copies the ONNX Runtime Web assets that RecallTube ships *inside* the extension.
//
// Why this exists: @huggingface/transformers defaults ONNX Runtime's `wasmPaths` to
// https://cdn.jsdelivr.net/npm/onnxruntime-web@<version>/dist/. That makes the extension fetch
// remote executable JavaScript at runtime, which (a) violates Chrome Web Store MV3 policy,
// (b) contacts an undeclared third-party host, and (c) is refused by our own CSP, so the
// semantic backend fails outright.
//
// We copy the runtime into public/ort/ and point wasmPaths at the packaged copies.
// The `asyncify` variant is the one transformers.js itself selects for non-Safari and is the
// only packaged variant that serves both the WebGPU and the WASM execution providers.
import { createRequire } from "node:module";
import { mkdir, copyFile, readFile, writeFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const targetDir = path.join(root, "public", "ort");

/** The runtime files the worker loads. Keep in sync with src/ai/runtime/ort-env.ts. */
const ASSETS = ["ort-wasm-simd-threaded.asyncify.mjs", "ort-wasm-simd-threaded.asyncify.wasm"];

// onnxruntime-web does not export ./package.json, so resolve an entry point and walk up to the
// package root. This keeps working under hoisting, workspaces and pnpm layouts.
function packageRootOf(entry) {
  let dir = path.dirname(entry);
  while (dir !== path.dirname(dir)) {
    if (path.basename(dir) === "onnxruntime-web") return dir;
    dir = path.dirname(dir);
  }
  throw new Error(`Could not locate the onnxruntime-web package root from ${entry}`);
}

const ortRoot = packageRootOf(require.resolve("onnxruntime-web"));
const ortDist = path.join(ortRoot, "dist");
const ortVersion = JSON.parse(await readFile(path.join(ortRoot, "package.json"), "utf8")).version;

await mkdir(targetDir, { recursive: true });

// Drop stale runtimes so an upgrade can never leave two versions in the artifact.
for (const stale of await readdir(targetDir).catch(() => [])) {
  if (!ASSETS.includes(stale) && stale !== "VERSION") await rm(path.join(targetDir, stale), { force: true });
}

for (const asset of ASSETS) {
  await copyFile(path.join(ortDist, asset), path.join(targetDir, asset));
}
await writeFile(path.join(targetDir, "VERSION"), `${ortVersion}\n`, "utf8");

console.log(`[sync-ort-assets] onnxruntime-web@${ortVersion} -> public/ort (${ASSETS.join(", ")})`);
