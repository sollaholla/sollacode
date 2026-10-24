/**
 * Which task checklist is the current one.
 *
 * A task list is the agent's progress checklist - TodoWrite, Claude Tasks,
 * Codex update_plan, Cursor todos, or a server refresh - carried by
 * `turn.plan.updated` activities despite the name. It is not a proposed plan:
 * a plan is a proposal waiting for approval (see ./proposedPlans.ts).
 *
 * The current list is the newest one, from any turn, so a follow-up question
 * does not wipe the checklist and a refresh (written without a turn) replaces
 * what it corrected. The exception is a proposed plan made after it: a new plan
 * is new work, and an older checklist is not its steps.
 */

export const TASK_LIST_ACTIVITY_KIND = "turn.plan.updated";

export function selectCurrentTaskList<
  T extends { readonly kind: string; readonly createdAt: string },
>(
  /** In display order, oldest first. */
  orderedActivities: ReadonlyArray<T>,
  options?: { readonly newestProposedPlanCreatedAt?: string | null | undefined },
): T | null {
  let newest: T | null = null;
  for (const activity of orderedActivities) {
    if (activity.kind === TASK_LIST_ACTIVITY_KIND) newest = activity;
  }
  const planCreatedAt = options?.newestProposedPlanCreatedAt ?? null;
  if (newest !== null && planCreatedAt !== null && newest.createdAt < planCreatedAt) return null;
  return newest;
}
