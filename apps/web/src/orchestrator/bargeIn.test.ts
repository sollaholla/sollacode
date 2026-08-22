import { describe, expect, it } from "vite-plus/test";

import {
  BARGE_IN_ACTIVE_LEVEL,
  BARGE_IN_ECHO_MARGIN,
  createBargeInWindow,
  isSustainedSpeech,
  type BargeInSample,
  type BargeInThresholds,
} from "./bargeIn";

/**
 * Level traces are written as ~25-frame windows, which is what one 420ms
 * decision window looks like at 60fps.
 */
const FRAMES = 24;

/** A knock: one or two very loud frames, then exponential decay to nothing. */
const impact = (peak = 0.95): ReadonlyArray<number> =>
  Array.from({ length: FRAMES }, (_, index) => (index < 2 ? peak : peak * Math.pow(0.45, index)));

/** Speech: sustained, varying, never silent for long. */
const speech = (): ReadonlyArray<number> =>
  Array.from({ length: FRAMES }, (_, index) => 0.28 + 0.16 * Math.sin(index / 2));

/**
 * Lifts a bare microphone trace into frames, with the assistant silent — which
 * is what every trace below was already describing implicitly.
 */
const quiet = (trace: ReadonlyArray<number>): ReadonlyArray<BargeInSample> =>
  trace.map((mic) => ({ mic, assistant: 0 }));

/** Room tone with nobody talking. */
const silence = (): ReadonlyArray<number> => Array.from({ length: FRAMES }, () => 0.02);

describe("noises that must not interrupt", () => {
  it("ignores a cup set down on the desk", () => {
    // The reported failure: loud, brief, and it stopped the assistant dead.
    expect(isSustainedSpeech(quiet(impact()))).toBe(false);
  });

  it("ignores an impact louder than any speech", () => {
    // Peak level is deliberately not evidence — this is the case where
    // raising the VAD threshold makes things worse, not better.
    expect(isSustainedSpeech(quiet(impact(1)))).toBe(false);
  });

  it("ignores a double knock", () => {
    const trace = [...impact(0.9).slice(0, 12), ...impact(0.9).slice(0, 12)];
    expect(isSustainedSpeech(quiet(trace))).toBe(false);
  });

  it("ignores a keyboard burst", () => {
    // Short clicks with real gaps between them.
    const trace = Array.from({ length: FRAMES }, (_, index) => (index % 4 === 0 ? 0.6 : 0.03));
    expect(isSustainedSpeech(quiet(trace))).toBe(false);
  });

  it("ignores room tone", () => {
    expect(isSustainedSpeech(quiet(silence()))).toBe(false);
  });

  it("ignores a noise that decays even if it starts long", () => {
    // Active for the first half, dead for the second: something happened, but
    // nothing is happening now.
    const trace = [
      ...Array.from({ length: 12 }, () => 0.5),
      ...Array.from({ length: 12 }, () => 0.01),
    ];
    expect(isSustainedSpeech(quiet(trace))).toBe(false);
  });
});

describe("speech that must interrupt", () => {
  it("treats sustained speech as a real interruption", () => {
    expect(isSustainedSpeech(quiet(speech()))).toBe(true);
  });

  it("catches a quiet talker", () => {
    const softVoice = Array.from({ length: FRAMES }, () => BARGE_IN_ACTIVE_LEVEL + 0.01);
    expect(isSustainedSpeech(quiet(softVoice))).toBe(true);
  });

  it("survives the natural gaps between words", () => {
    // Speech is not continuous; brief dips must not read as decay.
    const trace = Array.from({ length: FRAMES }, (_, index) => (index % 5 === 3 ? 0.05 : 0.35));
    expect(isSustainedSpeech(quiet(trace))).toBe(true);
  });

  it("catches someone talking over a noisy room", () => {
    const trace = Array.from({ length: FRAMES }, (_, index) => 0.3 + (index % 3) * 0.05);
    expect(isSustainedSpeech(quiet(trace))).toBe(true);
  });
});

describe("guards", () => {
  it("refuses to decide on too few frames", () => {
    // A stalled or just-opened window must never trigger an interruption.
    expect(isSustainedSpeech(quiet([0.9, 0.9, 0.9]))).toBe(false);
    expect(isSustainedSpeech(quiet([]))).toBe(false);
  });

  it("honours custom thresholds", () => {
    const strict: BargeInThresholds = {
      activeLevel: 0.8,
      minActiveRatio: 0.9,
      minSamples: 4,
      echoMargin: BARGE_IN_ECHO_MARGIN,
    };
    expect(isSustainedSpeech(quiet(speech()), strict)).toBe(false);
  });
});

describe("createBargeInWindow", () => {
  it("collects frames and rules on them", () => {
    const window = createBargeInWindow();
    for (const mic of speech()) window.push({ mic, assistant: 0 });
    expect(window.sampleCount()).toBe(FRAMES);
    expect(window.verdict()).toBe(true);
  });

  it("returns false for a window that only saw a thud", () => {
    const window = createBargeInWindow();
    for (const mic of impact()) window.push({ mic, assistant: 0 });
    expect(window.verdict()).toBe(false);
  });

  it("is bounded, so a stuck timer cannot grow it without limit", () => {
    const window = createBargeInWindow();
    for (let index = 0; index < 5_000; index += 1) window.push({ mic: 0.4, assistant: 0 });
    expect(window.sampleCount()).toBeLessThanOrEqual(240);
  });
});

describe("the assistant's own voice coming back through the speaker", () => {
  /** Echo: the microphone tracks whatever is being played, at some fraction. */
  const echo = (bleed: number): ReadonlyArray<BargeInSample> =>
    Array.from({ length: FRAMES }, (_, index) => {
      const assistant = 0.5 + 0.2 * Math.sin(index / 2);
      return { mic: assistant * bleed, assistant };
    });

  it("does not interrupt itself on a phone speaker", () => {
    // The reported symptom: the model cut itself off after a word or two.
    // Echo is perfectly sustained, so sustain alone could never catch it —
    // only the comparison against what is actually being played does.
    expect(isSustainedSpeech(echo(0.9))).toBe(false);
  });

  it("does not interrupt itself even on a loud, badly-cancelled speaker", () => {
    // Louder at the microphone than at the source, but still tracking it.
    expect(isSustainedSpeech(echo(1.4))).toBe(false);
  });

  it("still interrupts for someone talking over the assistant", () => {
    // A real person is louder than the leakage and is not correlated with it.
    const trace: ReadonlyArray<BargeInSample> = Array.from({ length: FRAMES }, (_, index) => ({
      mic: 0.55 + 0.15 * Math.sin(index / 2),
      assistant: 0.2,
    }));
    expect(isSustainedSpeech(trace)).toBe(true);
  });

  it("is unchanged on a device whose echo cancellation works", () => {
    // The assistant barely registers, so the ratio never binds and ordinary
    // speech interrupts exactly as before.
    const trace: ReadonlyArray<BargeInSample> = speech().map((mic) => ({ mic, assistant: 0.01 }));
    expect(isSustainedSpeech(trace)).toBe(true);
  });

  it("does not let silence-with-silence count as speech", () => {
    const trace: ReadonlyArray<BargeInSample> = Array.from({ length: FRAMES }, () => ({
      mic: 0,
      assistant: 0,
    }));
    expect(isSustainedSpeech(trace)).toBe(false);
  });
});
