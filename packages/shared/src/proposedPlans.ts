/**
 * Which proposed plan a thread is waiting on, and what became of the others.
 *
 * One rule, shared by the decider that closes plans, the server's shell flag
 * (`has_actionable_proposed_plan`, the same rule in SQL), and every client that
 * shows or approves a plan: the thread's newest plan is waiting while it is
 * neither implemented nor closed. Older plans are history — implemented,
 * closed, or superseded by a newer proposal — and never come back as the plan
 * to approve, however many turns have passed since.
 */

export interface ProposedPlanLifecycle {
  readonly id: string;
  readonly createdAt: string;
  readonly implementedAt: string | null;
  /** Optional so payloads from servers that predate closing still read. */
  readonly closedAt?: string | null | undefined;
}

export type ProposedPlanStatus = "waiting" | "implemented" | "closed" | "superseded";

/** Oldest first; ties broken by id so every reader agrees on "newest". */
export function compareProposedPlans(
  left: Pick<ProposedPlanLifecycle, "id" | "createdAt">,
  right: Pick<ProposedPlanLifecycle, "id" | "createdAt">,
): number {
  return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

export function newestProposedPlan<T extends Pick<ProposedPlanLifecycle, "id" | "createdAt">>(
  plans: ReadonlyArray<T>,
): T | null {
  let newest: T | null = null;
  for (const plan of plans) {
    if (newest === null || compareProposedPlans(plan, newest) > 0) newest = plan;
  }
  return newest;
}

export function isProposedPlanOpen(
  plan: Pick<ProposedPlanLifecycle, "implementedAt" | "closedAt">,
): boolean {
  return plan.implementedAt === null && (plan.closedAt ?? null) === null;
}

/** The plan the thread is waiting on: its newest plan, while still open. */
export function waitingProposedPlan<T extends ProposedPlanLifecycle>(
  plans: ReadonlyArray<T>,
): T | null {
  const newest = newestProposedPlan(plans);
  return newest !== null && isProposedPlanOpen(newest) ? newest : null;
}

export function proposedPlanStatus(
  plan: ProposedPlanLifecycle,
  plans: ReadonlyArray<ProposedPlanLifecycle>,
): ProposedPlanStatus {
  if (plan.implementedAt !== null) return "implemented";
  if ((plan.closedAt ?? null) !== null) return "closed";
  return newestProposedPlan(plans)?.id === plan.id ? "waiting" : "superseded";
}

/** What Implement sends: the whole plan, so the agent works from it verbatim. */
export function buildPlanImplementationPrompt(planMarkdown: string): string {
  return `PLEASE IMPLEMENT THIS PLAN:\n${planMarkdown.trim()}`;
}

/** The plan's first heading, which is how every surface names it. */
export function proposedPlanTitle(planMarkdown: string): string | null {
  const heading = planMarkdown.match(/^\s{0,3}#{1,6}\s+(.+)$/m)?.[1]?.trim();
  return heading && heading.length > 0 ? heading : null;
}

/**
 * `<proposed_plan>` blocks are how providers without a plan tool of their own
 * (Grok, Muse, Deep Code, OpenCode, Antigravity) hand over a plan: Plan mode
 * tells the model to put its final plan in one block with each tag on its own
 * line. Requiring those lines keeps prose that merely mentions the tags, as in
 * "keep `<proposed_plan>` and `</proposed_plan>`", from reading as a plan.
 */
const PROPOSED_PLAN_BLOCK_SOURCE = String.raw`^[ \t]*<proposed_plan>[ \t]*\r?\n([\s\S]*?)^[ \t]*<\/proposed_plan>[ \t]*$`;
const PROPOSED_PLAN_CLOSING_TAG = "</proposed_plan>";

/**
 * Each completed block's plan, in order, and where the last completed block
 * ends, so a reader of streaming text can drop what it has already read. An
 * unfinished block is not a plan yet.
 */
export function scanProposedPlanBlocks(text: string): {
  readonly plans: ReadonlyArray<string>;
  readonly end: number;
} {
  const plans: Array<string> = [];
  let end = 0;
  if (!text.includes(PROPOSED_PLAN_CLOSING_TAG)) return { plans, end };
  for (const match of text.matchAll(new RegExp(PROPOSED_PLAN_BLOCK_SOURCE, "gmu"))) {
    end = match.index + match[0].length;
    const plan = match[1]?.trim();
    if (plan) plans.push(plan);
  }
  return { plans, end };
}

/**
 * A message's text without the blocks its plan cards already show, so the
 * message does not repeat a plan, raw tags and all, beside its card. A block
 * no card shows stays in place.
 */
export function withoutShownProposedPlanBlocks(
  text: string,
  shownPlanMarkdowns: ReadonlySet<string>,
): string {
  if (shownPlanMarkdowns.size === 0 || !text.includes(PROPOSED_PLAN_CLOSING_TAG)) return text;
  return text.replace(
    new RegExp(PROPOSED_PLAN_BLOCK_SOURCE, "gmu"),
    (block, plan: string | undefined) => (shownPlanMarkdowns.has(plan?.trim() ?? "") ? "" : block),
  );
}

/**
 * A message's text with each completed block's tags dropped and its plan kept,
 * for a surface that draws no plan card beside the message (the phone feed).
 */
export function unwrapProposedPlanBlocks(text: string): string {
  if (!text.includes(PROPOSED_PLAN_CLOSING_TAG)) return text;
  return text.replace(
    new RegExp(PROPOSED_PLAN_BLOCK_SOURCE, "gmu"),
    (_block, plan: string | undefined) => plan?.trim() ?? "",
  );
}
