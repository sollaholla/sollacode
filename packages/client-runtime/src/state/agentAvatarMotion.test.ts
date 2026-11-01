import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  AGENT_AVATAR_BLINK,
  AGENT_AVATAR_DOUBLE_BLINK,
  AGENT_AVATAR_WORK_NOD,
  agentAvatarGlance,
  agentAvatarIdleGesture,
  agentAvatarMoodGesture,
  agentAvatarMotion,
  scheduleAgentAvatarMotion,
  type AgentAvatarGesture,
} from "./agentAvatarMotion.ts";
import { AGENT_AVATAR_SHAPES } from "./agentAppearance.ts";

afterEach(() => vi.useRealTimers());

const allGestures = (): AgentAvatarGesture[] => [
  ...AGENT_AVATAR_SHAPES.map((_, color) => agentAvatarIdleGesture("agent", color)),
  ...(["happy", "blocked", "waiting", "sleeping"] as const).map(
    (mood) => agentAvatarMoodGesture(mood)!,
  ),
  AGENT_AVATAR_BLINK,
  AGENT_AVATAR_DOUBLE_BLINK,
  AGENT_AVATAR_WORK_NOD,
  agentAvatarGlance("agent"),
];

describe("agent avatar gestures", () => {
  it("animate only transforms, stay short and finish where they started", () => {
    for (const gesture of allGestures()) {
      expect(gesture.duration).toBeLessThanOrEqual(1_300);
      for (const track of [gesture.root, gesture.eyes]) {
        if (!track) continue;
        expect(track[0]!.offset).toBe(0);
        expect(track.at(-1)!.offset).toBe(1);
        // A full turn is the same pose as no turn.
        const rest = track.at(-1)!.transform.replace(/rotate\(-?360deg\)/u, "rotate(0deg)");
        expect(rest).toBe(track[0]!.transform);
        for (const frame of track) {
          expect(Object.keys(frame).toSorted().join()).toMatch(/^(easing,)?offset,transform$/u);
          expect(frame.transform).not.toMatch(/NaN|undefined/u);
        }
      }
    }
  });

  it("gives characters their own gesture and blinks with the eyes alone", () => {
    const names = new Set(AGENT_AVATAR_SHAPES.map((_, c) => agentAvatarIdleGesture("a", c).name));
    expect(names.size).toBeGreaterThan(6);
    expect(AGENT_AVATAR_BLINK.root).toBeUndefined();
    expect(AGENT_AVATAR_BLINK.duration).toBeLessThan(200);
    expect(agentAvatarMoodGesture("idle")).toBeNull();
  });

  it("keeps poses for clients that animate one drawing", () => {
    const motion = agentAvatarMotion("agent-0");
    expect(motion.y).toHaveLength(6);
    expect(motion.rotate).toHaveLength(6);
    expect(motion.y.at(-1)).toBe(0);
  });
});

describe("the avatar director", () => {
  it("runs one timer however many avatars are showing, and none once they leave", () => {
    vi.useFakeTimers();
    const cancels = Array.from({ length: 30 }, (_, i) =>
      scheduleAgentAvatarMotion(`agent-${i}`, { play: vi.fn(), rest: vi.fn() }),
    );
    expect(vi.getTimerCount()).toBe(1);
    for (const cancel of cancels) cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("spends the same motion budget for two hundred avatars as for two", () => {
    vi.useFakeTimers();
    const played = vi.fn();
    const cancels = Array.from({ length: 200 }, (_, i) =>
      scheduleAgentAvatarMotion(`agent-${i}`, { play: played, rest: vi.fn() }),
    );
    vi.advanceTimersByTime(60_000);
    expect(played.mock.calls.length).toBeLessThanOrEqual(25);
    for (const cancel of cancels) cancel();
  });

  it("gives a lone avatar regular blinks and an occasional gesture", () => {
    vi.useFakeTimers();
    const played: string[] = [];
    const cancel = scheduleAgentAvatarMotion("agent-0", {
      play: (gesture) => played.push(gesture.name),
      rest: vi.fn(),
    });
    vi.advanceTimersByTime(60_000);
    cancel();
    expect(played.filter((name) => name.includes("blink")).length).toBeGreaterThanOrEqual(6);
    expect(played.filter((name) => !name.includes("blink")).length).toBeGreaterThanOrEqual(3);
  });

  it("nods while working and never blinks closed eyes", () => {
    vi.useFakeTimers();
    let mood: "working" | "sleeping" = "working";
    const played: string[] = [];
    const cancel = scheduleAgentAvatarMotion(
      "agent-0",
      { play: (gesture) => played.push(gesture.name), rest: vi.fn() },
      { mood: () => mood },
    );
    vi.advanceTimersByTime(30_000);
    expect(played).toContain("nod");
    played.length = 0;
    mood = "sleeping";
    vi.advanceTimersByTime(30_000);
    expect(played.some((name) => name.includes("blink") || name === "glance")).toBe(false);
    cancel();
  });

  it("returns to rest when cancelled", () => {
    vi.useFakeTimers();
    const rest = vi.fn();
    const cancel = scheduleAgentAvatarMotion("agent-3", { play: vi.fn(), rest });
    cancel();
    expect(rest).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
