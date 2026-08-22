/**
 * A very small deterministic animation runtime, in the shape of Remotion's API.
 *
 * Remotion is source-available, not open source: free for individuals and
 * for-profit organizations up to three employees, paid above that. Solla Code is
 * MIT, and a README GIF is not worth pushing a licensing question onto everyone
 * who clones the repository. This is the subset those compositions actually use.
 *
 * The model is the same: a composition is a React component rendered once per
 * frame with an explicit frame number. Nothing is time-driven and no CSS
 * transitions are used, so frame N is a pure function of N and rendering is
 * reproducible.
 */
import { createContext, useContext } from "react";

export interface VideoConfig {
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationInFrames: number;
}

export interface FrameState extends VideoConfig {
  readonly frame: number;
}

const FrameContext = createContext<FrameState | null>(null);

export const FrameProvider = FrameContext.Provider;

function useFrameState(): FrameState {
  const state = useContext(FrameContext);
  if (state === null) {
    throw new Error("useCurrentFrame must be called inside a composition render");
  }
  return state;
}

export function useCurrentFrame(): number {
  return useFrameState().frame;
}

export function useVideoConfig(): VideoConfig {
  const { frame: _frame, ...config } = useFrameState();
  return config;
}

export type ExtrapolateMode = "clamp" | "extend";

/**
 * Map a value from one range to another, matching Remotion's signature.
 * Ranges may have more than two stops; segments are found by scanning.
 */
export function interpolate(
  input: number,
  inputRange: readonly number[],
  outputRange: readonly number[],
  options?: {
    readonly extrapolateLeft?: ExtrapolateMode;
    readonly extrapolateRight?: ExtrapolateMode;
  },
): number {
  if (inputRange.length !== outputRange.length || inputRange.length < 2) {
    throw new Error("interpolate needs matching ranges of at least two stops");
  }
  const extrapolateLeft = options?.extrapolateLeft ?? "extend";
  const extrapolateRight = options?.extrapolateRight ?? "extend";

  const first = inputRange[0]!;
  const last = inputRange[inputRange.length - 1]!;
  if (input <= first && extrapolateLeft === "clamp") return outputRange[0]!;
  if (input >= last && extrapolateRight === "clamp") return outputRange[outputRange.length - 1]!;

  let index = 0;
  while (index < inputRange.length - 2 && input >= inputRange[index + 1]!) index += 1;

  const inStart = inputRange[index]!;
  const inEnd = inputRange[index + 1]!;
  const outStart = outputRange[index]!;
  const outEnd = outputRange[index + 1]!;
  if (inEnd === inStart) return outStart;
  return outStart + ((input - inStart) / (inEnd - inStart)) * (outEnd - outStart);
}

export interface SpringConfig {
  /** Higher damping settles sooner with less overshoot. */
  readonly damping?: number;
  readonly mass?: number;
  readonly stiffness?: number;
}

/**
 * A damped-spring value in [0, 1], integrated at the frame rate.
 *
 * Integrating rather than using a closed form keeps this readable and matches
 * Remotion closely enough for UI entrances; `durationInFrames` then rescales the
 * curve so a caller can say "settle within N frames" as they do there.
 */
export function spring(input: {
  readonly frame: number;
  readonly fps: number;
  readonly config?: SpringConfig;
  readonly durationInFrames?: number;
}): number {
  const { config, durationInFrames, fps, frame } = input;
  const damping = config?.damping ?? 10;
  const mass = config?.mass ?? 1;
  const stiffness = config?.stiffness ?? 100;

  if (frame <= 0) return 0;
  // Rescale time so the natural curve completes over the requested duration.
  const naturalDuration = 60;
  const scale = durationInFrames === undefined ? 1 : naturalDuration / durationInFrames;
  const steps = Math.max(0, Math.round(frame * scale));

  let position = 0;
  let velocity = 0;
  const dt = 1 / fps;
  for (let step = 0; step < steps; step += 1) {
    const springForce = -stiffness * (position - 1);
    const dampingForce = -damping * velocity;
    velocity += ((springForce + dampingForce) / mass) * dt;
    position += velocity * dt;
  }
  return position;
}
