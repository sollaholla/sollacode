import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { agentAvatarMotion, scheduleAgentAvatarMotion } from "./agentAvatarMotion.ts";

afterEach(() => vi.useRealTimers());

describe("agent character motion", () => {
  it("varies identity, keeps gestures subtle and rests much longer than it moves", () => {
    const variants = new Set<number>();
    const delays = new Set<number>();
    for (let index = 0; index < 32; index += 1) {
      const motion = agentAvatarMotion(`agent-${index}`);
      variants.add(motion.variant);
      delays.add(motion.firstDelay);
      expect(motion.restMs).toBeGreaterThan(motion.duration * 6);
      expect(Math.max(...motion.y.map(Math.abs))).toBeLessThanOrEqual(2.5);
      expect(motion.y.at(-1)).toBe(0);
      expect(motion.rotate.at(-1)).toBe(0);
      expect(motion.scaleX).toEqual(motion.scaleY);
    }
    expect(variants.size).toBe(4);
    expect(delays.size).toBeGreaterThan(25);
  });

  it("blinks briefly, settles to rest and cancels all pending work when disabled", () => {
    vi.useFakeTimers();
    const move = vi.fn();
    const blink = vi.fn();
    const rest = vi.fn();
    const motion = agentAvatarMotion("agent-0");
    const cancel = scheduleAgentAvatarMotion("agent-0", { move, blink, rest });
    vi.advanceTimersByTime(motion.firstBlinkDelay);
    expect(blink).toHaveBeenLastCalledWith(true);
    vi.advanceTimersByTime(motion.blinkDuration);
    expect(blink).toHaveBeenLastCalledWith(false);
    vi.advanceTimersByTime(motion.firstDelay + motion.duration);
    expect(rest).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(60_000);
    expect(move).toHaveBeenCalledTimes(1);
    expect(blink).toHaveBeenLastCalledWith(false);
  });

  it("can be stopped during a blink without leaving the face asleep", () => {
    vi.useFakeTimers();
    const blink = vi.fn();
    const rest = vi.fn();
    const cancel = scheduleAgentAvatarMotion("agent-3", { move: vi.fn(), blink, rest });
    vi.advanceTimersByTime(agentAvatarMotion("agent-3").firstBlinkDelay);
    expect(blink).toHaveBeenLastCalledWith(true);
    cancel();
    expect(blink).toHaveBeenLastCalledWith(false);
    expect(rest).toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps blinking between body gestures", () => {
    vi.useFakeTimers();
    const move = vi.fn();
    const blink = vi.fn();
    const motion = agentAvatarMotion("agent-0");
    const cancel = scheduleAgentAvatarMotion("agent-0", { move, blink, rest: vi.fn() });
    vi.advanceTimersByTime(motion.firstBlinkDelay + motion.blinkRestMs);
    expect(blink.mock.calls.filter(([closed]) => closed)).toHaveLength(2);
    expect(move.mock.calls.length).toBeLessThanOrEqual(1);
    cancel();
    expect(vi.getTimerCount()).toBe(0);
  });
});
