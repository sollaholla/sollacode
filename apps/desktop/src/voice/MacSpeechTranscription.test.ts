import { describe, expect, it } from "vite-plus/test";

import { encodeMonoPcm16Wav, readMacosMajorVersion } from "./MacSpeechTranscription.ts";

describe("MacSpeechTranscription", () => {
  it("reads the user-facing macOS major version", () => {
    expect(readMacosMajorVersion("26.3.1")).toBe(26);
    expect(readMacosMajorVersion("15.7")).toBe(15);
    expect(readMacosMajorVersion("Darwin 25")).toBeNull();
  });

  it("wraps little-endian mono PCM in a valid WAV container", () => {
    const wav = encodeMonoPcm16Wav({
      pcm16: new Uint8Array([0x00, 0x80, 0xff, 0x7f]),
      sampleRate: 16_000,
    });
    const text = (start: number, length: number) =>
      String.fromCharCode(...wav.slice(start, start + length));
    const view = new DataView(wav.buffer);

    expect(text(0, 4)).toBe("RIFF");
    expect(text(8, 4)).toBe("WAVE");
    expect(text(12, 4)).toBe("fmt ");
    expect(view.getUint16(20, true)).toBe(1);
    expect(view.getUint16(22, true)).toBe(1);
    expect(view.getUint32(24, true)).toBe(16_000);
    expect(view.getUint16(34, true)).toBe(16);
    expect(text(36, 4)).toBe("data");
    expect(Array.from(wav.slice(44))).toEqual([0x00, 0x80, 0xff, 0x7f]);
  });
});
