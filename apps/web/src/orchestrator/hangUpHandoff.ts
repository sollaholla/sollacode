import { AWAITED_WORK_TTL_MS, type AwaitedWork } from "./awaitedWork";

/**
 * What the orchestrator's text chat is told when the person hangs up a voice
 * session with something still open.
 *
 * The voice says "I'll get back to you on that" and means it, but once the call
 * ends nothing was going to keep that promise: only a live session speaks. The
 * text chat can. The spoken conversation is already recorded in the thread and
 * rides along with the next message sent there, so this only has to say the
 * call ended and what is still open.
 */
export interface HangUpHandoffInput {
  /** Work the voice handed off and said it would report on. */
  readonly awaited: ReadonlyArray<AwaitedWork>;
  /** The voice was still working (a tool call or delegation) when the call ended. */
  readonly workingAtHangUp: boolean;
  /** The last thing the orchestrator said on the call, if anything. */
  readonly lastAssistantLine: string | null;
  /** Whether anything was said on this call at all. */
  readonly spokeThisCall: boolean;
  readonly nowMs: number;
}

/**
 * Phrases that commit to doing something later. Deliberately narrow: a
 * handoff starts a real turn, and a goodbye is not a promise.
 */
const FOLLOW_UP_PROMISE =
  /\b(?:i'll|i will|i'm going to|let me|i can)\s+(?:get back|follow up|check|report|let you know|look into|keep an eye|update you|ping you|circle back|finish|see)\b|\bwhen (?:it|that|they|this) (?:finishes|is done|completes|comes back)\b|\b(?:get back to you|follow up|keep you posted)\b/iu;

export function promisesFollowUp(line: string | null): boolean {
  return line !== null && FOLLOW_UP_PROMISE.test(line);
}

/** The message for the orchestrator's chat, or null when nothing is left open. */
export function buildHangUpHandoff(input: HangUpHandoffInput): string | null {
  if (!input.spokeThisCall) return null;
  const open = input.awaited.filter((item) => input.nowMs - item.askedAt <= AWAITED_WORK_TTL_MS);
  const promised = promisesFollowUp(input.lastAssistantLine);
  if (open.length === 0 && !input.workingAtHangUp && !promised) return null;

  const lines = [
    "The person hung up the voice call. Carry on here in text from where the call left off: finish anything that is still open, check on the work below, and report the results in this chat. If it all turns out to be done already, say so in a line.",
  ];
  if (open.length > 0) {
    lines.push(
      "",
      "Still open from the call:",
      ...open.map(
        (item) => `- ${item.threadTitle}: ${item.request.replaceAll(/\s+/gu, " ").slice(0, 300)}`,
      ),
    );
  }
  if (input.workingAtHangUp) {
    lines.push("", "You were still in the middle of something when the call ended.");
  }
  if (promised && input.lastAssistantLine !== null) {
    lines.push("", `Your last words on the call: "${input.lastAssistantLine.slice(0, 400)}"`);
  }
  return lines.join("\n");
}
