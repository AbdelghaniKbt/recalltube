import { createRequire } from "node:module";
import path from "node:path";
import { defineConfig } from "wxt";
// @ts-expect-error -- plain ESM helper shared with the CLI entry point.
import { hardenArtifact } from "./scripts/harden-artifact.mjs";

const require = createRequire(import.meta.url);

/**
 * onnxruntime-web publishes two flavours of each entry point:
 *
 *   - `*.bundle.min.mjs` inlines the emscripten glue and refers to the `.wasm` through
 *     `new URL(..., import.meta.url)`, which makes Vite emit a second 23.5 MB copy of a file we
 *     already package ourselves.
 *   - `*.min.mjs` (selected upstream by the `onnxruntime-web-use-extern-wasm` condition) loads both
 *     the glue and the binary from `env.backends.onnx.wasm.wasmPaths`, which src/ai/runtime/ort-env.ts
 *     points at the copies in `public/ort/`.
 *
 * We alias to an absolute path rather than adding a resolve condition so the choice cannot be
 * silently undone by a change to Vite's default condition list.
 */
function ortExternWasmEntry(): string {
  let dir = path.dirname(require.resolve("onnxruntime-web"));
  while (dir !== path.dirname(dir) && path.basename(dir) !== "onnxruntime-web") dir = path.dirname(dir);
  return path.join(dir, "dist", "ort.webgpu.min.mjs");
}

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  srcDir: "src",
  hooks: {
    /**
     * Harden and inspect every build, including the one `wxt zip` runs internally.
     *
     * Doing this only from an npm script shipped an un-hardened bundle: `npm run zip` hardened the
     * output and then `wxt zip` rebuilt over it. Failing here fails the build.
     */
    "build:done": async (wxt) => {
      const { scripts, rewritten } = await hardenArtifact(wxt.config.outDir);
      wxt.logger.success(
        `Artifact hardened: ${scripts} scripts checked, ${rewritten} rewritten, no unexpected hosts.`
      );
    },
  },
  vite: () => ({
    resolve: {
      alias: [{ find: /^onnxruntime-web\/webgpu$/, replacement: ortExternWasmEntry() }],
    },
  }),
  manifest: {
    name: "RecallTube — Search What You Remember",
    description:
      "Search a YouTube video's captions by exact words or meaning and jump to the moment.",
    minimum_chrome_version: "116",
    permissions: ["storage", "sidePanel", "tabs"],
    host_permissions: [
      "https://www.youtube.com/*",
      "https://youtube.com/*",
      "https://huggingface.co/*",
      "https://cdn-lfs.huggingface.co/*",
      "https://cdn-lfs-us-1.huggingface.co/*",
      "https://*.hf.co/*"
    ],
    action: {
      default_title: "Open RecallTube",
      default_icon: {
        "16": "icons/icon-16.png",
        "32": "icons/icon-32.png",
        "48": "icons/icon-48.png",
        "128": "icons/icon-128.png"
      }
    },
    icons: {
      "16": "icons/icon-16.png",
      "32": "icons/icon-32.png",
      "48": "icons/icon-48.png",
      "128": "icons/icon-128.png"
    },
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'"
    }
  }
});
