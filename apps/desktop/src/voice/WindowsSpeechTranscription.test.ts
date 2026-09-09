import { describe, expect, it } from "vite-plus/test";
import {
  parseWindowsSpeechResult,
  transcribeWindowsVoice,
  windowsSpeechTimeoutMs,
} from "./WindowsSpeechTranscription.ts";

describe("Windows native transcription", () => {
  it("uses a duration-scaled budget with a hard ceiling before AI fallback", () => {
    expect(windowsSpeechTimeoutMs(32_000 * 10, 16_000)).toBe(7_500);
    expect(windowsSpeechTimeoutMs(32_000 * 120, 16_000)).toBe(30_000);
  });
  it("preserves the entire successful transcript including Unicode", () => {
    expect(
      parseWindowsSpeechResult(
        JSON.stringify({ status: "success", text: "  First phrase. Second phrase, café.  " }),
      ),
    ).toEqual({ status: "success", text: "First phrase. Second phrase, café." });
  });
  it("falls back on uncertain recognition without exposing a partial transcript", () => {
    expect(
      parseWindowsSpeechResult(
        JSON.stringify({ status: "unavailable", reason: "uncertain", text: "partial" }),
      ),
    ).toEqual({ status: "unavailable", reason: "uncertain" });
    for (const response of [
      "not json",
      "null",
      '{"status":"success","text":""}',
      '{"status":"success","text":123}',
    ]) {
      expect(parseWindowsSpeechResult(response).status).toBe("unavailable");
    }
  });
  it("does not spawn on other operating systems or invalid audio", async () => {
    const input = {
      pcm16: new Uint8Array([1]),
      sampleRate: 16_000,
      locale: "en-US",
      contextualStrings: [],
    };
    expect(
      (await transcribeWindowsVoice(input, { platform: "darwin", stateDir: "unused" })).status,
    ).toBe("unavailable");
    expect(
      (await transcribeWindowsVoice(input, { platform: "win32", stateDir: "unused" })).status,
    ).toBe("unavailable");
  });
});
