/**
 * Composition metadata, kept free of JSX on purpose.
 *
 * The render CLI runs under Node's type stripping, which removes type
 * annotations but does not transform JSX, so it cannot import the scene
 * components. It reads this file; the browser bundle pairs the same entries with
 * their components in `compositions.tsx`. One source of truth, no duplication.
 */
export interface CompositionMeta {
  readonly id: string;
  readonly fps: number;
  readonly width: number;
  readonly height: number;
  readonly durationInFrames: number;
}

// A realistic laptop window: at 1280 the 255px sidebar occupies ~20% of the
// frame, which is what it does in the real client (255 of a 1168px viewport).
const base = { fps: 30, width: 1280, height: 800 } as const;

/**
 * Every composition shows something this fork adds on top of T3 Code. A generic
 * thread list or chat pane belongs in T3's own README, not this one.
 */
export const COMPOSITION_META: readonly CompositionMeta[] = [
  { ...base, id: "voice-orchestrator", durationInFrames: 200 },
  { ...base, id: "custom-agents", durationInFrames: 210 },
  { ...base, id: "terminal-workspaces", durationInFrames: 170 },
  { ...base, id: "thread-artifacts", durationInFrames: 190 },
  { ...base, id: "provider-failover", durationInFrames: 190 },
];
