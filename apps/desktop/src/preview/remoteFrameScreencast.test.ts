import { describe, expect, it } from "vite-plus/test";

import { createScreencastPacer } from "./remoteFrameScreencast.ts";

/** A manual timer queue: nothing runs until the test advances the clock. */
function fakeTimers() {
  let now = 0;
  let nextId = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer: (run: () => void, ms: number) => {
      const id = nextId++;
      timers.set(id, { at: now + ms, run });
      return () => timers.delete(id);
    },
    advance: (ms: number) => {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()]
          .filter(([, timer]) => timer.at <= until)
          .sort((left, right) => left[1].at - right[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].run();
      }
      now = until;
    },
  };
}

const pacer = (timers: ReturnType<typeof fakeTimers>) => {
  const acks: Array<{ at: number; sessionId: number }> = [];
  const refreshes: Array<number> = [];
  const instance = createScreencastPacer({
    minIntervalMs: 50,
    settleMs: 120,
    now: timers.now,
    setTimer: timers.setTimer,
    ack: (sessionId) => acks.push({ at: timers.now(), sessionId }),
    refresh: () => refreshes.push(timers.now()),
  });
  return { instance, acks, refreshes };
};

describe("createScreencastPacer", () => {
  it("acknowledges an isolated frame at once and asks for nothing more", () => {
    const timers = fakeTimers();
    const { instance, acks, refreshes } = pacer(timers);
    instance.onFrame(1);
    timers.advance(1_000);
    expect(acks).toEqual([{ at: 0, sessionId: 1 }]);
    expect(refreshes).toEqual([]);
  });

  it("spaces acknowledgements of a burst by the minimum interval", () => {
    const timers = fakeTimers();
    const { instance, acks } = pacer(timers);
    instance.onFrame(1);
    timers.advance(16);
    instance.onFrame(1);
    timers.advance(16);
    instance.onFrame(1);
    timers.advance(200);
    expect(acks.map((ack) => ack.at)).toEqual([0, 50, 100]);
  });

  it("asks for one more frame when a held-back burst goes quiet", () => {
    const timers = fakeTimers();
    const { instance, acks, refreshes } = pacer(timers);
    instance.onFrame(1);
    timers.advance(10);
    instance.onFrame(1);
    timers.advance(1_000);
    expect(acks.map((ack) => ack.at)).toEqual([0, 50]);
    // The page may have changed after the held frame and been dropped.
    expect(refreshes).toEqual([170]);
  });

  it("skips the extra frame when the page keeps drawing", () => {
    const timers = fakeTimers();
    const { instance, refreshes } = pacer(timers);
    instance.onFrame(1);
    timers.advance(10);
    instance.onFrame(1);
    timers.advance(100);
    instance.onFrame(1);
    timers.advance(60);
    expect(refreshes).toEqual([]);
  });

  it("does nothing after it is disposed", () => {
    const timers = fakeTimers();
    const { instance, acks, refreshes } = pacer(timers);
    instance.onFrame(1);
    instance.onFrame(1);
    instance.dispose();
    timers.advance(1_000);
    instance.onFrame(1);
    expect(acks).toHaveLength(1);
    expect(refreshes).toEqual([]);
  });
});
