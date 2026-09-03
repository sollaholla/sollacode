/**
 * App-wide net for dynamic-import failures.
 *
 * Hashed asset filenames are served `immutable`, and a release replaces them,
 * so every chunk from the previous build starts returning 404 the moment the
 * server updates. Any client that was already open — a phone left on a tab, a
 * laptop asleep — then dies on its next lazy import with Safari's "Importing a
 * module script failed" (or the Chrome/Firefox equivalents). Reported from
 * mobile Safari on 2026-09-03, right after a desktop update swapped the assets
 * out from under a connected phone.
 *
 * The router error boundary already recovers from this, but it only sees
 * failures raised while a *route* loads. A stale page that lazily pulls a file
 * preview, a syntax-highlighter language chunk or the command palette raises an
 * unhandled rejection with no boundary above it, and Vite's own
 * `vite:preloadError` was not listened for at all. Those paths left the app
 * dead until someone knew to reload by hand.
 *
 * These listeners route every one of those into the same
 * `attemptDynamicImportRecovery`, so its one-shot URL marker and per-version
 * cooldown remain the single guard against reload loops.
 */

import {
  attemptDynamicImportRecovery,
  type DynamicImportRecoveryResult,
  isDynamicImportFailure,
  shouldAutoRecoverDynamicImportFailure,
} from "~/routes/-rootErrorRecovery.logic";

/**
 * Pull the underlying error out of a window event, whatever shape it arrived in.
 *
 * Vite sets `payload` on its `vite:preloadError` event; rejections carry
 * `reason`; error events carry `error` and fall back to `message`.
 */
export function dynamicImportErrorFromEvent(event: Event): unknown {
  const candidate = event as Event & {
    readonly payload?: unknown;
    readonly detail?: unknown;
    readonly reason?: unknown;
    readonly error?: unknown;
    readonly message?: unknown;
  };
  return (
    candidate.payload ??
    candidate.detail ??
    candidate.reason ??
    candidate.error ??
    candidate.message ??
    null
  );
}

/** True when this event is a dynamic-import failure worth recovering from. */
export function isRecoverableDynamicImportEvent(event: Event): boolean {
  return isDynamicImportFailure(dynamicImportErrorFromEvent(event));
}

export interface DynamicImportRecoveryListenerOptions {
  readonly appVersion: string;
  readonly target: Pick<Window, "addEventListener" | "removeEventListener">;
  readonly getStorage: () => Storage;
  readonly location: {
    readonly href: string;
    readonly pathname: string;
    readonly reload: () => void;
    readonly replace: (url: string) => void;
  };
  readonly now: () => number;
  readonly desktopBridgeAvailable: () => boolean;
  readonly onRecovery?: (result: DynamicImportRecoveryResult) => void;
}

const RECOVERABLE_EVENTS = ["vite:preloadError", "unhandledrejection", "error"] as const;

export function installDynamicImportRecoveryListeners(
  options: DynamicImportRecoveryListenerOptions,
): () => void {
  const handle = (event: Event) => {
    const error = dynamicImportErrorFromEvent(event);
    if (
      !shouldAutoRecoverDynamicImportFailure({
        dynamicImportFailure: isDynamicImportFailure(error),
        desktopBridgeAvailable: options.desktopBridgeAvailable(),
      })
    ) {
      return;
    }
    const result = attemptDynamicImportRecovery({
      appVersion: options.appVersion,
      error,
      getStorage: options.getStorage,
      location: options.location,
      now: options.now(),
    });
    options.onRecovery?.(result);
  };

  for (const name of RECOVERABLE_EVENTS) options.target.addEventListener(name, handle);
  return () => {
    for (const name of RECOVERABLE_EVENTS) options.target.removeEventListener(name, handle);
  };
}
