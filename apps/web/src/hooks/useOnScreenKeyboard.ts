import { useMediaQuery } from "./useMediaQuery";

/**
 * Whether moving focus into a text field raises a keyboard over the content.
 *
 * A coarse pointer is the whole condition. Every device with a soft keyboard
 * has one, in any orientation and at any width — which is the point: guards
 * written as "phone-sized and portrait and touch" quietly let tablets and
 * sideways phones through, and those raise a keyboard just the same.
 *
 * Use this to suppress *restoring* focus after a UI action. Do not use it to
 * suppress focus the user actually asked for — tapping the composer, quoting a
 * message, typing a character to start a draft — where the keyboard appearing
 * is the whole point.
 */
export function useOnScreenKeyboard(): boolean {
  return useMediaQuery({ pointer: "coarse" });
}
