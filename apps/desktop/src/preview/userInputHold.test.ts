import { describe, expect, it } from "vite-plus/test";

import {
  USER_INPUT_STORM_PER_SECOND,
  armUserInputHold,
  initialUserInputHoldState,
  isUserInputStorm,
  type UserInputHoldState,
} from "./userInputHold.ts";

const T0 = 1_000_000;
const drive = (
  state: UserInputHoldState,
  arms: ReadonlyArray<{ atMs: number; repeat?: boolean; source?: string }>,
): UserInputHoldState =>
  arms.reduce(
    (current, arm) =>
      armUserInputHold(current, {
        ...arm,
        source: arm.source ?? "app-typing:keydown",
      }),
    state,
  );

describe("armUserInputHold", () => {
  it("names the observer and protects a deliberate input", () => {
    expect(
      armUserInputHold(initialUserInputHoldState, {
        source: "guest-key:tab_1",
        atMs: T0,
      }),
    ).toMatchObject({ lastArmAtMs: T0, lastSource: "guest-key:tab_1", armCount: 1 });
  });

  it("protects a deliberate held key beyond ten seconds", () => {
    const repeats = Array.from({ length: 600 }, (_, index) => ({
      atMs: T0 + 500 + index * 90,
      repeat: true,
    }));
    const state = drive(initialUserInputHoldState, [{ atMs: T0 }, ...repeats]);
    expect(state.lastArmAtMs).toBe(repeats.at(-1)?.atMs);
    expect(state.lastArmAtMs - T0).toBeGreaterThan(50_000);
    expect(state.armCount).toBe(601);
  });

  it("protects a repeat even when the initial press was not observed", () => {
    const state = armUserInputHold(initialUserInputHoldState, {
      source: "app-key",
      atMs: T0,
      repeat: true,
    });
    expect(state.lastArmAtMs).toBe(T0);
  });

  it("never treats a sustained high input rate as evidence that a person is absent", () => {
    const arms = Array.from({ length: 1190 }, (_, index) => ({ atMs: T0 + (index * 1000) / 24 }));
    const state = drive(initialUserInputHoldState, arms);
    expect(isUserInputStorm(state, "app-typing:keydown", arms.at(-1)!.atMs)).toBe(true);
    expect(state.lastArmAtMs).toBe(arms.at(-1)?.atMs);
    expect(state.armCount).toBe(1190);
  });

  it("protects mixed native, renderer, and forwarded input throughout a fast stream", () => {
    const sources = ["app-key", "app-typing:keydown:<char>", "reclaimed-key:tab_1"];
    const arms = Array.from({ length: 1800 }, (_, index) => ({
      atMs: T0 + index * 10,
      source: sources[index % sources.length]!,
      repeat: index % 2 === 0,
    }));
    const state = drive(initialUserInputHoldState, arms);
    expect(state.armCount).toBe(1800);
    expect(state.lastArmAtMs).toBe(T0 + 17_990);
    const takeover = armUserInputHold(state, {
      source: "app-typing:pointerdown:mouse-0",
      atMs: T0 + 18_000,
    });
    expect(takeover.lastArmAtMs).toBe(T0 + 18_000);
  });

  it("clears high-rate diagnostic state after input becomes quiet", () => {
    const busy = drive(
      initialUserInputHoldState,
      Array.from({ length: 300 }, (_, index) => ({ atMs: T0 + index * 30 })),
    );
    expect(isUserInputStorm(busy, "app-typing:keydown", T0 + 9_000)).toBe(true);
    const quiet = armUserInputHold(busy, { source: "app-typing:keydown", atMs: T0 + 30_000 });
    expect(isUserInputStorm(quiet, "app-typing:keydown", T0 + 30_000)).toBe(false);
    expect(quiet.lastArmAtMs).toBe(T0 + 30_000);
  });

  it("bounds both source count and per-source samples without dropping protection", () => {
    const arms = Array.from({ length: 10_000 }, (_, index) => ({
      atMs: T0 + index / 100,
      source: `guest-key:tab_${index % 80}`,
    }));
    const state = drive(initialUserInputHoldState, arms);
    expect(state.sources.size).toBeLessThanOrEqual(64);
    expect(state.armCount).toBe(10_000);
    const burst = drive(
      state,
      Array.from({ length: 10_000 }, (_, index) => ({ atMs: T0 + 100 + index / 100 })),
    );
    expect(burst.sources.get("app-typing:keydown")!.recentAtMs.length).toBeLessThanOrEqual(
      USER_INPUT_STORM_PER_SECOND + 1,
    );
    expect(burst.armCount).toBe(20_000);
  });
});
