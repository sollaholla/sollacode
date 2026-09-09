import { describe, expect, it, vi } from "vite-plus/test";
import { createLocalTranscriptionRunner } from "./localTranscription";

function transcriber(text: string) {
  return Object.assign(
    vi.fn(async () => ({ text })),
    { dispose: vi.fn(async () => {}) },
  );
}

describe("local transcription acceleration", () => {
  it("reuses the GPU model and passes the current request id for progress", async () => {
    const model = transcriber("complete");
    const create = vi.fn(async () => model);
    const runner = createLocalTranscriptionRunner({ hasWebGpu: true, create });
    const audio = new Float32Array([0.1, 0.2]);
    await runner.transcribe(audio, 1);
    await runner.transcribe(audio, 2);
    expect(create).toHaveBeenCalledExactlyOnceWith("webgpu", 1);
    expect(model).toHaveBeenLastCalledWith(audio, 2);
    await runner.dispose();
    expect(model.dispose).toHaveBeenCalledOnce();
  });

  it("uses WASM directly when WebGPU is unavailable", async () => {
    const create = vi.fn(async () => transcriber("CPU result"));
    const runner = createLocalTranscriptionRunner({ hasWebGpu: false, create });
    expect(await runner.transcribe(new Float32Array(), 1)).toEqual({ text: "CPU result" });
    expect(create).toHaveBeenCalledExactlyOnceWith("wasm", 1);
  });

  it("falls back after GPU initialization fails and keeps using the CPU model", async () => {
    const model = transcriber("recovered");
    const create = vi.fn(async (device: string) => {
      if (device === "webgpu") throw new Error("adapter unavailable");
      return model;
    });
    const runner = createLocalTranscriptionRunner({ hasWebGpu: true, create });
    await runner.transcribe(new Float32Array(), 1);
    await runner.transcribe(new Float32Array(), 2);
    expect(create.mock.calls).toEqual([
      ["webgpu", 1],
      ["wasm", 1],
    ]);
  });

  it("retries the entire recording once after GPU inference fails", async () => {
    const gpu = Object.assign(
      vi.fn(async () => {
        throw new Error("device lost");
      }),
      { dispose: vi.fn(async () => {}) },
    );
    const cpu = transcriber("all phrases");
    const create = vi.fn(async (device: string) => (device === "webgpu" ? gpu : cpu));
    const runner = createLocalTranscriptionRunner({ hasWebGpu: true, create });
    const audio = new Float32Array([0.1, 0.2, 0.3]);
    expect(await runner.transcribe(audio, 4)).toEqual({ text: "all phrases" });
    expect(gpu.dispose).toHaveBeenCalledOnce();
    expect(cpu).toHaveBeenCalledExactlyOnceWith(audio, 4);
  });

  it("clears a failed CPU load so the next recording can retry", async () => {
    const create = vi
      .fn()
      .mockRejectedValueOnce(new Error("download failed"))
      .mockResolvedValue(transcriber("retry worked"));
    const runner = createLocalTranscriptionRunner({ hasWebGpu: false, create });
    await expect(runner.transcribe(new Float32Array(), 1)).rejects.toThrow("download failed");
    expect(await runner.transcribe(new Float32Array(), 2)).toEqual({ text: "retry worked" });
    expect(create).toHaveBeenCalledTimes(2);
  });
});
