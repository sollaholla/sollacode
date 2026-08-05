import type { ProviderInteractionMode } from "@t3tools/contracts";
import {
  AGENT_CONTINUE_PROMPT,
  AGENT_STOP_TOKEN,
  classifyAgentLoopReplyFailure,
  containsAgentStopToken,
  isAgentContinuePrompt,
  shouldAgentContinueAfterReply,
  stripAgentStopToken,
  type AgentLoopReplyFailure,
} from "@t3tools/shared/agentMode";

export {
  AGENT_CONTINUE_PROMPT,
  AGENT_STOP_TOKEN,
  classifyAgentLoopReplyFailure,
  containsAgentStopToken,
  isAgentContinuePrompt,
  shouldAgentContinueAfterReply,
  stripAgentStopToken,
  type AgentLoopReplyFailure,
};

export function isAgentMode(mode: ProviderInteractionMode | undefined): boolean {
  return mode === "agent";
}

/**
 * Whether a completed turn should be followed by another nudge.
 *
 * Every guard here exists to stop the loop running away: a turn that is still
 * streaming has no final text to inspect, a failed or interrupted turn means
 * something needs a human, and an empty reply usually signals the provider is
 * wedged rather than working.
 */
/**
 * Nudges are one per completed turn, but a provider that fails instantly mints a
 * fresh turn for every nudge, so per-turn keying alone is no brake at all. This
 * is the floor between consecutive nudges: below it, something is failing fast
 * rather than working.
 */
export const AGENT_LOOP_MIN_NUDGE_INTERVAL_MS = 4_000;

/**
 * How many turns the loop may drive without the user touching it.
 *
 * The mode is meant to be unattended, so this is deliberately generous — but it
 * is not unbounded, because "unbounded" is indistinguishable from "runaway" when
 * something upstream is broken, and the user is not necessarily watching.
 */
export const AGENT_LOOP_MAX_CONSECUTIVE_NUDGES = 50;

/**
 * Provider-level failures that repeat identically forever.
 *
 * These come back instantly, so the loop retries at full speed and floods the
 * thread — this is what filled a conversation with hundreds of identical nudges
 * after a logout. None of them can be resolved by trying again; they all need
 * the user.
 */
/**
 * Failures a retry cannot fix. Something about the account or credentials has
 * to change first, so the turn is over.
 */
/**
 * Whether the reply is a provider failure rather than work.
 *
 * A fast path, not the real safety net — the interval floor and the
 * identical-reply check catch the same runaway a beat later without needing to
 * recognise the wording. It exists so the common case stops on the first repeat
 * instead of the second.
 */
export function isAgentLoopBlockingReply(text: string): boolean {
  return classifyAgentLoopReplyFailure(text) !== null;
}

export interface AgentLoopGuardInput {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly turnState: string | null | undefined;
  readonly assistantText: string;
  readonly isStreaming: boolean;
  readonly hasPendingUserInput: boolean;
  readonly isConnected: boolean;
  /**
   * The user has sent a message of their own since the loop last acted.
   *
   * `hasPendingUserInput` covers a question the agent asked and is waiting on;
   * this covers the user simply typing something unprompted. Their message is
   * already driving the next turn, so nudging would talk over them.
   */
  readonly userHasRepliedSinceNudge?: boolean;
  /**
   * The user has actually started this loop by sending a message in agent mode.
   *
   * Selecting the mode must not be enough. The previous turn is already
   * `completed`, so without this the act of choosing "Agent" satisfied every
   * other guard and fired a turn immediately — the mode picker became a send
   * button.
   */
  readonly armed?: boolean;
  /** Nudges already sent without user input; see the max above. */
  readonly consecutiveNudges?: number;
  /** Wall clock, and when the last nudge went out — for the interval floor. */
  readonly nowMs?: number;
  readonly lastNudgeAtMs?: number | null;
  /** The previous turn's reply, to catch a loop that is making no progress. */
  readonly previousAssistantText?: string | null;
  /** The provider session is usable (not stopped, errored, or unauthenticated). */
  readonly isSessionReady?: boolean;
}

/**
 * Whether a completed turn should be followed by another nudge.
 *
 * Every guard here exists to stop the loop running away. The structural ones —
 * streaming, turn state, pending input — catch an orderly stop. The rest catch
 * the disorderly one: a provider that answers instantly and identically forever,
 * which passes every structural check while doing no work at all.
 */
export function shouldContinueAgentLoop(input: AgentLoopGuardInput): boolean {
  if (!isAgentMode(input.interactionMode)) return false;
  // Selecting the mode is not consent to start sending.
  if (input.armed === false) return false;
  // Never nudge while the connection is down. A dropped link cannot deliver the
  // turn, and retrying into a dead socket would spin the loop against the
  // network instead of waiting for it to come back. The supervisor reconnects on
  // its own, and the next completed turn resumes the loop.
  if (!input.isConnected) return false;
  // A session that is stopped or errored cannot run a turn; nudging it just
  // manufactures failures.
  if (input.isSessionReady === false) return false;
  if (input.isStreaming) return false;
  // Only a cleanly completed turn continues. "incomplete", "failed", and
  // "interrupted" all mean the user should be looking at it.
  if (input.turnState !== "completed") return false;
  // A question is outstanding; answering it drives the next turn instead.
  if (input.hasPendingUserInput) return false;
  // The user beat the loop to it — their message is the next turn.
  if (input.userHasRepliedSinceNudge === true) return false;

  const text = input.assistantText.trim();
  if (text.length === 0) return false;
  if (isAgentLoopBlockingReply(text)) return false;

  const previous = input.previousAssistantText?.trim();

  // The token is the terminal contract. The prompt already requires the agent
  // to audit completion before emitting it; sending another user turn after a
  // clean sign-off violates that contract and can restart finished work.
  if (containsAgentStopToken(text)) return false;

  if ((input.consecutiveNudges ?? 0) >= AGENT_LOOP_MAX_CONSECUTIVE_NUDGES) return false;

  // Anything coming back faster than a real turn is a failure loop.
  const nowMs = input.nowMs;
  const lastNudgeAtMs = input.lastNudgeAtMs;
  if (
    nowMs !== undefined &&
    lastNudgeAtMs !== undefined &&
    lastNudgeAtMs !== null &&
    nowMs - lastNudgeAtMs < AGENT_LOOP_MIN_NUDGE_INTERVAL_MS
  ) {
    return false;
  }

  // Byte-identical to last turn means the nudge changed nothing. Real work
  // never repeats itself exactly, so this is a stuck provider.
  if (previous !== undefined && previous.length > 0 && previous === text) return false;

  return true;
}

export interface AgentLoopMessageView {
  readonly role: string;
  readonly turnId?: string | null;
  readonly streaming?: boolean;
  readonly text?: string;
  readonly inputOrigin?: string | undefined;
}

/**
 * The text the loop decision is allowed to inspect.
 *
 * Only the newest assistant message is a candidate. Skipping past it to an
 * older, already-final message would let the decision read the PREVIOUS
 * turn's text during the window where the turn has settled but the final
 * message's streaming flag has not flipped yet — which is exactly how a stop
 * token gets missed and a turn that asked to end is nudged anyway. `null`
 * means "not readable yet": the caller must wait for the flags to agree, not
 * fall back to stale text. No assistant message at all reads as empty, which
 * the loop already refuses to continue on.
 */
export function selectAgentLoopAssistantText(
  messages: ReadonlyArray<AgentLoopMessageView>,
  turnId?: string | null,
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant") continue;
    // Settings-only and provider-handoff turns must not borrow an older
    // assistant reply as proof that the current turn finished cleanly.
    // Likewise, a stale latest-turn pointer must not skip past a newer reply
    // and infer continuation from an older turn. The newest assistant reply is
    // authoritative; a turn mismatch means the projection has not converged
    // yet, so the UI must show neither a pending continuation nor a Resume.
    if (turnId != null && message.turnId !== turnId) return "";
    if (message.streaming === true) return null;
    return message.text ?? "";
  }
  return "";
}

export interface AgentAutoResumePendingInput {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly turnId: string | null | undefined;
  readonly turnState: string | null | undefined;
  readonly latestTurnSettled: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly sessionStatus: string | null | undefined;
  readonly messages: ReadonlyArray<AgentLoopMessageView>;
}

/**
 * Shows the otherwise invisible interval between a clean Agent reply and the
 * server-owned continuation becoming an active provider turn.
 */
export function shouldShowAgentAutoResumePending(input: AgentAutoResumePendingInput): boolean {
  if (!isAgentMode(input.interactionMode)) return false;
  if (input.turnState !== "completed" || !input.latestTurnSettled) return false;
  if (input.hasPendingApproval || input.hasPendingUserInput) return false;
  if (input.sessionStatus === "error" || input.sessionStatus === "stopped") return false;

  const assistantText = selectAgentLoopAssistantText(input.messages, input.turnId);
  if (assistantText === null || !shouldAgentContinueAfterReply(assistantText)) return false;

  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message === undefined) continue;
    if (message.role === "assistant" && message.turnId === input.turnId) break;
    if (message.role === "user" && message.inputOrigin !== "agent-loop") return false;
  }
  return true;
}

/**
 * Whether the newest message is the user's rather than the assistant's.
 *
 * Walking back from the end, a user message reached before any assistant one
 * means the user has spoken since the last reply — so the next turn is already
 * theirs and the loop has nothing to nudge for.
 */
export function hasUserRepliedAfterLastAssistant(
  messages: ReadonlyArray<AgentLoopMessageView>,
): boolean {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined) continue;
    if (message.role === "assistant") return false;
    if (message.role === "user") return true;
  }
  return false;
}

const RECOMMENDED_MARKER = /\(recommended\)/iu;

/**
 * Picks the option a question marks as recommended.
 *
 * The marker is a literal "(Recommended)" in the option label, which is the
 * convention these prompts already follow. When nothing is marked, callers fall
 * back to free text rather than guessing an option, because an arbitrary first
 * choice can be destructive.
 */
export function selectRecommendedOption<T extends { readonly label: string }>(
  options: ReadonlyArray<T>,
): T | null {
  return options.find((option) => RECOMMENDED_MARKER.test(option.label)) ?? null;
}

export const AGENT_FALLBACK_ANSWER = "Use the recommended answer";

/**
 * The answer Agent mode gives on the user's behalf: the recommended option when
 * one is marked, otherwise free text asking for the recommended answer.
 */
export function agentAnswerForQuestion<T extends { readonly label: string }>(
  options: ReadonlyArray<T>,
):
  | { readonly kind: "option"; readonly option: T }
  | { readonly kind: "text"; readonly text: string } {
  const recommended = selectRecommendedOption(options);
  if (recommended) return { kind: "option", option: recommended };
  return { kind: "text", text: AGENT_FALLBACK_ANSWER };
}

/**
 * Answers every question in a request on the user's behalf.
 *
 * Matches the answer shape the composer produces: an option label, or an array
 * of labels for multi-select questions. Questions with nothing marked
 * recommended get free text asking for the recommended answer rather than an
 * arbitrary option, which could be the destructive one.
 */
export function buildAgentAnswers(
  questions: ReadonlyArray<{
    readonly id: string;
    readonly options: ReadonlyArray<{ readonly label: string }>;
    readonly multiSelect?: boolean | undefined;
  }>,
): Record<string, string | string[]> {
  const answers: Record<string, string | string[]> = {};
  for (const question of questions) {
    const answer = agentAnswerForQuestion(question.options);
    if (answer.kind === "option") {
      answers[question.id] = question.multiSelect ? [answer.option.label] : answer.option.label;
    } else {
      answers[question.id] = answer.text;
    }
  }
  return answers;
}
