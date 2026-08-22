import { describe, expect, it } from "vite-plus/test";

import { float32ToPcm16Base64, pcm16Base64ToFloat32, resampleLinear } from "./pcmAudio";

describe("pcm16 codec", () => {
  it("round-trips silence as zeros", () => {
    const encoded = float32ToPcm16Base64(new Float32Array(8));
    const decoded = pcm16Base64ToFloat32(encoded);
    expect(decoded.length).toBe(8);
    expect([...decoded].every((sample) => sample === 0)).toBe(true);
  });

  it("preserves a full-scale sample within integer rounding", () => {
    const encoded = float32ToPcm16Base64(new Float32Array([0.5, -0.5]));
    const decoded = pcm16Base64ToFloat32(encoded);
    expect(decoded[0]).toBeCloseTo(0.5, 3);
    expect(decoded[1]).toBeCloseTo(-0.5, 3);
  });
});

describe("resampleLinear", () => {
  it("copies the buffer when rates match", () => {
    const input = new Float32Array([0, 1, 0]);
    const output = resampleLinear(input, 24_000, 24_000);
    expect([...output]).toEqual([0, 1, 0]);
    expect(output).not.toBe(input);
  });

  it("stretches a two-sample ramp when downsampling", () => {
    const output = resampleLinear(new Float32Array([0, 1]), 48_000, 24_000);
    expect(output.length).toBe(1);
    expect(output[0]).toBeCloseTo(0, 5);
  });
});
