import { pipeline, type FeatureExtractionPipeline } from "@huggingface/transformers";
import { configureOnnxRuntime, registerOnnxWebGpuAdapter } from "./runtime/ort-env";
import { modelDescriptor, type ModelDescriptor } from "./models";
import type { Backend, EmbeddingProvider, InitializeOptions } from "./provider";

/**
 * `EmbeddingProvider` backed by transformers.js.
 *
 * Two behaviours are deliberate:
 *
 *   - WebGPU is attempted first and falls back to WASM on *any* failure, including a failure that
 *     only surfaces on the first inference rather than at construction time.
 *   - Query and passage prefixes come from the model descriptor rather than being hard-coded, so
 *     a symmetric model cannot accidentally inherit E5's asymmetric convention.
 */

interface TensorLike {
  tolist(): number[][];
  data?: Float32Array;
  dims?: number[];
}

type Extractor = FeatureExtractionPipeline;

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly modelId: string;
  readonly modelRevision: string;
  readonly dimension: number;
  readonly dtype: string;
  readonly pooling: string;

  private extractor?: Extractor;
  private backend: Backend = "wasm";
  private readonly descriptor: ModelDescriptor;

  constructor(modelKey: string) {
    this.descriptor = modelDescriptor(modelKey);
    this.id = this.descriptor.id;
    this.modelId = this.descriptor.repo;
    this.modelRevision = this.descriptor.revision;
    this.dimension = this.descriptor.dimension;
    this.dtype = this.descriptor.dtype;
    this.pooling = this.descriptor.pooling;
  }

  get activeBackend(): Backend {
    return this.backend;
  }

  async initialize(options: InitializeOptions): Promise<{ backend: Backend }> {
    configureOnnxRuntime();
    if (this.extractor) return { backend: this.backend };

    const progressCallback = (event: { status?: string; progress?: number; file?: string }) => {
      if (event.status === "progress") {
        options.onProgress?.({ phase: "downloading", progress: event.progress, file: event.file });
      } else if (event.status === "ready") {
        options.onProgress?.({ phase: "ready" });
      }
    };

    const create = (device: Backend) =>
      pipeline("feature-extraction", this.descriptor.repo, {
        revision: this.descriptor.revision,
        dtype: this.descriptor.dtype,
        device,
        progress_callback: progressCallback,
      });

    const order: Backend[] =
      options.preferredBackend === "webgpu" && (await this.webgpuAvailable())
        ? ["webgpu", "wasm"]
        : ["wasm"];

    const failures: string[] = [];
    for (const device of order) {
      if (options.signal?.aborted) throw new Error("Model initialization cancelled.");
      let extractor: Extractor | undefined;
      try {
        extractor = await create(device);
        // A WebGPU pipeline can construct and only fail on first inference; prove it works before
        // committing, otherwise the first user search is the thing that discovers the problem.
        await extractor("warmup", { pooling: this.descriptor.pooling, normalize: true });
        this.extractor = extractor;
        this.backend = device;
        options.onProgress?.({ phase: "ready" });
        return { backend: device };
      } catch (error) {
        // Transformers.js cannot initialize WASM while a failed WebGPU session is still alive.
        // Pipeline creation can succeed and warm-up can fail, so dispose the partial pipeline
        // before trying the next backend.
        await extractor?.dispose?.().catch(() => undefined);
        failures.push(`[${device}] ${error instanceof Error ? error.message : String(error)}`);
        if (options.signal?.aborted) throw new Error("Model initialization cancelled.");
      }
    }

    throw new Error(`No usable inference backend. ${failures.join("; ")}`);
  }

  private async webgpuAvailable(): Promise<boolean> {
    if (typeof navigator === "undefined" || !("gpu" in navigator)) return false;
    const gpu = (navigator as Navigator & {
      gpu?: { requestAdapter?: () => Promise<unknown | null> };
    }).gpu;
    if (typeof gpu?.requestAdapter !== "function") return false;
    try {
      // Chromium can expose navigator.gpu while providing no adapter (common under Linux/Xvfb).
      // Constructing an ONNX WebGPU session in that state poisons its process-wide backend and can
      // prevent a subsequent WASM fallback, so prove an adapter exists before creating a pipeline.
      // Do not pass an options object here. Chromium ignores powerPreference on Windows and logs a
      // warning whenever the property is present. Reusing this adapter also avoids ONNX Runtime's
      // second requestAdapter({ powerPreference, ... }) call entirely.
      const adapter = await gpu.requestAdapter();
      if (!adapter) return false;
      registerOnnxWebGpuAdapter(adapter);
      return true;
    } catch {
      return false;
    }
  }

  private async embed(texts: string[], prefix: string, signal?: AbortSignal): Promise<Float32Array[]> {
    if (!this.extractor) throw new Error("The embedding model is not initialized.");
    if (!texts.length) return [];

    const output = (await this.extractor(
      texts.map((text) => `${prefix}${text}`),
      { pooling: this.descriptor.pooling, normalize: true }
    )) as unknown as TensorLike;

    const dimension = this.descriptor.dimension;
    // Prefer the flat typed array: `tolist()` allocates nested JS arrays we would immediately
    // convert back to Float32Array.
    if (output.data instanceof Float32Array && output.data.length === texts.length * dimension) {
      const vectors: Float32Array[] = [];
      for (let index = 0; index < texts.length; index += 1) {
        vectors.push(output.data.slice(index * dimension, (index + 1) * dimension));
      }
      return vectors;
    }
    return output.tolist().map((row) => Float32Array.from(row));
  }

  async embedQueries(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return this.embed(texts, this.descriptor.queryPrefix, signal);
  }

  async embedPassages(texts: string[], signal?: AbortSignal): Promise<Float32Array[]> {
    return this.embed(texts, this.descriptor.passagePrefix, signal);
  }

  async dispose(): Promise<void> {
    const extractor = this.extractor;
    this.extractor = undefined;
    await extractor?.dispose?.().catch(() => undefined);
  }
}
