import { type PreviewAutomationOpenInput, type PreviewSessionSnapshot } from "@t3tools/contracts";

export function shouldOpenPreviewMiniPlayer(input: PreviewAutomationOpenInput): boolean {
  return input.open ?? input.show ?? true;
}

export function previewAutomationOpenNeedsOverlay(
  input: PreviewAutomationOpenInput,
  snapshot: PreviewSessionSnapshot,
): boolean {
  return input.url !== undefined || snapshot.navStatus._tag !== "Idle";
}

/**
 * Explain a `visible: false` result to the agent that just asked to present a
 * tab. Presentation is deliberately not faked for a thread the user is not
 * looking at, so a background-thread open legitimately succeeds and still
 * reports `visible: false`. Unexplained, that reads like a silent refusal:
 * on 2026-08-31 an agent called `preview_open` with
 * `open: true`, got `outcome: "reused"`, `available: true`, `visible: false`,
 * and abandoned work the user had already approved.
 */
export function previewPresentationNotice(input: {
  readonly requestedPresentation: boolean;
  readonly visible: boolean;
}): string {
  if (!input.requestedPresentation || input.visible) return "";
  return " The user is not looking at this tab right now (visible: false), normally because its thread is not the one on screen. That is not a blocker and nothing went wrong: automation is unaffected, so keep driving this tab.";
}
