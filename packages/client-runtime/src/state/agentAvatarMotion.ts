// @effect-diagnostics globalTimers:off globalDate:off
// This client animation scheduler uses one native timer owned by its synchronous cancellation.
import {
  agentAvatarHue,
  agentAvatarTraits,
  type AgentAvatarMood,
  type AgentAvatarShape,
} from "./agentAppearance.ts";

/** A transform at one moment. Translations are percent of the avatar, so any size works. */
export type AgentAvatarKeyframe = {
  readonly offset: number;
  readonly transform: string;
  readonly easing?: string;
};

/**
 * One short gesture: transforms only, so it runs on the compositor and leaves
 * nothing active when it ends. `eyes` moves the eye layer alone.
 */
export interface AgentAvatarGesture {
  readonly name: string;
  readonly duration: number;
  readonly origin: readonly [number, number];
  readonly root?: ReadonlyArray<AgentAvatarKeyframe>;
  readonly eyes?: ReadonlyArray<AgentAvatarKeyframe>;
}

const OUT = "cubic-bezier(.2,.8,.3,1)";
const IN = "cubic-bezier(.6,0,.8,.4)";
const IN_OUT = "cubic-bezier(.45,0,.55,1)";

/** Every frame lists the same functions, so the browser interpolates each number. */
const pose = (y = 0, rotate = 0, scaleX = 1, scaleY = 1, x = 0) =>
  `translate(${x}%, ${y}%) rotate(${rotate}deg) scale(${scaleX}, ${scaleY})`;
const frames = (
  ...list: ReadonlyArray<readonly [number, string, string?]>
): ReadonlyArray<AgentAvatarKeyframe> =>
  list.map(([offset, transform, easing]) =>
    easing === undefined ? { offset, transform } : { offset, transform, easing },
  );
const FEET = [0.5, 0.92] as const;

function body(
  name: string,
  duration: number,
  root: ReadonlyArray<AgentAvatarKeyframe>,
  origin: readonly [number, number] = FEET,
): AgentAvatarGesture {
  return { name, duration, origin, root };
}

/** Squash, leap, land, recover: the anticipation and overshoot are what sell it. */
const hop = body(
  "hop",
  760,
  frames(
    [0, pose(), OUT],
    [0.16, pose(0, 0, 1.1, 0.87), OUT],
    [0.42, pose(-17, 0, 0.94, 1.09), IN],
    [0.62, pose(0, 0, 1.13, 0.85), OUT],
    [0.8, pose(-2.5, 0, 0.97, 1.04), IN_OUT],
    [1, pose()],
  ),
);
const SHAPE_GESTURES: Record<AgentAvatarShape, AgentAvatarGesture> = {
  mochi: hop,
  capsule: body(
    "rock",
    900,
    frames(
      [0, pose(), IN_OUT],
      [0.25, pose(0, -11), IN_OUT],
      [0.55, pose(0, 8), IN_OUT],
      [0.8, pose(0, -3), IN_OUT],
      [1, pose()],
    ),
  ),
  // Rung from its knob, so it swings from the top.
  bell: body(
    "swing",
    960,
    frames(
      [0, pose(), IN_OUT],
      [0.2, pose(0, 14), IN_OUT],
      [0.46, pose(0, -11), IN_OUT],
      [0.7, pose(0, 6), IN_OUT],
      [0.87, pose(0, -2.5), IN_OUT],
      [1, pose()],
    ),
    [0.5, 0.08],
  ),
  acorn: body(
    "wiggle",
    700,
    frames(
      [0, pose(), IN_OUT],
      [0.2, pose(-2, -9, 1.03, 0.97), IN_OUT],
      [0.45, pose(-2, 8, 1.03, 0.97), IN_OUT],
      [0.7, pose(0, -4), IN_OUT],
      [1, pose()],
    ),
  ),
  onion: body(
    "wiggle",
    700,
    frames(
      [0, pose(), IN_OUT],
      [0.2, pose(0, 9, 0.97, 1.04), IN_OUT],
      [0.45, pose(0, -8, 0.97, 1.04), IN_OUT],
      [0.7, pose(0, 4), IN_OUT],
      [1, pose()],
    ),
  ),
  lantern: body(
    "bob",
    980,
    frames(
      [0, pose(), IN_OUT],
      [0.35, pose(-8, 3), IN_OUT],
      [0.7, pose(2, -2), IN_OUT],
      [1, pose()],
    ),
    [0.5, 0.5],
  ),
  // A full turn with a little overshoot.
  sunburst: body(
    "spin",
    980,
    frames(
      [0, pose(0, 0), IN],
      [0.12, pose(0, -14, 1.04, 0.96), IN_OUT],
      [0.72, pose(0, 372), OUT],
      [1, pose(0, 360)],
    ),
    [0.5, 0.55],
  ),
  gumdrop: body(
    "perk",
    760,
    frames(
      [0, pose(), OUT],
      [0.2, pose(0, 0, 1.08, 0.9), OUT],
      [0.46, pose(-5, 0, 0.93, 1.12), IN_OUT],
      [0.72, pose(0, 0, 1.03, 0.98), IN_OUT],
      [1, pose()],
    ),
  ),
  pebble: body(
    "scoot",
    820,
    frames(
      [0, pose(), IN_OUT],
      [0.3, pose(-3, -4, 1, 1, -8), IN_OUT],
      [0.65, pose(-3, 4, 1, 1, 8), IN_OUT],
      [1, pose()],
    ),
  ),
  dango: body(
    "bobble",
    780,
    frames(
      [0, pose(), IN_OUT],
      [0.25, pose(0, 8, 1.02, 0.97), IN_OUT],
      [0.55, pose(0, -7, 1.02, 0.97), IN_OUT],
      [0.8, pose(0, 3), IN_OUT],
      [1, pose()],
    ),
  ),
  star: body(
    "pop",
    720,
    frames(
      [0, pose(), OUT],
      [0.3, pose(-4, 12, 1.17, 1.17), IN_OUT],
      [0.62, pose(0, -5, 0.94, 0.94), IN_OUT],
      [1, pose()],
    ),
    [0.5, 0.55],
  ),
};

const EYES_REST = "translate(0%, 0%) scale(1, 1)";
const eyesAt = (x: number, y: number, scaleY = 1) => `translate(${x}%, ${y}%) scale(1, ${scaleY})`;

const BLINK: AgentAvatarGesture = {
  name: "blink",
  duration: 170,
  origin: FEET,
  eyes: frames(
    [0, EYES_REST, IN],
    [0.42, eyesAt(0, 0, 0.08)],
    [0.58, eyesAt(0, 0, 0.08), OUT],
    [1, EYES_REST],
  ),
};
const DOUBLE_BLINK: AgentAvatarGesture = {
  name: "double-blink",
  duration: 420,
  origin: FEET,
  eyes: frames(
    [0, EYES_REST, IN],
    [0.17, eyesAt(0, 0, 0.08)],
    [0.24, eyesAt(0, 0, 0.08), OUT],
    [0.42, EYES_REST],
    [0.58, EYES_REST, IN],
    [0.75, eyesAt(0, 0, 0.08)],
    [0.82, eyesAt(0, 0, 0.08), OUT],
    [1, EYES_REST],
  ),
};

function glance(direction: number): AgentAvatarGesture {
  return {
    name: "glance",
    duration: 1300,
    origin: FEET,
    root: frames(
      [0, pose(), IN_OUT],
      [0.2, pose(0, direction * 5), IN_OUT],
      [0.8, pose(0, direction * 5), IN_OUT],
      [1, pose()],
    ),
    eyes: frames(
      [0, EYES_REST, OUT],
      [0.14, eyesAt(direction * 9, -1), IN_OUT],
      [0.82, eyesAt(direction * 9, -1), OUT],
      [1, EYES_REST],
    ),
  };
}

/** Heads-down: two small nods while the eyes stay on the work. */
const NOD: AgentAvatarGesture = {
  name: "nod",
  duration: 880,
  origin: FEET,
  root: frames(
    [0, pose(), IN_OUT],
    [0.25, pose(3.5, 5, 1.03, 0.95), IN_OUT],
    [0.5, pose(), IN_OUT],
    [0.75, pose(3.5, -5, 1.03, 0.95), IN_OUT],
    [1, pose()],
  ),
  eyes: frames(
    [0, EYES_REST, IN_OUT],
    [0.25, eyesAt(3, 2.5)],
    [0.75, eyesAt(-3, 2.5), IN_OUT],
    [1, EYES_REST],
  ),
};

/** Plays once as a mood arrives; no mood keeps moving because of what it is. */
const MOOD_ENTRANCES: Partial<Record<AgentAvatarMood, AgentAvatarGesture>> = {
  happy: body(
    "cheer",
    980,
    frames(
      [0, pose(), OUT],
      [0.12, pose(0, 0, 1.08, 0.88), OUT],
      [0.32, pose(-16, -7, 0.95, 1.08), IN],
      [0.5, pose(0, 0, 1.1, 0.88), OUT],
      [0.68, pose(-9, 6, 0.97, 1.05), IN],
      [0.84, pose(0, 0, 1.05, 0.94), OUT],
      [1, pose()],
    ),
  ),
  blocked: body(
    "shake",
    820,
    frames(
      [0, pose(), IN_OUT],
      [0.14, pose(0, -5, 1, 1, -8), IN_OUT],
      [0.3, pose(0, 5, 1, 1, 8), IN_OUT],
      [0.46, pose(0, -3, 1, 1, -5), IN_OUT],
      [0.66, pose(6, 0, 1.12, 0.84), IN_OUT],
      [0.86, pose(5, 0, 1.1, 0.87), IN_OUT],
      [1, pose()],
    ),
  ),
  waiting: body(
    "tilt",
    1100,
    frames(
      [0, pose(), OUT],
      [0.12, pose(0, 0, 1.05, 0.93), OUT],
      [0.34, pose(-9, 13, 0.97, 1.05), IN_OUT],
      [0.78, pose(-7, 11), IN_OUT],
      [1, pose()],
    ),
  ),
  sleeping: body(
    "settle",
    1200,
    frames(
      [0, pose(), IN_OUT],
      [0.45, pose(1.5, 0, 1.05, 0.93), IN_OUT],
      [1, pose()],
    ),
  ),
};

export function agentAvatarMoodGesture(mood: AgentAvatarMood): AgentAvatarGesture | null {
  return MOOD_ENTRANCES[mood] ?? null;
}

export function agentAvatarIdleGesture(
  agentId: string,
  avatarColor?: number | null,
): AgentAvatarGesture {
  return SHAPE_GESTURES[agentAvatarTraits(agentId, avatarColor).shape];
}

export function agentAvatarGlance(agentId: string, avatarColor?: number | null) {
  return glance(agentAvatarTraits(agentId, avatarColor).glance[0] >= 0 ? 1 : -1);
}

export const AGENT_AVATAR_BLINK = BLINK;
export const AGENT_AVATAR_DOUBLE_BLINK = DOUBLE_BLINK;
export const AGENT_AVATAR_WORK_NOD = NOD;

/** Whether this mood shows open eyes, which are the only eyes that can blink or glance. */
const eyesOpen = (mood: AgentAvatarMood) => mood !== "happy" && mood !== "sleeping";

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
  readonly agentId: string;
  readonly avatarColor: number | null | undefined;
  readonly mood: () => AgentAvatarMood;
  readonly stage: AgentAvatarStage;
  nextBlinkAt: number;
  nextMoveAt: number;
  moves: number;
}

const registered = new Set<Registered>();
let timer: ReturnType<typeof setTimeout> | undefined;
let lastPlayedAt = Number.NEGATIVE_INFINITY;

function earliestDue(entry: Registered): number {
  return eyesOpen(entry.mood()) ? Math.min(entry.nextBlinkAt, entry.nextMoveAt) : entry.nextMoveAt;
}

function playNext(entry: Registered, now: number): void {
  const mood = entry.mood();
  if (eyesOpen(mood) && entry.nextBlinkAt <= entry.nextMoveAt) {
    entry.stage.play(entry.seed % 5 === 0 ? DOUBLE_BLINK : BLINK);
    entry.nextBlinkAt = now + 4_200 + (entry.seed + entry.moves) % 3_100;
    entry.moves += 1;
    return;
  }
  if (mood === "working") {
    entry.stage.play(NOD);
    entry.nextMoveAt = now + 2_600 + entry.seed % 1_400;
  } else {
    entry.stage.play(
      // Mostly a look around; every third move is the character's own gesture.
      eyesOpen(mood) && entry.moves % 3 !== 2
        ? agentAvatarGlance(entry.agentId, entry.avatarColor)
        : agentAvatarIdleGesture(entry.agentId, entry.avatarColor),
    );
    entry.nextMoveAt = now + 9_000 + entry.seed % 6_000;
  }
  entry.moves += 1;
}

function arm(): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  if (registered.size === 0) return;
  const now = Date.now();
  let due = Number.POSITIVE_INFINITY;
  for (const entry of registered) due = Math.min(due, earliestDue(entry));
  // Bounded, so a clock set backwards cannot stall every avatar.
  const gapLeft = Math.min(MIN_GAP_MS, lastPlayedAt + MIN_GAP_MS - now);
  timer = setTimeout(tick, Math.max(0, due - now, gapLeft));
}

function tick(): void {
  timer = undefined;
  const now = Date.now();
  let next: Registered | undefined;
  for (const entry of registered) {
    if (next === undefined || earliestDue(entry) < earliestDue(next)) next = entry;
  }
  if (next && earliestDue(next) <= now) {
    lastPlayedAt = now;
    playNext(next, now);
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
  const now = Date.now();
  const entry: Registered = {
    seed,
    agentId,
    avatarColor: options.avatarColor,
    mood: options.mood ?? (() => "idle"),
    stage,
    nextBlinkAt: now + 800 + seed % 3_000,
    nextMoveAt: now + 3_000 + seed % 7_000,
    moves: seed % 3,
  };
  registered.add(entry);
  arm();
  return () => {
    registered.delete(entry);
    stage.rest();
    arm();
  };
}

const POSES = [
  { y: [0, 0.3, -2.5, 0, -0.8, 0], rotate: [0, 0, -2, 1, 0, 0] },
  { y: [0, -0.3, -0.6, -0.4, 0, 0], rotate: [0, -5, 4, -2, 1, 0] },
  { y: [0, 0.4, -1.8, -0.4, 0.2, 0], rotate: [0, 2, 3, -2, 0, 0] },
  { y: [0, -1.8, 0.2, -1.3, 0, 0], rotate: [0, -2, 0, 2, 0, 0] },
] as const;

/** Six evenly spaced poses for a client animating one drawing rather than layers. */
export function agentAvatarMotion(agentId: string) {
  const seed = Math.floor(agentAvatarHue(agentId) * 1000);
  const variant = seed % POSES.length;
  const pose = POSES[variant]!;
  return {
    variant,
    duration: 820 + variant * 90,
    y: pose.y,
    rotate: pose.rotate,
    scaleX: [1, 1.012, 0.995, 1.005, 1, 1],
    scaleY: [1, 1.012, 0.995, 1.005, 1, 1],
  };
}
