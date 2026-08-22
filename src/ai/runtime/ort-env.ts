import { env } from "@huggingface/transformers";

/**
 * Pins the ONNX Runtime to the copies packaged inside the extension.
 *
 * transformers.js defaults `wasmPaths` to a jsdelivr URL and, when `useWasmCache` is on, fetches
 * the runtime, wraps it in a blob URL and dynamically imports it. Inside an MV3 extension that
 * blob import is refused by `script-src 'self'`, so *both* the WebGPU and WASM backends fail with
 * "no available backend found" — while still having leaked a request to an undeclared CDN and
 * downloaded 23.5 MB that we already ship.
 *
 * Setting explicit `chrome-extension://` paths and disabling the WASM cache keeps every byte of
 * executable code inside the package.
 */

/** Must match scripts/sync-ort-assets.mjs. */
const ORT_ASSETS = {
  mjs: "ort/ort-wasm-simd-threaded.asyncify.mjs",
  wasm: "ort/ort-wasm-simd-threaded.asyncify.wasm",
} as const;

function packagedUrl(relativePath: string): string {
  const runtime = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome?.runtime;
  if (typeof runtime?.getURL === "function") return runtime.getURL(relativePath);
  // Workers created from an extension page share its origin, so this resolves correctly too.
  return new URL(`/${relativePath}`, self.location.href).href;
}

let configured = false;

interface NavigatorPlatformLike {
  platform?: string;
  userAgent?: string;
  userAgentData?: { platform?: string };
}

/** Chrome ignores ONNX's WebGPU adapter preference on Windows and warns for every request. */
export function isWindowsPlatform(navigatorLike: NavigatorPlatformLike | undefined): boolean {
  if (!navigatorLike) return false;
  const platform = navigatorLike.userAgentData?.platform ?? navigatorLike.platform ?? "";
  return /^win/iu.test(platform) || /windows/iu.test(navigatorLike.userAgent ?? "");
}

export function configureOnnxRuntime(): void {
  if (configured) return;
  configured = true;

  env.allowLocalModels = false;
  env.useBrowserCache = true;

  // Must be false: the caching path is what produces the CSP-blocked blob import.
  env.useWasmCache = false;

  // Transformers.js defaults this to `high-performance`. Chromium deliberately ignores that hint
  // on Windows and emits a DevTools warning (crbug.com/369219127), so clear the optional value.
  // registerOnnxWebGpuAdapter() also supplies the adapter we preflight, which prevents ONNX from
  // making a second requestAdapter() call with an options object.
  const webgpu = env.backends?.onnx?.webgpu;
  if (webgpu && isWindowsPlatform(typeof navigator === "undefined" ? undefined : navigator)) {
    Reflect.deleteProperty(webgpu, "powerPreference");
  }

  const wasm = env.backends?.onnx?.wasm;
  if (wasm) {
    wasm.wasmPaths = { mjs: packagedUrl(ORT_ASSETS.mjs), wasm: packagedUrl(ORT_ASSETS.wasm) };
    wasm.proxy = false;
  }
}

/** Reuses the option-free adapter probe instead of asking ONNX to create a second adapter. */
export function registerOnnxWebGpuAdapter(adapter: unknown): void {
  const webgpu = env.backends?.onnx?.webgpu as { adapter?: unknown } | undefined;
  if (webgpu) webgpu.adapter = adapter;
}

/** Exposed so the artifact test can assert the packaged paths are the ones actually referenced. */
export const packagedOrtAssets = ORT_ASSETS;
