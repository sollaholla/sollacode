import { describe, expect, it } from "vite-plus/test";

import {
  GATE_CLOSE_MARGIN_DB,
  GATE_OPEN_MARGIN_DB,
  microphoneConstraints,
  shouldGateOpen,
  supportsVoiceIsolation,
  updateNoiseFloor,
} from "./voiceIsolation";

describe("microphoneConstraints", () => {
  it("asks for platform voice isolation where the browser knows the constraint", () => {
    expect(microphoneConstraints({ isolationSupported: true })).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      voiceIsolation: true,
    });
  });

  it("leaves it out where it is unknown, since an unknown constraint can throw", () => {
    expect(microphoneConstraints({ isolationSupported: false })).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    });
  });
});

describe("supportsVoiceIsolation", () => {
  it("believes the browser's own list rather than sniffing a user agent", () => {
    expect(
      supportsVoiceIsolation({ getSupportedConstraints: () => ({ voiceIsolation: true }) }),
    ).toBe(true);
    expect(supportsVoiceIsolation({ getSupportedConstraints: () => ({}) })).toBe(false);
    expect(supportsVoiceIsolation({})).toBe(false);
  });
});

describe("shouldGateOpen", () => {
  it("needs a clear margin over the noise floor to open", () => {
    expect(
      shouldGateOpen({ levelDb: -40 + GATE_OPEN_MARGIN_DB + 1, noiseFloorDb: -40, wasOpen: false }),
    ).toBe(true);
    expect(
      shouldGateOpen({ levelDb: -40 + GATE_OPEN_MARGIN_DB - 1, noiseFloorDb: -40, wasOpen: false }),
    ).toBe(false);
  });

  it("holds open on a smaller margin, so speech does not chatter it shut", () => {
    // Between the two thresholds: closed stays closed, open stays open. That
    // gap is the whole point — a voice hovering at one threshold would
    // otherwise gate on and off syllable by syllable.
    const between = -40 + (GATE_OPEN_MARGIN_DB + GATE_CLOSE_MARGIN_DB) / 2;
    expect(shouldGateOpen({ levelDb: between, noiseFloorDb: -40, wasOpen: true })).toBe(true);
    expect(shouldGateOpen({ levelDb: between, noiseFloorDb: -40, wasOpen: false })).toBe(false);
  });
});

describe("updateNoiseFloor", () => {
  it("drops quickly towards a quieter moment", () => {
    // A genuinely quiet frame is the best evidence of the floor there is.
    expect(updateNoiseFloor({ current: -40, levelDb: -60 })).toBeLessThan(-45);
  });

  it("rises only slowly, so a long sentence cannot drag the gate shut", () => {
    const raised = updateNoiseFloor({ current: -60, levelDb: -10 });
    expect(raised).toBeGreaterThan(-60);
    expect(raised).toBeLessThan(-59.9);
  });

  it("ignores a non-finite level rather than poisoning the floor", () => {
    expect(updateNoiseFloor({ current: -50, levelDb: Number.NEGATIVE_INFINITY })).toBe(-50);
  });
});
