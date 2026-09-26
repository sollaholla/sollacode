/** How often a startup that could not reach the server tries again on its own. */
export const ROOT_ERROR_RETRY_INTERVAL_MS = 5_000;

interface RetryWindow {
  readonly addEventListener: (type: "online", listener: () => void) => void;
  readonly removeEventListener: (type: "online", listener: () => void) => void;
  readonly setInterval: (handler: () => void, timeout: number) => number;
  readonly clearInterval: (id: number) => void;
}

interface RetryDocument {
  readonly visibilityState: DocumentVisibilityState;
  readonly addEventListener: (type: "visibilitychange", listener: () => void) => void;
  readonly removeEventListener: (type: "visibilitychange", listener: () => void) => void;
}

/**
 * Keeps retrying a startup that failed only because the server was out of
 * reach: now and then while the page is on screen, and at once when the
 * connection or the page comes back. A phone that lost its connection while
 * loading sat on the error until someone pressed a button; the network
 * returning is reason enough to try again. Returns the cleanup.
 */
export function installRootErrorAutoRetry(input: {
  readonly window: RetryWindow;
  readonly document: RetryDocument;
  readonly retry: () => void;
}): () => void {
  const retryIfVisible = () => {
    if (input.document.visibilityState === "visible") input.retry();
  };
  const interval = input.window.setInterval(retryIfVisible, ROOT_ERROR_RETRY_INTERVAL_MS);
  input.window.addEventListener("online", retryIfVisible);
  input.document.addEventListener("visibilitychange", retryIfVisible);
  return () => {
    input.window.clearInterval(interval);
    input.window.removeEventListener("online", retryIfVisible);
    input.document.removeEventListener("visibilitychange", retryIfVisible);
  };
}
