import type { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Option from "effect/Option";
import type * as Scope from "effect/Scope";

import type {
  ThreadWorkKind,
  ThreadWorkObligation,
} from "../../persistence/Services/ThreadWorkObligations.ts";
import type { ThreadRuntimePhase } from "../../provider/Services/RuntimeLeaseRegistry.ts";

export type ThreadWorkExecutionOutcome =
  | { readonly state: "completed" }
  | { readonly state: "cancelled"; readonly reason: string | null }
  | {
      readonly state: "sleeping";
      readonly nextAttemptAt: string;
      readonly reason: string | null;
      /** Keep the scheduler-owned process/runtime reservation alive while the
       * durable obligation sleeps. Used for transient upstream retries that
       * must not be reaped between attempts. */
      readonly retainedRuntimePhase?: ThreadRuntimePhase;
    }
  | { readonly state: "blocked-authentication"; readonly reason: string }
  | {
      readonly state: "waiting-approval" | "waiting-user-input";
      /** True only when the adapter can durably reconstruct the callback. */
      readonly durableCallbackRehydration: true;
      readonly reason: string | null;
    };

export type ThreadWorkHandler = (
  obligation: ThreadWorkObligation,
) => Effect.Effect<ThreadWorkExecutionOutcome, never>;

export interface ThreadWorkSchedulerSnapshot {
  readonly activeGlobal: number;
  readonly activeByProvider: Readonly<Record<string, number>>;
  readonly activeRecoveryByProvider: Readonly<Record<string, number>>;
  readonly activeThreads: ReadonlyArray<ThreadId>;
  readonly schedulerWindowSize: number;
  readonly runtimeByThread: Readonly<
    Record<
      string,
      {
        readonly activeTurnId: TurnId | null;
        readonly phase: ThreadRuntimePhase;
      }
    >
  >;
}

export interface ThreadWorkSchedulerShape {
  /** Start the single coalesced scheduler loop for this server. */
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;

  /** Coalesced wakeup; callers do not create one timer/fiber per obligation. */
  readonly wake: (providerInstanceId?: ProviderInstanceId) => Effect.Effect<void>;

  readonly registerHandler: (
    kind: ThreadWorkKind,
    handler: ThreadWorkHandler,
  ) => Effect.Effect<void>;

  readonly unregisterHandler: (kind: ThreadWorkKind) => Effect.Effect<void>;

  /**
   * Refine the live runtime lease for an executing obligation. Runtime
   * ingestion may call this for every provider event; observations for a
   * thread without scheduler-owned work are deliberately ignored.
   */
  readonly observeRuntime: (input: {
    readonly threadId: ThreadId;
    readonly activeTurnId?: TurnId | null;
    readonly phase: ThreadRuntimePhase;
  }) => Effect.Effect<boolean>;

  /**
   * Epoch millis of the last runtime observation for the thread, if the
   * scheduler currently owns work for it. Long tool calls surface only as
   * 30-second provider heartbeats that never change the projected shell;
   * this is the liveness signal that keeps the silence watchdog from
   * killing a session that is quietly mid-tool.
   */
  readonly runtimeLivenessAt: (threadId: ThreadId) => Effect.Effect<Option.Option<number>>;

  readonly snapshot: Effect.Effect<ThreadWorkSchedulerSnapshot>;
}

export class ThreadWorkScheduler extends Context.Service<
  ThreadWorkScheduler,
  ThreadWorkSchedulerShape
>()("t3/orchestration/Services/ThreadWorkScheduler") {}
