import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { RemoteClickFeedback, TOUCH_PRESS_MARKER_DELAY_MS } from "./clickFeedback.ts";

describe("remote click feedback", () => {
  it("shows touch-down immediately, then waits for its matching host receipt", () => {
    const state = new RemoteClickFeedback();
    state.press({ x: 0.25, y: 0.75 }, { x: 20, y: 60 });
    expect(state.getSnapshot()).toMatchObject([{ x: 0.25, y: 0.75, state: "pressed" }]);
    const first = state.submit({ x: 0.25, y: 0.75 });
    const second = state.submit({ x: 0.8, y: 0.1 });
    state.settle(second, true);
    expect(state.getSnapshot()).toMatchObject([{ id: first, state: "pending" }]);
    state.settle("unrelated-receipt", true);
    expect(state.getSnapshot()).toHaveLength(1);
    state.settle(first, true);
    expect(state.getSnapshot()).toEqual([]);
  });

  it("cancels a scroll or pinch candidate without dropping already submitted clicks", () => {
    const state = new RemoteClickFeedback();
    const pending = state.submit({ x: 0.1, y: 0.2 });
    state.press({ x: 0.3, y: 0.4 }, { x: 30, y: 40 });
    state.movePress({ x: 31, y: 40 }, 8);
    expect(state.getSnapshot()).toHaveLength(2);
    state.movePress({ x: 50, y: 40 }, 8);
    expect(state.getSnapshot()).toMatchObject([{ id: pending }]);
    state.press({ x: 0.3, y: 0.4 }, { x: 30, y: 40 });
    state.cancelPress();
    expect(state.getSnapshot()).toMatchObject([{ id: pending }]);
  });

  it("shows failure until the next gesture, instead of implying success", () => {
    const state = new RemoteClickFeedback();
    const id = state.submit({ x: 0.5, y: 0.5 });
    state.settle(id, false);
    expect(state.getSnapshot()).toMatchObject([{ id, state: "failed" }]);
    state.press({ x: 0.2, y: 0.2 }, { x: 20, y: 20 });
    expect(state.getSnapshot()).toMatchObject([{ state: "pressed" }]);
  });

  describe("a touch that may turn out to be a pinch", () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    const touch = { delayMs: TOUCH_PRESS_MARKER_DELAY_MS };

    it("shows no dot if the second finger lands in time", () => {
      const state = new RemoteClickFeedback();
      state.press({ x: 0.3, y: 0.4 }, { x: 30, y: 40 }, touch);
      expect(state.getSnapshot()).toEqual([]);
      vi.advanceTimersByTime(TOUCH_PRESS_MARKER_DELAY_MS - 1);
      state.cancelPress();
      vi.runAllTimers();
      expect(state.getSnapshot()).toEqual([]);
    });

    it("shows the dot once the touch has lasted, and keeps clicks already sent", () => {
      const state = new RemoteClickFeedback();
      const pending = state.submit({ x: 0.1, y: 0.2 });
      state.press({ x: 0.3, y: 0.4 }, { x: 30, y: 40 }, touch);
      vi.advanceTimersByTime(TOUCH_PRESS_MARKER_DELAY_MS);
      expect(state.getSnapshot()).toMatchObject([{ id: pending }, { state: "pressed" }]);
    });

    it("clears an old failure straight away, and adds no dot after a click or reset", () => {
      const state = new RemoteClickFeedback();
      const failed = state.submit({ x: 0.5, y: 0.5 });
      state.settle(failed, false);
      state.press({ x: 0.3, y: 0.4 }, { x: 30, y: 40 }, touch);
      expect(state.getSnapshot()).toEqual([]);
      const clicked = state.submit({ x: 0.3, y: 0.4 });
      vi.runAllTimers();
      expect(state.getSnapshot()).toMatchObject([{ id: clicked, state: "pending" }]);
      state.press({ x: 0.3, y: 0.4 }, { x: 30, y: 40 }, touch);
      state.reset();
      vi.runAllTimers();
      expect(state.getSnapshot()).toEqual([]);
    });
  });

  it("ignores a previous tab's completion after scope reset", () => {
    const state = new RemoteClickFeedback();
    const old = state.submit({ x: 0.1, y: 0.1 });
    state.reset();
    const current = state.submit({ x: 0.9, y: 0.9 });
    state.settle(old, true);
    expect(state.getSnapshot()).toMatchObject([{ id: current, state: "pending" }]);
  });
});
