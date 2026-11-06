import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { AgentAvatarMood } from "./agentAppearance.ts";
import {
  AGENT_AVATAR_DRIFT,
  AGENT_AVATAR_PULSE,
  AGENT_AVATAR_SWIRL,
  agentAvatarMoodGesture,
  scheduleAgentAvatarMotion,
  type AgentAvatarGesture,
} from "./agentAvatarMotion.ts";

const MOODS: ReadonlyArray<AgentAvatarMood> = [
  "idle",
  "working",
  "waiting",
  "blocked",
  "happy",
  "speaking",
  "sleeping",
];

describe("orb gestures", () => {
  it("pop the status mark in and leave it at full size", () => {
    const badge = agentAvatarMoodGesture("working")?.badge;
    expect(badge?.[0]?.transform).toBe("scale(0)");
    expect(badge?.at(-1)?.transform).toBe("scale(1)");
  });

  it("turn the gas and the stars opposite ways, for depth", () => {
    for (const gesture of [AGENT_AVATAR_DRIFT, AGENT_AVATAR_SWIRL]) {
      expect(gesture.turn?.deep).toBeGreaterThan(0);
      expect(gesture.turn?.dust).toBeLessThan(0);
    }
    expect(AGENT_AVATAR_SWIRL.turn!.deep).toBeGreaterThan(AGENT_AVATAR_DRIFT.turn!.deep);
  });

  it("use transforms only, stay short and end where they began", () => {
    for (const mood of MOODS) {
      const gesture = agentAvatarMoodGesture(mood);
      if (!gesture) continue;
      expect(gesture.duration).toBeLessThanOrEqual(2_500);
      if (gesture.root) expect(gesture.root.at(-1)?.transform).toBe(gesture.root[0]?.transform);
    }
  });

  it("leave rest and sleep without an entrance", () => {
    expect(agentAvatarMoodGesture("idle")).toBeNull();
    expect(agentAvatarMoodGesture("sleeping")).toBeNull();
  });
});

describe("the avatar director", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const stage = (played: Array<AgentAvatarGesture> = []) => ({
    play: (gesture: AgentAvatarGesture) => void played.push(gesture),
    rest: vi.fn(),
  });

  it("runs one timer however many avatars are showing, and none once they leave", () => {
    const cancels = Array.from({ length: 40 }, (_, index) =>
      scheduleAgentAvatarMotion(`agent-${index}`, stage()),
    );
    expect(vi.getTimerCount()).toBe(1);
    for (const cancel of cancels) cancel();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("spends the same motion budget for two hundred avatars as for two", () => {
    const played: Array<AgentAvatarGesture> = [];
    const cancels = Array.from({ length: 200 }, (_, index) =>
      scheduleAgentAvatarMotion(`agent-${index}`, stage(played)),
    );
    vi.advanceTimersByTime(60_000);
    expect(played.length).toBeLessThanOrEqual(25);
    for (const cancel of cancels) cancel();
  });

  it("drifts at rest, swirls while busy and asks for attention when waiting", () => {
    const seen = (mood: AgentAvatarMood) => {
      const played: Array<AgentAvatarGesture> = [];
      const cancel = scheduleAgentAvatarMotion("agent", stage(played), { mood: () => mood });
      vi.advanceTimersByTime(30_000);
      cancel();
      return new Set(played.map((gesture) => gesture.name));
    };
    expect(seen("idle")).toEqual(new Set([AGENT_AVATAR_DRIFT.name]));
    expect(seen("working")).toEqual(new Set([AGENT_AVATAR_SWIRL.name]));
    expect(seen("waiting")).toEqual(new Set([AGENT_AVATAR_PULSE.name]));
  });

  it("leaves a sleeping orb still", () => {
    const played: Array<AgentAvatarGesture> = [];
    const cancel = scheduleAgentAvatarMotion("agent", stage(played), { mood: () => "sleeping" });
    vi.advanceTimersByTime(60_000);
    cancel();
    expect(played).toEqual([]);
  });

  it("returns to rest when cancelled", () => {
    const watching = stage();
    scheduleAgentAvatarMotion("agent", watching)();
    expect(watching.rest).toHaveBeenCalledOnce();
  });
});
