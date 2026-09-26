import { describe, expect, it, vi } from "vite-plus/test";
import { prepareVoiceNoteForSend } from "./voiceNote";
const decode = vi.hoisted(() => vi.fn());
vi.mock("./pushToTalk", async (importOriginal) => {
  const original = await importOriginal<typeof import("./pushToTalk")>();
  return { ...original, decodeAudio: decode };
});

describe("voice note send preparation", () => {
  it("encodes host-readable mono PCM and computes duration from decoded audio", async () => {
    decode.mockResolvedValue(new Float32Array(16000).fill(0.25));
    const result = await prepareVoiceNoteForSend(
      new File(["original"], "Voice note", { type: "audio/mp4" }),
    );
    expect(result).toMatchObject({
      type: "audio",
      mimeType: "audio/wav",
      durationMs: 1000,
      sizeBytes: 32044,
    });
    const binary = atob(result.dataUrl.split(",")[1]!);
    const wav = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    expect(new TextDecoder().decode(wav.slice(0, 4))).toBe("RIFF");
    expect(new DataView(wav.buffer).getUint32(24, true)).toBe(16000);
    expect(new DataView(wav.buffer).getInt16(44, true) / 32767).toBeCloseTo(0.25, 4);
  });
  it("rejects oversized recordings instead of silently dropping spoken content", async () => {
    decode.mockResolvedValue(new Float32Array(120 * 16000 + 1));
    await expect(prepareVoiceNoteForSend(new File(["original"], "Voice note"))).rejects.toThrow(
      "exceeds two minutes",
    );
  });
});
