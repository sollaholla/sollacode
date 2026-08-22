import { describe, expect, it } from "vite-plus/test";

import {
  createHeldInputTracker,
  diffHeldKeys,
  FPS_LOOK_SENSITIVITY_DEFAULT,
  FPS_STICK_CENTER,
  FPS_STICK_DEADZONE,
  fpsMovementKeysForVector,
  resolveFpsStickVector,
  scaleFpsLookDelta,
  shouldShowFpsController,
} from "./remoteControlFpsController";

const ORIGIN = { x: 100, y: 100 };
const RADIUS = 50;

function stick(dx: number, dy: number) {
  return resolveFpsStickVector({
    origin: ORIGIN,
    point: { x: ORIGIN.x + dx, y: ORIGIN.y + dy },
    radius: RADIUS,
  });
}

describe("resolveFpsStickVector", () => {
  it("maps a full push to the unit disc edge", () => {
    expect(stick(RADIUS, 0)).toEqual({ x: 1, y: 0, magnitude: 1 });
    expect(stick(0, -RADIUS)).toEqual({ x: 0, y: -1, magnitude: 1 });
  });

  it("scales linearly inside the radius", () => {
    const half = stick(RADIUS / 2, 0);
    expect(half.x).toBeCloseTo(0.5, 10);
    expect(half.magnitude).toBeCloseTo(0.5, 10);
  });

  it("saturates past the radius without changing direction", () => {
    // A thumb sliding past the stick's edge should keep running forward, not
    // snap back to centre.
    const far = stick(0, -RADIUS * 4);
    expect(far).toEqual({ x: 0, y: -1, magnitude: 1 });
  });

  it("does not let a diagonal outrun a cardinal", () => {
    // Clamping per-axis instead of by direction would give a corner push a
    // magnitude of √2, so diagonal movement would read as faster.
    const diagonal = stick(RADIUS * 3, RADIUS * 3);
    expect(Math.hypot(diagonal.x, diagonal.y)).toBeCloseTo(1, 10);
    expect(diagonal.x).toBeCloseTo(Math.SQRT1_2, 10);
  });

  it("returns centre for a degenerate stick or a non-finite point", () => {
    expect(resolveFpsStickVector({ origin: ORIGIN, point: ORIGIN, radius: RADIUS })).toEqual(
      FPS_STICK_CENTER,
    );
    expect(resolveFpsStickVector({ origin: ORIGIN, point: { x: 150, y: 100 }, radius: 0 })).toEqual(
      FPS_STICK_CENTER,
    );
    expect(
      resolveFpsStickVector({ origin: ORIGIN, point: { x: Number.NaN, y: 100 }, radius: RADIUS }),
    ).toEqual(FPS_STICK_CENTER);
  });
});

describe("fpsMovementKeysForVector", () => {
  it("treats screen-up as forward", () => {
    // Positive Y is downward on screen, so forward is negative.
    expect([...fpsMovementKeysForVector(stick(0, -RADIUS))]).toEqual(["KeyW"]);
    expect([...fpsMovementKeysForVector(stick(0, RADIUS))]).toEqual(["KeyS"]);
    expect([...fpsMovementKeysForVector(stick(-RADIUS, 0))]).toEqual(["KeyA"]);
    expect([...fpsMovementKeysForVector(stick(RADIUS, 0))]).toEqual(["KeyD"]);
  });

  it("holds both keys on a diagonal, in canonical order", () => {
    expect([...fpsMovementKeysForVector(stick(-RADIUS, -RADIUS))]).toEqual(["KeyW", "KeyA"]);
  });

  it("holds nothing inside the deadzone", () => {
    const drift = stick(RADIUS * (FPS_STICK_DEADZONE - 0.05), 0);
    expect(fpsMovementKeysForVector(drift).size).toBe(0);
    expect(fpsMovementKeysForVector(FPS_STICK_CENTER).size).toBe(0);
  });

  it("never holds opposing keys at once", () => {
    for (const angle of [0, 30, 45, 90, 135, 180, 225, 270, 315]) {
      const radians = (angle * Math.PI) / 180;
      const held = fpsMovementKeysForVector(
        stick(Math.cos(radians) * RADIUS, Math.sin(radians) * RADIUS),
      );
      expect(held.has("KeyW") && held.has("KeyS")).toBe(false);
      expect(held.has("KeyA") && held.has("KeyD")).toBe(false);
    }
  });
});

describe("diffHeldKeys", () => {
  it("reports only the transitions", () => {
    expect(diffHeldKeys(new Set(["KeyW"]), new Set(["KeyW", "KeyA"]))).toEqual({
      pressed: ["KeyA"],
      released: [],
    });
    expect(diffHeldKeys(new Set(["KeyW", "KeyA"]), new Set(["KeyA"]))).toEqual({
      pressed: [],
      released: ["KeyW"],
    });
  });

  it("emits nothing while a direction is simply held", () => {
    // The regression this guards: re-sending the whole held set every frame
    // floods the host with redundant key-down edges.
    const held = new Set(["KeyW", "KeyD"]);
    expect(diffHeldKeys(held, new Set(held))).toEqual({ pressed: [], released: [] });
  });

  it("releases everything when the stick returns to centre", () => {
    expect(diffHeldKeys(new Set(["KeyW", "KeyA"]), new Set())).toEqual({
      pressed: [],
      released: ["KeyW", "KeyA"],
    });
  });

  it("swaps cleanly when a direction reverses", () => {
    expect(diffHeldKeys(new Set(["KeyW"]), new Set(["KeyS"]))).toEqual({
      pressed: ["KeyS"],
      released: ["KeyW"],
    });
  });
});

describe("scaleFpsLookDelta", () => {
  it("applies sensitivity", () => {
    expect(scaleFpsLookDelta(10)).toBeCloseTo(10 * FPS_LOOK_SENSITIVITY_DEFAULT, 10);
    expect(scaleFpsLookDelta(10, 2)).toBe(20);
  });

  it("bounds sensitivity and clamps the result to the wire limit", () => {
    expect(scaleFpsLookDelta(10, 1_000)).toBe(40);
    expect(scaleFpsLookDelta(10, -5)).toBeCloseTo(4, 10);
    expect(scaleFpsLookDelta(1e9, 4)).toBe(4_000);
    expect(scaleFpsLookDelta(Number.NaN)).toBe(0);
  });
});

describe("shouldShowFpsController", () => {
  const base = {
    armed: true,
    canControl: true,
    canPointer: true,
    canKeyboard: true,
    remoteLocked: true,
    pointerLocked: false,
  };

  it("shows once the pointer is captured by either side", () => {
    expect(shouldShowFpsController(base)).toBe(true);
    expect(shouldShowFpsController({ ...base, remoteLocked: false, pointerLocked: true })).toBe(
      true,
    );
  });

  it("stays hidden until something actually locks the pointer", () => {
    // The look pad emits relative deltas, which only mean anything once the
    // remote is reading motion rather than absolute positions.
    expect(shouldShowFpsController({ ...base, remoteLocked: false, pointerLocked: false })).toBe(
      false,
    );
  });

  it("stays hidden when not armed or not permitted", () => {
    expect(shouldShowFpsController({ ...base, armed: false })).toBe(false);
    expect(shouldShowFpsController({ ...base, canControl: false })).toBe(false);
    expect(shouldShowFpsController({ ...base, canPointer: false })).toBe(false);
  });

  it("stays hidden without the keyboard grant", () => {
    // The movement stick is WASD. A pointer-only session would render a pad
    // whose entire left half silently does nothing.
    expect(shouldShowFpsController({ ...base, canKeyboard: false })).toBe(false);
  });
});

describe("createHeldInputTracker", () => {
  it("emits a press once however many times it arrives", () => {
    // A finger that re-fires pointerdown (or a re-render mid-touch) must not
    // stack duplicate downs on the host.
    const tracker = createHeldInputTracker<string>();
    expect(tracker.press("Space")).toBe(true);
    expect(tracker.press("Space")).toBe(false);
    expect(tracker.size()).toBe(1);
  });

  it("ignores a release for something never pressed", () => {
    // Otherwise a stray pointercancel invents an up edge the host never had a
    // down edge for.
    const tracker = createHeldInputTracker<string>();
    expect(tracker.release("Space")).toBe(false);
  });

  it("pairs every press with exactly one release", () => {
    const tracker = createHeldInputTracker<string>();
    tracker.press("ShiftLeft");
    expect(tracker.release("ShiftLeft")).toBe(true);
    expect(tracker.release("ShiftLeft")).toBe(false);
    expect(tracker.size()).toBe(0);
  });

  it("drains everything outstanding, in press order, exactly once", () => {
    // This is what teardown calls. Anything it misses stays down on the host
    // for the rest of the session.
    const tracker = createHeldInputTracker<string>();
    tracker.press("KeyR");
    tracker.press("Space");
    tracker.press("ControlLeft");
    tracker.release("Space");

    expect(tracker.drain()).toEqual(["KeyR", "ControlLeft"]);
    expect(tracker.drain()).toEqual([]);
    expect(tracker.size()).toBe(0);
  });

  it("can be reused after a drain", () => {
    // Leaving and re-entering FPS mode reuses the same tracker shape; a drain
    // must not poison it.
    const tracker = createHeldInputTracker<string>();
    tracker.press("Space");
    tracker.drain();
    expect(tracker.press("Space")).toBe(true);
    expect(tracker.isHeld("Space")).toBe(true);
  });
});
