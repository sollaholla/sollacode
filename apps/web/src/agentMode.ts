import type { ProviderInteractionMode } from "@t3tools/contracts";

/**
 * Agent mode keeps a thread working without the user re-prompting. After each
 * assistant turn completes the app sends a nudge, and the loop only ends when
 * the model signs off with the stop token.
 *
 * The loop is intentionally unbounded — that is the point of the mode — so the
 * stop token is the contract, and the running turn indicator plus the manual
 * stop button remain the user's way out.
 */

export const AGENT_STOP_TOKEN = "AGENT_STOP";

export const AGENT_CONTINUE_PROMPT =
  "The user wants you to continue working autonomously without input returned to them. " +
  "First judge honestly: is the requested work finished, or are you blocked on something " +
  "only the user can provide? If either is true, summarize what you did and end your " +
  `message with \`${AGENT_STOP_TOKEN}\` to stop this agent loop — finishing is the right ` +
  "reason to stop, not a failure to continue. Otherwise keep working on the next concrete " +
  "step, and do not stop to ask questions you can resolve yourself.";

/**
 * True when the assistant signed off.
 *
 * Matched on a word boundary so prose that merely mentions the token — such as
 * these instructions being quoted back — does not end the loop, while the usual
 * sign-offs (bare, fenced, bolded, or followed by punctuation) all do.
 */
export function containsAgentStopToken(text: string): boolean {
  return new RegExp(`(^|[^A-Za-z0-9_])${AGENT_STOP_TOKEN}([^A-Za-z0-9_]|$)`, "u").test(text);
}

/**
 * Strips the token so it never reaches the next prompt as literal text.
 */
export function stripAgentStopToken(text: string): string {
  return text.replaceAll(new RegExp(`(^|[^A-Za-z0-9_])${AGENT_STOP_TOKEN}`, "gu"), "$1").trimEnd();
}

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
export function shouldContinueAgentLoop(input: {
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly turnState: string | null | undefined;
  readonly assistantText: string;
  readonly isStreaming: boolean;
  readonly hasPendingUserInput: boolean;
  readonly isConnected: boolean;
}): boolean {
  if (!isAgentMode(input.interactionMode)) return false;
  // Never nudge while the connection is down. A dropped link cannot deliver the
  // turn, and retrying into a dead socket would spin the loop against the
  // network instead of waiting for it to come back. The supervisor reconnects on
  // its own, and the next completed turn resumes the loop.
  if (!input.isConnected) return false;
  if (input.isStreaming) return false;
  // Only a cleanly completed turn continues. "incomplete", "failed", and
  // "interrupted" all mean the user should be looking at it.
  if (input.turnState !== "completed") return false;
  // A question is outstanding; answering it drives the next turn instead.
  if (input.hasPendingUserInput) return false;
  const text = input.assistantText.trim();
  if (text.length === 0) return false;
  return !containsAgentStopToken(text);
}

export interface AgentLoopMessageView {
  readonly role: string;
  readonly streaming?: boolean;
  readonly text?: string;
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
): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== "assistant") continue;
    if (message.streaming === true) return null;
    return message.text ?? "";
  }
  return "";
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
