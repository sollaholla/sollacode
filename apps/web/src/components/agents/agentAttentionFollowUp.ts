export interface AgentAttentionComposer {
  readonly readSnapshot: () => { readonly value: string };
  readonly insertTextAtEnd: (
    text: string,
    options?: { readonly ensureLeadingBoundary?: boolean },
  ) => boolean;
  readonly focusAtEnd: () => void;
}

/**
 * Start a correction in the existing agent composer without touching blocker
 * state or replacing text the user has already drafted.
 */
export function beginWaitingOnYouFollowUp(composer: AgentAttentionComposer, title: string): void {
  const leadIn = waitingOnYouFollowUpLeadIn(title);
  if (!composer.readSnapshot().value.includes(leadIn.trim())) {
    composer.insertTextAtEnd(leadIn, { ensureLeadingBoundary: true });
  }
  composer.focusAtEnd();
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
 * Chat navigation can replace the mobile composer before its imperative handle
 * is mounted. Keep the follow-up intent alive across that short handoff rather
 * than silently dropping the click after one animation frame.
 */
export function beginWaitingOnYouFollowUpWhenReady(
  readComposer: () => AgentAttentionComposer | null,
  title: string,
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

  const tryBegin = () => {
    scheduledHandle = null;
    if (cancelled) return;
    const composer = readComposer();
    if (composer !== null) {
      beginWaitingOnYouFollowUp(composer, title);
      return;
    }
    attempt += 1;
    if (attempt < maxAttempts) {
      scheduledHandle = scheduler.schedule(tryBegin);
    }
  };

  tryBegin();
  return () => {
    cancelled = true;
    if (scheduledHandle !== null) scheduler.cancel(scheduledHandle);
  };
}
import { waitingOnYouFollowUpLeadIn } from "@t3tools/shared/agentAttentionFollowUp";
