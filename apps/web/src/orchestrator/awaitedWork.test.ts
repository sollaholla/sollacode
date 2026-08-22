import { describe, expect, it } from "vite-plus/test";

import {
  AWAITED_WORK_TTL_MS,
  MAX_AWAITED_WORK,
  MAX_CONSECUTIVE_WAKES,
  buildWakeAnnouncement,
  decideWake,
  forgetAwaitedWork,
  initialAwaitedWorkState,
  noteSessionEnded,
  noteWoke,
  rememberAwaitedWork,
  resetWakeBudget,
  type AwaitedWorkState,
} from "./awaitedWork";

const NOW = 1_760_000_000_000;

const work = (overrides: Partial<Parameters<typeof rememberAwaitedWork>[1]> = {}) => ({
  threadKey: "env-1:thread-a",
  threadTitle: "Synthetic Release Verification",
  request: "look at the issue tracker review and summarize the output",
  askedAt: NOW,
  ...overrides,
});

/** The state the bug actually happened in: asked, then closed on silence. */
const awaitingAfterTimeout = (): AwaitedWorkState =>
  noteSessionEnded(rememberAwaitedWork(initialAwaitedWorkState, work()), "idle-timeout");

const baseInput = {
  threadKey: "env-1:thread-a",
  now: NOW + 60_000,
  settingEnabled: true,
  orchestratorEnabled: true,
  sessionLive: false,
};

describe("rememberAwaitedWork", () => {
  it("replaces rather than stacks a second ask to the same thread", () => {
    const first = rememberAwaitedWork(initialAwaitedWorkState, work());
    const second = rememberAwaitedWork(first, work({ request: "actually, just the failures" }));

    expect(second.items).toHaveLength(1);
    expect(second.items[0]?.request).toBe("actually, just the failures");
  });

  it("keeps the newest asks when more are outstanding than it tracks", () => {
    let state = initialAwaitedWorkState;
    for (let index = 0; index < MAX_AWAITED_WORK + 5; index += 1) {
      state = rememberAwaitedWork(state, work({ threadKey: `env-1:thread-${index}` }));
    }

    expect(state.items).toHaveLength(MAX_AWAITED_WORK);
    expect(state.items.at(-1)?.threadKey).toBe(`env-1:thread-${MAX_AWAITED_WORK + 4}`);
  });

  it("forgets a thread once it has been reported on", () => {
    const state = forgetAwaitedWork(
      rememberAwaitedWork(initialAwaitedWorkState, work()),
      "env-1:thread-a",
    );
    expect(state.items).toEqual([]);
  });
});

describe("decideWake", () => {
  it("wakes for work the orchestrator promised to report on", () => {
    const decision = decideWake({ ...baseInput, state: awaitingAfterTimeout() });

    expect(decision.wake).toBe(true);
    if (decision.wake) {
      expect(decision.work.threadTitle).toBe("Synthetic Release Verification");
      expect(decision.reason).toBe("awaited-work-finished");
    }
  });

  it("never wakes a session the user stopped by hand", () => {
    // The whole point of the restriction: pressing stop is a decision, and an
    // app that reopens the microphone anyway has overruled it.
    const state = noteSessionEnded(rememberAwaitedWork(initialAwaitedWorkState, work()), "user");
    const decision = decideWake({ ...baseInput, state });

    expect(decision).toEqual({ wake: false, reason: "not-closed-by-timeout" });
  });

  it("ignores threads it was not waiting on", () => {
    const decision = decideWake({
      ...baseInput,
      state: awaitingAfterTimeout(),
      threadKey: "env-1:some-other-thread",
    });
    expect(decision).toEqual({ wake: false, reason: "not-awaited" });
  });

  it("does not wake for an ask that has gone stale", () => {
    const decision = decideWake({
      ...baseInput,
      state: awaitingAfterTimeout(),
      now: NOW + AWAITED_WORK_TTL_MS + 1,
    });
    expect(decision).toEqual({ wake: false, reason: "expired" });
  });

  it("wakes right up to the expiry boundary", () => {
    const decision = decideWake({
      ...baseInput,
      state: awaitingAfterTimeout(),
      now: NOW + AWAITED_WORK_TTL_MS,
    });
    expect(decision.wake).toBe(true);
  });

  it("stays quiet when the setting is off, or the orchestrator is", () => {
    expect(
      decideWake({ ...baseInput, state: awaitingAfterTimeout(), settingEnabled: false }),
    ).toEqual({ wake: false, reason: "setting-disabled" });
    expect(
      decideWake({ ...baseInput, state: awaitingAfterTimeout(), orchestratorEnabled: false }),
    ).toEqual({ wake: false, reason: "orchestrator-disabled" });
  });

  it("leaves a live session to its own announcement path", () => {
    expect(decideWake({ ...baseInput, state: awaitingAfterTimeout(), sessionLive: true })).toEqual({
      wake: false,
      reason: "session-live",
    });
  });

  it("stops waking after the budget is spent, and resumes once the user speaks", () => {
    let state = awaitingAfterTimeout();
    for (let index = 0; index < MAX_CONSECUTIVE_WAKES; index += 1) {
      state = noteWoke(state, "env-1:thread-a");
      state = noteSessionEnded(rememberAwaitedWork(state, work({ askedAt: NOW })), "idle-timeout");
    }

    expect(decideWake({ ...baseInput, state })).toEqual({
      wake: false,
      reason: "wake-budget-spent",
    });

    // The user saying something is proof the app is not talking to an empty room.
    expect(decideWake({ ...baseInput, state: resetWakeBudget(state) }).wake).toBe(true);
  });
});

describe("noteWoke", () => {
  it("drops the item and closes the door behind it", () => {
    const state = noteWoke(awaitingAfterTimeout(), "env-1:thread-a");

    expect(state.items).toEqual([]);
    expect(state.consecutiveWakes).toBe(1);
    // A second event must not wake again off the same stale "ended by timeout".
    expect(state.endedBy).toBe("never-started");
    expect(decideWake({ ...baseInput, state })).toEqual({
      wake: false,
      reason: "not-closed-by-timeout",
    });
  });
});

describe("buildWakeAnnouncement", () => {
  it("says why the microphone reopened and what was originally asked", () => {
    const line = buildWakeAnnouncement({
      work: work(),
      completion: "Tell the user what it found.",
    });

    // An app that starts talking unprompted has to say why in its first breath.
    expect(line).toContain("reopened by itself");
    expect(line).toContain("Synthetic Release Verification");
    expect(line).toContain("look at the issue tracker review and summarize the output");
    expect(line).toContain("Tell the user what it found.");
  });
});
