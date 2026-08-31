export function shouldEnsureBrowserOnlySurface(input: {
  readonly browserOnly: boolean;
  readonly browserAvailable: boolean;
  readonly panelOpen: boolean;
  readonly surfaceCount: number;
}): boolean {
  return input.browserOnly && input.browserAvailable && input.panelOpen && input.surfaceCount === 0;
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
