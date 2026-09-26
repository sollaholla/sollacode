/**
 * Input timing is diagnostic evidence, never evidence that a person is absent.
 * Every observed input extends the hold, including long key repeats and fast
 * or forwarded typing. Known automation must be excluded by its dispatch origin
 * before calling this reducer, not inferred here from its speed.
 */

/** Per-source rate threshold used only for diagnostics. */
export const USER_INPUT_STORM_PER_SECOND = 20;
/** How long a high rate must persist before diagnostic reporting. */
export const USER_INPUT_STORM_SUSTAIN_MS = 3_000;

/** One source label's recent rate and storm clock. */
export interface UserInputSourceState {
  /** Event times inside the trailing one-second window, for the rate. */
  readonly recentAtMs: ReadonlyArray<number>;
  /** When the rate first exceeded the storm threshold; 0 while it is below. */
  readonly stormSinceMs: number;
}

/**
 * Sources are a bounded vocabulary (a few observers x a few key or pointer
 * names), but a page could in principle mint labels; keep the map small and
 * drop the label idle longest when it grows past this.
 */
const MAX_TRACKED_SOURCES = 64;

export interface UserInputHoldState {
  /** The timestamp the deferral gate reads; 0 means the user never typed. */
  readonly lastArmAtMs: number;
  /** Which observer last armed the hold (see the sources in Manager.ts). */
  readonly lastSource: string;
  /** Events that moved `lastArmAtMs`. */
  readonly armCount: number;
  /** The press that started the current auto-repeat run. */
  readonly pressRunStartedAtMs: number;
  /** Per-label rate and storm state. */
  readonly sources: ReadonlyMap<string, UserInputSourceState>;
}

export const initialUserInputHoldState: UserInputHoldState = {
  lastArmAtMs: 0,
  lastSource: "none",
  armCount: 0,
  pressRunStartedAtMs: 0,
  sources: new Map(),
};

export interface UserInputArm {
  readonly source: string;
  readonly atMs: number;
  /** A keyboard auto-repeat rather than a fresh press. */
  readonly repeat?: boolean;
}

/** Whether one source currently has a sustained high observed input rate. */
export function isUserInputStorm(
  state: UserInputHoldState,
  source: string,
  nowMs: number,
): boolean {
  const tracked = state.sources.get(source);
  return (
    tracked !== undefined &&
    tracked.stormSinceMs !== 0 &&
    nowMs - tracked.stormSinceMs >= USER_INPUT_STORM_SUSTAIN_MS
  );
}

const trackSource = (
  sources: ReadonlyMap<string, UserInputSourceState>,
  source: string,
  atMs: number,
): ReadonlyMap<string, UserInputSourceState> => {
  const previous = sources.get(source);
  // Only threshold + 1 samples are needed; even an unbounded burst cannot
  // grow this diagnostic buffer without bound.
  const recentAtMs = [
    ...(previous?.recentAtMs ?? []).filter((at) => atMs - at < 1_000),
    atMs,
  ].slice(-(USER_INPUT_STORM_PER_SECOND + 1));
  const stormSinceMs =
    recentAtMs.length > USER_INPUT_STORM_PER_SECOND
      ? previous === undefined || previous.stormSinceMs === 0
        ? atMs
        : previous.stormSinceMs
      : 0;
  const next = new Map(sources);
  next.delete(source);
  if (next.size >= MAX_TRACKED_SOURCES) {
    // Map iteration is insertion order and every write re-inserts, so the
    // first entry is the label idle longest.
    const oldest = next.keys().next();
    if (!oldest.done) next.delete(oldest.value);
  }
  next.set(source, { recentAtMs, stormSinceMs });
  return next;
};

/** Records input already classified by the caller and always extends protection. */
export function armUserInputHold(state: UserInputHoldState, arm: UserInputArm): UserInputHoldState {
  return {
    ...state,
    sources: trackSource(state.sources, arm.source, arm.atMs),
    lastArmAtMs: arm.atMs,
    lastSource: arm.source,
    armCount: state.armCount + 1,
    pressRunStartedAtMs:
      arm.repeat === true && state.pressRunStartedAtMs !== 0 ? state.pressRunStartedAtMs : arm.atMs,
  };
}
