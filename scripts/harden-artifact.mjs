// Post-build hardening and inspection of the packaged extension.
//
// 1. Neutralizes the jsdelivr URL that @huggingface/transformers falls back to when `wasmPaths`
//    is unset. src/ai/runtime/ort-env.ts already overwrites `wasmPaths` before any session is
//    created, so that branch never runs — but rewriting the literal means that even if a future
//    upgrade reorders initialization, the worst case is a same-origin path that does not exist
//    rather than a request for remote executable JavaScript.
//
// 2. Throws if the artifact references any host outside the allowlist, or carries a Node-only
//    dependency.
//
// This runs from WXT's `build:done` hook (see wxt.config.ts) rather than only from an npm script,
// because `wxt zip` re-runs the build internally — a `zip` script that hardened before calling it
// shipped an un-hardened bundle, which `src/build/artifact.test.ts` caught.
//
// Also usable directly: `node scripts/harden-artifact.mjs [outDir]`
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const JSDELIVR_ORT_PREFIX = "https://cdn.jsdelivr.net/npm/onnxruntime-web@";
const REPLACEMENT = "/ort/unavailable-onnxruntime-web@";

const ALLOWED_HOSTS = [
  "huggingface.co",
  "hf.co",
  "youtube.com",
  "www.youtube.com",
  "m.youtube.com",
  // Documentation and error links inside vendored code. Inert strings, never fetched.
  "developer.mozilla.org",
  "github.com",
  "gist.github.com",
  "web.dev",
  "www.w3.org",
  "developer.chrome.com",
  "react.dev",
  "reactjs.org",
];

const FORBIDDEN_SUBSTRINGS = ["onnxruntime-node", "require('sharp')", 'require("sharp")'];

async function walk(directory) {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => null);
  if (!entries) throw new Error(`Artifact not found: ${directory}. Run the build first.`);
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else files.push(full);
  }
  return files;
}

/** Rewrites and verifies `artifactDir`. Throws on any policy violation. */
export async function hardenArtifact(artifactDir) {
  const files = await walk(artifactDir);
  const scripts = files.filter((file) => file.endsWith(".js") || file.endsWith(".mjs"));

  let rewritten = 0;
  for (const file of scripts) {
    const source = await readFile(file, "utf8");
    if (!source.includes(JSDELIVR_ORT_PREFIX)) continue;
    await writeFile(file, source.replaceAll(JSDELIVR_ORT_PREFIX, REPLACEMENT), "utf8");
    rewritten += 1;
  }

  const problems = [];
  for (const file of scripts) {
    const source = await readFile(file, "utf8");
    const name = path.relative(artifactDir, file);
    for (const [, host] of source.matchAll(/https?:\/\/([a-z0-9.-]+)/gi)) {
      const lower = host.toLowerCase();
      if (!ALLOWED_HOSTS.some((allowed) => lower === allowed || lower.endsWith(`.${allowed}`))) {
        problems.push(`${name} references an unexpected host: ${lower}`);
      }
    }
    for (const forbidden of FORBIDDEN_SUBSTRINGS) {
      if (source.includes(forbidden)) problems.push(`${name} contains a Node-only dependency: ${forbidden}`);
    }
  }

  const unique = [...new Set(problems)];
  if (unique.length) {
    throw new Error(`[harden-artifact] FAILED:\n${unique.map((problem) => `  - ${problem}`).join("\n")}`);
  }

  return { scripts: scripts.length, rewritten };
}

// CLI entry point.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const target = path.join(root, process.argv[2] ?? ".output/chrome-mv3");
  try {
    const { scripts, rewritten } = await hardenArtifact(target);
    console.log(
      `[harden-artifact] ${scripts} scripts checked, ${rewritten} rewritten, no unexpected hosts, no Node-only dependencies.`
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
