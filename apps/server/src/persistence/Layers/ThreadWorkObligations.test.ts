import { ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadWorkObligationRepositoryLive } from "./ThreadWorkObligations.ts";
import { ThreadWorkObligationRepository } from "../Services/ThreadWorkObligations.ts";

const repositoryLayer = it.layer(
  ThreadWorkObligationRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

const now = "2026-08-04T12:00:00.000Z";
const later = "2026-08-04T12:01:00.000Z";
const providerInstanceId = ProviderInstanceId.make("codex");

const insertThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id,
        project_id,
        title,
        model_selection_json,
        runtime_mode,
        interaction_mode,
        branch,
        worktree_path,
        latest_turn_id,
        created_at,
        updated_at,
        archived_at,
        latest_user_message_at,
        pending_approval_count,
        pending_user_input_count,
        has_actionable_proposed_plan,
        deleted_at
      ) VALUES (
        ${threadId},
        'project-thread-work',
        'Thread work test',
        '{"instanceId":"codex","model":"gpt-5.6-sol"}',
        'full-access',
        'agent',
        NULL,
        NULL,
        NULL,
        ${now},
        ${now},
        NULL,
        NULL,
        0,
        0,
        0,
        NULL
      )
    `;
  });

repositoryLayer("ThreadWorkObligationRepository", (it) => {
  it.effect("deduplicates, pages, and claims one active obligation per thread", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const threadId = ThreadId.make("thread-work-claim");
      yield* insertThread(threadId);

      const first = {
        obligationId: "work-1",
        threadId,
        sourceTurnId: TurnId.make("turn-1"),
        kind: "agent-continuation" as const,
        state: "pending" as const,
        providerInstanceId,
        attempt: 0,
        nextAttemptAt: null,
        claimedAt: null,
        leaseExpiresAt: null,
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
      };
      assert.isTrue(yield* repository.insert(first));
      assert.isFalse(yield* repository.insert({ ...first, obligationId: "work-duplicate" }));
      assert.isTrue(
        (yield* Metric.snapshot).some(
          (snapshot) =>
            snapshot.type === "Counter" &&
            snapshot.id === "t3_thread_work_duplicate_conflicts_total" &&
            snapshot.attributes?.provider === providerInstanceId &&
            snapshot.attributes?.kind === "agent-continuation" &&
            snapshot.state.count >= 1,
        ),
      );
      assert.isTrue(
        yield* repository.insert({
          ...first,
          obligationId: "work-2",
          sourceTurnId: TurnId.make("turn-2"),
          kind: "startup-resume",
        }),
      );

      const page = yield* repository.listSchedulable({ providerInstanceId, now, limit: 1 });
      assert.deepStrictEqual(
        page.map(({ obligationId }) => obligationId),
        ["work-1"],
      );

      const claimed = yield* repository.claim({
        obligationId: "work-1",
        now,
        leaseExpiresAt: later,
      });
      assert.strictEqual(Option.getOrNull(claimed)?.attempt, 1);

      const blockedClaim = yield* repository.claim({
        obligationId: "work-2",
        now,
        leaseExpiresAt: later,
      });
      assert.isTrue(Option.isNone(blockedClaim));

      assert.isTrue(
        yield* repository.transition({
          obligationId: "work-1",
          expectedState: "claimed",
          expectedAttempt: 1,
          state: "completed",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: later,
        }),
      );

      assert.isTrue(
        Option.isSome(
          yield* repository.claim({
            obligationId: "work-2",
            now,
            leaseExpiresAt: later,
          }),
        ),
      );
    }),
  );

  it.effect("keeps sleeping work out of the due page and prunes terminal rows in bounds", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const threadId = ThreadId.make("thread-work-sleep");
      yield* insertThread(threadId);

      yield* repository.insert({
        obligationId: "sleeping-work",
        threadId,
        sourceTurnId: TurnId.make("turn-sleep"),
        kind: "provider-retry",
        state: "sleeping",
        providerInstanceId,
        attempt: 7,
        nextAttemptAt: later,
        claimedAt: null,
        leaseExpiresAt: null,
        blockedReason: "upstream unavailable",
        createdAt: now,
        updatedAt: now,
      });

      const beforeDue = yield* repository.listSchedulable({ providerInstanceId, now, limit: 256 });
      assert.isFalse(beforeDue.some(({ obligationId }) => obligationId === "sleeping-work"));
      const whenDue = yield* repository.listSchedulable({
        providerInstanceId,
        now: later,
        limit: 256,
      });
      assert.isTrue(whenDue.some(({ obligationId }) => obligationId === "sleeping-work"));

      const cancelled = yield* repository.cancelByThread({
        threadId,
        updatedAt: later,
        blockedReason: "thread settled",
        mode: "thread-terminal",
      });
      assert.strictEqual(cancelled, 1);
      assert.strictEqual(
        yield* repository.pruneTerminal({
          updatedBefore: "2026-08-05T00:00:00.000Z",
          limit: 1,
        }),
        1,
      );
      assert.isTrue(Option.isNone(yield* repository.getById("sleeping-work")));
    }),
  );

  it.effect("cancelByThread modes protect user deliveries and live supervisors", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const base = (threadId: ThreadId) =>
        ({
          threadId,
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        }) as const;
      const pendingDelivery = (threadId: ThreadId) =>
        repository.insert({
          ...base(threadId),
          obligationId: `${threadId}:user-delivery`,
          sourceTurnId: TurnId.make("turn-start:user-message"),
          kind: "active-turn-recovery",
          state: "pending",
        });
      const stateOf = (obligationId: string) =>
        Effect.map(repository.getById(obligationId), (row) => Option.getOrThrow(row).state);

      // A newer user send spares the queued delivery AND the live supervisor
      // (whose scheduler fiber holds the runtime lease), while still clearing
      // queued synthetic work.
      const supersedeThread = ThreadId.make("thread-work-mode-supersede");
      yield* insertThread(supersedeThread);
      yield* pendingDelivery(supersedeThread);
      yield* repository.insert({
        ...base(supersedeThread),
        obligationId: `${supersedeThread}:supervisor`,
        sourceTurnId: TurnId.make("turn-running"),
        kind: "agent-continuation",
        state: "executing",
        attempt: 1,
        claimedAt: now,
        leaseExpiresAt: later,
      });
      yield* repository.insert({
        ...base(supersedeThread),
        obligationId: `${supersedeThread}:queued-continuation`,
        sourceTurnId: TurnId.make("turn-queued-continuation"),
        kind: "agent-continuation",
        state: "pending",
      });
      assert.strictEqual(
        yield* repository.cancelByThread({
          threadId: supersedeThread,
          updatedAt: later,
          blockedReason: "superseded by user turn",
          mode: "user-supersede",
        }),
        1,
      );
      assert.strictEqual(yield* stateOf(`${supersedeThread}:user-delivery`), "pending");
      assert.strictEqual(yield* stateOf(`${supersedeThread}:supervisor`), "executing");
      assert.strictEqual(yield* stateOf(`${supersedeThread}:queued-continuation`), "cancelled");

      // A sleeping retry was already surfaced as a failure; the newer message
      // replaces it even though the queued delivery survives.
      const retryThread = ThreadId.make("thread-work-mode-supersede-retry");
      yield* insertThread(retryThread);
      yield* pendingDelivery(retryThread);
      yield* repository.insert({
        ...base(retryThread),
        obligationId: `${retryThread}:failing-retry`,
        sourceTurnId: TurnId.make("turn-start:failing-message"),
        kind: "active-turn-recovery",
        state: "sleeping",
        attempt: 3,
        nextAttemptAt: later,
      });
      assert.strictEqual(
        yield* repository.cancelByThread({
          threadId: retryThread,
          updatedAt: later,
          blockedReason: "superseded by user turn",
          mode: "user-supersede",
        }),
        1,
      );
      assert.strictEqual(yield* stateOf(`${retryThread}:user-delivery`), "pending");
      assert.strictEqual(yield* stateOf(`${retryThread}:failing-retry`), "cancelled");

      // Stop button: ends current work (supervisor included) but the queued
      // user delivery survives to dispatch once the thread is idle.
      const interruptThread = ThreadId.make("thread-work-mode-interrupt");
      yield* insertThread(interruptThread);
      yield* pendingDelivery(interruptThread);
      yield* repository.insert({
        ...base(interruptThread),
        obligationId: `${interruptThread}:supervisor`,
        sourceTurnId: TurnId.make("turn-running"),
        kind: "agent-continuation",
        state: "executing",
        attempt: 1,
        claimedAt: now,
        leaseExpiresAt: later,
      });
      assert.strictEqual(
        yield* repository.cancelByThread({
          threadId: interruptThread,
          updatedAt: later,
          blockedReason: "thread.turn-interrupt-requested",
          mode: "turn-interrupt",
        }),
        1,
      );
      assert.strictEqual(yield* stateOf(`${interruptThread}:user-delivery`), "pending");
      assert.strictEqual(yield* stateOf(`${interruptThread}:supervisor`), "cancelled");

      // Deleting/settling the thread drops everything, deliveries included.
      const terminalThread = ThreadId.make("thread-work-mode-terminal");
      yield* insertThread(terminalThread);
      yield* pendingDelivery(terminalThread);
      yield* repository.insert({
        ...base(terminalThread),
        obligationId: `${terminalThread}:supervisor`,
        sourceTurnId: TurnId.make("turn-running"),
        kind: "agent-continuation",
        state: "executing",
        attempt: 1,
        claimedAt: now,
        leaseExpiresAt: later,
      });
      assert.strictEqual(
        yield* repository.cancelByThread({
          threadId: terminalThread,
          updatedAt: later,
          blockedReason: "thread.deleted",
          mode: "thread-terminal",
        }),
        2,
      );
      assert.strictEqual(yield* stateOf(`${terminalThread}:user-delivery`), "cancelled");
      assert.strictEqual(yield* stateOf(`${terminalThread}:supervisor`), "cancelled");
    }),
  );

  it.effect("summarizes obligation state and age without loading individual rows", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const threadIds = [
        ThreadId.make("thread-work-summary-1"),
        ThreadId.make("thread-work-summary-2"),
      ];
      for (const threadId of threadIds) yield* insertThread(threadId);

      for (const [index, threadId] of threadIds.entries()) {
        yield* repository.insert({
          obligationId: `summary-${index}`,
          threadId,
          sourceTurnId: TurnId.make(`turn-summary-${index}`),
          kind: "provider-retry",
          state: "sleeping",
          providerInstanceId,
          attempt: index,
          nextAttemptAt: later,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: "upstream unavailable",
          createdAt: index === 0 ? now : later,
          updatedAt: index === 0 ? now : later,
        });
      }

      const summary = yield* repository.summarize();
      assert.deepInclude(summary, {
        providerInstanceId,
        kind: "provider-retry",
        state: "sleeping",
        count: 2,
        oldestCreatedAt: now,
        oldestUpdatedAt: now,
      });
      assert.deepEqual(
        (yield* repository.summarizeSchedulable(now)).filter(
          ({ kind }) => kind === "provider-retry",
        ),
        [],
      );
      assert.deepInclude(yield* repository.summarizeSchedulable(later), {
        providerInstanceId,
        kind: "provider-retry",
        count: 2,
        oldestCreatedAt: now,
      });
    }),
  );

  it.effect("recovers expired execution and fences the stale attempt", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const threadId = ThreadId.make("thread-work-expired-execution");
      yield* insertThread(threadId);
      yield* repository.insert({
        obligationId: "expired-execution",
        threadId,
        sourceTurnId: TurnId.make("turn-expired-execution"),
        kind: "active-turn-recovery",
        state: "executing",
        providerInstanceId,
        attempt: 1,
        nextAttemptAt: null,
        claimedAt: "2026-08-04T10:00:00.000Z",
        leaseExpiresAt: "2026-08-04T11:00:00.000Z",
        blockedReason: null,
        createdAt: "2026-08-04T10:00:00.000Z",
        updatedAt: "2026-08-04T10:00:00.000Z",
      });

      const due = yield* repository.listSchedulable({ providerInstanceId, now, limit: 256 });
      assert.isTrue(due.some(({ obligationId }) => obligationId === "expired-execution"));
      const reclaimed = Option.getOrThrow(
        yield* repository.claim({
          obligationId: "expired-execution",
          now,
          leaseExpiresAt: later,
        }),
      );
      assert.strictEqual(reclaimed.attempt, 2);
      assert.isFalse(
        yield* repository.heartbeatClaim({
          obligationId: "expired-execution",
          expectedAttempt: 1,
          leaseExpiresAt: later,
          updatedAt: now,
        }),
      );
      assert.isFalse(
        yield* repository.transition({
          obligationId: "expired-execution",
          expectedState: "claimed",
          expectedAttempt: 1,
          state: "completed",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: later,
        }),
      );
      assert.isTrue(
        yield* repository.transition({
          obligationId: "expired-execution",
          expectedState: "claimed",
          expectedAttempt: 2,
          state: "completed",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: later,
        }),
      );
    }),
  );

  it.effect("returns no claim when another logical-active state owns the thread", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const activeStates = [
        "sleeping",
        "blocked-authentication",
        "waiting-approval",
        "waiting-user-input",
      ] as const;

      for (const [index, state] of activeStates.entries()) {
        const threadId = ThreadId.make(`thread-work-blocked-${state}`);
        yield* insertThread(threadId);
        yield* repository.insert({
          obligationId: `active-${state}`,
          threadId,
          sourceTurnId: TurnId.make(`turn-active-${state}`),
          kind: "provider-retry",
          state,
          providerInstanceId,
          attempt: 1,
          nextAttemptAt: state === "sleeping" ? later : null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: state,
          createdAt: now,
          updatedAt: now,
        });
        yield* repository.insert({
          obligationId: `pending-behind-${state}`,
          threadId,
          sourceTurnId: TurnId.make(`turn-pending-${state}`),
          kind: "startup-resume",
          state: "pending",
          providerInstanceId,
          attempt: index,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });
        assert.isTrue(
          Option.isNone(
            yield* repository.claim({
              obligationId: `pending-behind-${state}`,
              now,
              leaseExpiresAt: later,
            }),
          ),
        );
      }
    }),
  );

  it.effect("paginates authentication wakeups and distinguishes key conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const authProviderInstanceId = ProviderInstanceId.make("codex-auth-page");
      for (let index = 0; index < 3; index += 1) {
        const threadId = ThreadId.make(`thread-work-auth-page-${index}`);
        yield* insertThread(threadId);
        yield* repository.insert({
          obligationId: `auth-page-${index}`,
          threadId,
          sourceTurnId: TurnId.make(`turn-auth-page-${index}`),
          kind: "authentication-resume",
          state: "blocked-authentication",
          providerInstanceId: authProviderInstanceId,
          attempt: 1,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: "credentials expired",
          createdAt: now,
          updatedAt: index < 2 ? now : later,
        });
      }

      const firstPage = yield* repository.listByState({
        providerInstanceId: authProviderInstanceId,
        state: "blocked-authentication",
        afterUpdatedAt: null,
        afterObligationId: null,
        limit: 2,
      });
      assert.strictEqual(firstPage.length, 2);
      const cursor = firstPage[1]!;
      const secondPage = yield* repository.listByState({
        providerInstanceId: authProviderInstanceId,
        state: "blocked-authentication",
        afterUpdatedAt: cursor.updatedAt,
        afterObligationId: cursor.obligationId,
        limit: 2,
      });
      assert.deepStrictEqual(
        secondPage.map(({ obligationId }) => obligationId),
        ["auth-page-2"],
      );

      const primaryKeyCollision = yield* repository
        .insert({
          ...firstPage[0]!,
          threadId: ThreadId.make("different-thread-same-id"),
          sourceTurnId: TurnId.make("different-turn-same-id"),
          state: "pending",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(primaryKeyCollision));
    }),
  );

  it.effect("atomically hands active work to a deterministic replacement", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const threadId = ThreadId.make("thread-work-handoff");
      const sourceTurnId = TurnId.make("turn-work-handoff");
      yield* insertThread(threadId);
      yield* repository.insert({
        obligationId: "handoff-current",
        threadId,
        sourceTurnId,
        kind: "active-turn-recovery",
        state: "executing",
        providerInstanceId,
        attempt: 3,
        nextAttemptAt: null,
        claimedAt: now,
        leaseExpiresAt: later,
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
      });

      const replacement = Option.getOrThrow(
        yield* repository.replaceActive({
          currentObligationId: "handoff-current",
          expectedCurrentState: "executing",
          expectedCurrentAttempt: 3,
          currentTerminalState: "cancelled",
          replacement: {
            obligationId: "handoff-auth-resume",
            threadId,
            sourceTurnId,
            kind: "authentication-resume",
            state: "blocked-authentication",
            providerInstanceId,
            attempt: 3,
            nextAttemptAt: null,
            claimedAt: null,
            leaseExpiresAt: null,
            blockedReason: "credentials expired",
            createdAt: later,
            updatedAt: later,
          },
          updatedAt: later,
        }),
      );

      assert.strictEqual(replacement.state, "blocked-authentication");
      const current = Option.getOrThrow(yield* repository.getById("handoff-current"));
      assert.strictEqual(current.state, "cancelled");
      assert.strictEqual(current.blockedReason, "replaced by authentication-resume");
    }),
  );

  it.effect("rolls back the current transition when replacement promotion conflicts", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const threadId = ThreadId.make("thread-work-handoff-rollback");
      const sourceTurnId = TurnId.make("turn-work-handoff-rollback");
      yield* insertThread(threadId);
      yield* repository.insert({
        obligationId: "rollback-current",
        threadId,
        sourceTurnId,
        kind: "active-turn-recovery",
        state: "executing",
        providerInstanceId,
        attempt: 2,
        nextAttemptAt: null,
        claimedAt: now,
        leaseExpiresAt: later,
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
      });
      yield* repository.insert({
        obligationId: "rollback-existing-replacement",
        threadId,
        sourceTurnId,
        kind: "authentication-resume",
        state: "completed",
        providerInstanceId,
        attempt: 2,
        nextAttemptAt: null,
        claimedAt: null,
        leaseExpiresAt: null,
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
      });

      const result = yield* repository.replaceActive({
        currentObligationId: "rollback-current",
        expectedCurrentState: "executing",
        expectedCurrentAttempt: 2,
        currentTerminalState: "cancelled",
        replacement: {
          obligationId: "rollback-new-id-for-same-key",
          threadId,
          sourceTurnId,
          kind: "authentication-resume",
          state: "blocked-authentication",
          providerInstanceId,
          attempt: 2,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: "credentials expired",
          createdAt: later,
          updatedAt: later,
        },
        updatedAt: later,
      });

      assert.isTrue(Option.isNone(result));
      const current = Option.getOrThrow(yield* repository.getById("rollback-current"));
      assert.strictEqual(current.state, "executing");
      const existingReplacement = Option.getOrThrow(
        yield* repository.getById("rollback-existing-replacement"),
      );
      assert.strictEqual(existingReplacement.state, "completed");
      assert.isTrue(Option.isNone(yield* repository.getById("rollback-new-id-for-same-key")));
    }),
  );

  it.effect("refuses to hand active work to a different thread", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const currentThreadId = ThreadId.make("thread-work-handoff-current-thread");
      const otherThreadId = ThreadId.make("thread-work-handoff-other-thread");
      const sourceTurnId = TurnId.make("turn-work-handoff-thread-mismatch");
      yield* insertThread(currentThreadId);
      yield* insertThread(otherThreadId);
      yield* repository.insert({
        obligationId: "thread-mismatch-current",
        threadId: currentThreadId,
        sourceTurnId,
        kind: "active-turn-recovery",
        state: "executing",
        providerInstanceId,
        attempt: 1,
        nextAttemptAt: null,
        claimedAt: now,
        leaseExpiresAt: later,
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
      });

      const result = yield* repository.replaceActive({
        currentObligationId: "thread-mismatch-current",
        expectedCurrentState: "executing",
        expectedCurrentAttempt: 1,
        currentTerminalState: "cancelled",
        replacement: {
          obligationId: "thread-mismatch-replacement",
          threadId: otherThreadId,
          sourceTurnId,
          kind: "authentication-resume",
          state: "blocked-authentication",
          providerInstanceId,
          attempt: 1,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: "credentials expired",
          createdAt: later,
          updatedAt: later,
        },
        updatedAt: later,
      });

      assert.isTrue(Option.isNone(result));
      const current = Option.getOrThrow(yield* repository.getById("thread-mismatch-current"));
      assert.strictEqual(current.state, "executing");
      assert.isTrue(Option.isNone(yield* repository.getById("thread-mismatch-replacement")));
    }),
  );

  it.effect("requeues orphaned claims in bounded restart pages", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const firstThreadId = ThreadId.make("thread-work-recover-first");
      const secondThreadId = ThreadId.make("thread-work-recover-second");
      yield* insertThread(firstThreadId);
      yield* insertThread(secondThreadId);

      for (const [index, threadId, state] of [
        [1, firstThreadId, "claimed"],
        [2, secondThreadId, "executing"],
      ] as const) {
        yield* repository.insert({
          obligationId: `recover-${index}`,
          threadId,
          sourceTurnId: TurnId.make(`recover-turn-${index}`),
          kind: "active-turn-recovery",
          state,
          providerInstanceId,
          attempt: 1,
          nextAttemptAt: null,
          claimedAt: now,
          leaseExpiresAt: later,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });
      }

      let recovered = 0;
      for (let page = 0; page < 32; page += 1) {
        const pageSize = yield* repository.recoverOrphanedClaims({ updatedAt: later, limit: 1 });
        assert.isAtMost(pageSize, 1);
        recovered += pageSize;
        if (pageSize === 0) break;
      }
      // The shared in-memory layer can contain earlier test rows in claimed or
      // executing state. Recovery is intentionally global, so only require
      // that both rows created here were included in bounded pages.
      assert.isAtLeast(recovered, 2);
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getById("recover-1")).state,
        "pending",
      );
      assert.strictEqual(
        Option.getOrThrow(yield* repository.getById("recover-2")).state,
        "pending",
      );
    }),
  );

  it.effect("keeps the projection_threads pending-work columns in sync with the lifecycle", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadWorkObligationRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("thread-work-pending-columns");
      yield* insertThread(threadId);

      const readPendingWork = Effect.gen(function* () {
        const rows = yield* sql<{
          readonly kind: string | null;
          readonly state: string | null;
          readonly since: string | null;
        }>`
          SELECT
            pending_work_kind AS "kind",
            pending_work_state AS "state",
            pending_work_since AS "since"
          FROM projection_threads
          WHERE thread_id = ${threadId}
        `;
        return rows[0];
      });

      const base = {
        threadId,
        providerInstanceId,
        attempt: 0,
        nextAttemptAt: null,
        claimedAt: null,
        leaseExpiresAt: null,
        blockedReason: null,
        createdAt: now,
        updatedAt: now,
      } as const;

      yield* repository.insert({
        ...base,
        obligationId: "pw-continuation",
        sourceTurnId: TurnId.make("turn-pw-1"),
        kind: "agent-continuation",
        state: "pending",
      });
      assert.deepStrictEqual(yield* readPendingWork, {
        kind: "agent-continuation",
        state: "pending",
        since: now,
      });

      yield* repository.claim({ obligationId: "pw-continuation", now, leaseExpiresAt: later });
      assert.strictEqual((yield* readPendingWork)?.state, "claimed");

      assert.isTrue(
        yield* repository.transition({
          obligationId: "pw-continuation",
          expectedState: "claimed",
          expectedAttempt: 1,
          state: "executing",
          nextAttemptAt: null,
          claimedAt: now,
          leaseExpiresAt: later,
          blockedReason: null,
          updatedAt: now,
        }),
      );
      assert.strictEqual((yield* readPendingWork)?.state, "executing");

      // A freshly queued successor outranks the executing supervisor: the
      // executing row is already represented by the running turn, while the
      // pending row is what the thread does next.
      yield* repository.insert({
        ...base,
        obligationId: "pw-next",
        sourceTurnId: TurnId.make("turn-pw-2"),
        kind: "agent-continuation",
        state: "pending",
        createdAt: later,
        updatedAt: later,
      });
      assert.deepStrictEqual(yield* readPendingWork, {
        kind: "agent-continuation",
        state: "pending",
        since: later,
      });

      // Retiring the supervisor leaves the successor surfaced.
      assert.isTrue(
        yield* repository.transition({
          obligationId: "pw-continuation",
          expectedState: "executing",
          expectedAttempt: 1,
          state: "completed",
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          updatedAt: later,
        }),
      );
      assert.deepStrictEqual(yield* readPendingWork, {
        kind: "agent-continuation",
        state: "pending",
        since: later,
      });

      // Terminal for the whole thread: the columns clear rather than pointing
      // at cancelled work.
      yield* repository.cancelByThread({
        threadId,
        updatedAt: later,
        blockedReason: "thread settled",
        mode: "thread-terminal",
      });
      assert.deepStrictEqual(yield* readPendingWork, { kind: null, state: null, since: null });
    }),
  );
});
