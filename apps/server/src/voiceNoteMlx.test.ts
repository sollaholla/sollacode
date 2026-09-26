import { beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { transcribeVoiceMlx } from "./voiceNoteMlx.ts";

const run = vi.hoisted(() => vi.fn());
vi.mock("@t3tools/shared/nativeVoice/VoiceProcess", () => ({ runVoiceProcess: run }));

const runtime = {
  pythonPath: "/owned/runtime/bin/python",
  modelPath: "/owned/models/pinned-snapshot",
  engine: "parakeet-tdt-0.6b-v3" as const,
  runtimeKey: "verified-runtime",
};

beforeEach(() => {
  run.mockReset();
});

describe("accelerated local voice inference", () => {
  it("uses the managed interpreter and offline model with audio on stdin", async () => {
    run.mockResolvedValue({ exitCode: 0, stdout: '{"text":" In dev. "}', stderr: "" });
    const signal = new AbortController().signal;
    await expect(
      transcribeVoiceMlx(new Uint8Array([1, 0]), runtime, signal, { HF_HUB_OFFLINE: "0" }),
    ).resolves.toBe("In dev.");
    expect(run.mock.calls[0]?.[0]).toBe(runtime.pythonPath);
    expect(run.mock.calls[0]?.[1][0]).toBe("-I");
    const options = run.mock.calls[0]?.[2];
    expect(options).toMatchObject({ signal, env: { HF_HUB_OFFLINE: "1" } });
    expect(JSON.parse(options.input)).toEqual({ pcm16: "AQA=", modelPath: runtime.modelPath });
  });

  it("does not start an already cancelled recording", async () => {
    const controller = new AbortController();
    controller.abort(new Error("recording cancelled"));
    await expect(
      transcribeVoiceMlx(new Uint8Array([1, 0]), runtime, controller.signal, {}),
    ).rejects.toThrow("recording cancelled");
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects late success after cancellation", async () => {
    const controller = new AbortController();
    run.mockImplementation(async () => {
      controller.abort(new Error("recording cancelled"));
      return { exitCode: 0, stdout: '{"text":"late"}', stderr: "" };
    });
    await expect(
      transcribeVoiceMlx(new Uint8Array([1, 0]), runtime, controller.signal, {}),
    ).rejects.toThrow("recording cancelled");
  });

  it.each([
    { exitCode: 1, stdout: "", stderr: "private diagnostic" },
    { exitCode: 0, stdout: '{"text":42}', stderr: "" },
  ])("rejects a failed model without exposing child diagnostics", async (result) => {
    run.mockResolvedValue(result);
    await expect(
      transcribeVoiceMlx(new Uint8Array([1, 0]), runtime, new AbortController().signal, {}),
    ).rejects.toThrow(/local accelerated speech model/);
  });
});
