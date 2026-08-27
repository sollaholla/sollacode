export interface AgentAttentionComposer {
  readonly readSnapshot: () => { readonly value: string };
  readonly insertTextAtEnd: (
    text: string,
    options?: { readonly ensureLeadingBoundary?: boolean },
  ) => boolean;
  readonly focusAtEnd: () => void;
}

export interface WaitingOnYouFollowUpScheduler {
  readonly schedule: (callback: () => void) => number;
  readonly cancel: (handle: number) => void;
}

const browserFrameScheduler: WaitingOnYouFollowUpScheduler = {
  schedule: (callback) => window.requestAnimationFrame(callback),
  cancel: (handle) => window.cancelAnimationFrame(handle),
};

/**
 * Puts the caret in the composer once it exists.
 *
 * Chat navigation can replace the mobile composer before its imperative handle
 * is mounted. Keep the intent alive across that short handoff rather than
 * silently dropping the click after one animation frame.
 *
 * Only focus: what the follow-up is *about* is carried by the tag attached to
 * the composer, not by text typed on the user's behalf.
 */
export function focusComposerWhenReady(
  readComposer: () => AgentAttentionComposer | null,
  options: {
    readonly maxAttempts?: number;
    readonly scheduler?: WaitingOnYouFollowUpScheduler;
  } = {},
): () => void {
  const maxAttempts = Math.max(1, options.maxAttempts ?? 60);
  const scheduler = options.scheduler ?? browserFrameScheduler;
  let attempt = 0;
  let cancelled = false;
  let scheduledHandle: number | null = null;

  const tryFocus = () => {
    scheduledHandle = null;
    if (cancelled) return;
    const composer = readComposer();
    if (composer !== null) {
      composer.focusAtEnd();
      return;
    }
    attempt += 1;
    if (attempt < maxAttempts) {
      scheduledHandle = scheduler.schedule(tryFocus);
    }
  };

  tryFocus();
  return () => {
    cancelled = true;
    if (scheduledHandle !== null) scheduler.cancel(scheduledHandle);
  };
}
