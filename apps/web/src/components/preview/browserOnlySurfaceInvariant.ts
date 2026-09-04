/**
 * Whether an empty agent panel should be refilled with a Browser tab.
 *
 * An agent's panel opens on its browser rather than the general-purpose "Open
 * a surface" chooser, so a panel that is empty because nothing has been opened
 * yet gets a Browser tab.
 *
 * What it must NOT do is refill a panel the user just emptied. Closing the last
 * tab is how the column is meant to go away - {@link
 * shouldAutoCollapseRightPanelOnEmpty} folds it, exactly as it does for a
 * thread. The refill runs in a layout effect and that collapse runs in a
 * passive one, so React fires the refill first and the tab snapped straight
 * back: closing the final tab of an agent was simply impossible.
 *
 * `previousSurfaceCount` is what separates the two. Null (nothing observed yet)
 * or zero means the panel opened empty and should be filled; anything above
 * zero means it just lost its last surface, which is a deliberate close and has
 * to be honoured. Reopening the panel later starts from zero again, so the
 * Browser tab still comes back.
 */
export function shouldEnsureBrowserOnlySurface(input: {
  readonly browserOnly: boolean;
  readonly browserAvailable: boolean;
  readonly panelOpen: boolean;
  readonly surfaceCount: number;
  readonly previousSurfaceCount: number | null;
}): boolean {
  if (!input.browserOnly || !input.browserAvailable || !input.panelOpen) return false;
  if (input.surfaceCount !== 0) return false;
  return (input.previousSurfaceCount ?? 0) === 0;
}

/**
 * Which browser surface an empty agent panel should be refilled with.
 *
 * The refill exists so the panel is never empty — not to manufacture tabs. When
 * the host still has tabs for this thread (an agent's own tabs, or the ones a
 * person left open), adopt the most recently updated instead of stacking a
 * blank tab beside them. Only a thread with no tabs at all gets a fresh blank.
 */
export function resolveBrowserOnlySurfaceTarget(sessions: {
  readonly [tabId: string]: { readonly updatedAt: string };
}): { readonly kind: "existing"; readonly tabId: string } | { readonly kind: "blank" } {
  let newest: { tabId: string; updatedAt: string } | null = null;
  for (const [tabId, session] of Object.entries(sessions)) {
    if (newest === null || session.updatedAt > newest.updatedAt) {
      newest = { tabId, updatedAt: session.updatedAt };
    }
  }
  return newest === null ? { kind: "blank" } : { kind: "existing", tabId: newest.tabId };
}
