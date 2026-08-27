/**
 * Whether closing the last right-panel tab should also fold the right panel away.
 *
 * Once, and only once. Folding on every empty transition would make the
 * sidebar impossible to keep open — reopen it with no tabs and the next close
 * would take it away again — so the latch fires on the first time the panel
 * empties and then stays spent for the rest of the session.
 *
 * Starting with zero tabs is not a transition to zero: someone who opens the
 * app to a bare chat asked for nothing, and having their sidebar vanish on
 * arrival is the opposite of an improvement.
 */
export function shouldAutoCollapseRightPanelOnEmpty(input: {
  readonly previousSurfaceCount: number | null;
  readonly surfaceCount: number;
  readonly alreadyCollapsedOnce: boolean;
  readonly panelOpen: boolean;
}): boolean {
  if (input.alreadyCollapsedOnce) return false;
  if (!input.panelOpen) return false;
  if (input.surfaceCount !== 0) return false;
  return input.previousSurfaceCount !== null && input.previousSurfaceCount > 0;
}
