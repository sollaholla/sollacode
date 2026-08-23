import { ProviderInstanceId, type ThreadId, type TurnId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Metric from "effect/Metric";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import {
  metricAttributes,
  threadRuntimeLeasesCurrent,
  threadSubscriptionsCurrent,
  threadWorkAuthenticationTransitionsTotal,
  threadWorkObligationOldestAgeSeconds,
  threadWorkObligationsCurrent,
  threadWorkRecoveredTotal,
  threadWorkSchedulerOldestWaitSeconds,
  threadWorkSchedulerQueueDepth,
  threadsRunningWithoutClientCurrent,
} from "../../observability/Metrics.ts";
import { ThreadWorkObligationRepository } from "../../persistence/Services/ThreadWorkObligations.ts";
import type {
  ThreadWorkKind,
  ThreadWorkObligation,
} from "../../persistence/Services/ThreadWorkObligations.ts";
import { RuntimeLeaseRegistry } from "../../provider/Services/RuntimeLeaseRegistry.ts";
import type {
  ThreadRuntimeLeaseHandle,
  ThreadRuntimePhase,
} from "../../provider/Services/RuntimeLeaseRegistry.ts";
import { ThreadSubscriptionRegistry } from "../Services/ThreadSubscriptionRegistry.ts";
import {
  ThreadWorkScheduler,
  type ThreadWorkExecutionOutcome,
  type ThreadWorkHandler,
  type ThreadWorkSchedulerShape,
} from "../Services/ThreadWorkScheduler.ts";

// Sized for the real workflow: several long-running agent threads plus their
// side chats, concurrently, on one provider.
const DEFAULT_MAX_GLOBAL = 12;
const DEFAULT_MAX_PER_PROVIDER = 6;
const DEFAULT_MAX_RECOVERY_PER_PROVIDER = 2;
const DEFAULT_WINDOW_SIZE = 256;
const DEFAULT_POLL_INTERVAL_MS = 1_000;
const DEFAULT_CLAIM_LEASE_MS = 60_000;
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_METRICS_INTERVAL_MS = 5_000;
const PROVIDER_RETRY_BACKOFF_CAP_MS = 15_000;
const TERMINAL_RETENTION_DAYS = 7;
const THREAD_WORK_KINDS: ReadonlyArray<ThreadWorkKind> = [
  "agent-continuation",
  "startup-resume",
  "authentication-resume",
  "provider-retry",
  "active-turn-recovery",
];

export interface ThreadWorkSchedulerLiveOptions {
  readonly maxGlobal?: number;
  readonly maxPerProvider?: number;
  readonly maxRecoveryPerProvider?: number;
  readonly windowSize?: number;
  readonly pollIntervalMs?: number;
  readonly claimLeaseMs?: number;
  readonly heartbeatIntervalMs?: number;
}

interface AdmissionState {
  readonly activeGlobal: number;
  readonly activeByProvider: ReadonlyMap<string, number>;
  readonly activeRecoveryByProvider: ReadonlyMap<string, number>;
  readonly activeThreads: ReadonlySet<ThreadId>;
  /**
   * Threads whose obligation is still executing but is blocked on a human —
   * an unanswered question or approval. Their concurrency counts are given
   * back while they wait; they stay in {@link activeThreads} so a second
   * obligation for the same thread still cannot start behind their back.
   */
  readonly parkedThreads: ReadonlyMap<string, ParkedAdmission>;
  /** Provider/recovery shape of each admitted thread, so parking can give
   *  back exactly what was taken without the caller restating it. */
  readonly activeAdmissions: ReadonlyMap<string, ParkedAdmission>;
}

interface ParkedAdmission {
  readonly providerKey: string;
  readonly recovery: boolean;
}

interface Admission {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly recovery: boolean;
}

interface ActiveRuntimeObservation {
  readonly obligationId: string;
  readonly activeTurnId: TurnId | null;
  readonly phase: ThreadRuntimePhase;
  /**
   * When runtime ingestion last reported ANY provider event for this thread.
   * Long tool calls emit only 30s progress heartbeats that never touch the
   * projected shell, so this in-memory stamp is the only liveness signal the
   * silence watchdog can consult before declaring the feed dead.
   */
  readonly lastObservedAtMs: number;
}

const emptyAdmissionState = (): AdmissionState => ({
  activeGlobal: 0,
  activeByProvider: new Map(),
  activeRecoveryByProvider: new Map(),
  activeThreads: new Set(),
  parkedThreads: new Map(),
  activeAdmissions: new Map(),
});

// The recovery throttle exists to keep autonomous boot/auth resume storms
// from spawning a CLI per thread at once. `active-turn-recovery` must NOT
// count against it: it is also the delivery obligation for every ordinary
// user message, so including it capped live concurrent chats at
// maxRecoveryPerProvider (2) — two busy main threads then starved every
// side chat's send forever, which read as "side chats never reach a CLI".
const recoveryKind = (kind: ThreadWorkKind): boolean =>
  kind === "authentication-resume" || kind === "startup-resume";

const runtimePhase = (kind: ThreadWorkKind) =>
  kind === "provider-retry" ? ("provider-retrying" as const) : ("provider-running" as const);

const schedulerPriority = (kind: ThreadWorkKind): number => {
  switch (kind) {
    case "active-turn-recovery":
      return 1;
    case "authentication-resume":
    case "provider-retry":
      return 2;
    case "agent-continuation":
      return 3;
    case "startup-resume":
      return 4;
  }
};

interface GaugePoint {
  readonly key: string;
  readonly attributes: Readonly<Record<string, unknown>>;
  readonly value: number;
}

const updateGaugeSnapshot = (
  metric: Metric.Metric<number, unknown>,
  previous: Ref.Ref<ReadonlyMap<string, Readonly<Record<string, unknown>>>>,
  points: ReadonlyArray<GaugePoint>,
) =>
  Effect.gen(function* () {
    const prior = yield* Ref.get(previous);
    const next = new Map<string, Readonly<Record<string, unknown>>>();
    for (const point of points) {
      next.set(point.key, point.attributes);
      yield* Metric.update(
        Metric.withAttributes(metric, metricAttributes(point.attributes)),
        point.value,
      );
    }
    for (const [key, attributes] of prior) {
      if (next.has(key)) continue;
      yield* Metric.update(Metric.withAttributes(metric, metricAttributes(attributes)), 0);
    }
    yield* Ref.set(previous, next);
  });

const outcomeTransition = (outcome: ThreadWorkExecutionOutcome) => {
  switch (outcome.state) {
    case "completed":
      return {
        state: "completed" as const,
        nextAttemptAt: null,
        blockedReason: null,
      };
    case "cancelled":
      return {
        state: "cancelled" as const,
        nextAttemptAt: null,
        blockedReason: outcome.reason,
      };
    case "sleeping":
      return {
        state: "sleeping" as const,
        nextAttemptAt: outcome.nextAttemptAt,
        blockedReason: outcome.reason,
      };
    case "blocked-authentication":
      return {
        state: "blocked-authentication" as const,
        nextAttemptAt: null,
        blockedReason: outcome.reason,
      };
    case "waiting-approval":
    case "waiting-user-input":
      return {
        state: outcome.state,
        nextAttemptAt: null,
        blockedReason: outcome.reason,
      };
  }
};

const make = (options?: ThreadWorkSchedulerLiveOptions) =>
  Effect.gen(function* () {
    const obligations = yield* ThreadWorkObligationRepository;
    const runtimeLeases = yield* RuntimeLeaseRegistry;
    const threadSubscriptions = yield* ThreadSubscriptionRegistry;
    const wakeQueue = yield* Queue.sliding<void>(1);
    const wakeHints = yield* Ref.make<ReadonlySet<string>>(new Set());
    const handlers = yield* Ref.make<ReadonlyMap<ThreadWorkKind, ThreadWorkHandler>>(new Map());
    const admissions = yield* Ref.make<AdmissionState>(emptyAdmissionState());
    const runtimeObservations = yield* Ref.make<ReadonlyMap<ThreadId, ActiveRuntimeObservation>>(
      new Map(),
    );
    const started = yield* Ref.make(false);
    const schedulerWindowSize = yield* Ref.make(0);
    const providerCursor = yield* Ref.make<ProviderInstanceId | null>(null);
    const lastPrunedAt = yield* Ref.make(0);
    const lastMetricsAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
    const obligationMetricLabels = yield* Ref.make<
      ReadonlyMap<string, Readonly<Record<string, unknown>>>
    >(new Map());
    const obligationAgeMetricLabels = yield* Ref.make<
      ReadonlyMap<string, Readonly<Record<string, unknown>>>
    >(new Map());
    const queueMetricLabels = yield* Ref.make<
      ReadonlyMap<string, Readonly<Record<string, unknown>>>
    >(new Map());
    const queueAgeMetricLabels = yield* Ref.make<
      ReadonlyMap<string, Readonly<Record<string, unknown>>>
    >(new Map());
    const runtimeMetricLabels = yield* Ref.make<
      ReadonlyMap<string, Readonly<Record<string, unknown>>>
    >(new Map());

    const maxGlobal = Math.max(1, options?.maxGlobal ?? DEFAULT_MAX_GLOBAL);
    const maxPerProvider = Math.max(1, options?.maxPerProvider ?? DEFAULT_MAX_PER_PROVIDER);
    const maxRecoveryPerProvider = Math.max(
      1,
      options?.maxRecoveryPerProvider ?? DEFAULT_MAX_RECOVERY_PER_PROVIDER,
    );
    const windowSize = Math.max(1, Math.min(256, options?.windowSize ?? DEFAULT_WINDOW_SIZE));
    const pollIntervalMs = Math.max(10, options?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
    const claimLeaseMs = Math.max(1_000, options?.claimLeaseMs ?? DEFAULT_CLAIM_LEASE_MS);
    const heartbeatIntervalMs = Math.max(
      250,
      Math.min(claimLeaseMs / 2, options?.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS),
    );

    const wake: ThreadWorkSchedulerShape["wake"] = (providerInstanceId) =>
      Effect.gen(function* () {
        if (providerInstanceId !== undefined) {
          yield* Ref.update(wakeHints, (current) => {
            const next = new Set(current);
            if (next.size < windowSize || next.has(providerInstanceId)) {
              next.add(providerInstanceId);
            }
            return next;
          });
        }
        yield* Queue.offer(wakeQueue, undefined);
      });

    const observeRuntime: ThreadWorkSchedulerShape["observeRuntime"] = (input) =>
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        return yield* Ref.modify(runtimeObservations, (current) => {
          const existing = current.get(input.threadId);
          if (existing === undefined) return [false, current] as const;
          const next = new Map(current);
          next.set(input.threadId, {
            ...existing,
            activeTurnId:
              input.activeTurnId === undefined ? existing.activeTurnId : input.activeTurnId,
            phase: input.phase,
            lastObservedAtMs: nowMs,
          });
          return [true, next] as const;
        });
      });

    const runtimeLivenessAt: ThreadWorkSchedulerShape["runtimeLivenessAt"] = (threadId) =>
      Ref.get(runtimeObservations).pipe(
        Effect.map((current) => Option.fromUndefinedOr(current.get(threadId)?.lastObservedAtMs)),
      );

    const tryReserve = (obligation: ThreadWorkObligation) =>
      Ref.modify(admissions, (current) => {
        const providerKey = String(obligation.providerInstanceId);
        const activeForProvider = current.activeByProvider.get(providerKey) ?? 0;
        const activeRecoveryForProvider = current.activeRecoveryByProvider.get(providerKey) ?? 0;
        const recovery = recoveryKind(obligation.kind);
        if (
          current.activeGlobal >= maxGlobal ||
          activeForProvider >= maxPerProvider ||
          (recovery && activeRecoveryForProvider >= maxRecoveryPerProvider) ||
          current.activeThreads.has(obligation.threadId)
        ) {
          return [Option.none<Admission>(), current] as const;
        }

        const activeByProvider = new Map(current.activeByProvider);
        activeByProvider.set(providerKey, activeForProvider + 1);
        const activeRecoveryByProvider = new Map(current.activeRecoveryByProvider);
        if (recovery) {
          activeRecoveryByProvider.set(providerKey, activeRecoveryForProvider + 1);
        }
        const activeThreads = new Set(current.activeThreads);
        activeThreads.add(obligation.threadId);
        const activeAdmissions = new Map(current.activeAdmissions);
        activeAdmissions.set(String(obligation.threadId), { providerKey, recovery });
        return [
          Option.some({
            threadId: obligation.threadId,
            providerInstanceId: obligation.providerInstanceId,
            recovery,
          }),
          {
            activeGlobal: current.activeGlobal + 1,
            activeByProvider,
            activeRecoveryByProvider,
            activeThreads,
            parkedThreads: current.parkedThreads,
            activeAdmissions,
          },
        ] as const;
      });

    const releaseAdmission = (admission: Admission) =>
      Ref.update(admissions, (current) => {
        const providerKey = String(admission.providerInstanceId);
        // A parked admission already gave its counts back. Decrementing again
        // here would drift them below the real number of running obligations
        // and silently raise the effective concurrency cap.
        const parkedThreads = new Map(current.parkedThreads);
        const activeAdmissions = new Map(current.activeAdmissions);
        activeAdmissions.delete(String(admission.threadId));
        if (parkedThreads.delete(String(admission.threadId))) {
          const activeThreads = new Set(current.activeThreads);
          activeThreads.delete(admission.threadId);
          return { ...current, activeThreads, parkedThreads, activeAdmissions };
        }
        const activeByProvider = new Map(current.activeByProvider);
        const nextProviderCount = Math.max(0, (activeByProvider.get(providerKey) ?? 1) - 1);
        if (nextProviderCount === 0) activeByProvider.delete(providerKey);
        else activeByProvider.set(providerKey, nextProviderCount);

        const activeRecoveryByProvider = new Map(current.activeRecoveryByProvider);
        if (admission.recovery) {
          const nextRecoveryCount = Math.max(
            0,
            (activeRecoveryByProvider.get(providerKey) ?? 1) - 1,
          );
          if (nextRecoveryCount === 0) activeRecoveryByProvider.delete(providerKey);
          else activeRecoveryByProvider.set(providerKey, nextRecoveryCount);
        }

        const activeThreads = new Set(current.activeThreads);
        activeThreads.delete(admission.threadId);
        return {
          activeGlobal: Math.max(0, current.activeGlobal - 1),
          activeByProvider,
          activeRecoveryByProvider,
          activeThreads,
          parkedThreads,
          activeAdmissions,
        };
      });

    /**
     * Give a thread's concurrency slot back while it waits on a human, and
     * take it again when the answer lands.
     *
     * A turn blocked on an unanswered question is not using a provider — but
     * its obligation stays `executing` for as long as the person takes to
     * answer, because the durable `waiting-user-input` state is only
     * available to adapters that can rehydrate the callback (Claude cannot:
     * its `canUseTool` promise dies with the process). Holding the slot meant
     * a handful of unanswered questions consumed the whole per-provider
     * budget and every other thread on that provider starved in `pending`
     * with no error anywhere — reported as "the app is broken, new messages
     * time out too, but other threads are fine".
     *
     * Unparking does NOT re-check the caps: this is work that is already
     * running and must keep being supervised. The overshoot is bounded by the
     * number of questions actually on screen.
     */
    const setAdmissionParked: ThreadWorkSchedulerShape["setAdmissionParked"] = (input) =>
      Ref.update(admissions, (current) => {
        const threadKey = String(input.threadId);
        const parked = current.parkedThreads.get(threadKey);
        if (input.parked === (parked !== undefined)) return current;
        // Only a thread the scheduler currently owns has a slot to give back.
        const admission = parked ?? current.activeAdmissions.get(threadKey);
        if (admission === undefined) return current;

        const { providerKey, recovery } = admission;
        const delta = input.parked ? -1 : 1;

        const activeByProvider = new Map(current.activeByProvider);
        const nextProviderCount = Math.max(0, (activeByProvider.get(providerKey) ?? 0) + delta);
        if (nextProviderCount === 0) activeByProvider.delete(providerKey);
        else activeByProvider.set(providerKey, nextProviderCount);

        const activeRecoveryByProvider = new Map(current.activeRecoveryByProvider);
        if (recovery) {
          const nextRecovery = Math.max(
            0,
            (activeRecoveryByProvider.get(providerKey) ?? 0) + delta,
          );
          if (nextRecovery === 0) activeRecoveryByProvider.delete(providerKey);
          else activeRecoveryByProvider.set(providerKey, nextRecovery);
        }

        const parkedThreads = new Map(current.parkedThreads);
        if (input.parked) parkedThreads.set(threadKey, admission);
        else parkedThreads.delete(threadKey);

        return {
          ...current,
          activeGlobal: Math.max(0, current.activeGlobal + delta),
          activeByProvider,
          activeRecoveryByProvider,
          parkedThreads,
        };
      }).pipe(
        // Freeing a slot is only useful if someone tries to claim it.
        Effect.andThen(input.parked ? wake() : Effect.void),
      );

    const runClaimed = (
      claimed: ThreadWorkObligation,
      handler: ThreadWorkHandler,
      admission: Admission,
      retainedRuntimeHandle: Option.Option<ThreadRuntimeLeaseHandle>,
    ) =>
      Effect.scoped(
        Effect.gen(function* () {
          const executingAt = yield* DateTime.now;
          const executingAtIso = DateTime.formatIso(executingAt);
          const initialLeaseExpiresAt = DateTime.formatIso(
            DateTime.add(executingAt, { milliseconds: claimLeaseMs }),
          );
          const transitioned = yield* obligations.transition({
            obligationId: claimed.obligationId,
            expectedState: "claimed",
            expectedAttempt: claimed.attempt,
            state: "executing",
            nextAttemptAt: null,
            claimedAt: claimed.claimedAt,
            leaseExpiresAt: initialLeaseExpiresAt,
            blockedReason: null,
            updatedAt: executingAtIso,
          });
          if (!transitioned) return;

          let runtimeHandleOption = Option.none<ThreadRuntimeLeaseHandle>();
          if (Option.isSome(retainedRuntimeHandle)) {
            const retained = yield* runtimeLeases.heartbeat({
              threadId: claimed.threadId,
              leaseToken: retainedRuntimeHandle.value.leaseToken,
              phase: runtimePhase(claimed.kind),
              lastHeartbeatAt: executingAtIso,
              expiresAt: initialLeaseExpiresAt,
            });
            if (retained) runtimeHandleOption = retainedRuntimeHandle;
          }
          if (Option.isNone(runtimeHandleOption)) {
            runtimeHandleOption = yield* runtimeLeases.acquire({
              threadId: claimed.threadId,
              activeTurnId: claimed.sourceTurnId,
              phase: runtimePhase(claimed.kind),
              lastHeartbeatAt: executingAtIso,
              expiresAt: initialLeaseExpiresAt,
            });
          }
          if (Option.isNone(runtimeHandleOption)) {
            yield* obligations.transition({
              obligationId: claimed.obligationId,
              expectedState: "executing",
              expectedAttempt: claimed.attempt,
              state: "pending",
              nextAttemptAt: null,
              claimedAt: null,
              leaseExpiresAt: null,
              blockedReason: "runtime lease busy",
              updatedAt: executingAtIso,
            });
            return;
          }

          const runtimeHandle = runtimeHandleOption.value;
          yield* Ref.update(runtimeObservations, (current) => {
            const next = new Map(current);
            next.set(claimed.threadId, {
              obligationId: claimed.obligationId,
              activeTurnId: claimed.sourceTurnId,
              phase: runtimePhase(claimed.kind),
              lastObservedAtMs: DateTime.toEpochMillis(executingAt),
            });
            return next;
          });
          yield* Effect.addFinalizer(() =>
            Ref.update(runtimeObservations, (current) => {
              const existing = current.get(claimed.threadId);
              if (existing?.obligationId !== claimed.obligationId) return current;
              const next = new Map(current);
              next.delete(claimed.threadId);
              return next;
            }),
          );
          let retainRuntimeLease = false;
          yield* Effect.addFinalizer(() =>
            retainRuntimeLease
              ? Effect.void
              : runtimeLeases
                  .release({
                    threadId: claimed.threadId,
                    leaseToken: runtimeHandle.leaseToken,
                  })
                  .pipe(Effect.asVoid),
          );

          const leaseLoss = Effect.gen(function* () {
            while (true) {
              yield* Effect.sleep(Duration.millis(heartbeatIntervalMs));
              const heartbeatAt = yield* DateTime.now;
              const heartbeatAtIso = DateTime.formatIso(heartbeatAt);
              const leaseExpiresAt = DateTime.formatIso(
                DateTime.add(heartbeatAt, { milliseconds: claimLeaseMs }),
              );
              const durableAlive = yield* obligations.heartbeatClaim({
                obligationId: claimed.obligationId,
                expectedAttempt: claimed.attempt,
                leaseExpiresAt,
                updatedAt: heartbeatAtIso,
              });
              if (!durableAlive) return;
              const observation = (yield* Ref.get(runtimeObservations)).get(claimed.threadId);
              const liveObservation =
                observation?.obligationId === claimed.obligationId
                  ? observation
                  : {
                      activeTurnId: claimed.sourceTurnId,
                      phase: runtimePhase(claimed.kind),
                    };
              const runtimeAlive = yield* runtimeLeases.heartbeat({
                threadId: claimed.threadId,
                leaseToken: runtimeHandle.leaseToken,
                activeTurnId: liveObservation.activeTurnId,
                phase: liveObservation.phase,
                lastHeartbeatAt: heartbeatAtIso,
                expiresAt: leaseExpiresAt,
              });
              if (!runtimeAlive) return;
            }
          });

          const handlerAttempt = handler({ ...claimed, state: "executing" }).pipe(
            Effect.map(
              (outcome): Option.Option<ThreadWorkExecutionOutcome> => Option.some(outcome),
            ),
            Effect.catchCause((cause) => {
              if (Cause.hasInterruptsOnly(cause)) {
                return Effect.failCause(cause);
              }
              return Effect.gen(function* () {
                const failedAt = yield* DateTime.now;
                const nextAttemptAt = DateTime.formatIso(DateTime.add(failedAt, { seconds: 15 }));
                yield* Effect.logError("thread-work.scheduler.handler-defect", {
                  obligationId: claimed.obligationId,
                  threadId: claimed.threadId,
                  kind: claimed.kind,
                  cause: Cause.pretty(cause),
                });
                return Option.some<ThreadWorkExecutionOutcome>({
                  state: "sleeping",
                  nextAttemptAt,
                  reason: "scheduler handler defect",
                });
              });
            }),
          );
          const supervisedOutcome = yield* Effect.raceFirst(
            handlerAttempt,
            leaseLoss.pipe(Effect.as(Option.none<ThreadWorkExecutionOutcome>())),
          );
          if (Option.isNone(supervisedOutcome)) {
            yield* Effect.logWarning("thread-work.scheduler.lease-lost", {
              obligationId: claimed.obligationId,
              threadId: claimed.threadId,
              kind: claimed.kind,
              attempt: claimed.attempt,
            });
            return;
          }
          const handlerOutcome = supervisedOutcome.value;
          const outcomeObservedAt = yield* DateTime.now;
          const retainsRetryRuntime =
            handlerOutcome.state === "sleeping" &&
            (claimed.kind === "provider-retry" ||
              handlerOutcome.retainedRuntimePhase === "provider-retrying");
          const outcome = retainsRetryRuntime
            ? (() => {
                const requestedAt = Date.parse(handlerOutcome.nextAttemptAt);
                const cappedAt = DateTime.add(outcomeObservedAt, {
                  milliseconds: PROVIDER_RETRY_BACKOFF_CAP_MS,
                });
                const cappedAtMs = DateTime.toEpochMillis(cappedAt);
                return {
                  ...handlerOutcome,
                  nextAttemptAt: DateTime.formatIso(
                    Number.isFinite(requestedAt) && requestedAt <= cappedAtMs
                      ? DateTime.makeUnsafe(requestedAt)
                      : cappedAt,
                  ),
                };
              })()
            : handlerOutcome;
          const transition = outcomeTransition(outcome);
          const completedAt = yield* DateTime.now;
          const completedAtIso = DateTime.formatIso(completedAt);
          const transitionedToOutcome = yield* obligations.transition({
            obligationId: claimed.obligationId,
            expectedState: "executing",
            expectedAttempt: claimed.attempt,
            state: transition.state,
            nextAttemptAt: transition.nextAttemptAt,
            claimedAt: null,
            leaseExpiresAt: null,
            blockedReason: transition.blockedReason,
            updatedAt: completedAtIso,
          });

          if (
            transitionedToOutcome &&
            claimed.kind === "authentication-resume" &&
            outcome.state === "completed"
          ) {
            yield* Metric.update(
              Metric.withAttributes(
                threadWorkAuthenticationTransitionsTotal,
                metricAttributes({
                  provider: claimed.providerInstanceId,
                  transition: "resumed",
                }),
              ),
              1,
            );
          }

          if (transitionedToOutcome && outcome.state === "sleeping" && retainsRetryRuntime) {
            const retryAtMs = Date.parse(outcome.nextAttemptAt);
            const retainedUntil = DateTime.formatIso(
              DateTime.add(completedAt, {
                milliseconds:
                  Math.max(
                    0,
                    Number.isFinite(retryAtMs)
                      ? retryAtMs - DateTime.toEpochMillis(completedAt)
                      : 0,
                  ) + claimLeaseMs,
              }),
            );
            const retained = yield* runtimeLeases.heartbeat({
              threadId: claimed.threadId,
              leaseToken: runtimeHandle.leaseToken,
              phase: outcome.retainedRuntimePhase ?? "provider-retrying",
              lastHeartbeatAt: completedAtIso,
              expiresAt: retainedUntil,
            });
            if (retained) {
              retainRuntimeLease = true;
            }
          }
        }).pipe(
          Effect.ensuring(
            releaseAdmission(admission).pipe(
              Effect.andThen(wake()),
              Effect.catchCause((cause) =>
                Effect.logWarning("thread-work.scheduler.release-failed", { cause }),
              ),
            ),
          ),
        ),
      );

    const releaseRetainedRetryLeases = Effect.gen(function* () {
      const liveLeases = yield* runtimeLeases.listLive();
      yield* Effect.forEach(
        liveLeases,
        (handle) =>
          handle.lease.phase === "provider-retrying"
            ? runtimeLeases
                .release({
                  threadId: handle.lease.threadId,
                  leaseToken: handle.leaseToken,
                })
                .pipe(Effect.asVoid)
            : Effect.void,
        { discard: true },
      );
    });

    const reconcileRetainedRetryLeases = Effect.gen(function* () {
      const liveLeases = yield* runtimeLeases.listLive();
      yield* Effect.forEach(
        liveLeases,
        (handle) =>
          Effect.gen(function* () {
            if (handle.lease.phase !== "provider-retrying") return;
            if (handle.lease.activeTurnId === null) {
              yield* runtimeLeases.release({
                threadId: handle.lease.threadId,
                leaseToken: handle.leaseToken,
              });
              return;
            }
            const matchingObligations = yield* Effect.forEach(
              THREAD_WORK_KINDS,
              (kind) =>
                obligations.getByKey({
                  threadId: handle.lease.threadId,
                  sourceTurnId: handle.lease.activeTurnId!,
                  kind,
                }),
              { concurrency: THREAD_WORK_KINDS.length },
            );
            const hasActiveOwner = matchingObligations.some(
              (obligation) =>
                Option.isSome(obligation) &&
                ["sleeping", "claimed", "executing"].includes(obligation.value.state),
            );
            if (!hasActiveOwner) {
              yield* runtimeLeases.release({
                threadId: handle.lease.threadId,
                leaseToken: handle.leaseToken,
              });
            }
          }),
        { concurrency: 4, discard: true },
      );
    });

    const maybePruneTerminal = Effect.gen(function* () {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const lastPruned = yield* Ref.get(lastPrunedAt);
      const shouldPrune = nowMs - lastPruned >= Duration.toMillis(Duration.hours(1));
      if (!shouldPrune) return;
      const updatedBefore = DateTime.formatIso(
        DateTime.add(now, { days: -TERMINAL_RETENTION_DAYS }),
      );
      for (let page = 0; page < 4; page += 1) {
        const deleted = yield* obligations.pruneTerminal({
          updatedBefore,
          limit: windowSize,
        });
        if (deleted < windowSize) break;
      }
      yield* Ref.set(lastPrunedAt, nowMs);
    });

    const maybeRefreshMetrics = (now: DateTime.Utc, nowIso: string) =>
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(now);
        const last = yield* Ref.get(lastMetricsAt);
        if (nowMs >= last && nowMs - last < DEFAULT_METRICS_INTERVAL_MS) return;

        const [summaries, queueSummaries, leases, subscriptionSnapshot] = yield* Effect.all([
          obligations.summarize(),
          obligations.summarizeSchedulable(nowIso),
          runtimeLeases.listLive(),
          threadSubscriptions.snapshot,
        ]);
        const obligationPoints = summaries.map((summary) => {
          const attributes = {
            provider: summary.providerInstanceId,
            kind: summary.kind,
            state: summary.state,
          };
          return {
            key: `${summary.providerInstanceId}:${summary.kind}:${summary.state}`,
            attributes,
            value: summary.count,
          } satisfies GaugePoint;
        });
        const obligationAgePoints = summaries.map((summary) => ({
          key: `${summary.providerInstanceId}:${summary.kind}:${summary.state}`,
          attributes: {
            provider: summary.providerInstanceId,
            kind: summary.kind,
            state: summary.state,
          },
          value: Math.max(0, (nowMs - Date.parse(summary.oldestCreatedAt)) / 1_000),
        }));

        const queueGroups = new Map<
          string,
          {
            readonly provider: ProviderInstanceId;
            readonly priority: number;
            count: number;
            oldestCreatedAtMs: number;
          }
        >();
        for (const summary of queueSummaries) {
          const priority = schedulerPriority(summary.kind);
          const key = `${summary.providerInstanceId}:${priority}`;
          const createdAtMs = Date.parse(summary.oldestCreatedAt);
          const existing = queueGroups.get(key);
          if (existing === undefined) {
            queueGroups.set(key, {
              provider: summary.providerInstanceId,
              priority,
              count: summary.count,
              oldestCreatedAtMs: createdAtMs,
            });
          } else {
            existing.count += summary.count;
            existing.oldestCreatedAtMs = Math.min(existing.oldestCreatedAtMs, createdAtMs);
          }
        }
        const queuePoints = Array.from(queueGroups, ([key, group]) => ({
          key,
          attributes: { provider: group.provider, priority: group.priority },
          value: group.count,
        }));
        const queueAgePoints = Array.from(queueGroups, ([key, group]) => ({
          key,
          attributes: { provider: group.provider, priority: group.priority },
          value: Math.max(0, (nowMs - group.oldestCreatedAtMs) / 1_000),
        }));

        const runtimeCounts = new Map<ThreadRuntimePhase, number>();
        for (const { lease } of leases) {
          runtimeCounts.set(lease.phase, (runtimeCounts.get(lease.phase) ?? 0) + 1);
        }
        const runtimePoints = Array.from(runtimeCounts, ([phase, count]) => ({
          key: phase,
          attributes: { phase },
          value: count,
        }));

        yield* updateGaugeSnapshot(
          threadWorkObligationsCurrent,
          obligationMetricLabels,
          obligationPoints,
        );
        yield* updateGaugeSnapshot(
          threadWorkObligationOldestAgeSeconds,
          obligationAgeMetricLabels,
          obligationAgePoints,
        );
        yield* updateGaugeSnapshot(threadWorkSchedulerQueueDepth, queueMetricLabels, queuePoints);
        yield* updateGaugeSnapshot(
          threadWorkSchedulerOldestWaitSeconds,
          queueAgeMetricLabels,
          queueAgePoints,
        );
        yield* updateGaugeSnapshot(threadRuntimeLeasesCurrent, runtimeMetricLabels, runtimePoints);
        yield* Metric.update(
          Metric.withAttributes(threadSubscriptionsCurrent, metricAttributes({ kind: "shell" })),
          subscriptionSnapshot.shellSubscriptions,
        );
        yield* Metric.update(
          Metric.withAttributes(threadSubscriptionsCurrent, metricAttributes({ kind: "detail" })),
          subscriptionSnapshot.detailSubscriptions,
        );
        yield* Metric.update(
          threadsRunningWithoutClientCurrent,
          leases.reduce(
            (count, { lease }) =>
              subscriptionSnapshot.detailedThreadIds.has(lease.threadId) ? count : count + 1,
            0,
          ),
        );
        yield* Ref.set(lastMetricsAt, nowMs);
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("thread-work.scheduler.metrics-refresh-failed", {
            cause: Cause.pretty(cause),
          }),
        ),
      );

    const drain = Effect.gen(function* () {
      yield* maybePruneTerminal;
      yield* reconcileRetainedRetryLeases;
      const now = yield* DateTime.now;
      const nowIso = DateTime.formatIso(now);
      yield* maybeRefreshMetrics(now, nowIso);
      const hints = Array.from(yield* Ref.getAndSet(wakeHints, new Set())).map((value) =>
        ProviderInstanceId.make(value),
      );
      let cursor = yield* Ref.get(providerCursor);
      let providerPage = yield* obligations.listSchedulableProviderIds({
        now: nowIso,
        afterProviderInstanceId: cursor,
        limit: windowSize,
      });
      if (providerPage.length === 0 && cursor !== null) {
        cursor = null;
        providerPage = yield* obligations.listSchedulableProviderIds({
          now: nowIso,
          afterProviderInstanceId: null,
          limit: windowSize,
        });
      }
      yield* Ref.set(
        providerCursor,
        providerPage.length >= windowSize ? (providerPage[providerPage.length - 1] ?? null) : null,
      );

      const providerIds = Array.from(new Set([...hints, ...providerPage])).slice(0, windowSize);
      const perProviderLimit = Math.max(1, Math.ceil(windowSize / Math.max(1, providerIds.length)));
      const providerPages: Array<ReadonlyArray<ThreadWorkObligation>> = [];

      let loaded = 0;
      for (const providerInstanceId of providerIds) {
        if (loaded >= windowSize) break;
        const page = yield* obligations.listSchedulable({
          providerInstanceId,
          now: nowIso,
          limit: Math.min(perProviderLimit, windowSize - loaded),
        });
        loaded += page.length;
        providerPages.push(page);
      }

      const maxProviderPageLength = providerPages.reduce(
        (max, page) => Math.max(max, page.length),
        0,
      );
      for (let candidateIndex = 0; candidateIndex < maxProviderPageLength; candidateIndex += 1) {
        for (const page of providerPages) {
          const candidate = page[candidateIndex];
          if (candidate === undefined) continue;
          const handler = (yield* Ref.get(handlers)).get(candidate.kind);
          if (handler === undefined) continue;

          const liveRuntimeHandle = yield* runtimeLeases.getLive(candidate.threadId);
          const retainedRetryLease = Option.filter(
            liveRuntimeHandle,
            ({ lease }) =>
              candidate.state === "sleeping" &&
              lease.phase === "provider-retrying" &&
              lease.activeTurnId === candidate.sourceTurnId,
          );
          if (Option.isSome(liveRuntimeHandle) && Option.isNone(retainedRetryLease)) {
            continue;
          }

          const admission = yield* tryReserve(candidate);
          if (Option.isNone(admission)) continue;

          const claimExpiresAt = DateTime.formatIso(
            DateTime.add(now, { milliseconds: claimLeaseMs }),
          );
          const claimed = yield* obligations.claim({
            obligationId: candidate.obligationId,
            now: nowIso,
            leaseExpiresAt: claimExpiresAt,
          });
          if (Option.isNone(claimed)) {
            yield* releaseAdmission(admission.value);
            continue;
          }

          yield* Effect.forkScoped(
            runClaimed(claimed.value, handler, admission.value, retainedRetryLease).pipe(
              Effect.catchCause((cause) => {
                if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
                return Effect.logError("thread-work.scheduler.execution-failed", {
                  obligationId: candidate.obligationId,
                  threadId: candidate.threadId,
                  kind: candidate.kind,
                  cause: Cause.pretty(cause),
                });
              }),
            ),
          );
        }
      }
      yield* Ref.set(schedulerWindowSize, loaded);
    }).pipe(
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.failCause(cause);
        return Effect.logWarning("thread-work.scheduler.drain-failed", {
          cause: Cause.pretty(cause),
        });
      }),
    );

    const start: ThreadWorkSchedulerShape["start"] = () =>
      Effect.gen(function* () {
        const shouldStart = yield* Ref.modify(started, (value) => [!value, true]);
        if (!shouldStart) return;
        const recoveryAt = DateTime.formatIso(yield* DateTime.now);
        let recoveredClaims = 0;
        while (true) {
          const recovered = yield* obligations.recoverOrphanedClaims({
            updatedAt: recoveryAt,
            limit: windowSize,
          });
          recoveredClaims += recovered;
          if (recovered < windowSize) break;
        }
        if (recoveredClaims > 0) {
          yield* Metric.update(
            Metric.withAttributes(
              threadWorkRecoveredTotal,
              metricAttributes({ recovery: "orphaned-claim" }),
            ),
            recoveredClaims,
          );
        }
        yield* Effect.addFinalizer(() =>
          releaseRetainedRetryLeases.pipe(
            Effect.andThen(Ref.set(started, false)),
            Effect.catchCause((cause) =>
              Effect.logWarning("thread-work.scheduler.shutdown-cleanup-failed", {
                cause: Cause.pretty(cause),
              }),
            ),
          ),
        );

        yield* Effect.forkScoped(Effect.forever(Queue.take(wakeQueue).pipe(Effect.andThen(drain))));
        yield* Effect.forkScoped(
          wake().pipe(Effect.repeat(Schedule.spaced(Duration.millis(pollIntervalMs)))),
        );
        yield* wake();
        yield* Effect.logInfo("thread-work.scheduler.started", {
          maxGlobal,
          maxPerProvider,
          maxRecoveryPerProvider,
          windowSize,
          pollIntervalMs,
          recoveredClaims,
        });
      }).pipe(
        Effect.catch((error) =>
          Ref.set(started, false).pipe(
            Effect.andThen(
              Effect.logError("thread-work.scheduler.start-failed", {
                error,
              }),
            ),
          ),
        ),
      );

    const snapshot = Effect.all({
      admission: Ref.get(admissions),
      runtimeObservations: Ref.get(runtimeObservations),
      schedulerWindowSize: Ref.get(schedulerWindowSize),
    }).pipe(
      Effect.map(
        ({ admission, runtimeObservations: runtime, schedulerWindowSize: currentWindowSize }) => ({
          activeGlobal: admission.activeGlobal,
          activeByProvider: Object.fromEntries(admission.activeByProvider),
          activeRecoveryByProvider: Object.fromEntries(admission.activeRecoveryByProvider),
          activeThreads: Array.from(admission.activeThreads),
          schedulerWindowSize: currentWindowSize,
          runtimeByThread: Object.fromEntries(
            Array.from(runtime, ([threadId, observation]) => [
              String(threadId),
              {
                activeTurnId: observation.activeTurnId,
                phase: observation.phase,
              },
            ]),
          ),
        }),
      ),
    );

    return {
      start,
      wake,
      registerHandler: (kind, handler) =>
        Ref.update(handlers, (current) => {
          const next = new Map(current);
          next.set(kind, handler);
          return next;
        }).pipe(Effect.andThen(wake())),
      unregisterHandler: (kind) =>
        Ref.update(handlers, (current) => {
          const next = new Map(current);
          next.delete(kind);
          return next;
        }).pipe(Effect.andThen(releaseRetainedRetryLeases)),
      observeRuntime,
      runtimeLivenessAt,
      setAdmissionParked,
      snapshot,
    } satisfies ThreadWorkSchedulerShape;
  });

export const makeThreadWorkSchedulerLive = (options?: ThreadWorkSchedulerLiveOptions) =>
  Layer.effect(ThreadWorkScheduler, make(options));

export const ThreadWorkSchedulerLive = makeThreadWorkSchedulerLive();
