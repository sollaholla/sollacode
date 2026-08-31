/**
 * Which renderer input events mean "the user is typing somewhere automation
 * must not steal".
 *
 * Originally ANY trusted pointerdown or keydown in the app window armed the
 * deferral cooldown. That is far too broad: clicking a thread in the sidebar,
 * a tab, or any button re-armed a 5s hold, so simply reading through threads
 * kept every agent parked and the "waiting for you" state never cleared
 * (reported 2026-08-31). Only two surfaces actually own a caret worth
 * protecting — a text field in the app (the composer above all) and a guest
 * page in the preview browser. Guest input is armed separately, on the
 * webContents itself, so this covers the app window alone.
 */
export const EDITABLE_FOCUS_SELECTOR =
  'input:not([type="button"]):not([type="submit"]):not([type="reset"]):not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]):not([type="color"]), textarea, [contenteditable="true"], [contenteditable="plaintext-only"]';

/**
 * Keydown is judged by where focus already is: the character is about to land
 * in the focused field regardless of what the event's target reports.
 * Pointerdown is judged by what was hit, because focus has not moved yet — the
 * click IS the user claiming that field.
 */
export function isTypingSurfaceInput(input: {
  readonly eventType: string;
  readonly activeElementIsEditable: boolean;
  readonly targetIsInsideEditable: boolean;
}): boolean {
  if (input.eventType === "keydown") return input.activeElementIsEditable;
  if (input.eventType === "pointerdown") return input.targetIsInsideEditable;
  return false;
}
