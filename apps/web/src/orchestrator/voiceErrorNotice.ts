/**
 * Saying out loud what voice last reported.
 *
 * There was nowhere this appeared. The listening overlay looks like it reports
 * failures — `describeMobileVoice` has a whole "Voice stopped" branch carrying
 * the message and a restart action — but the overlay returns early unless the
 * session is `connecting`, `listening` or `speaking`, and a session that failed
 * to start is none of those. That branch is unreachable, so the overlay never
 * displays an error in practice; and on desktop the overlay is not rendered at
 * all, leaving a hover tooltip on the microphone button as the only trace.
 *
 * Pressing the microphone and getting silence is indistinguishable from a
 * broken build, and the swallowed message is usually the one you can act on
 * ("your OpenAI account has no credits left"). So this is announced as a toast
 * unconditionally — nothing else can double-report it.
 */

import type { VoiceIssueSeverity } from "./useOrchestratorSession";

/** A voice failure, phrased for a toast. */
export interface VoiceIssueAnnouncement {
  readonly title: string;
  readonly description: string;
  readonly type: "error" | "info";
}

export function shouldAnnounceVoiceIssue(input: {
  readonly message: string | null;
  /** Message last announced, so a steady render loop cannot repeat it. */
  readonly announced: string | null;
}): boolean {
  if (input.message === null) return false;
  return input.message !== input.announced;
}

export function describeVoiceIssue(input: {
  readonly message: string;
  readonly severity: VoiceIssueSeverity | null;
}): VoiceIssueAnnouncement {
  // A notice is the session explaining itself, not breaking; titling it
  // "Voice unavailable" would send people looking for a fault that isn't there.
  if (input.severity === "notice") {
    return { title: "Voice ended", description: input.message, type: "info" };
  }
  return { title: "Voice unavailable", description: input.message, type: "error" };
}
