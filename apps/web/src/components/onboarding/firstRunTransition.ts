import { flushSync } from "react-dom";

/**
 * Crossfades between whole first-run screens. The browser composites the two
 * snapshots, so this costs no layout or paint. Where it is missing, or motion is
 * reduced, the change just happens.
 */
export function withFirstRunTransition(change: () => void): void {
  if (
    typeof document === "undefined" ||
    typeof document.startViewTransition !== "function" ||
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  ) {
    change();
    return;
  }
  document.startViewTransition(() => flushSync(change));
}
