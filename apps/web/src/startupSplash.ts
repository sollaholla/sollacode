/**
 * The startup splash is drawn by `index.html` before any app code loads, and
 * stays up until the app has a real screen to show. It is one surface with one
 * rule: it covers the app while the app itself is starting — its code, the
 * sign-in check, the workspace, and the first screen's code — and never
 * returns afterwards. Later loads show their own in-place loading states.
 *
 * The app tells it which step it is on so a slow start says what it is waiting
 * for, and dismisses it once the first screen is ready.
 */
export type StartupStage = "loading" | "signing-in" | "connecting" | "opening";

interface StartupSplashController {
  readonly setStage: (stage: StartupStage) => void;
  readonly done: () => void;
}

declare global {
  interface Window {
    __sollaSplash?: StartupSplashController;
  }
}

export function setStartupStage(stage: StartupStage): void {
  if (typeof window === "undefined") return;
  window.__sollaSplash?.setStage(stage);
}

/** Removes the splash. Safe to call more than once. */
export function finishStartup(): void {
  if (typeof window === "undefined") return;
  window.__sollaSplash?.done();
}

/**
 * Whether the first screen at this path is the chat view, whose code the
 * splash waits for (and starts downloading early). Everything else under the
 * chat layout — the landing page included — ends up in it.
 */
export function startupRouteShowsChatView(pathname: string): boolean {
  return !/^\/(?:settings|agents|orchestrator|pair|connect)(?:\/|$)/u.test(pathname);
}
