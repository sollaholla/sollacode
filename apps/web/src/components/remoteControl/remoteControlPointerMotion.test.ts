import { describe, expect, it } from "vite-plus/test";

import {
  createPointerMotionSmoother,
  DEFAULT_POINTER_MAX_STEP,
  mergePointerMoves,
  REMOTE_CONTROL_POINTER_DELTA_LIMIT,
  splitPointerDelta,
} from "./remoteControlPointerMotion.ts";

const move = (extra: { readonly dx?: number; readonly dy?: number } = {}) =>
  ({
    type: "pointer",
    action: "move",
    x: 0.5,
    y: 0.5,
    button: "left",
    ...extra,
  }) as const;

function drain(
  smoother: ReturnType<typeof createPointerMotionSmoother>,
  limit = 500,
): { readonly x: number; readonly y: number; readonly steps: number; readonly peak: number } {
  let x = 0;
  let y = 0;
  let steps = 0;
  let peak = 0;
  for (let index = 0; index < limit; index += 1) {
    const step = smoother.next();
    if (step === null) break;
    x += step.dx;
    y += step.dy;
    steps += 1;
    peak = Math.max(peak, Math.hypot(step.dx, step.dy));
  }
  return { x, y, steps, peak };
}

describe("pointer motion smoothing", () => {
  it("conserves total travel so aim never drifts", () => {
    const smoother = createPointerMotionSmoother();
    smoother.push(300, -180);
    const drained = drain(smoother);
    expect(drained.x).toBe(300);
    expect(drained.y).toBe(-180);
  });

  it("spreads a large flick across several sends instead of one jump", () => {
    const smoother = createPointerMotionSmoother();
    smoother.push(1_200, 0);
    const drained = drain(smoother);
    expect(drained.steps).toBeGreaterThan(1);
    // The fling brake: no single emitted step exceeds the cap.
    expect(drained.peak).toBeLessThanOrEqual(DEFAULT_POINTER_MAX_STEP);
    expect(drained.x).toBe(1_200);
  });

  it("passes a small movement straight through", () => {
    const smoother = createPointerMotionSmoother();
    smoother.push(1, 0);
    expect(smoother.next()).toEqual({ dx: 1, dy: 0 });
    expect(smoother.next()).toBeNull();
  });

  it("preserves direction on a diagonal instead of bending it toward 45 degrees", () => {
    const smoother = createPointerMotionSmoother();
    smoother.push(900, 300);
    const first = smoother.next();
    expect(first).not.toBeNull();
    // Input ratio is 3:1; the first eased step must keep it.
    expect(Math.abs(first!.dx / first!.dy)).toBeCloseTo(3, 1);
  });

  it("accumulates samples that arrive faster than they are drained", () => {
    const smoother = createPointerMotionSmoother();
    smoother.push(10, 10);
    smoother.push(10, 10);
    smoother.push(10, 10);
    const drained = drain(smoother);
    expect(drained.x).toBe(30);
    expect(drained.y).toBe(30);
  });

  it("terminates rather than trailing sub-pixel motion forever", () => {
    const smoother = createPointerMotionSmoother();
    smoother.push(7.4, -3.2);
    const drained = drain(smoother);
    expect(drained.steps).toBeLessThan(20);
    expect(smoother.hasPending()).toBe(false);
  });

  it("drops outstanding motion on reset so it cannot leak after unlock", () => {
    const smoother = createPointerMotionSmoother();
    smoother.push(500, 500);
    smoother.reset();
    expect(smoother.hasPending()).toBe(false);
    expect(smoother.next()).toBeNull();
  });

  it("ignores non-finite samples", () => {
    const smoother = createPointerMotionSmoother();
    smoother.push(Number.NaN, Number.POSITIVE_INFINITY);
    expect(smoother.hasPending()).toBe(false);
  });

  it("falls back to defaults for nonsensical options", () => {
    const smoother = createPointerMotionSmoother({ smoothing: 0, maxStep: -5 });
    smoother.push(400, 0);
    const drained = drain(smoother);
    expect(drained.x).toBe(400);
    expect(drained.peak).toBeLessThanOrEqual(DEFAULT_POINTER_MAX_STEP);
  });

  it("passes everything through when smoothing is disabled", () => {
    const smoother = createPointerMotionSmoother({ smoothing: 1, maxStep: 10_000 });
    smoother.push(250, -90);
    expect(smoother.next()).toEqual({ dx: 250, dy: -90 });
  });
});

describe("splitPointerDelta", () => {
  it("leaves an in-range delta alone", () => {
    expect(splitPointerDelta({ dx: 10, dy: -4 }, 100)).toEqual([{ dx: 10, dy: -4 }]);
  });

  it("chunks an oversized delta without losing travel", () => {
    const chunks = splitPointerDelta({ dx: 950, dy: -300 }, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(Math.abs(chunk.dx)).toBeLessThanOrEqual(100);
      expect(Math.abs(chunk.dy)).toBeLessThanOrEqual(100);
    }
    expect(chunks.reduce((total, chunk) => total + chunk.dx, 0)).toBe(950);
    expect(chunks.reduce((total, chunk) => total + chunk.dy, 0)).toBe(-300);
  });
});

describe("coalescing queued pointer moves", () => {
  it("sums relative deltas instead of discarding the queued one", () => {
    // The bug this guards: a queued relative move used to be *replaced* by the
    // next one. Deltas are increments, so every pixel the queued move carried
    // was thrown away — mouse-look under-rotated whenever the send queue was
    // busy, which is precisely when a fast flick produces the most samples.
    const merged = mergePointerMoves(move({ dx: 12, dy: -7 }), move({ dx: 5, dy: 3 }));
    expect(merged).not.toBeNull();
    expect(merged).toMatchObject({ dx: 17, dy: -4 });
  });

  it("conserves total travel across a burst of coalesced samples", () => {
    const samples = [
      { dx: 30, dy: -10 },
      { dx: -4, dy: 22 },
      { dx: 11, dy: 6 },
      { dx: 0, dy: -3 },
    ];
    let queued = move(samples[0]);
    for (const sample of samples.slice(1)) {
      const merged = mergePointerMoves(queued, move(sample));
      expect(merged).not.toBeNull();
      queued = merged as typeof queued;
    }
    expect(queued.dx).toBe(samples.reduce((total, sample) => total + sample.dx, 0));
    expect(queued.dy).toBe(samples.reduce((total, sample) => total + sample.dy, 0));
  });

  it("lets the newest absolute position win", () => {
    // An absolute move names a destination, so the older one is genuinely dead.
    const merged = mergePointerMoves(move(), { ...move(), x: 0.1, y: 0.9 });
    expect(merged).toMatchObject({ x: 0.1, y: 0.9 });
    expect(merged?.dx).toBeUndefined();
  });

  it("refuses to merge across a pointer-lock transition", () => {
    // Mixing the two would either drop an anchor or reinterpret a delta as a
    // position, so both events have to survive.
    expect(mergePointerMoves(move({ dx: 4, dy: 4 }), move())).toBeNull();
    expect(mergePointerMoves(move(), move({ dx: 4, dy: 4 }))).toBeNull();
  });

  it("refuses to merge past the contract's per-event delta bound", () => {
    const merged = mergePointerMoves(
      move({ dx: REMOTE_CONTROL_POINTER_DELTA_LIMIT, dy: 0 }),
      move({ dx: 1, dy: 0 }),
    );
    // Splitting is the caller's job; a merge here would produce an event the
    // schema rejects, which would fail the whole send.
    expect(merged).toBeNull();
  });
});
