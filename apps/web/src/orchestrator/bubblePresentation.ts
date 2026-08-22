import type { DesktopOrchestratorBubbleState } from "@t3tools/contracts";

/**
 * Pure appearance math for the floating voice orb, kept out of the component
 * so the response curve is testable without a DOM.
 *
 * The user asked for the orb to grow when the orchestrator speaks and grow
 * *more* when they do — so the mic term outweighs the assistant term.
 */

export const BUBBLE_BASE_DIAMETER = 56;
/** The window is 128px; the orb plus glow must never clip against it. */
export const BUBBLE_MAX_SCALE = 2.0;

const MIC_WEIGHT = 0.95;
const ASSISTANT_WEIGHT = 0.55;

export function computeBubbleScale(state: DesktopOrchestratorBubbleState): number {
  if (state.status === "idle" || state.status === "error") return 1;
  const mic = clamp01(state.micLevel);
  const assistant = clamp01(state.assistantLevel);
  return Math.min(BUBBLE_MAX_SCALE, 1 + mic * MIC_WEIGHT + assistant * ASSISTANT_WEIGHT);
}

/** 0..1 halo intensity driven by whichever side is louder. */
export function computeBubbleGlow(state: DesktopOrchestratorBubbleState): number {
  if (state.status === "idle" || state.status === "error") return 0;
  return Math.max(clamp01(state.micLevel), clamp01(state.assistantLevel) * 0.8);
}

/**
 * Frame-to-frame smoothing: quick to swell, slow to settle, so speech reads as
 * motion instead of flicker.
 */
export function smoothBubbleScale(previous: number, target: number): number {
  const factor = target > previous ? 0.55 : 0.16;
  return previous + (target - previous) * factor;
}

function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}
