export type ComposerFooterLayoutMode = "full" | "icons" | "overflow";

/**
 * The footer now has a deliberate middle state instead of allowing its labels
 * to be flex-shrunk into accidental fragments. Only truly narrow composers
 * collapse all secondary controls into the overflow menu.
 */
export const COMPOSER_FOOTER_OVERFLOW_BREAKPOINT_PX = 360;
// Enter icon-only mode with enough room left for the fixed right-side actions.
// Waiting until labels visibly overflow makes the transition feel broken,
// especially in split and side-chat layouts where that action cluster still
// consumes a substantial part of the composer width.
export const COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX = 900;
export const COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX = 1080;

// Compatibility names for the prior two-state layout. Compact now means the
// narrow overflow state; intermediate widths use the new icon-only state.
export const COMPOSER_FOOTER_COMPACT_BREAKPOINT_PX = COMPOSER_FOOTER_OVERFLOW_BREAKPOINT_PX;
export const COMPOSER_FOOTER_WIDE_ACTIONS_COMPACT_BREAKPOINT_PX =
  COMPOSER_FOOTER_OVERFLOW_BREAKPOINT_PX;
export const COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX = 780;

export function resolveComposerFooterLayoutMode(
  width: number | null,
  options?: { hasWideActions?: boolean },
): ComposerFooterLayoutMode {
  if (width === null) return "full";
  if (width < COMPOSER_FOOTER_OVERFLOW_BREAKPOINT_PX) return "overflow";

  const iconOnlyBreakpoint = options?.hasWideActions
    ? COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX
    : COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX;
  return width < iconOnlyBreakpoint ? "icons" : "full";
}

export function shouldUseCompactComposerFooter(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  return resolveComposerFooterLayoutMode(width, options) === "overflow";
}

export function shouldUseCompactComposerPrimaryActions(
  width: number | null,
  options?: { hasWideActions?: boolean },
): boolean {
  if (!options?.hasWideActions) {
    return false;
  }
  return width !== null && width < COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX;
}
