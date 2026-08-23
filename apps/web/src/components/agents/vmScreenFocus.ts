/**
 * Keyboard-routing rules for the VM takeover surface.
 *
 * While the user holds control, the keyboard belongs to the agent's computer.
 * The surface used to forward keys only while it also held DOM focus, which
 * made the whole feature hostage to focus hygiene: any code that pulled focus
 * to the chat composer (autofocus-on-settle effects, streaming re-renders,
 * panels mounting) silently rerouted the user's typing into the chat box
 * mid-session. These rules make the claim explicit instead: control decides
 * routing, and DOM focus is only consulted to respect a *deliberate* move
 * into a text field.
 */

/** Structural view of a focus target — `Element | null` at the call sites. */
export interface FocusTargetLike {
  readonly isContentEditable?: boolean;
  readonly tagName?: string;
}

/** Fields, editors and anything else that legitimately owns typed characters. */
export function isEditableElement(element: FocusTargetLike | null | undefined): boolean {
  if (!element) return false;
  if (element.isContentEditable === true) return true;
  const tag = element.tagName?.toUpperCase();
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Should a keystroke be forwarded to the VM?
 *
 * Claimed whenever the user holds control, EXCEPT when the active element is
 * editable — that is the one signal of "I am deliberately typing somewhere
 * else" (the chat composer, a rename field). A focused button or the page
 * body does not divert the keyboard: releasing control is what ends the claim.
 */
export function shouldForwardKeyToVm(input: {
  readonly canDrive: boolean;
  readonly activeElement: FocusTargetLike | null;
}): boolean {
  if (!input.canDrive) return false;
  return !isEditableElement(input.activeElement);
}

/**
 * Should the surface take DOM focus back after losing it?
 *
 * A deliberate departure always starts with a pointer press outside the
 * surface (clicking the composer, a toolbar button, another pane) — those are
 * respected. A blur with no such press behind it is programmatic: some
 * autofocus effect stole the keyboard out from under the user's hands, which
 * is exactly the bug this exists to stop. Focus moved by a dialog's focus
 * trap lands on non-editable chrome and is left alone so the reclaim never
 * fights a modal.
 */
export function shouldReclaimVmScreenFocus(input: {
  readonly canDrive: boolean;
  readonly hadRecentOutsidePointerDown: boolean;
  readonly blurredTo: FocusTargetLike | null;
}): boolean {
  if (!input.canDrive) return false;
  if (input.hadRecentOutsidePointerDown) return false;
  // null = focus fell to body (or the window itself blurred — refocusing an
  // element in a background window is inert, so that case is harmless).
  return input.blurredTo === null || isEditableElement(input.blurredTo);
}

/** How long a pointer press outside the surface excuses the following blur. */
export const VM_SCREEN_OUTSIDE_POINTER_GRACE_MS = 1_000;
