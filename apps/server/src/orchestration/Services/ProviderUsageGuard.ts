import type { ThreadTokenUsageSnapshot } from "@t3tools/contracts";
import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { UsageGuardEvaluation, UsageGuardResolvedConfig } from "../ProviderUsageGuard.ts";

export type UsageGuardAction = "allow" | "optimize" | "pause";

export interface UsageGuardDecision {
  /** What the caller should do with the work it is about to run. */
  readonly action: UsageGuardAction;
  readonly evaluation: UsageGuardEvaluation;
  readonly config: UsageGuardResolvedConfig;
  /** ISO time a held delivery should try again on its own. */
  readonly wakeAtIso: string;
  /** True when a user-initiated resume lifted the hold for this thread. */
  readonly overridden: boolean;
  readonly providerLabel: string;
  /** ISO time of the newest usage report behind this decision; null before any report. */
  readonly reportedAt: string | null;
  readonly effortEstimates?: ReadonlyArray<{
    readonly effort: string;
    readonly optionId?: string;
    readonly windowLabel?: string | null;
    readonly model: string;
    readonly resumeAt: number | null;
    readonly samples: number;
  }>;
}

export interface ProviderUsageGuardShape {
  /** Fold a provider's account-usage report into the guard. */
  readonly recordRateLimits: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver: ProviderDriverKind;
    readonly rateLimits: unknown;
    readonly reportedAt: string;
  }) => Effect.Effect<void>;

  /** Count the tokens one provider call spent, weighted by the model it ran on. */
  readonly recordTokens: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly driver?: ProviderDriverKind | undefined;
    readonly tokens: number;
    readonly usage?: ThreadTokenUsageSnapshot | undefined;
    readonly threadKey?: string | undefined;
    readonly fast?: boolean | undefined;
    readonly effort?: string | undefined;
    readonly model?: string | null | undefined;
  }) => Effect.Effect<void>;

  /**
   * Decide whether work on `model` may run on this instance right now.
   * `background` work (scheduled agent runs, auto-continuations) is admitted
   * only while the window's pace budget has room for one more thread.
   */
  readonly evaluate: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly threadId?: ThreadId | undefined;
    readonly purpose: "user-turn" | "background" | "running";
    readonly fast?: boolean | undefined;
    readonly effort?: string | undefined;
    readonly model?: string | null | undefined;
  }) => Effect.Effect<UsageGuardDecision>;

  /**
   * Lower reasoning effort on the selection when the guard is optimizing.
   * Returns the same selection when nothing applies.
   */
  readonly optimizeModelSelection: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly modelSelection: ModelSelection;
  }) => Effect.Effect<{
    readonly modelSelection: ModelSelection;
    readonly applied: {
      readonly optionId: string;
      readonly from: string;
      readonly to: string;
    } | null;
    readonly decision: UsageGuardDecision;
  }>;

  /**
   * User-initiated resume: lift the hold for this thread until the window
   * resets, put its waiting deliveries back on the queue, and wake the
   * scheduler. Returns false when nothing on the thread was held.
   */
  readonly resumeThread: (input: {
    readonly threadId: ThreadId;
    readonly recheckOnly?: boolean | undefined;
    readonly modelSelection?: ModelSelection | undefined;
  }) => Effect.Effect<{ readonly resumed: boolean; readonly reason?: string }>;

  /**
   * Ask the provider for a fresh usage report when the guard's newest one is
   * older than `maxAgeMs` (default one minute). A hold can last hours with no
   * turn running, and turns are the only thing that report usage on their
   * own — so without this the hold card shows a balance the account spent
   * long ago, and a resume runs into a limit the guard never saw.
   */
  readonly refreshUsage: (input: {
    readonly instanceId: ProviderInstanceId;
    readonly maxAgeMs?: number | undefined;
  }) => Effect.Effect<{ readonly refreshed: boolean; readonly reportedAt: string | null }>;

  /**
   * Re-check every hold on the instance against the current reading and
   * release as many as the pace budget admits, oldest first. Called by the
   * guard itself after every report and on a timer; exposed so a thread
   * going idle can trigger it too.
   */
  readonly reconsiderHeldWork: (input: {
    readonly instanceId: ProviderInstanceId;
  }) => Effect.Effect<{ readonly released: number }>;
}

export class ProviderUsageGuard extends Context.Service<
  ProviderUsageGuard,
  ProviderUsageGuardShape
>()("t3/orchestration/Services/ProviderUsageGuard") {}
