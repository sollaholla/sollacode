import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProviderInstanceId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ThreadWorkKind = Schema.Literals([
  "agent-continuation",
  "startup-resume",
  "authentication-resume",
  "provider-retry",
  "active-turn-recovery",
]);
export type ThreadWorkKind = typeof ThreadWorkKind.Type;

export const ThreadWorkState = Schema.Literals([
  "pending",
  "claimed",
  "executing",
  "sleeping",
  "blocked-authentication",
  "waiting-approval",
  "waiting-user-input",
  "completed",
  "cancelled",
]);
export type ThreadWorkState = typeof ThreadWorkState.Type;

export const ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON =
  "awaiting durable steer delivery receipt";

export const ACTIVE_TURN_STEER_DELIVERY_UNKNOWN_REASON =
  "steer delivery outcome unknown after restart";

/**
 * Durable admission marker for synthetic prompts that won the race against a
 * later real user turn. A user-supersede sweep may cancel an executing
 * synthetic obligation until this marker is written, but never after it.
 */
export const SYNTHETIC_DISPATCH_ADMITTED_REASON = "native synthetic dispatch admitted";

/**
 * Marker on an executing queued delivery whose message has not been sent
 * because another turn holds the thread. The delivery handler writes it when
 * it starts supervising that blocking turn; a `turn-interrupt` sweep hands
 * rows carrying it back to `pending` instead of cancelling them, because
 * ending the blocking turn does not un-send the message.
 */
export const ACTIVE_TURN_DELIVERY_QUEUED_BEHIND_TURN_REASON = "queued behind the active turn";

export const ActiveThreadWorkState = Schema.Literals([
  "claimed",
  "executing",
  "sleeping",
  "blocked-authentication",
  "waiting-approval",
  "waiting-user-input",
]);
export type ActiveThreadWorkState = typeof ActiveThreadWorkState.Type;

export const ThreadWorkObligation = Schema.Struct({
  obligationId: TrimmedNonEmptyString,
  threadId: ThreadId,
  sourceTurnId: TurnId,
  kind: ThreadWorkKind,
  state: ThreadWorkState,
  providerInstanceId: ProviderInstanceId,
  attempt: NonNegativeInt,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  claimedAt: Schema.NullOr(IsoDateTime),
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  blockedReason: Schema.NullOr(Schema.String),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ThreadWorkObligation = typeof ThreadWorkObligation.Type;

export const ThreadWorkObligationSummary = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  kind: ThreadWorkKind,
  state: ThreadWorkState,
  count: NonNegativeInt,
  oldestCreatedAt: IsoDateTime,
  oldestUpdatedAt: IsoDateTime,
});
export type ThreadWorkObligationSummary = typeof ThreadWorkObligationSummary.Type;

export const ThreadWorkQueueSummary = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  kind: ThreadWorkKind,
  count: NonNegativeInt,
  oldestCreatedAt: IsoDateTime,
});
export type ThreadWorkQueueSummary = typeof ThreadWorkQueueSummary.Type;

export const ThreadWorkObligationKey = Schema.Struct({
  threadId: ThreadId,
  sourceTurnId: TurnId,
  kind: ThreadWorkKind,
});
export type ThreadWorkObligationKey = typeof ThreadWorkObligationKey.Type;

export const ListSchedulableThreadWorkInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  now: IsoDateTime,
  limit: NonNegativeInt,
});
export type ListSchedulableThreadWorkInput = typeof ListSchedulableThreadWorkInput.Type;

export const ListSchedulableProviderIdsInput = Schema.Struct({
  now: IsoDateTime,
  afterProviderInstanceId: Schema.NullOr(ProviderInstanceId),
  limit: NonNegativeInt,
});
export type ListSchedulableProviderIdsInput = typeof ListSchedulableProviderIdsInput.Type;

export const ClaimThreadWorkInput = Schema.Struct({
  obligationId: TrimmedNonEmptyString,
  now: IsoDateTime,
  leaseExpiresAt: IsoDateTime,
});
export type ClaimThreadWorkInput = typeof ClaimThreadWorkInput.Type;

export const ListThreadWorkByStateInput = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  state: ThreadWorkState,
  afterUpdatedAt: Schema.NullOr(IsoDateTime),
  afterObligationId: Schema.NullOr(TrimmedNonEmptyString),
  limit: NonNegativeInt,
});
export type ListThreadWorkByStateInput = typeof ListThreadWorkByStateInput.Type;

export const TransitionThreadWorkInput = Schema.Struct({
  obligationId: TrimmedNonEmptyString,
  expectedState: ThreadWorkState,
  expectedAttempt: NonNegativeInt,
  expectedBlockedReason: Schema.optional(Schema.NullOr(Schema.String)),
  state: ThreadWorkState,
  nextAttemptAt: Schema.NullOr(IsoDateTime),
  claimedAt: Schema.NullOr(IsoDateTime),
  leaseExpiresAt: Schema.NullOr(IsoDateTime),
  blockedReason: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type TransitionThreadWorkInput = typeof TransitionThreadWorkInput.Type;

export const ReplaceActiveThreadWorkInput = Schema.Struct({
  currentObligationId: TrimmedNonEmptyString,
  expectedCurrentState: ActiveThreadWorkState,
  expectedCurrentAttempt: NonNegativeInt,
  currentTerminalState: Schema.Literals(["completed", "cancelled"]),
  replacement: ThreadWorkObligation,
  updatedAt: IsoDateTime,
});
export type ReplaceActiveThreadWorkInput = typeof ReplaceActiveThreadWorkInput.Type;

export const HeartbeatThreadWorkClaimInput = Schema.Struct({
  obligationId: TrimmedNonEmptyString,
  expectedAttempt: NonNegativeInt,
  leaseExpiresAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type HeartbeatThreadWorkClaimInput = typeof HeartbeatThreadWorkClaimInput.Type;

export const MarkExecutingThreadWorkReasonInput = Schema.Struct({
  obligationId: TrimmedNonEmptyString,
  expectedAttempt: NonNegativeInt,
  blockedReason: Schema.NullOr(Schema.String),
  updatedAt: IsoDateTime,
});
export type MarkExecutingThreadWorkReasonInput = typeof MarkExecutingThreadWorkReasonInput.Type;

export const TryAdmitSyntheticDispatchInput = Schema.Struct({
  obligationId: TrimmedNonEmptyString,
  expectedAttempt: NonNegativeInt,
  sourceMessageId: Schema.optional(MessageId),
  updatedAt: IsoDateTime,
});
export type TryAdmitSyntheticDispatchInput = typeof TryAdmitSyntheticDispatchInput.Type;

export const CancelThreadWorkByThreadInput = Schema.Struct({
  threadId: ThreadId,
  updatedAt: IsoDateTime,
  blockedReason: Schema.NullOr(Schema.String),
  /** Handoffs preserve the replacement delivery even if it was already claimed. */
  exceptSourceTurnId: Schema.optional(TurnId),
  /** Cancel only while the observed outgoing session is still projected. */
  expectedSession: Schema.optional(
    Schema.Struct({
      updatedAt: IsoDateTime,
      activeTurnId: Schema.NullOr(TurnId),
    }),
  ),
  /**
   * Which rows the sweep may cancel. The policy lives here so no call site can
   * accidentally drop user work with a too-broad sweep.
   *
   * - `thread-terminal` (delete/settle/auth-replacement): cancel everything —
   *   the thread is over or a replacement owner is inserted in the same
   *   transaction.
   * - `turn-interrupt` (internal session stop, provider handoff): cancel
   *   current work but spare `active-turn-recovery` rows whose message has
   *   not started a provider turn — queued deliveries of real user messages
   *   the UI has marked "Sent". A queued delivery the scheduler had already
   *   claimed to supervise the blocking turn is handed back to `pending`
   *   rather than cancelled; either way they dispatch once the thread is
   *   idle.
   * - `user-stop` (explicit Stop at any stage): cancel everything, including
   *   queued deliveries, so nothing restarts until the user sends again.
   * - `user-supersede` (a newer user send): additionally spare `claimed` and
   *   `executing` rows of every kind. Those are live supervisors whose
   *   scheduler fiber holds the thread's runtime lease; cancelling the row
   *   kills their durable heartbeat mid-run, which releases the lease and lets
   *   a queued delivery dispatch into a busy provider session. Sleeping
   *   retries are still superseded: their failure was already surfaced, and
   *   the newer message replaces them.
   */
  mode: Schema.Literals(["thread-terminal", "turn-interrupt", "user-stop", "user-supersede"]),
});
export type CancelThreadWorkByThreadInput = typeof CancelThreadWorkByThreadInput.Type;

export const PruneTerminalThreadWorkInput = Schema.Struct({
  updatedBefore: IsoDateTime,
  limit: NonNegativeInt,
});
export type PruneTerminalThreadWorkInput = typeof PruneTerminalThreadWorkInput.Type;

export const RecoverOrphanedThreadWorkInput = Schema.Struct({
  updatedAt: IsoDateTime,
  limit: NonNegativeInt,
});
export type RecoverOrphanedThreadWorkInput = typeof RecoverOrphanedThreadWorkInput.Type;

export interface ThreadWorkObligationRepositoryShape {
  /**
   * Insert once by deterministic id/key. Returns false for a duplicate.
   *
   * With `reviveCancelled`, a row for the same key that ended `cancelled` is
   * reset to `pending` (attempt 0, no lease, no reason) and counts as
   * inserted; live, completed, and explicitly stopped work is left alone. The boot
   * backfill needs this: a thread whose earlier resume of the SAME turn gave
   * up ("Gave up after 11 failed attempts", thread 3112ffe4 2026-09-02
   * 16:27) was killed again by the next relaunch, and the plain insert's
   * conflict no-op meant it never got a resume at all -- the user had to
   * type "Resume" while three sibling threads recovered on their own.
   */
  readonly insert: (
    obligation: ThreadWorkObligation,
    options?: { readonly reviveCancelled?: boolean },
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  readonly getById: (
    obligationId: string,
  ) => Effect.Effect<Option.Option<ThreadWorkObligation>, ProjectionRepositoryError>;

  readonly getByKey: (
    key: ThreadWorkObligationKey,
  ) => Effect.Effect<Option.Option<ThreadWorkObligation>, ProjectionRepositoryError>;

  /**
   * Return one bounded provider-scoped scheduling page. Sleeping work is only
   * included when due; expired claims are eligible for restart recovery.
   */
  readonly listSchedulable: (
    input: ListSchedulableThreadWorkInput,
  ) => Effect.Effect<ReadonlyArray<ThreadWorkObligation>, ProjectionRepositoryError>;

  readonly listSchedulableProviderIds: (
    input: ListSchedulableProviderIdsInput,
  ) => Effect.Effect<ReadonlyArray<ProviderInstanceId>, ProjectionRepositoryError>;

  /** Keyset page used by authentication wakeups, recovery, and local metrics. */
  readonly listByState: (
    input: ListThreadWorkByStateInput,
  ) => Effect.Effect<ReadonlyArray<ThreadWorkObligation>, ProjectionRepositoryError>;

  /** Database-side aggregate for bounded local telemetry; never loads obligation rows. */
  readonly summarize: () => Effect.Effect<
    ReadonlyArray<ThreadWorkObligationSummary>,
    ProjectionRepositoryError
  >;

  /** Database-side aggregate of currently due work, grouped by provider and kind. */
  readonly summarizeSchedulable: (
    now: IsoDateTime,
  ) => Effect.Effect<ReadonlyArray<ThreadWorkQueueSummary>, ProjectionRepositoryError>;

  /** Atomically acquire work while preserving the one-active-turn invariant. */
  readonly claim: (
    input: ClaimThreadWorkInput,
  ) => Effect.Effect<Option.Option<ThreadWorkObligation>, ProjectionRepositoryError>;

  /** Compare-and-set lifecycle transition. */
  readonly transition: (
    input: TransitionThreadWorkInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Atomically terminalize one active obligation and promote its deterministic
   * replacement. Used when the kind changes (for example, auth pause) without
   * opening a crash gap or violating the one-active-thread index.
   */
  readonly replaceActive: (
    input: ReplaceActiveThreadWorkInput,
  ) => Effect.Effect<Option.Option<ThreadWorkObligation>, ProjectionRepositoryError>;

  readonly heartbeatClaim: (
    input: HeartbeatThreadWorkClaimInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Atomically admit an executing synthetic prompt only when no later real
   * user turn exists in the thread event stream. Follow-ups that were already
   * delivered into the source turn (Grok steers) are not later intent. Once
   * admitted, retries in the same claim must revalidate the event stream
   * before a definitely-undispatched provider retry; restart recovery clears
   * the marker.
   */
  readonly tryAdmitSyntheticDispatch: (
    input: TryAdmitSyntheticDispatchInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  /**
   * Rewrite the reason on this attempt's executing claim without touching its
   * lease. Leaves durable markers the cancel sweep keys on (see
   * ACTIVE_TURN_DELIVERY_QUEUED_BEHIND_TURN_REASON). False when the row is no
   * longer this attempt's executing claim.
   */
  readonly markExecutingReason: (
    input: MarkExecutingThreadWorkReasonInput,
  ) => Effect.Effect<boolean, ProjectionRepositoryError>;

  readonly cancelByThread: (
    input: CancelThreadWorkByThreadInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /** Requeue a bounded page of claims left behind by a previous server process. */
  readonly recoverOrphanedClaims: (
    input: RecoverOrphanedThreadWorkInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;

  /** Delete a bounded page of terminal metadata after the seven-day window. */
  readonly pruneTerminal: (
    input: PruneTerminalThreadWorkInput,
  ) => Effect.Effect<number, ProjectionRepositoryError>;
}

export class ThreadWorkObligationRepository extends Context.Service<
  ThreadWorkObligationRepository,
  ThreadWorkObligationRepositoryShape
>()("t3/persistence/Services/ThreadWorkObligations/ThreadWorkObligationRepository") {}
