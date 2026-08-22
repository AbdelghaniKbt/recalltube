import { beforeEach, describe, expect, it, vi } from "vitest";

const pipelineMock = vi.fn();
const configureMock = vi.fn();
const registerAdapterMock = vi.fn();

vi.mock("@huggingface/transformers", () => ({
  pipeline: pipelineMock,
}));

vi.mock("./runtime/ort-env", () => ({
  configureOnnxRuntime: configureMock,
  registerOnnxWebGpuAdapter: registerAdapterMock,
}));

describe("TransformersEmbeddingProvider", () => {
  beforeEach(() => {
    pipelineMock.mockReset();
    configureMock.mockReset();
    registerAdapterMock.mockReset();
    vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn().mockResolvedValue({}) } });
  });

  it("disposes a partially initialized WebGPU pipeline before falling back to WASM", async () => {
    const webgpu = Object.assign(vi.fn().mockRejectedValue(new Error("GPU adapter unavailable")), {
      dispose: vi.fn().mockResolvedValue(undefined),
    });
    const wasm = Object.assign(
      vi.fn().mockResolvedValue({
        data: new Float32Array(384),
        dims: [1, 384],
        tolist: () => [Array.from({ length: 384 }, () => 0)],
      }),
      { dispose: vi.fn().mockResolvedValue(undefined) }
    );
    pipelineMock.mockImplementation(async (_task, _model, options: { device: string }) =>
      options.device === "webgpu" ? webgpu : wasm
    );

    const { TransformersEmbeddingProvider } = await import("./transformers-provider");
    const provider = new TransformersEmbeddingProvider("e5-small");
    await expect(provider.initialize({ preferredBackend: "webgpu" })).resolves.toEqual({ backend: "wasm" });

    expect(pipelineMock.mock.calls.map((call) => call[2].device)).toEqual(["webgpu", "wasm"]);
    expect(registerAdapterMock).toHaveBeenCalledOnce();
    expect((navigator as Navigator & { gpu: { requestAdapter: ReturnType<typeof vi.fn> } }).gpu.requestAdapter)
      .toHaveBeenCalledWith();
    expect(webgpu.dispose).toHaveBeenCalledOnce();
    expect(provider.activeBackend).toBe("wasm");
  });

  it("uses WASM directly when Chromium exposes WebGPU without an adapter", async () => {
    vi.stubGlobal("navigator", { gpu: { requestAdapter: vi.fn().mockResolvedValue(null) } });
    const wasm = Object.assign(
      vi.fn().mockResolvedValue({
        data: new Float32Array(384),
        dims: [1, 384],
        tolist: () => [Array.from({ length: 384 }, () => 0)],
      }),
      { dispose: vi.fn().mockResolvedValue(undefined) }
    );
    pipelineMock.mockResolvedValue(wasm);

    const { TransformersEmbeddingProvider } = await import("./transformers-provider");
    const provider = new TransformersEmbeddingProvider("e5-small");
    await expect(provider.initialize({ preferredBackend: "webgpu" })).resolves.toEqual({ backend: "wasm" });

    expect(pipelineMock).toHaveBeenCalledOnce();
    expect(pipelineMock.mock.calls[0]![2].device).toBe("wasm");
    expect(registerAdapterMock).not.toHaveBeenCalled();
  });
});
