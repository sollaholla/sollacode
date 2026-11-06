// @effect-diagnostics globalTimers:off globalDate:off
// This client animation scheduler uses one native timer owned by its synchronous cancellation.
import { agentAvatarHue, type AgentAvatarMood } from "./agentAppearance.ts";

/** A transform at one moment. Translations are percent of the avatar, so any size works. */
export type AgentAvatarKeyframe = {
  readonly offset: number;
  readonly transform: string;
  readonly easing?: string;
};

/**
 * One short move: transforms only, so it runs on the compositor and leaves
 * nothing active when it ends. `turn` rotates the inside of the orb behind its
 * still glass, by degrees added to wherever each layer last came to rest. The
 * gas and the stars turn opposite ways, which is what gives the ball its depth.
 */
export interface AgentAvatarGesture {
  readonly name: string;
  readonly duration: number;
  readonly turn?: { readonly deep: number; readonly dust: number };
  readonly root?: ReadonlyArray<AgentAvatarKeyframe>;
  /** The corner status mark, which pops in just after the orb has moved. */
  readonly badge?: ReadonlyArray<AgentAvatarKeyframe>;
}

/** The middle of the corner slot every status mark sits in, as fractions of the frame. */
export const AGENT_AVATAR_BADGE_ORIGIN = [0.81, 0.16] as const;

export const AGENT_AVATAR_TURN_EASING = "cubic-bezier(.45,0,.55,1)";

const OUT = "cubic-bezier(.2,.8,.3,1)";
const IN_OUT = AGENT_AVATAR_TURN_EASING;

const frames = (
  ...list: ReadonlyArray<readonly [number, string, string?]>
): ReadonlyArray<AgentAvatarKeyframe> =>
  list.map(([offset, transform, easing]) =>
    easing === undefined ? { offset, transform } : { offset, transform, easing },
  );

/** A slow turn at rest. */
export const AGENT_AVATAR_DRIFT: AgentAvatarGesture = {
  name: "drift",
  duration: 2_400,
  turn: { deep: 18, dust: -30 },
};

/** Busy: the galaxy winds up. */
export const AGENT_AVATAR_SWIRL: AgentAvatarGesture = {
  name: "swirl",
  duration: 2_400,
  turn: { deep: 52, dust: -84 },
};

/** Wants attention: the whole orb swells once. */
export const AGENT_AVATAR_PULSE: AgentAvatarGesture = {
  name: "pulse",
  duration: 900,
  root: frames(
    [0, "scale(1)", OUT],
    [0.38, "scale(1.07)", IN_OUT],
    [0.72, "scale(0.985)", IN_OUT],
    [1, "scale(1)"],
  ),
};

/** Stuck: a small shake, the one move here that reads as a problem. */
const SHAKE: AgentAvatarGesture = {
  name: "shake",
  duration: 620,
  root: frames(
    [0, "translate(0%, 0%)"],
    [0.2, "translate(-3%, 0%)", IN_OUT],
    [0.45, "translate(3%, 0%)", IN_OUT],
    [0.7, "translate(-1.5%, 0%)", IN_OUT],
    [1, "translate(0%, 0%)"],
  ),
};

/** Done: one fast turn with a swell, then still. */
const SURGE: AgentAvatarGesture = {
  name: "surge",
  duration: 1_300,
  turn: { deep: 150, dust: -220 },
  root: AGENT_AVATAR_PULSE.root!,
};

const BADGE_POP = frames(
  [0, "scale(0)", OUT],
  [0.55, "scale(0)", OUT],
  [0.78, "scale(1.18)", IN_OUT],
  [1, "scale(1)"],
);

const MOOD_ENTRANCES: Record<AgentAvatarMood, AgentAvatarGesture | null> = {
  idle: null,
  working: AGENT_AVATAR_SWIRL,
  waiting: AGENT_AVATAR_PULSE,
  blocked: SHAKE,
  happy: SURGE,
  speaking: AGENT_AVATAR_PULSE,
  sleeping: null,
};

export function agentAvatarMoodGesture(mood: AgentAvatarMood): AgentAvatarGesture | null {
  const gesture = MOOD_ENTRANCES[mood];
  return gesture ? { ...gesture, badge: BADGE_POP } : null;
}

/** The move a mood keeps coming back to, and roughly how long it leaves between them. */
function restingMove(mood: AgentAvatarMood, seed: number) {
  switch (mood) {
    case "working":
    case "speaking":
      return { gesture: AGENT_AVATAR_SWIRL, wait: 2_600 + (seed % 1_400) };
    case "waiting":
    case "blocked":
      return { gesture: AGENT_AVATAR_PULSE, wait: 5_000 + (seed % 2_000) };
    case "sleeping":
      return null;
    default:
      return { gesture: AGENT_AVATAR_DRIFT, wait: 9_000 + (seed % 6_000) };
  }
}

// ---------------------------------------------------------------------------
// One director for the whole client. Each avatar asks for its next move and a
// single timer serves them, at most one every MIN_GAP_MS. So the cost of motion
// stays flat however many avatars are on screen, nothing runs between moves, and
// no timer exists at all once none are showing.

const MIN_GAP_MS = 2_500;

export interface AgentAvatarStage {
  readonly play: (gesture: AgentAvatarGesture) => void;
  /** Stops anything playing and returns to rest. */
  readonly rest: () => void;
}

interface Registered {
  readonly seed: number;
  readonly mood: () => AgentAvatarMood;
  readonly stage: AgentAvatarStage;
  nextMoveAt: number;
}

const registered = new Set<Registered>();
let timer: ReturnType<typeof setTimeout> | undefined;
let lastPlayedAt = Number.NEGATIVE_INFINITY;

function arm(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (registered.size === 0) return;
  const now = Date.now();
  let due = Number.POSITIVE_INFINITY;
  for (const entry of registered) due = Math.min(due, entry.nextMoveAt);
  // Bounded, so a clock set backwards cannot stall every avatar.
  const gapLeft = Math.min(MIN_GAP_MS, lastPlayedAt + MIN_GAP_MS - now);
  timer = setTimeout(tick, Math.max(0, due - now, gapLeft));
}

function tick(): void {
  timer = undefined;
  const now = Date.now();
  let next: Registered | undefined;
  for (const entry of registered) {
    if (next === undefined || entry.nextMoveAt < next.nextMoveAt) next = entry;
  }
  if (next && next.nextMoveAt <= now) {
    const move = restingMove(next.mood(), next.seed);
    if (move) {
      lastPlayedAt = now;
      next.stage.play(move.gesture);
    }
    next.nextMoveAt = now + (move?.wait ?? 10_000);
  }
  arm();
}

/** Gives an avatar turns from the director. Returns a complete cancellation. */
export function scheduleAgentAvatarMotion(
  agentId: string,
  stage: AgentAvatarStage,
  options: {
    readonly avatarColor?: number | null | undefined;
    readonly mood?: (() => AgentAvatarMood) | undefined;
  } = {},
): () => void {
  const seed = Math.floor(agentAvatarHue(agentId, options.avatarColor) * 1000);
  const entry: Registered = {
    seed,
    mood: options.mood ?? (() => "idle"),
    stage,
    nextMoveAt: Date.now() + 800 + (seed % 6_000),
  };
  registered.add(entry);
  arm();
  return () => {
    registered.delete(entry);
    stage.rest();
    arm();
  };
}
