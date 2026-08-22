/**
 * Saying what a thread waiting on a plan is actually waiting for.
 *
 * "Waiting on a proposed plan" is true and useless. It does not say what the
 * plan proposes, how big it is, or that the person being told is the one
 * holding it up — so the answer to "what's Rover doing?" was a status word that
 * left the user to go and look, which is the thing talking to the orchestrator
 * is supposed to save them.
 *
 * A plan is markdown written by an agent, so the shape is not guaranteed: it
 * may open with a heading, or a sentence, or dive straight into a list. Every
 * function here degrades rather than assuming — a plan with no heading still
 * gets a title, a plan with no list still gets a step count of zero, and
 * nothing throws on markdown nobody anticipated.
 *
 * Pure, so the awkward shapes are cheap to pin down in tests.
 */

export interface ProposedPlanInput {
  readonly planId: string;
  readonly planMarkdown: string;
  readonly implementedAt: string | null;
  readonly createdAt: string;
}

export interface ProposedPlanSummary {
  readonly planId: string;
  /** One line, said out loud in place of reading the plan. */
  readonly title: string;
  readonly stepCount: number;
  /** The opening steps, for "what does it say?" without reading all of it. */
  readonly steps: ReadonlyArray<string>;
  readonly proposedAt: string;
  /**
   * Who is holding it up. Always the user: an agent that has proposed a plan
   * has stopped, and nothing in the workspace can approve on their behalf.
   * Stated as a field rather than left implied because "waiting for approval"
   * reads as though something else might still be coming.
   */
  readonly awaiting: "user";
}

/** How many steps are worth reading back before it stops being an answer. */
const MAX_SPOKEN_STEPS = 5;
const MAX_TITLE_LENGTH = 120;

/**
 * The plan the thread is stopped on, if any.
 *
 * A plan with an `implementedAt` has already been acted on and is history;
 * only an outstanding one is what a thread is waiting for. The newest wins
 * when several are outstanding — that is the one on screen.
 */
export function findActionablePlan(
  plans: ReadonlyArray<ProposedPlanInput>,
): ProposedPlanInput | null {
  const outstanding = plans.filter((plan) => plan.implementedAt === null);
  if (outstanding.length === 0) return null;
  return outstanding.reduce((latest, plan) =>
    Date.parse(plan.createdAt) > Date.parse(latest.createdAt) ? plan : latest,
  );
}

/** Markdown list markers, ordered or not, including checkboxes. */
const STEP_LINE = /^\s{0,3}(?:[-*+]|\d+[.)])\s+(.*)$/;
const HEADING_LINE = /^\s{0,3}#{1,6}\s+(.*)$/;
const CHECKBOX_PREFIX = /^\[[ xX]\]\s*/;

/** Inline markdown, stripped so nothing is read out as punctuation. */
function plainText(value: string): string {
  return value
    .replace(/`{1,3}([^`]*)`{1,3}/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/(?<!\*)\*([^*]+)\*(?!\*)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(CHECKBOX_PREFIX, "")
    .trim();
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 1).trimEnd()}…`;
}

/**
 * Folds a plan into something answerable in a sentence.
 *
 * The title is the first heading if there is one, else the first line that
 * carries words — an agent that opened with prose should not end up titled
 * after its first bullet, which reads as though the plan were only that step.
 */
export function summarizeProposedPlan(plan: ProposedPlanInput): ProposedPlanSummary {
  const lines = plan.planMarkdown.split(/\r?\n/);
  const steps: Array<string> = [];
  let heading: string | null = null;
  let firstProse: string | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;

    const headingMatch = HEADING_LINE.exec(trimmed);
    if (headingMatch?.[1] !== undefined) {
      heading ??= plainText(headingMatch[1]);
      continue;
    }

    const stepMatch = STEP_LINE.exec(line);
    if (stepMatch?.[1] !== undefined) {
      const step = plainText(stepMatch[1]);
      if (step.length > 0) steps.push(step);
      continue;
    }

    firstProse ??= plainText(trimmed);
  }

  const title = heading ?? firstProse ?? steps[0] ?? "an untitled plan";
  return {
    planId: plan.planId,
    title: truncate(title, MAX_TITLE_LENGTH),
    stepCount: steps.length,
    steps: steps.slice(0, MAX_SPOKEN_STEPS).map((step) => truncate(step, MAX_TITLE_LENGTH)),
    proposedAt: plan.createdAt,
    awaiting: "user",
  };
}

/**
 * How to say it, as an instruction rather than a script.
 *
 * The point is that the user learns they are the blocker and roughly what they
 * are being asked to agree to, without the plan being read at them.
 */
export function describePlanAloud(summary: ProposedPlanSummary, threadTitle: string): string {
  const size =
    summary.stepCount === 0
      ? ""
      : ` It is ${summary.stepCount} step${summary.stepCount === 1 ? "" : "s"}.`;
  // Only offered when there is something to read; a plan with no list should
  // not be followed by an offer to read a list.
  const offer =
    summary.stepCount === 0 ? "" : " Offer to read them rather than reading them unprompted.";
  return `${threadTitle} has stopped and is waiting for the user to approve a plan: ${summary.title}.${size} Say what it proposes and that it needs their go-ahead.${offer}`;
}
