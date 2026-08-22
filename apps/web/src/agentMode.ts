import type { OrchestrationThreadPendingWork, ProviderInteractionMode } from "@t3tools/contracts";
import { AGENT_CONTINUE_PROMPT, isAgentContinuePrompt } from "@t3tools/shared/agentMode";

export { AGENT_CONTINUE_PROMPT, isAgentContinuePrompt };

export function isAgentMode(mode: ProviderInteractionMode | undefined): boolean {
  return mode === "agent";
}

/**
 * Pending-work states that mean the server will start a turn on its own.
 *
 * "executing" is deliberately excluded: an executing obligation supervises the
 * whole provider turn it dispatched, so during it the running turn is already
 * on screen — and its terminal transition happens after the turn's final
 * events, so an "executing" value in a freshly refetched shell may be the
 * scheduler's last word on retired work. The waiting states below always
 * resolve into either a dispatched turn (events update the shell) or a
 * terminal transition observed on the next refetch.
 *
 * "blocked-authentication", "waiting-approval", and "waiting-user-input" are
 * also excluded: they wait on the user, and each already has its own surface
 * (auth banner, approval prompt, question card). Claiming "auto-resuming"
 * over them would assert progress the server is explicitly not making.
 */
const AUTO_RESUME_PENDING_WORK_STATES: ReadonlySet<string> = new Set([
  "pending",
  "sleeping",
  "claimed",
]);

/**
 * Whether server-reported pending work should surface as an "auto-resuming"
 * affordance, optionally restricted to one work kind.
 *
 * `undefined` pending work means the server predates the field; callers fall
 * back to their local prediction bounded by the 90s stall deadline. `null`
 * means the server definitively has nothing queued for the thread.
 */
export function isAutoResumePendingWork(
  pendingWork: OrchestrationThreadPendingWork | null | undefined,
  kind?: string,
): boolean {
  if (pendingWork == null) return false;
  if (kind !== undefined && pendingWork.kind !== kind) return false;
  return AUTO_RESUME_PENDING_WORK_STATES.has(pendingWork.state);
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

/**
 * Should the UI announce an imminent agent auto-resume?
 *
 * A backgrounded task keeps running after the turn that launched it ends — that
 * is the point of backgrounding one — and the provider harness re-invokes the
 * agent when it exits. The server already parks the continuation for exactly
 * this reason (`agentContinuationShouldAwaitBackgroundTask`), but it parks it
 * in `sleeping` and the projected pendingWork carries only kind/state/since. No
 * reason field reaches the client, so a parked continuation is indistinguishable
 * from an imminent one, and the UI claimed "Agent auto-resuming" for as long as
 * the task ran — a resume the user could neither wait out nor stop.
 */
export function shouldAnnounceAgentAutoResume(input: {
  readonly pending: boolean;
  readonly isWorking: boolean;
  readonly hasRunningBackgroundTask: boolean;
}): boolean {
  return input.pending && !input.isWorking && !input.hasRunningBackgroundTask;
}
