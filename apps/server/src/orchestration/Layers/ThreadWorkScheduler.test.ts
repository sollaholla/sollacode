import { MessageId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ThreadWorkObligationRepositoryLive } from "../../persistence/Layers/ThreadWorkObligations.ts";
import { ThreadWorkObligationRepository } from "../../persistence/Services/ThreadWorkObligations.ts";
import { RuntimeLeaseRegistryLive } from "../../provider/Layers/RuntimeLeaseRegistry.ts";
import { RuntimeLeaseRegistry } from "../../provider/Services/RuntimeLeaseRegistry.ts";
import { activeTurnWorkSourceId } from "../agentModeContinuation.ts";
import { ThreadWorkScheduler } from "../Services/ThreadWorkScheduler.ts";
import { ThreadSubscriptionRegistry } from "../Services/ThreadSubscriptionRegistry.ts";
import { ThreadSubscriptionRegistryLive } from "./ThreadSubscriptionRegistry.ts";
import { makeThreadWorkSchedulerLive } from "./ThreadWorkScheduler.ts";

const persistenceLayer = ThreadWorkObligationRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);
const layer = it.layer(
  makeThreadWorkSchedulerLive({
    pollIntervalMs: 60_000,
    claimLeaseMs: 60_000,
    heartbeatIntervalMs: 30_000,
  }).pipe(
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(RuntimeLeaseRegistryLive),
    Layer.provideMerge(ThreadSubscriptionRegistryLive),
  ),
);

const waitUntil = <E, R>(predicate: Effect.Effect<boolean, E, R>, description: string) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 5_000; attempt += 1) {
      if (yield* predicate) return;
      yield* Effect.yieldNow;
    }
    return yield* Effect.die(`Timed out waiting for ${description}`);
  });

const findGauge = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Gauge" }> =>
      snapshot.type === "Gauge" &&
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

const findCounter = (
  snapshots: ReadonlyArray<Metric.Metric.Snapshot>,
  id: string,
  attributes: Readonly<Record<string, string>>,
) =>
  snapshots.find(
    (snapshot): snapshot is Extract<Metric.Metric.Snapshot, { readonly type: "Counter" }> =>
      snapshot.type === "Counter" &&
      snapshot.id === id &&
      Object.entries(attributes).every(([key, value]) => snapshot.attributes?.[key] === value),
  );

layer("ThreadWorkScheduler", (it) => {
  it.effect("bounds global, provider, recovery, and per-thread execution", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const release = yield* Deferred.make<void>();
        const now = DateTime.formatIso(yield* DateTime.now);
        const providers = [
          ProviderInstanceId.make("codex"),
          ProviderInstanceId.make("claudeAgent"),
        ];

        yield* scheduler.registerHandler("authentication-resume", () =>
          Deferred.await(release).pipe(Effect.as({ state: "completed" as const })),
        );
        yield* scheduler.registerHandler("agent-continuation", () =>
          Deferred.await(release).pipe(Effect.as({ state: "completed" as const })),
        );

        for (let index = 0; index < 16; index += 1) {
          const providerInstanceId = providers[index % providers.length]!;
          const kind =
            index < 8 ? ("authentication-resume" as const) : ("agent-continuation" as const);
          yield* repository.insert({
            obligationId: `scheduler-work-${index}`,
            threadId: ThreadId.make(`scheduler-thread-${index}`),
            sourceTurnId: TurnId.make(`scheduler-turn-${index}`),
            kind,
            state: "pending",
            providerInstanceId,
            attempt: 0,
            nextAttemptAt: null,
            claimedAt: null,
            leaseExpiresAt: null,
            blockedReason: null,
            createdAt: now,
            updatedAt: now,
          });
        }

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          scheduler.snapshot.pipe(Effect.map(({ activeGlobal }) => activeGlobal === 12)),
          "twelve admitted obligations",
        );

        const active = yield* scheduler.snapshot;
        assert.strictEqual(active.activeGlobal, 12);
        assert.isAtMost(active.activeByProvider.codex ?? 0, 6);
        assert.isAtMost(active.activeByProvider.claudeAgent ?? 0, 6);
        assert.isAtMost(active.activeRecoveryByProvider.codex ?? 0, 2);
        assert.isAtMost(active.activeRecoveryByProvider.claudeAgent ?? 0, 2);
        assert.strictEqual(new Set(active.activeThreads).size, active.activeThreads.length);
        assert.isAtMost(active.schedulerWindowSize, 256);

        yield* Deferred.succeed(release, undefined);
        yield* waitUntil(
          repository
            .listByState({
              providerInstanceId: providers[0]!,
              state: "completed",
              afterUpdatedAt: null,
              afterObligationId: null,
              limit: 256,
            })
            .pipe(
              Effect.zip(
                repository.listByState({
                  providerInstanceId: providers[1]!,
                  state: "completed",
                  afterUpdatedAt: null,
                  afterObligationId: null,
                  limit: 256,
                }),
              ),
              Effect.map(([left, right]) => left.length + right.length === 16),
            ),
          "all obligations to finish",
        );
      }),
    ),
  );

  it.effect("frees a provider slot while a thread waits on a human", () =>
    Effect.scoped(
      Effect.gen(function* () {
        // Seven Claude threads, one more than the per-provider budget. While
        // the first six sit blocked on unanswered questions they must not keep
        // the budget to themselves: an obligation stays `executing` for the
        // whole time a person takes to answer, and holding the slot starved
        // every other thread on the provider with no error anywhere.
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const release = yield* Deferred.make<void>();
        const now = DateTime.formatIso(yield* DateTime.now);
        const provider = ProviderInstanceId.make("claudeAgent");
        const threadIds = Array.from({ length: 7 }, (_, index) =>
          ThreadId.make(`parked-thread-${index}`),
        );

        yield* scheduler.registerHandler("agent-continuation", () =>
          Deferred.await(release).pipe(Effect.as({ state: "completed" as const })),
        );

        for (const [index, threadId] of threadIds.entries()) {
          yield* repository.insert({
            obligationId: `parked-work-${index}`,
            threadId,
            sourceTurnId: TurnId.make(`parked-turn-${index}`),
            kind: "agent-continuation",
            state: "pending",
            providerInstanceId: provider,
            attempt: 0,
            nextAttemptAt: null,
            claimedAt: null,
            leaseExpiresAt: null,
            blockedReason: null,
            createdAt: now,
            updatedAt: now,
          });
        }

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          scheduler.snapshot.pipe(
            Effect.map(({ activeByProvider }) => (activeByProvider.claudeAgent ?? 0) === 6),
          ),
          "the provider budget to fill",
        );
        const saturated = yield* scheduler.snapshot;
        assert.strictEqual(saturated.activeThreads.length, 6, "seventh thread is starved");

        // The six on screen are all waiting on an answer.
        const parkedThreads = saturated.activeThreads.slice(0, 6);
        for (const threadId of parkedThreads) {
          yield* scheduler.setAdmissionParked({ threadId, parked: true });
        }

        const parked = yield* scheduler.snapshot;
        assert.strictEqual(parked.activeByProvider.claudeAgent ?? 0, 0, "slots handed back");
        assert.strictEqual(parked.activeGlobal, 0);

        // The starved thread can now run while the questions stay open.
        yield* scheduler.wake();
        yield* waitUntil(
          scheduler.snapshot.pipe(Effect.map(({ activeThreads }) => activeThreads.length === 7)),
          "the previously starved thread to be admitted",
        );

        // Answering takes the slot back without re-checking the cap: this work
        // is already running and must keep being supervised.
        for (const threadId of parkedThreads) {
          yield* scheduler.setAdmissionParked({ threadId, parked: false });
        }
        const resumed = yield* scheduler.snapshot;
        assert.strictEqual(resumed.activeByProvider.claudeAgent ?? 0, 7);
        assert.strictEqual(resumed.activeThreads.length, 7);

        // Parking is idempotent and never double-counts.
        yield* scheduler.setAdmissionParked({ threadId: parkedThreads[0]!, parked: false });
        assert.strictEqual(
          (yield* scheduler.snapshot).activeByProvider.claudeAgent ?? 0,
          7,
          "unparking twice must not inflate the count",
        );

        yield* Deferred.succeed(release, undefined);
        yield* waitUntil(
          scheduler.snapshot.pipe(Effect.map(({ activeGlobal }) => activeGlobal === 0)),
          "every obligation to finish and release its slot",
        );
      }),
    ),
  );

  it.effect("retries the same sleeping obligation without growing durable rows", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const calls = yield* Ref.make(0);
        const now = DateTime.formatIso(yield* DateTime.now);
        const providerInstanceId = ProviderInstanceId.make("retry-provider");
        const threadId = ThreadId.make("retry-thread");

        yield* scheduler.registerHandler("provider-retry", () =>
          Ref.getAndUpdate(calls, (count) => count + 1).pipe(
            Effect.map((count) =>
              count === 0
                ? ({ state: "sleeping", nextAttemptAt: now, reason: "retryable 502" } as const)
                : ({ state: "completed" } as const),
            ),
          ),
        );
        yield* repository.insert({
          obligationId: "retry-work",
          threadId,
          sourceTurnId: TurnId.make("retry-turn"),
          kind: "provider-retry",
          state: "pending",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          repository
            .getById("retry-work")
            .pipe(Effect.map((row) => Option.getOrNull(row)?.state === "completed")),
          "retry obligation to complete",
        );

        const completed = Option.getOrThrow(yield* repository.getById("retry-work"));
        assert.strictEqual(completed.attempt, 2);
        assert.strictEqual(yield* Ref.get(calls), 2);
        const rows = yield* repository.listByState({
          providerInstanceId,
          state: "completed",
          afterUpdatedAt: null,
          afterObligationId: null,
          limit: 256,
        });
        assert.deepStrictEqual(
          rows.map(({ obligationId }) => obligationId),
          ["retry-work"],
        );
      }),
    ),
  );

  it.effect("caps provider retry sleeping backoff at fifteen seconds", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const nowDateTime = yield* DateTime.now;
        const now = DateTime.formatIso(nowDateTime);
        const providerInstanceId = ProviderInstanceId.make("retry-cap-provider");

        yield* scheduler.registerHandler("provider-retry", () =>
          Effect.succeed({
            state: "sleeping" as const,
            nextAttemptAt: DateTime.formatIso(DateTime.add(nowDateTime, { minutes: 1 })),
            reason: "retryable 503",
          }),
        );
        yield* repository.insert({
          obligationId: "retry-cap-work",
          threadId: ThreadId.make("retry-cap-thread"),
          sourceTurnId: TurnId.make("retry-cap-turn"),
          kind: "provider-retry",
          state: "pending",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          repository
            .getById("retry-cap-work")
            .pipe(Effect.map((row) => Option.getOrNull(row)?.state === "sleeping")),
          "retry obligation to enter sleeping state",
        );

        const sleeping = Option.getOrThrow(yield* repository.getById("retry-cap-work"));
        const retryDelayMs =
          Date.parse(sleeping.nextAttemptAt ?? "") - Date.parse(sleeping.updatedAt);
        assert.isAtLeast(retryDelayMs, 0);
        assert.isAtMost(retryDelayMs, 15_000);
      }),
    ),
  );

  it.effect("retains an active-turn runtime lease across transient upstream sleep", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const runtimeLeases = yield* RuntimeLeaseRegistry;
        const nowDateTime = yield* DateTime.now;
        const now = DateTime.formatIso(nowDateTime);
        const providerInstanceId = ProviderInstanceId.make("active-retry-provider");
        const threadId = ThreadId.make("active-retry-thread");
        const sourceTurnId = TurnId.make("active-retry-turn");

        yield* scheduler.registerHandler("active-turn-recovery", () =>
          Effect.succeed({
            state: "sleeping" as const,
            nextAttemptAt: DateTime.formatIso(DateTime.add(nowDateTime, { minutes: 1 })),
            reason: "structured 502",
            retainedRuntimePhase: "provider-retrying" as const,
          }),
        );
        yield* repository.insert({
          obligationId: "active-retry-work",
          threadId,
          sourceTurnId,
          kind: "active-turn-recovery",
          state: "pending",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          repository
            .getById("active-retry-work")
            .pipe(Effect.map((row) => Option.getOrNull(row)?.state === "sleeping")),
          "active turn retry to sleep",
        );

        const sleeping = Option.getOrThrow(yield* repository.getById("active-retry-work"));
        assert.isAtMost(
          Date.parse(sleeping.nextAttemptAt ?? "") - Date.parse(sleeping.updatedAt),
          15_000,
        );
        yield* scheduler.wake();
        yield* Effect.yieldNow;
        const retained = Option.getOrThrow(yield* runtimeLeases.getLive(threadId));
        assert.strictEqual(retained.lease.phase, "provider-retrying");
        assert.strictEqual(retained.lease.activeTurnId, sourceTurnId);

        yield* scheduler.unregisterHandler("active-turn-recovery");
        yield* waitUntil(
          runtimeLeases.getLive(threadId).pipe(Effect.map(Option.isNone)),
          "retained active turn lease to release",
        );
      }),
    ),
  );

  it.effect("lets startup resumes use normal provider capacity", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const release = yield* Deferred.make<void>();
        const now = DateTime.formatIso(yield* DateTime.now);
        const providerInstanceId = ProviderInstanceId.make("startup-capacity-provider");

        const hold = Deferred.await(release).pipe(Effect.as({ state: "completed" as const }));
        yield* scheduler.registerHandler("authentication-resume", () => hold);
        yield* scheduler.registerHandler("startup-resume", () => hold);

        for (let index = 0; index < 3; index += 1) {
          for (const kind of ["authentication-resume", "startup-resume"] as const) {
            yield* repository.insert({
              obligationId: `${kind}-${index}`,
              threadId: ThreadId.make(`${kind}-thread-${index}`),
              sourceTurnId: TurnId.make(`${kind}-turn-${index}`),
              kind,
              state: "pending",
              providerInstanceId,
              attempt: 0,
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              createdAt: now,
              updatedAt: now,
            });
          }
        }

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          scheduler.snapshot.pipe(Effect.map(({ activeGlobal }) => activeGlobal === 5)),
          "two authentication recoveries and three startup resumes",
        );

        const active = yield* scheduler.snapshot;
        assert.strictEqual(active.activeByProvider[providerInstanceId], 5);
        assert.strictEqual(active.activeRecoveryByProvider[providerInstanceId], 2);

        yield* Deferred.succeed(release, undefined);
      }),
    ),
  );
});

const metricsLayer = it.layer(
  makeThreadWorkSchedulerLive({ pollIntervalMs: 60_000 }).pipe(
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(RuntimeLeaseRegistryLive),
    Layer.provideMerge(ThreadSubscriptionRegistryLive),
  ),
);

metricsLayer("ThreadWorkScheduler metrics", (it) => {
  it.effect("publishes bounded obligation, queue, and runtime lease gauges", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const runtimeLeases = yield* RuntimeLeaseRegistry;
        const threadSubscriptions = yield* ThreadSubscriptionRegistry;
        const now = DateTime.formatIso(yield* DateTime.now);
        const providerInstanceId = ProviderInstanceId.make("metrics-provider");
        const threadId = ThreadId.make("metrics-thread");
        const runtimeThreadId = ThreadId.make("metrics-runtime-thread");

        yield* threadSubscriptions.acquireShell();
        yield* threadSubscriptions.acquireDetail(runtimeThreadId);

        yield* repository.insert({
          obligationId: "metrics-work",
          threadId,
          sourceTurnId: TurnId.make("metrics-turn"),
          kind: "startup-resume",
          state: "pending",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });
        assert.isTrue(
          Option.isSome(
            yield* runtimeLeases.acquire({
              threadId: runtimeThreadId,
              activeTurnId: TurnId.make("metrics-runtime-turn"),
              phase: "tool-running",
              lastHeartbeatAt: now,
              expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 1 })),
            }),
          ),
        );

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          scheduler.snapshot.pipe(Effect.map(({ schedulerWindowSize }) => schedulerWindowSize > 0)),
          "thread work scheduler to drain",
        );
        const snapshots = yield* Metric.snapshot;
        assert.strictEqual(
          findGauge(snapshots, "t3_thread_work_obligations_current", {
            provider: providerInstanceId,
            kind: "startup-resume",
            state: "pending",
          })?.state.value,
          1,
        );
        assert.strictEqual(
          findGauge(snapshots, "t3_thread_work_scheduler_queue_depth", {
            provider: providerInstanceId,
            priority: "4",
          })?.state.value,
          1,
        );
        assert.strictEqual(
          findGauge(snapshots, "t3_thread_runtime_leases_current", {
            phase: "tool-running",
          })?.state.value,
          1,
        );
        assert.strictEqual(
          findGauge(snapshots, "t3_thread_subscriptions_current", { kind: "shell" })?.state.value,
          1,
        );
        assert.strictEqual(
          findGauge(snapshots, "t3_thread_subscriptions_current", { kind: "detail" })?.state.value,
          1,
        );
        assert.strictEqual(
          findGauge(snapshots, "t3_threads_running_without_client_current", {})?.state.value,
          0,
        );
      }),
    ),
  );
});

const authMetricsLayer = it.layer(
  makeThreadWorkSchedulerLive({ pollIntervalMs: 60_000 }).pipe(
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(RuntimeLeaseRegistryLive),
    Layer.provideMerge(ThreadSubscriptionRegistryLive),
  ),
);

authMetricsLayer("ThreadWorkScheduler authentication metrics", (it) => {
  it.effect("counts an authentication resume only after its durable completion wins", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const providerInstanceId = ProviderInstanceId.make("auth-metrics-provider");
        const now = DateTime.formatIso(yield* DateTime.now);

        yield* scheduler.registerHandler("authentication-resume", () =>
          Effect.succeed({ state: "completed" as const }),
        );
        yield* repository.insert({
          obligationId: "auth-metrics-work",
          threadId: ThreadId.make("auth-metrics-thread"),
          sourceTurnId: TurnId.make("auth-metrics-turn"),
          kind: "authentication-resume",
          state: "pending",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          repository
            .getById("auth-metrics-work")
            .pipe(Effect.map((row) => Option.getOrNull(row)?.state === "completed")),
          "authentication resume to complete",
        );

        const snapshots = yield* Metric.snapshot;
        assert.strictEqual(
          findCounter(snapshots, "t3_thread_work_authentication_transitions_total", {
            provider: providerInstanceId,
            transition: "resumed",
          })?.state.count,
          1,
        );
      }),
    ),
  );
});

const phaseLayer = it.layer(
  makeThreadWorkSchedulerLive({
    pollIntervalMs: 60_000,
    claimLeaseMs: 2_000,
    heartbeatIntervalMs: 250,
  }).pipe(
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(RuntimeLeaseRegistryLive),
    Layer.provideMerge(ThreadSubscriptionRegistryLive),
  ),
);

phaseLayer("ThreadWorkScheduler runtime observations", (it) => {
  it.effect("heartbeats the observed provider turn and runtime phase", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const runtimeLeases = yield* RuntimeLeaseRegistry;
        const release = yield* Deferred.make<void>();
        const now = DateTime.formatIso(yield* DateTime.now);
        const threadId = ThreadId.make("phase-thread");
        const sourceTurnId = TurnId.make("phase-source-turn");
        const providerTurnId = TurnId.make("phase-provider-turn");

        yield* scheduler.registerHandler("agent-continuation", () =>
          Deferred.await(release).pipe(Effect.as({ state: "completed" as const })),
        );
        yield* repository.insert({
          obligationId: "phase-work",
          threadId,
          sourceTurnId,
          kind: "agent-continuation",
          state: "pending",
          providerInstanceId: ProviderInstanceId.make("phase-provider"),
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          scheduler.snapshot.pipe(
            Effect.map(({ runtimeByThread }) => runtimeByThread[threadId] !== undefined),
          ),
          "runtime observation obligation to register its runtime lease",
        );
        assert.isTrue(
          yield* scheduler.observeRuntime({
            threadId,
            activeTurnId: providerTurnId,
            phase: "context-compacting",
          }),
        );
        assert.deepEqual((yield* scheduler.snapshot).runtimeByThread[threadId], {
          activeTurnId: providerTurnId,
          phase: "context-compacting",
        });

        yield* TestClock.adjust(Duration.millis(350));
        const lease = Option.getOrThrow(yield* runtimeLeases.getLive(threadId));
        assert.strictEqual(lease.lease.activeTurnId, providerTurnId);
        assert.strictEqual(lease.lease.phase, "context-compacting");

        yield* Deferred.succeed(release, undefined);
        yield* waitUntil(
          repository
            .getById("phase-work")
            .pipe(Effect.map((row) => Option.getOrNull(row)?.state === "completed")),
          "runtime observation obligation to finish",
        );
        assert.isFalse(yield* scheduler.observeRuntime({ threadId, phase: "provider-running" }));
      }),
    ),
  );
});

// Fresh layer: the scheduler must fork its supervision fibers under THIS
// test's TestClock, not one captured by an earlier block's start() call.
const cancellationLayer = it.layer(
  makeThreadWorkSchedulerLive({
    pollIntervalMs: 60_000,
    claimLeaseMs: 2_000,
    heartbeatIntervalMs: 250,
  }).pipe(
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(RuntimeLeaseRegistryLive),
    Layer.provideMerge(ThreadSubscriptionRegistryLive),
  ),
);

cancellationLayer("ThreadWorkScheduler cancellation", (it) => {
  it.effect("releases an orphaned admission after its durable owner and runtime lease end", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const runtimeLeases = yield* RuntimeLeaseRegistry;
        const sql = yield* SqlClient.SqlClient;
        const releaseStrandedHandler = yield* Deferred.make<void>();
        const strandedHandlerReturned = yield* Deferred.make<void>();
        const releaseReclaimedHandler = yield* Deferred.make<void>();
        const now = DateTime.formatIso(yield* DateTime.now);
        const threadId = ThreadId.make("orphaned-admission-thread");
        const providerInstanceId = ProviderInstanceId.make("orphaned-admission-provider");

        // The first attempt simulates a supervisor that cannot finish
        // unwinding after losing both of its leases. A reclaimed second
        // attempt completes normally.
        yield* scheduler.registerHandler("startup-resume", (obligation) =>
          obligation.attempt === 1
            ? Effect.uninterruptible(Deferred.await(releaseStrandedHandler)).pipe(
                Effect.as({ state: "completed" as const }),
                Effect.ensuring(Deferred.succeed(strandedHandlerReturned, undefined)),
              )
            : Effect.uninterruptible(Deferred.await(releaseReclaimedHandler)).pipe(
                Effect.as({ state: "completed" as const }),
              ),
        );
        yield* scheduler.registerHandler("active-turn-recovery", () =>
          Effect.succeed({ state: "completed" as const }),
        );
        yield* repository.insert({
          obligationId: "orphaned-admission-owner",
          threadId,
          sourceTurnId: TurnId.make("orphaned-admission-source-turn"),
          kind: "startup-resume",
          state: "pending",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          Effect.zip(scheduler.snapshot, repository.getById("orphaned-admission-owner")).pipe(
            Effect.map(
              ([snapshot, row]) =>
                snapshot.activeGlobal === 1 && Option.getOrNull(row)?.state === "executing",
            ),
          ),
          "the stranded supervisor to acquire its admission",
        );

        const owner = Option.getOrThrow(yield* repository.getById("orphaned-admission-owner"));
        const runtimeHandle = Option.getOrThrow(yield* runtimeLeases.getLive(threadId));
        yield* sql`
          UPDATE thread_work_obligations
          SET lease_expires_at = '1970-01-01T00:00:00.000Z'
          WHERE obligation_id = ${owner.obligationId}
        `;
        assert.isTrue(
          yield* runtimeLeases.release({
            threadId,
            leaseToken: runtimeHandle.leaseToken,
          }),
        );

        // Both ownership leases are gone while the simulated handler is still
        // unwinding, leaving only the stale in-memory admission behind.
        assert.isTrue(Option.isNone(yield* runtimeLeases.getLive(threadId)));
        assert.strictEqual((yield* scheduler.snapshot).activeGlobal, 1);
        const expiredOwner = Option.getOrThrow(
          yield* repository.getById("orphaned-admission-owner"),
        );
        assert.strictEqual(expiredOwner.state, "executing");
        assert.strictEqual(expiredOwner.leaseExpiresAt, "1970-01-01T00:00:00.000Z");

        yield* repository.insert({
          obligationId: "work-after-orphaned-admission",
          threadId,
          sourceTurnId: TurnId.make("work-after-orphaned-admission-turn"),
          kind: "active-turn-recovery",
          state: "pending",
          providerInstanceId,
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
          updatedAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* scheduler.wake();
        yield* waitUntil(
          Effect.zip(scheduler.snapshot, repository.getById("orphaned-admission-owner")).pipe(
            Effect.map(([snapshot, row]) => {
              const reclaimed = Option.getOrNull(row);
              return (
                snapshot.activeGlobal === 1 &&
                reclaimed?.state === "executing" &&
                reclaimed.attempt === 2
              );
            }),
          ),
          "the expired owner to be reclaimed under a replacement admission",
        );

        // The old finalizer is fenced by reservation attempt. Unwinding
        // attempt 1 while attempt 2 owns the same obligation/thread must not
        // decrement or remove the replacement admission.
        yield* Deferred.succeed(releaseStrandedHandler, undefined);
        yield* Deferred.await(strandedHandlerReturned);
        for (let index = 0; index < 20; index += 1) yield* Effect.yieldNow;
        assert.strictEqual((yield* scheduler.snapshot).activeGlobal, 1);
        assert.isTrue(Option.isSome(yield* scheduler.runtimeLivenessAt(threadId)));
        const replacementOwner = Option.getOrThrow(
          yield* repository.getById("orphaned-admission-owner"),
        );
        assert.strictEqual(replacementOwner.state, "executing");
        assert.strictEqual(replacementOwner.attempt, 2);

        yield* Deferred.succeed(releaseReclaimedHandler, undefined);
        yield* waitUntil(
          repository
            .getById("work-after-orphaned-admission")
            .pipe(Effect.map((row) => Option.getOrNull(row)?.state === "completed")),
          "later user work to pass the reconciled admission",
        );
        assert.strictEqual((yield* scheduler.snapshot).activeGlobal, 0);
      }),
    ),
  );

  it.effect("interrupts an executing supervisor and releases leases on thread cancellation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const repository = yield* ThreadWorkObligationRepository;
        const scheduler = yield* ThreadWorkScheduler;
        const runtimeLeases = yield* RuntimeLeaseRegistry;
        const interrupted = yield* Ref.make(false);
        const now = DateTime.formatIso(yield* DateTime.now);
        const threadId = ThreadId.make("cancel-supervisor-thread");

        yield* scheduler.registerHandler("agent-continuation", () =>
          Effect.never.pipe(
            Effect.onInterrupt(() => Ref.set(interrupted, true)),
            Effect.as({ state: "completed" as const }),
          ),
        );
        yield* repository.insert({
          obligationId: "cancel-supervisor-work",
          threadId,
          sourceTurnId: TurnId.make("cancel-supervisor-turn"),
          kind: "agent-continuation",
          state: "pending",
          providerInstanceId: ProviderInstanceId.make("cancel-supervisor-provider"),
          attempt: 0,
          nextAttemptAt: null,
          claimedAt: null,
          leaseExpiresAt: null,
          blockedReason: null,
          createdAt: now,
          updatedAt: now,
        });

        yield* scheduler.start();
        yield* scheduler.wake();
        yield* waitUntil(
          Effect.zip(scheduler.snapshot, repository.getById("cancel-supervisor-work")).pipe(
            Effect.map(
              ([snapshot, row]) =>
                snapshot.activeGlobal === 1 && Option.getOrNull(row)?.state === "executing",
            ),
          ),
          "supervisor to claim the obligation",
        );
        assert.isTrue(yield* runtimeLeases.hasLiveWork(threadId));

        // A terminal thread command cancels the durable row out from under the
        // running supervisor; the next heartbeat must kill the fiber instead of
        // letting orphaned work keep executing against a dead thread.
        const cancelled = yield* repository.cancelByThread({
          threadId,
          updatedAt: DateTime.formatIso(yield* DateTime.now),
          blockedReason: "thread.deleted",
          mode: "thread-terminal",
        });
        assert.strictEqual(cancelled, 1);

        // The heartbeat sleep may register only after this point; advance the
        // clock in small steps until the failed heartbeat kills the supervisor.
        yield* Effect.gen(function* () {
          for (let attempt = 0; attempt < 100; attempt += 1) {
            const done =
              (yield* Ref.get(interrupted)) && (yield* scheduler.snapshot).activeGlobal === 0;
            if (done) return;
            yield* TestClock.adjust(Duration.millis(300));
            yield* Effect.yieldNow;
          }
          return yield* Effect.die(
            "Timed out waiting for supervisor interruption and admission release",
          );
        });
        assert.isFalse(yield* runtimeLeases.hasLiveWork(threadId));
        assert.isTrue(Option.isNone(yield* runtimeLeases.getLive(threadId)));
        const row = Option.getOrThrow(yield* repository.getById("cancel-supervisor-work"));
        assert.strictEqual(row.state, "cancelled");
        assert.strictEqual(row.blockedReason, "thread.deleted");
      }),
    ),
  );
});

const userDeliveryLayer = it.layer(
  makeThreadWorkSchedulerLive({ maxGlobal: 1, maxPerProvider: 1, pollIntervalMs: 60_000 }).pipe(
    Layer.provideMerge(persistenceLayer),
    Layer.provideMerge(RuntimeLeaseRegistryLive),
    Layer.provideMerge(ThreadSubscriptionRegistryLive),
  ),
);

userDeliveryLayer("ThreadWorkScheduler user delivery", (it) => {
  it.effect(
    "delivers user sends at capacity while keeping automatic work capped and each thread serial",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const repository = yield* ThreadWorkObligationRepository;
          const scheduler = yield* ThreadWorkScheduler;
          const backgroundStarted = yield* Deferred.make<void>();
          const releaseBackground = yield* Deferred.make<void>();
          const userStarted = yield* Deferred.make<void>();
          const otherProviderStarted = yield* Deferred.make<void>();
          const releaseUser = yield* Deferred.make<void>();
          const nextUserStarted = yield* Deferred.make<void>();
          const now = DateTime.formatIso(yield* DateTime.now);
          const provider = ProviderInstanceId.make("codex");
          const userThread = ThreadId.make("interactive-thread");
          const insert = (
            id: string,
            threadId: ThreadId,
            kind: "agent-continuation" | "active-turn-recovery",
            sourceTurnId: TurnId,
            providerInstanceId = provider,
          ) =>
            repository.insert({
              obligationId: id,
              threadId,
              sourceTurnId,
              kind,
              state: "pending",
              providerInstanceId,
              attempt: 0,
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: null,
              createdAt: now,
              updatedAt: now,
            });
          yield* scheduler.registerHandler("agent-continuation", () =>
            Deferred.succeed(backgroundStarted, undefined).pipe(
              Effect.andThen(Deferred.await(releaseBackground)),
              Effect.as({ state: "completed" as const }),
            ),
          );
          yield* scheduler.registerHandler("active-turn-recovery", (work) =>
            Deferred.succeed(
              work.obligationId === "first-user"
                ? userStarted
                : work.obligationId === "other-provider-user"
                  ? otherProviderStarted
                  : nextUserStarted,
              undefined,
            ).pipe(
              Effect.andThen(Deferred.await(releaseUser)),
              Effect.as({ state: "completed" as const }),
            ),
          );
          yield* insert(
            "running-background",
            ThreadId.make("background-thread"),
            "agent-continuation",
            TurnId.make("background-turn"),
          );
          yield* scheduler.start();
          yield* Deferred.await(backgroundStarted);
          yield* insert(
            "waiting-background",
            ThreadId.make("waiting-background-thread"),
            "agent-continuation",
            TurnId.make("next-background-turn"),
          );
          yield* insert(
            "waiting-recovery",
            ThreadId.make("recovery-thread"),
            "active-turn-recovery",
            TurnId.make("existing-provider-turn"),
          );
          yield* insert(
            "waiting-scheduled-task",
            ThreadId.make("scheduled-thread"),
            "active-turn-recovery",
            activeTurnWorkSourceId(MessageId.make("vm-task:scheduled")),
          );
          yield* insert(
            "first-user",
            userThread,
            "active-turn-recovery",
            activeTurnWorkSourceId(MessageId.make("user-1")),
          );
          yield* insert(
            "other-provider-user",
            ThreadId.make("other-provider-thread"),
            "active-turn-recovery",
            activeTurnWorkSourceId(MessageId.make("user-2")),
            ProviderInstanceId.make("claudeAgent"),
          );
          yield* scheduler.wake();
          yield* Deferred.await(userStarted);
          yield* Deferred.await(otherProviderStarted);
          yield* insert(
            "second-user",
            userThread,
            "active-turn-recovery",
            activeTurnWorkSourceId(MessageId.make("user-3")),
          );
          yield* scheduler.wake();
          assert.strictEqual((yield* scheduler.snapshot).activeGlobal, 3);
          for (const id of [
            "waiting-background",
            "waiting-recovery",
            "waiting-scheduled-task",
            "second-user",
          ]) {
            assert.strictEqual(Option.getOrThrow(yield* repository.getById(id)).state, "pending");
          }
          yield* Deferred.succeed(releaseUser, undefined);
          yield* Deferred.await(nextUserStarted);
          // The original background turn is still running when this thread's
          // next user send starts; neither send waits for another thread to end.
          assert.strictEqual(
            Option.getOrThrow(yield* repository.getById("running-background")).state,
            "executing",
          );
          yield* Deferred.succeed(releaseBackground, undefined);
        }),
      ),
  );
});
