import type { OrchestrationMessage, OrchestrationThreadActivity } from "@t3tools/contracts";

/**
 * Pure inputs for the plan refresh.
 *
 * Kept out of the reactor so the two decisions that actually matter — what the
 * model is shown, and how much of it — are testable without an orchestration
 * engine.
 */

/** Messages sent to the model. A refresh reads recent intent, not the archive. */
export const PLAN_REFRESH_MAX_MESSAGES = 40;
/** Per-message ceiling; one pasted log must not crowd out the rest. */
export const PLAN_REFRESH_MAX_MESSAGE_CHARS = 2_000;
/** Overall ceiling, enforced oldest-first so the newest turns always survive. */
export const PLAN_REFRESH_MAX_TRANSCRIPT_CHARS = 24_000;

export type PlanRefreshStepStatus = "pending" | "inProgress" | "completed";

export interface PlanRefreshStep {
  readonly step: string;
  readonly status: PlanRefreshStepStatus;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isStepStatus(value: unknown): value is PlanRefreshStepStatus {
  return value === "pending" || value === "inProgress" || value === "completed";
}

/**
 * The plan as it currently stands, read from the newest `turn.plan.updated`.
 *
 * The panel derives what it shows from the same activity, so reading the latest
 * one is what makes a refresh a *correction* of the visible list rather than a
 * competing list built from different information.
 */
export function derivePlanRefreshCurrentSteps(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<PlanRefreshStep> {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity === undefined || activity.kind !== "turn.plan.updated") continue;

    const plan = asRecord(activity.payload).plan;
    if (!Array.isArray(plan)) return [];

    const steps: Array<PlanRefreshStep> = [];
    for (const raw of plan) {
      const entry = asRecord(raw);
      const step = typeof entry.step === "string" ? entry.step.trim() : "";
      if (step.length === 0) continue;
      steps.push({ step, status: isStepStatus(entry.status) ? entry.status : "pending" });
    }
    return steps;
  }
  return [];
}

/**
 * Renders recent conversation for the prompt.
 *
 * Trimming is deliberate and layered: a thread here can run to thousands of
 * messages, and pasting it wholesale would be slow, expensive, and would bury
 * the recent turns that actually determine what is done. The newest messages
 * are the ones kept — the tail is what says whether the work finished.
 */
export function buildPlanRefreshTranscript(
  messages: ReadonlyArray<Pick<OrchestrationMessage, "role" | "text">>,
  options?: {
    readonly maxMessages?: number;
    readonly maxMessageChars?: number;
    readonly maxTranscriptChars?: number;
  },
): string {
  const maxMessages = options?.maxMessages ?? PLAN_REFRESH_MAX_MESSAGES;
  const maxMessageChars = options?.maxMessageChars ?? PLAN_REFRESH_MAX_MESSAGE_CHARS;
  const maxTranscriptChars = options?.maxTranscriptChars ?? PLAN_REFRESH_MAX_TRANSCRIPT_CHARS;

  const recent = messages.slice(-maxMessages);
  const lines: Array<string> = [];

  for (const message of recent) {
    const text = (message.text ?? "").trim();
    if (text.length === 0) continue;
    const clipped =
      text.length <= maxMessageChars ? text : `${text.slice(0, maxMessageChars - 3).trimEnd()}...`;
    lines.push(`${message.role === "user" ? "User" : "Assistant"}: ${clipped}`);
  }

  // Drop from the front until the whole thing fits, so the newest turns survive.
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0);
  let start = 0;
  while (start < lines.length && total > maxTranscriptChars) {
    total -= (lines[start]?.length ?? 0) + 1;
    start += 1;
  }

  return lines.slice(start).join("\n");
}
