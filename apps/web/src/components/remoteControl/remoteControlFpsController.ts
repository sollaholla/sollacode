import { clampPointerDelta } from "./remoteControlPointerMotion";

/**
 * The movement keys a virtual stick drives, in the order edges are emitted.
 *
 * A fixed order keeps the wire deterministic: pressing "forward-left" always
 * sends W before A, so a host replaying the stream cannot observe two
 * different orderings for the same gesture.
 */
export const FPS_MOVEMENT_CODES = ["KeyW", "KeyA", "KeyS", "KeyD"] as const;

export type FpsMovementCode = (typeof FPS_MOVEMENT_CODES)[number];

export interface FpsStickVector {
  /** -1 fully left … 1 fully right. */
  readonly x: number;
  /** -1 fully up … 1 fully down. Screen axis, so down is positive. */
  readonly y: number;
  /** Displacement from centre, 0…1. */
  readonly magnitude: number;
}

export const FPS_STICK_CENTER: FpsStickVector = { x: 0, y: 0, magnitude: 0 };

/**
 * Per-axis magnitude at which a direction starts holding its key.
 *
 * This is what carves the stick into eight directions: an axis engages past
 * 0.35, so a pure cardinal push spans roughly ±20° and each diagonal claims
 * the ~49° between. Too low and a nominally-forward push also holds A or D,
 * which reads as drifting; too high and diagonals become unreachable.
 *
 * It doubles as the jitter guard. A resting thumb wanders a pixel or two, and
 * every crossing of this threshold is a key edge on the wire — a deadzone at
 * 0 would emit hundreds of them per second without the player moving.
 */
export const FPS_STICK_DEADZONE = 0.35;

/** Multiplier from touch-drag pixels to remote look pixels. */
export const FPS_LOOK_SENSITIVITY_DEFAULT = 1.8;

export const FPS_LOOK_SENSITIVITY_MIN = 0.4;
export const FPS_LOOK_SENSITIVITY_MAX = 4;

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

/**
 * Project a touch point onto the stick's unit disc.
 *
 * Beyond the stick radius the vector saturates at magnitude 1 while keeping
 * its direction, so sliding a thumb past the edge keeps running forward
 * instead of snapping back to centre — the same behaviour as a physical stick
 * hitting its gate.
 */
export function resolveFpsStickVector(args: {
  readonly origin: { readonly x: number; readonly y: number };
  readonly point: { readonly x: number; readonly y: number };
  readonly radius: number;
}): FpsStickVector {
  const { origin, point, radius } = args;
  if (!(radius > 0) || !Number.isFinite(radius)) return FPS_STICK_CENTER;
  const rawX = point.x - origin.x;
  const rawY = point.y - origin.y;
  if (!Number.isFinite(rawX) || !Number.isFinite(rawY)) return FPS_STICK_CENTER;
  const distance = Math.hypot(rawX, rawY);
  if (distance === 0) return FPS_STICK_CENTER;
  // Saturate direction-preserving, rather than clamping each axis, so a
  // diagonal push does not gain magnitude over a cardinal one.
  const scale = Math.min(distance, radius) / distance / radius;
  const x = clampUnit(rawX * scale);
  const y = clampUnit(rawY * scale);
  return { x, y, magnitude: Math.min(1, distance / radius) };
}

/**
 * The movement keys a stick position holds down.
 *
 * Screen coordinates put positive Y downward, so pushing *up* is negative Y
 * and means forward — W. Opposing keys can never both be held: one sign per
 * axis.
 */
export function fpsMovementKeysForVector(
  vector: FpsStickVector,
  deadzone: number = FPS_STICK_DEADZONE,
): ReadonlySet<FpsMovementCode> {
  const held = new Set<FpsMovementCode>();
  const limit = Number.isFinite(deadzone) ? Math.max(0, deadzone) : FPS_STICK_DEADZONE;
  // Built in FPS_MOVEMENT_CODES order so iteration — and therefore the edge
  // order in diffHeldKeys — is canonical rather than insertion-dependent.
  if (vector.y < -limit) held.add("KeyW");
  if (vector.x < -limit) held.add("KeyA");
  if (vector.y > limit) held.add("KeyS");
  if (vector.x > limit) held.add("KeyD");
  return held;
}

export interface HeldKeyDiff<Code> {
  readonly pressed: readonly Code[];
  readonly released: readonly Code[];
}

/**
 * Edges between two held-key snapshots.
 *
 * The controller only ever knows which keys *should* be down; the host needs
 * the transitions. Deriving them here — rather than re-sending the whole set
 * each frame — is what keeps a held direction to exactly one down edge, and
 * guarantees every press has a matching release.
 */
export function diffHeldKeys<Code>(
  previous: ReadonlySet<Code>,
  next: ReadonlySet<Code>,
): HeldKeyDiff<Code> {
  const pressed: Code[] = [];
  const released: Code[] = [];
  for (const code of next) {
    if (!previous.has(code)) pressed.push(code);
  }
  for (const code of previous) {
    if (!next.has(code)) released.push(code);
  }
  return { pressed, released };
}

/**
 * Convert a touch-drag delta into a look delta.
 *
 * Clamped through the same bound as a real locked-pointer sample, so a
 * flung thumb cannot exceed what the contract accepts for a mouse.
 */
export function scaleFpsLookDelta(
  delta: number,
  sensitivity: number = FPS_LOOK_SENSITIVITY_DEFAULT,
): number {
  if (!Number.isFinite(delta) || !Number.isFinite(sensitivity)) return 0;
  const bounded = Math.max(
    FPS_LOOK_SENSITIVITY_MIN,
    Math.min(FPS_LOOK_SENSITIVITY_MAX, sensitivity),
  );
  return clampPointerDelta(delta * bounded);
}

export interface HeldInputTracker<Code> {
  /** Record a press. False when it was already held, so nothing is emitted. */
  readonly press: (code: Code) => boolean;
  /** Record a release. False when it was not held, so nothing is emitted. */
  readonly release: (code: Code) => boolean;
  /** Everything still held, in press order, clearing the tracker. */
  readonly drain: () => readonly Code[];
  readonly isHeld: (code: Code) => boolean;
  readonly size: () => number;
}

/**
 * Press/release bookkeeping for input the remote host holds on our behalf.
 *
 * The controller is the only thing that knows a touch ended. A remote key has
 * no idea this UI exists, so a press whose release never arrives leaves the
 * character running into a wall until the session ends — and the ways a touch
 * can end without a tidy `pointerup` are numerous: `pointercancel` from a
 * system gesture, the overlay unmounting because the lock dropped, the dialog
 * closing mid-press.
 *
 * Centralising it makes the two rules testable rather than merely intended:
 * a press is emitted at most once no matter how many times it arrives, and
 * `drain` returns exactly what is outstanding so teardown can release it.
 */
export function createHeldInputTracker<Code>(): HeldInputTracker<Code> {
  // Insertion-ordered, so a drain releases in the order things were pressed.
  const held = new Set<Code>();
  return {
    press: (code) => {
      if (held.has(code)) return false;
      held.add(code);
      return true;
    },
    release: (code) => held.delete(code),
    drain: () => {
      const outstanding = [...held];
      held.clear();
      return outstanding;
    },
    isHeld: (code) => held.has(code),
    size: () => held.size,
  };
}

/**
 * Whether the FPS controller should be on screen.
 *
 * Armed by the user, but only shown once the pointer is actually captured —
 * either because the host reported the remote app grabbed it (a game entering
 * mouse-look) or because this browser granted pointer lock. Those are the same
 * two conditions that switch pointer input to relative deltas, which is what
 * the look pad emits; showing the pad while the remote is still in absolute
 * mode would send deltas nothing is listening for.
 *
 * The keyboard grant is required rather than optional: the movement stick is
 * WASD, so without it half the controller is dead surface that silently
 * swallows the player's thumb.
 */
export function shouldShowFpsController(args: {
  readonly armed: boolean;
  readonly canControl: boolean;
  readonly canPointer: boolean;
  readonly canKeyboard: boolean;
  readonly remoteLocked: boolean;
  readonly pointerLocked: boolean;
}): boolean {
  if (!args.armed || !args.canControl || !args.canPointer || !args.canKeyboard) return false;
  return args.remoteLocked || args.pointerLocked;
}
