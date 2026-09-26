/** Silence triggers a view repair before it can end a Muse turn. */
export const MUSE_VIEW_RECONCILE_MS = 60_000;
export const MUSE_MODEL_SILENCE_MS = 15 * 60_000;
export const MUSE_TOOL_SILENCE_MS = 30 * 60_000;
export const MUSE_RETRY_BUDGET_MS = 5 * 60_000;

export interface MuseTurnHealthLimits {
  readonly reconcileMs: number;
  readonly modelSilenceMs: number;
  readonly toolSilenceMs: number;
  readonly retryBudgetMs: number;
}

const DEFAULT_LIMITS: MuseTurnHealthLimits = {
  reconcileMs: MUSE_VIEW_RECONCILE_MS,
  modelSilenceMs: MUSE_MODEL_SILENCE_MS,
  toolSilenceMs: MUSE_TOOL_SILENCE_MS,
  retryBudgetMs: MUSE_RETRY_BUDGET_MS,
};

export type MuseTurnHealthAction =
  | { readonly action: "wait" }
  | { readonly action: "reconcile" }
  | { readonly action: "stop"; readonly reason: "model-silence" | "tool-silence" | "retry-budget" };

/**
 * Called for an active turn using the host clock. A repair attempt does not
 * count as model progress, and retry announcements cannot extend their own
 * budget. Clear retrySinceMs only when actual model/tool progress resumes.
 * The caller must reconcile the owning host before acting on a stop decision.
 */
export function museTurnHealthAction(input: {
  readonly nowMs: number;
  readonly lastProgressAtMs: number;
  readonly lastReconcileAtMs: number;
  readonly pendingApproval: boolean;
  readonly openToolCount: number;
  readonly retrySinceMs: number | null;
  readonly limits?: MuseTurnHealthLimits;
}): MuseTurnHealthAction {
  const limits = input.limits ?? DEFAULT_LIMITS;
  if (input.pendingApproval) return { action: "wait" };
  const quietMs = Math.max(0, input.nowMs - input.lastProgressAtMs);
  if (input.retrySinceMs !== null && input.nowMs - input.retrySinceMs >= limits.retryBudgetMs) {
    return { action: "stop", reason: "retry-budget" };
  }
  const hasTool = input.openToolCount > 0;
  if (quietMs >= (hasTool ? limits.toolSilenceMs : limits.modelSilenceMs)) {
    return { action: "stop", reason: hasTool ? "tool-silence" : "model-silence" };
  }
  if (
    quietMs >= limits.reconcileMs &&
    input.nowMs - input.lastReconcileAtMs >= limits.reconcileMs
  ) {
    return { action: "reconcile" };
  }
  return { action: "wait" };
}
