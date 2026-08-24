import { IsoDateTime, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { increment, threadWorkDuplicateConflictsTotal } from "../../observability/Metrics.ts";
import { toPersistenceSqlError } from "../Errors.ts";
import { refreshProjectionThreadPendingWork } from "../PendingWorkProjection.ts";
import { ThreadPendingWorkSignal } from "../Services/ThreadPendingWorkSignal.ts";
import { ThreadPendingWorkSignalLive } from "./ThreadPendingWorkSignal.ts";
import {
  ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON,
  CancelThreadWorkByThreadInput,
  ClaimThreadWorkInput,
  HeartbeatThreadWorkClaimInput,
  ListSchedulableThreadWorkInput,
  ListSchedulableProviderIdsInput,
  ListThreadWorkByStateInput,
  PruneTerminalThreadWorkInput,
  RecoverOrphanedThreadWorkInput,
  ThreadWorkObligation,
  ThreadWorkObligationKey,
  ThreadWorkObligationSummary,
  ThreadWorkObligationRepository,
  ThreadWorkQueueSummary,
  TransitionThreadWorkInput,
  type ThreadWorkObligationRepositoryShape,
} from "../Services/ThreadWorkObligations.ts";

class ThreadWorkHandoffConflict extends Schema.TaggedErrorClass<ThreadWorkHandoffConflict>()(
  "ThreadWorkHandoffConflict",
  {},
) {}

const ReturnedId = Schema.Struct({ obligationId: Schema.String });
const ReturnedThreadRef = Schema.Struct({ obligationId: Schema.String, threadId: Schema.String });
const ReturnedProviderInstanceId = Schema.Struct({ providerInstanceId: ProviderInstanceId });
const GetByIdInput = Schema.Struct({ obligationId: Schema.String });
const SummarizeSchedulableInput = Schema.Struct({ now: IsoDateTime });

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const pendingWorkSignal = yield* ThreadPendingWorkSignal;

  const insertRow = SqlSchema.findOneOption({
    Request: ThreadWorkObligation,
    Result: ReturnedId,
    execute: (row) => sql`
      INSERT INTO thread_work_obligations (
        obligation_id,
        thread_id,
        source_turn_id,
        kind,
        state,
        provider_instance_id,
        attempt,
        next_attempt_at,
        claimed_at,
        lease_expires_at,
        blocked_reason,
        created_at,
        updated_at
      ) VALUES (
        ${row.obligationId},
        ${row.threadId},
        ${row.sourceTurnId},
        ${row.kind},
        ${row.state},
        ${row.providerInstanceId},
        ${row.attempt},
        ${row.nextAttemptAt},
        ${row.claimedAt},
        ${row.leaseExpiresAt},
        ${row.blockedReason},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id, source_turn_id, kind) DO NOTHING
      RETURNING obligation_id AS "obligationId"
    `,
  });

  const getByIdRow = SqlSchema.findOneOption({
    Request: GetByIdInput,
    Result: ThreadWorkObligation,
    execute: ({ obligationId }) => sql`
      SELECT
        obligation_id AS "obligationId",
        thread_id AS "threadId",
        source_turn_id AS "sourceTurnId",
        kind,
        state,
        provider_instance_id AS "providerInstanceId",
        attempt,
        next_attempt_at AS "nextAttemptAt",
        claimed_at AS "claimedAt",
        lease_expires_at AS "leaseExpiresAt",
        blocked_reason AS "blockedReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_work_obligations
      WHERE obligation_id = ${obligationId}
    `,
  });

  const getByKeyRow = SqlSchema.findOneOption({
    Request: ThreadWorkObligationKey,
    Result: ThreadWorkObligation,
    execute: ({ threadId, sourceTurnId, kind }) => sql`
      SELECT
        obligation_id AS "obligationId",
        thread_id AS "threadId",
        source_turn_id AS "sourceTurnId",
        kind,
        state,
        provider_instance_id AS "providerInstanceId",
        attempt,
        next_attempt_at AS "nextAttemptAt",
        claimed_at AS "claimedAt",
        lease_expires_at AS "leaseExpiresAt",
        blocked_reason AS "blockedReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_work_obligations
      WHERE thread_id = ${threadId}
        AND source_turn_id = ${sourceTurnId}
        AND kind = ${kind}
    `,
  });

  const listSchedulableRows = SqlSchema.findAll({
    Request: ListSchedulableThreadWorkInput,
    Result: ThreadWorkObligation,
    execute: ({ providerInstanceId, now, limit }) => sql`
      SELECT
        obligation_id AS "obligationId",
        thread_id AS "threadId",
        source_turn_id AS "sourceTurnId",
        kind,
        state,
        provider_instance_id AS "providerInstanceId",
        attempt,
        next_attempt_at AS "nextAttemptAt",
        claimed_at AS "claimedAt",
        lease_expires_at AS "leaseExpiresAt",
        blocked_reason AS "blockedReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM (
        SELECT
          scheduled.*,
          ROW_NUMBER() OVER (
            PARTITION BY scheduled.scheduler_priority
            ORDER BY scheduled.created_at ASC, scheduled.obligation_id ASC
          ) AS priority_rank
        FROM (
        SELECT
          candidate.*,
          CASE candidate.kind
            WHEN 'active-turn-recovery' THEN 1
            WHEN 'authentication-resume' THEN 2
            WHEN 'provider-retry' THEN 2
            WHEN 'agent-continuation' THEN 3
            WHEN 'startup-resume' THEN 4
            ELSE 5
          END AS scheduler_priority,
          ROW_NUMBER() OVER (
            PARTITION BY candidate.thread_id
            ORDER BY
              CASE candidate.kind
                WHEN 'active-turn-recovery' THEN 1
                WHEN 'authentication-resume' THEN 2
                WHEN 'provider-retry' THEN 2
                WHEN 'agent-continuation' THEN 3
                WHEN 'startup-resume' THEN 4
                ELSE 5
              END ASC,
              candidate.created_at ASC,
              candidate.obligation_id ASC
          ) AS thread_rank
        FROM thread_work_obligations AS candidate
        WHERE candidate.provider_instance_id = ${providerInstanceId}
          AND (
            candidate.state = 'pending'
            OR (
              candidate.state = 'sleeping'
              AND candidate.next_attempt_at IS NOT NULL
              AND candidate.next_attempt_at <= ${now}
            )
            OR (
              candidate.state IN ('claimed', 'executing')
              AND candidate.lease_expires_at IS NOT NULL
              AND candidate.lease_expires_at <= ${now}
            )
          )
          AND NOT EXISTS (
            SELECT 1
            FROM thread_work_obligations AS active
            WHERE active.thread_id = candidate.thread_id
              AND active.obligation_id <> candidate.obligation_id
              AND active.state IN (
                'claimed',
                'executing',
                'sleeping',
                'blocked-authentication',
                'waiting-approval',
                'waiting-user-input'
              )
          )
        ) AS scheduled
        WHERE thread_rank = 1
      ) AS fair
      ORDER BY
        CAST((priority_rank - 1) / 3 AS INTEGER) ASC,
        scheduler_priority ASC,
        priority_rank ASC,
        created_at ASC,
        obligation_id ASC
      LIMIT ${Math.max(0, Math.min(256, limit))}
    `,
  });

  const listRowsByState = SqlSchema.findAll({
    Request: ListThreadWorkByStateInput,
    Result: ThreadWorkObligation,
    execute: (input) => sql`
      SELECT
        obligation_id AS "obligationId",
        thread_id AS "threadId",
        source_turn_id AS "sourceTurnId",
        kind,
        state,
        provider_instance_id AS "providerInstanceId",
        attempt,
        next_attempt_at AS "nextAttemptAt",
        claimed_at AS "claimedAt",
        lease_expires_at AS "leaseExpiresAt",
        blocked_reason AS "blockedReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM thread_work_obligations
      WHERE provider_instance_id = ${input.providerInstanceId}
        AND state = ${input.state}
        AND (
          ${input.afterUpdatedAt} IS NULL
          OR updated_at > ${input.afterUpdatedAt}
          OR (
            updated_at = ${input.afterUpdatedAt}
            AND obligation_id > COALESCE(${input.afterObligationId}, '')
          )
        )
      ORDER BY updated_at ASC, obligation_id ASC
      LIMIT ${Math.max(0, Math.min(256, input.limit))}
    `,
  });

  const summarizeRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: ThreadWorkObligationSummary,
    execute: () => sql`
      SELECT
        provider_instance_id AS "providerInstanceId",
        kind,
        state,
        COUNT(*) AS "count",
        MIN(created_at) AS "oldestCreatedAt",
        MIN(updated_at) AS "oldestUpdatedAt"
      FROM thread_work_obligations
      GROUP BY provider_instance_id, kind, state
      ORDER BY provider_instance_id ASC, kind ASC, state ASC
    `,
  });

  const summarizeSchedulableRows = SqlSchema.findAll({
    Request: SummarizeSchedulableInput,
    Result: ThreadWorkQueueSummary,
    execute: ({ now }) => sql`
      SELECT
        provider_instance_id AS "providerInstanceId",
        kind,
        COUNT(*) AS "count",
        MIN(created_at) AS "oldestCreatedAt"
      FROM thread_work_obligations
      WHERE state = 'pending'
        OR (state = 'sleeping' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ${now})
        OR (
          state IN ('claimed', 'executing')
          AND lease_expires_at IS NOT NULL
          AND lease_expires_at <= ${now}
        )
      GROUP BY provider_instance_id, kind
      ORDER BY provider_instance_id ASC, kind ASC
    `,
  });

  const listSchedulableProviderIdRows = SqlSchema.findAll({
    Request: ListSchedulableProviderIdsInput,
    Result: ReturnedProviderInstanceId,
    execute: ({ now, afterProviderInstanceId, limit }) => sql`
      SELECT DISTINCT candidate.provider_instance_id AS "providerInstanceId"
      FROM thread_work_obligations AS candidate
      WHERE (
          candidate.state = 'pending'
          OR (
            candidate.state = 'sleeping'
            AND candidate.next_attempt_at IS NOT NULL
            AND candidate.next_attempt_at <= ${now}
          )
          OR (
            candidate.state IN ('claimed', 'executing')
            AND candidate.lease_expires_at IS NOT NULL
            AND candidate.lease_expires_at <= ${now}
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM thread_work_obligations AS active
          WHERE active.thread_id = candidate.thread_id
            AND active.obligation_id <> candidate.obligation_id
            AND active.state IN (
              'claimed',
              'executing',
              'sleeping',
              'blocked-authentication',
              'waiting-approval',
              'waiting-user-input'
            )
        )
        AND (
          ${afterProviderInstanceId} IS NULL
          OR candidate.provider_instance_id > ${afterProviderInstanceId}
        )
      ORDER BY candidate.provider_instance_id ASC
      LIMIT ${Math.max(0, Math.min(256, limit))}
    `,
  });

  const claimRow = SqlSchema.findOneOption({
    Request: ClaimThreadWorkInput,
    Result: ThreadWorkObligation,
    execute: ({ obligationId, now, leaseExpiresAt }) => sql`
      UPDATE thread_work_obligations AS candidate
      SET
        state = 'claimed',
        attempt = attempt + 1,
        next_attempt_at = NULL,
        claimed_at = ${now},
        lease_expires_at = ${leaseExpiresAt},
        blocked_reason = NULL,
        updated_at = ${now}
      WHERE obligation_id = ${obligationId}
        AND (
          state = 'pending'
          OR (state = 'sleeping' AND next_attempt_at IS NOT NULL AND next_attempt_at <= ${now})
          OR (
            state IN ('claimed', 'executing')
            AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ${now}
          )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM thread_work_obligations AS active
          WHERE active.thread_id = candidate.thread_id
            AND active.obligation_id <> candidate.obligation_id
            AND active.state IN (
              'claimed',
              'executing',
              'sleeping',
              'blocked-authentication',
              'waiting-approval',
              'waiting-user-input'
            )
        )
      RETURNING
        obligation_id AS "obligationId",
        thread_id AS "threadId",
        source_turn_id AS "sourceTurnId",
        kind,
        state,
        provider_instance_id AS "providerInstanceId",
        attempt,
        next_attempt_at AS "nextAttemptAt",
        claimed_at AS "claimedAt",
        lease_expires_at AS "leaseExpiresAt",
        blocked_reason AS "blockedReason",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
    `,
  });

  const transitionRow = SqlSchema.findOneOption({
    Request: TransitionThreadWorkInput,
    Result: ReturnedThreadRef,
    execute: (input) => sql`
      UPDATE thread_work_obligations
      SET
        state = ${input.state},
        next_attempt_at = ${input.nextAttemptAt},
        claimed_at = ${input.claimedAt},
        lease_expires_at = ${input.leaseExpiresAt},
        blocked_reason = ${input.blockedReason},
        updated_at = ${input.updatedAt}
      WHERE obligation_id = ${input.obligationId}
        AND state = ${input.expectedState}
        AND attempt = ${input.expectedAttempt}
        AND (
          ${input.expectedBlockedReason === undefined ? 1 : 0} = 1
          OR blocked_reason IS ${input.expectedBlockedReason ?? null}
        )
      RETURNING obligation_id AS "obligationId", thread_id AS "threadId"
    `,
  });

  const heartbeatClaimRow = SqlSchema.findOneOption({
    Request: HeartbeatThreadWorkClaimInput,
    Result: ReturnedId,
    execute: (input) => sql`
      UPDATE thread_work_obligations
      SET lease_expires_at = ${input.leaseExpiresAt}, updated_at = ${input.updatedAt}
      WHERE obligation_id = ${input.obligationId}
        AND state IN ('claimed', 'executing')
        AND attempt = ${input.expectedAttempt}
        AND lease_expires_at > ${input.updatedAt}
        AND ${input.leaseExpiresAt} > ${input.updatedAt}
      RETURNING obligation_id AS "obligationId"
    `,
  });

  const cancelRowsByThread = SqlSchema.findAll({
    Request: CancelThreadWorkByThreadInput,
    Result: ReturnedId,
    execute: (input) => sql`
      UPDATE thread_work_obligations
      SET
        state = 'cancelled',
        next_attempt_at = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL,
        blocked_reason = ${input.blockedReason},
        updated_at = ${input.updatedAt}
      WHERE thread_id = ${input.threadId}
        AND state NOT IN ('completed', 'cancelled')
        AND (
          ${input.mode} = 'thread-terminal'
          OR ${input.mode} = 'pending-start-interrupt'
          OR NOT (state = 'pending' AND kind = 'active-turn-recovery')
        )
        AND (
          ${input.mode} <> 'user-supersede'
          OR state NOT IN ('claimed', 'executing')
          -- A claimed-but-not-yet-running agent continuation is the one piece
          -- of claimed work a user reply must beat: the handler's own CAS to
          -- 'executing' fails on the cancelled row, so the synthetic prompt
          -- is never dispatched over the user's message. Executing rows stay
          -- exempt — cancelling live supervision mid-turn is the 0.1.55 wedge.
          OR (kind = 'agent-continuation' AND state = 'claimed')
        )
      RETURNING obligation_id AS "obligationId"
    `,
  });

  const recoverOrphanedClaimRows = SqlSchema.findAll({
    Request: RecoverOrphanedThreadWorkInput,
    Result: ReturnedThreadRef,
    execute: ({ updatedAt, limit }) => sql`
      UPDATE thread_work_obligations
      SET
        state = 'pending',
        next_attempt_at = NULL,
        claimed_at = NULL,
        lease_expires_at = NULL,
        blocked_reason = 'recovered after scheduler restart',
        updated_at = ${updatedAt}
      WHERE obligation_id IN (
        SELECT obligation_id
        FROM thread_work_obligations
        -- 'sleeping' is orphaned too: the retry fiber that would wake it died
        -- with the previous process, and a sleeping row occupies its thread's
        -- one-active-obligation slot, starving all later work on the thread.
        WHERE state IN ('claimed', 'executing', 'sleeping')
        ORDER BY updated_at ASC, obligation_id ASC
        LIMIT ${Math.max(0, Math.min(256, limit))}
      )
      RETURNING obligation_id AS "obligationId", thread_id AS "threadId"
    `,
  });

  const pruneTerminalRows = SqlSchema.findAll({
    Request: PruneTerminalThreadWorkInput,
    Result: ReturnedId,
    execute: ({ updatedBefore, limit }) => sql`
      DELETE FROM thread_work_obligations
      WHERE obligation_id IN (
        SELECT obligation_id
        FROM thread_work_obligations
        WHERE state IN ('completed', 'cancelled')
          AND updated_at < ${updatedBefore}
          AND NOT (
            state = 'completed'
            AND blocked_reason IS ${ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON}
          )
        ORDER BY updated_at ASC, obligation_id ASC
        LIMIT ${Math.max(0, Math.min(256, limit))}
      )
      RETURNING obligation_id AS "obligationId"
    `,
  });

  const mapError = (operation: string) =>
    Effect.mapError(toPersistenceSqlError(`ThreadWorkObligationRepository.${operation}:query`));

  // Every mutation that can change which obligation is a thread's "next work"
  // re-derives the denormalized pending-work columns on projection_threads, so
  // shell snapshots and event-driven shell refetches always read current
  // scheduler state. Lease heartbeats and terminal-row pruning are exempt:
  // neither changes the surfaced obligation.
  //
  // The refresh is then announced, because these transitions are the only shell
  // changes with no domain event behind them — see ThreadPendingWorkSignal. The
  // signal is best-effort by design: it carries no data, so a lost one costs a
  // refetch, never correctness, and it must not fail a scheduler mutation.
  const refreshPendingWork = (threadId: string) =>
    refreshProjectionThreadPendingWork(sql, threadId).pipe(
      Effect.mapError(
        toPersistenceSqlError("ThreadWorkObligationRepository.refreshPendingWork:query"),
      ),
      Effect.tap(() => announcePendingWork(threadId)),
    );

  const announcePendingWork = (threadId: string) =>
    pendingWorkSignal.publish(ThreadId.make(threadId));

  const clearTerminalPendingTurnStart = (obligationId: string) =>
    sql`
      DELETE FROM projection_turns AS pending
      WHERE pending.turn_id IS NULL
        AND pending.state = 'pending'
        AND pending.pending_message_id IS NOT NULL
        AND pending.checkpoint_turn_count IS NULL
        AND EXISTS (
          SELECT 1
          FROM thread_work_obligations AS work
          WHERE work.obligation_id = ${obligationId}
            AND work.thread_id = pending.thread_id
            AND work.state IN ('completed', 'cancelled')
            AND NOT (
              work.state = 'completed'
              AND work.blocked_reason IS ${ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON}
            )
            AND (
              (
                work.kind = 'active-turn-recovery'
                AND work.source_turn_id = 'turn-start:' || pending.pending_message_id
              )
              OR (
                work.kind = 'startup-resume'
                AND pending.pending_message_id =
                  'startup-auto-resume-message:' || work.thread_id || ':' || work.source_turn_id
              )
              OR (
                work.kind = 'agent-continuation'
                AND pending.pending_message_id =
                  'agent-auto-resume-message:' || work.thread_id || ':' || work.source_turn_id
              )
            )
        )
        AND NOT EXISTS (
          SELECT 1
          FROM thread_work_obligations AS live
          WHERE live.thread_id = pending.thread_id
            AND live.state NOT IN ('completed', 'cancelled')
            AND (
              (
                live.kind = 'active-turn-recovery'
                AND live.source_turn_id = 'turn-start:' || pending.pending_message_id
              )
              OR (
                live.kind = 'startup-resume'
                AND pending.pending_message_id =
                  'startup-auto-resume-message:' || live.thread_id || ':' || live.source_turn_id
              )
              OR (
                live.kind = 'agent-continuation'
                AND pending.pending_message_id =
                  'agent-auto-resume-message:' || live.thread_id || ':' || live.source_turn_id
              )
            )
        )
    `;

  return {
    insert: (obligation) =>
      insertRow(obligation).pipe(
        mapError("insert"),
        Effect.map(Option.isSome),
        Effect.tap((inserted) =>
          inserted
            ? refreshPendingWork(obligation.threadId)
            : increment(threadWorkDuplicateConflictsTotal, {
                provider: obligation.providerInstanceId,
                kind: obligation.kind,
              }),
        ),
      ),
    getById: (obligationId) => getByIdRow({ obligationId }).pipe(mapError("getById")),
    getByKey: (key) => getByKeyRow(key).pipe(mapError("getByKey")),
    listSchedulable: (input) => listSchedulableRows(input).pipe(mapError("listSchedulable")),
    listSchedulableProviderIds: (input) =>
      listSchedulableProviderIdRows(input).pipe(
        mapError("listSchedulableProviderIds"),
        Effect.map((rows) => rows.map(({ providerInstanceId }) => providerInstanceId)),
      ),
    listByState: (input) => listRowsByState(input).pipe(mapError("listByState")),
    summarize: () => summarizeRows().pipe(mapError("summarize")),
    summarizeSchedulable: (now) =>
      summarizeSchedulableRows({ now }).pipe(mapError("summarizeSchedulable")),
    claim: (input) =>
      claimRow(input).pipe(
        mapError("claim"),
        Effect.tap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (claimed) => refreshPendingWork(claimed.threadId),
          }),
        ),
      ),
    transition: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const transitioned = yield* transitionRow(input);
            if (Option.isNone(transitioned)) return transitioned;

            // A terminal delivery owner and a visible pending placeholder may
            // not coexist. The sole exception is the short live-steer claim
            // window: provider acceptance has not yet become a durable receipt.
            if (
              (input.state === "completed" || input.state === "cancelled") &&
              !(
                input.state === "completed" &&
                input.blockedReason === ACTIVE_TURN_STEER_DELIVERY_UNCONFIRMED_REASON
              )
            ) {
              yield* clearTerminalPendingTurnStart(input.obligationId);
            }
            yield* refreshProjectionThreadPendingWork(sql, transitioned.value.threadId);
            return transitioned;
          }),
        )
        .pipe(
          mapError("transition"),
          Effect.tap(
            Option.match({
              onNone: () => Effect.void,
              onSome: (transitioned) => announcePendingWork(transitioned.threadId),
            }),
          ),
          Effect.map(Option.isSome),
        ),
    replaceActive: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const current = yield* getByIdRow({
              obligationId: input.currentObligationId,
            });
            if (
              Option.isNone(current) ||
              current.value.threadId !== input.replacement.threadId ||
              current.value.sourceTurnId !== input.replacement.sourceTurnId ||
              current.value.providerInstanceId !== input.replacement.providerInstanceId ||
              current.value.state !== input.expectedCurrentState ||
              current.value.attempt !== input.expectedCurrentAttempt ||
              input.replacement.state === "completed" ||
              input.replacement.state === "cancelled"
            ) {
              return yield* new ThreadWorkHandoffConflict();
            }

            yield* insertRow({
              ...input.replacement,
              state: "pending",
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
            });

            const currentTransitioned = yield* transitionRow({
              obligationId: input.currentObligationId,
              expectedState: input.expectedCurrentState,
              expectedAttempt: input.expectedCurrentAttempt,
              state: input.currentTerminalState,
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: `replaced by ${input.replacement.kind}`,
              updatedAt: input.updatedAt,
            }).pipe(Effect.map(Option.isSome));
            if (!currentTransitioned) {
              return yield* new ThreadWorkHandoffConflict();
            }
            yield* clearTerminalPendingTurnStart(input.currentObligationId);

            const pendingReplacement = yield* getByKeyRow({
              threadId: input.replacement.threadId,
              sourceTurnId: input.replacement.sourceTurnId,
              kind: input.replacement.kind,
            });
            if (Option.isNone(pendingReplacement)) {
              return yield* new ThreadWorkHandoffConflict();
            }

            if (input.replacement.state !== "pending") {
              const promoted = yield* transitionRow({
                obligationId: pendingReplacement.value.obligationId,
                expectedState: "pending",
                expectedAttempt: pendingReplacement.value.attempt,
                state: input.replacement.state,
                nextAttemptAt: input.replacement.nextAttemptAt,
                claimedAt: input.replacement.claimedAt,
                leaseExpiresAt: input.replacement.leaseExpiresAt,
                blockedReason: input.replacement.blockedReason,
                updatedAt: input.updatedAt,
              }).pipe(Effect.map(Option.isSome));
              if (!promoted) {
                return yield* new ThreadWorkHandoffConflict();
              }
            }

            // The inner statements above are the raw rows, not the wrapped
            // service methods, so refresh once here; a conflict rolls the
            // whole transaction back and leaves the columns untouched.
            yield* refreshProjectionThreadPendingWork(sql, input.replacement.threadId);

            return yield* getByKeyRow({
              threadId: input.replacement.threadId,
              sourceTurnId: input.replacement.sourceTurnId,
              kind: input.replacement.kind,
            });
          }),
        )
        .pipe(
          Effect.catchTag("ThreadWorkHandoffConflict", () =>
            Effect.succeed(Option.none<ThreadWorkObligation>()),
          ),
          mapError("replaceActive"),
          // The handoff refreshes inside its transaction (see above), so the
          // announcement belongs out here, after it commits — and only when it
          // committed: a conflict rolled everything back and changed nothing.
          Effect.tap((replaced) =>
            Option.isSome(replaced) ? announcePendingWork(input.replacement.threadId) : Effect.void,
          ),
        ),
    heartbeatClaim: (input) =>
      heartbeatClaimRow(input).pipe(mapError("heartbeatClaim"), Effect.map(Option.isSome)),
    cancelByThread: (input) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* cancelRowsByThread(input);
            if (rows.length === 0) return rows;
            yield* Effect.forEach(
              rows,
              ({ obligationId }) => clearTerminalPendingTurnStart(obligationId),
              { concurrency: 1, discard: true },
            );
            yield* refreshProjectionThreadPendingWork(sql, input.threadId);
            return rows;
          }),
        )
        .pipe(
          mapError("cancelByThread"),
          Effect.tap((rows) =>
            rows.length > 0 ? announcePendingWork(input.threadId) : Effect.void,
          ),
          Effect.map((rows) => rows.length),
        ),
    recoverOrphanedClaims: (input) =>
      recoverOrphanedClaimRows(input).pipe(
        mapError("recoverOrphanedClaims"),
        Effect.tap((rows) =>
          Effect.forEach(new Set(rows.map(({ threadId }) => threadId)), refreshPendingWork, {
            discard: true,
          }),
        ),
        Effect.map((rows) => rows.length),
      ),
    pruneTerminal: (input) =>
      pruneTerminalRows(input).pipe(
        mapError("pruneTerminal"),
        Effect.map((rows) => rows.length),
      ),
  } satisfies ThreadWorkObligationRepositoryShape;
});

// The signal is merged in rather than required: every consumer of this
// repository is, by definition, a producer of the transitions nothing else
// reports, so the two belong together and `subscribeShell` reads the same
// instance from the merged output.
export const ThreadWorkObligationRepositoryLive = Layer.effect(
  ThreadWorkObligationRepository,
  make,
).pipe(Layer.provideMerge(ThreadPendingWorkSignalLive));
