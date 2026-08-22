import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import { CommandId, type OrchestrationSession, type ProviderSession } from "@t3tools/contracts";

import { increment, providerSessionReaperSkippedTotal } from "../../observability/Metrics.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { RuntimeLeaseRegistry } from "../Services/RuntimeLeaseRegistry.ts";
import {
  ProviderSessionReaper,
  type ProviderSessionReaperShape,
} from "../Services/ProviderSessionReaper.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const DEFAULT_INACTIVITY_THRESHOLD_MS = 30 * 60 * 1000;
const DEFAULT_SWEEP_INTERVAL_MS = 5 * 60 * 1000;
// How often to re-check that every session the UI shows as "working" is still
// backed by a live adapter. Deliberately faster than the idle sweep: this is
// the path that clears a stuck spinner, so it should feel prompt.
const DEFAULT_RECONCILE_INTERVAL_MS = 60 * 1000;
// A session projected "running" must be at least this stale before the periodic
// reconcile is allowed to strand it. This grace protects a turn that has only
// just started: its adapter session can take a moment to register, and without
// the grace a freshly-dispatched turn could be reaped in the gap.
const DEFAULT_RECONCILE_GRACE_MS = 60 * 1000;

function orchestrationStatusFromProviderSession(
  session: ProviderSession,
): OrchestrationSession["status"] {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "running":
      return "running";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
      return "ready";
  }
}

export interface ProviderSessionReaperLiveOptions {
  readonly inactivityThresholdMs?: number;
  readonly sweepIntervalMs?: number;
  /** How often the periodic "still backed by a live adapter?" reconcile runs. */
  readonly reconcileIntervalMs?: number;
  /** Minimum age of a `running` projection before the periodic reconcile acts. */
  readonly reconcileGraceMs?: number;
}

const makeProviderSessionReaper = (options?: ProviderSessionReaperLiveOptions) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const providerService = yield* ProviderService;
    const directory = yield* ProviderSessionDirectory;
    const runtimeLeases = yield* RuntimeLeaseRegistry;
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;

    const inactivityThresholdMs = Math.max(
      1,
      options?.inactivityThresholdMs ?? DEFAULT_INACTIVITY_THRESHOLD_MS,
    );
    const sweepIntervalMs = Math.max(1, options?.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    const reconcileIntervalMs = Math.max(
      1,
      options?.reconcileIntervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS,
    );
    const reconcileGraceMs = Math.max(0, options?.reconcileGraceMs ?? DEFAULT_RECONCILE_GRACE_MS);

    const reconcilePersistedActiveTurns = Effect.fn("reconcilePersistedActiveTurns")(
      function* (reconcileOptions?: { readonly graceMs?: number }) {
        const graceMs = Math.max(0, reconcileOptions?.graceMs ?? 0);
        const nowMs = graceMs > 0 ? yield* Clock.currentTimeMillis : 0;
        const liveSessions = yield* providerService.listSessions();
        const liveSessionByThreadId = new Map(
          liveSessions.map((session) => [session.threadId, session] as const),
        );
        const bindings = yield* directory.listBindings();

        yield* Effect.forEach(
          bindings,
          (binding) =>
            Effect.gen(function* () {
              const thread = yield* projectionSnapshotQuery
                .getThreadShellById(binding.threadId)
                .pipe(Effect.map(Option.getOrUndefined));
              const projectedSession = thread?.session;
              if (
                projectedSession === null ||
                projectedSession === undefined ||
                (projectedSession.status !== "starting" && projectedSession.status !== "running")
              ) {
                return;
              }

              if (graceMs > 0) {
                // On the periodic pass, only touch sessions old enough that a
                // still-registering adapter can be ruled out. A turn that just
                // started keeps a fresh `updatedAt`; a genuinely stranded one does
                // not (nothing is advancing it), so it ages past the grace and
                // gets cleared on a later tick.
                const updatedMs = Date.parse(projectedSession.updatedAt);
                if (!Number.isNaN(updatedMs) && nowMs - updatedMs < graceMs) {
                  return;
                }
              }

              const reapReservation = yield* runtimeLeases.tryReserveReap(binding.threadId);
              if (Option.isNone(reapReservation)) {
                yield* increment(providerSessionReaperSkippedTotal, {
                  reason: "runtime-lease",
                  phase: "restart-reconcile",
                });
                yield* Effect.logDebug("provider.session.restart-reconcile.skipped-runtime-lease", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                });
                return;
              }

              yield* Effect.gen(function* () {
                const liveSession = liveSessionByThreadId.get(binding.threadId);
                const updatedAt = DateTime.formatIso(yield* DateTime.now);
                const commandUuid = yield* crypto.randomUUIDv4;
                const commandId = CommandId.make(
                  `server:provider-session-restart-reconcile:${commandUuid}`,
                );

                if (liveSession === undefined) {
                  // Provider adapter process/session registries are in-memory. If
                  // none of them can prove this persisted turn is still live after
                  // startup, keep its resume cursor but stop advertising a turn
                  // that cannot be interrupted.
                  yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("provider.session.restart-reconcile.stop-failed", {
                        threadId: binding.threadId,
                        provider: binding.provider,
                        cause,
                      }),
                    ),
                  );
                  yield* orchestrationEngine.dispatch({
                    type: "thread.session.set",
                    commandId,
                    threadId: binding.threadId,
                    session: {
                      ...projectedSession,
                      status: "stopped",
                      activeTurnId: null,
                      updatedAt,
                    },
                    createdAt: updatedAt,
                  });
                  yield* Effect.logInfo("provider.session.restart-reconciled", {
                    threadId: binding.threadId,
                    provider: binding.provider,
                    previousStatus: projectedSession.status,
                    previousActiveTurnId: projectedSession.activeTurnId,
                    status: "stopped",
                  });
                  return;
                }

                const liveStatus = orchestrationStatusFromProviderSession(liveSession);
                const liveActiveTurnId =
                  liveStatus === "running" ? (liveSession.activeTurnId ?? null) : null;
                if (
                  projectedSession.status === liveStatus &&
                  projectedSession.activeTurnId === liveActiveTurnId
                ) {
                  return;
                }

                if (projectedSession.status === "running" && liveStatus !== "running") {
                  // A surviving adapter can be ready after restart without still
                  // executing the persisted turn. Project "stopped" first so the
                  // turn is durably classified as incomplete; the following live
                  // status sync must not rewrite that turn as normally completed.
                  yield* orchestrationEngine.dispatch({
                    type: "thread.session.set",
                    commandId: CommandId.make(
                      `server:provider-session-restart-settle:${commandUuid}`,
                    ),
                    threadId: binding.threadId,
                    session: {
                      ...projectedSession,
                      status: "stopped",
                      activeTurnId: null,
                      updatedAt,
                    },
                    createdAt: updatedAt,
                  });
                }

                yield* orchestrationEngine.dispatch({
                  type: "thread.session.set",
                  commandId,
                  threadId: binding.threadId,
                  session: {
                    ...projectedSession,
                    status: liveStatus,
                    activeTurnId: liveActiveTurnId,
                    lastError: liveSession.lastError ?? projectedSession.lastError,
                    updatedAt,
                  },
                  createdAt: updatedAt,
                });
                yield* Effect.logInfo("provider.session.restart-reattached", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  status: liveStatus,
                  activeTurnId: liveActiveTurnId,
                });
              }).pipe(
                Effect.ensuring(
                  runtimeLeases.releaseReap(reapReservation.value).pipe(Effect.asVoid),
                ),
              );
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.session.restart-reconcile.failed", {
                  threadId: binding.threadId,
                  provider: binding.provider,
                  cause,
                }),
              ),
            ),
          { concurrency: 1, discard: true },
        );
      },
    );

    const sweep = Effect.gen(function* () {
      const bindings = yield* directory.listBindings();
      const now = yield* Clock.currentTimeMillis;
      let reapedCount = 0;

      for (const binding of bindings) {
        if (binding.status === "stopped") {
          continue;
        }

        const lastSeenMs = Date.parse(binding.lastSeenAt);
        if (Number.isNaN(lastSeenMs)) {
          yield* Effect.logWarning("provider.session.reaper.invalid-last-seen", {
            threadId: binding.threadId,
            provider: binding.provider,
            lastSeenAt: binding.lastSeenAt,
          });
          continue;
        }

        const idleDurationMs = now - lastSeenMs;
        if (idleDurationMs < inactivityThresholdMs) {
          continue;
        }

        const thread = yield* projectionSnapshotQuery
          .getThreadShellById(binding.threadId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (thread?.session?.activeTurnId != null) {
          yield* increment(providerSessionReaperSkippedTotal, {
            reason: "active-turn",
            phase: "idle-sweep",
          });
          yield* Effect.logDebug("provider.session.reaper.skipped-active-turn", {
            threadId: binding.threadId,
            activeTurnId: thread.session.activeTurnId,
            idleDurationMs,
          });
          continue;
        }

        if (thread?.hasPendingApprovals || thread?.hasPendingUserInput) {
          yield* increment(providerSessionReaperSkippedTotal, {
            reason: "pending-interaction",
            phase: "idle-sweep",
          });
          yield* Effect.logDebug("provider.session.reaper.skipped-pending-interaction", {
            threadId: binding.threadId,
            hasPendingApprovals: thread.hasPendingApprovals,
            hasPendingUserInput: thread.hasPendingUserInput,
            idleDurationMs,
          });
          continue;
        }

        const reapReservation = yield* runtimeLeases.tryReserveReap(binding.threadId);
        if (Option.isNone(reapReservation)) {
          yield* increment(providerSessionReaperSkippedTotal, {
            reason: "runtime-lease",
            phase: "idle-sweep",
          });
          yield* Effect.logDebug("provider.session.reaper.skipped-runtime-lease", {
            threadId: binding.threadId,
            idleDurationMs,
          });
          continue;
        }

        const reaped = yield* providerService.stopSession({ threadId: binding.threadId }).pipe(
          Effect.tap(() =>
            Effect.logInfo("provider.session.reaped", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              reason: "inactivity_threshold",
            }),
          ),
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.reaper.stop-failed", {
              threadId: binding.threadId,
              provider: binding.provider,
              idleDurationMs,
              cause,
            }).pipe(Effect.as(false)),
          ),
          Effect.ensuring(runtimeLeases.releaseReap(reapReservation.value).pipe(Effect.asVoid)),
        );

        if (reaped) {
          reapedCount += 1;
        }
      }

      if (reapedCount > 0) {
        yield* Effect.logInfo("provider.session.reaper.sweep-complete", {
          reapedCount,
          totalBindings: bindings.length,
        });
      }
    });

    const start: ProviderSessionReaperShape["start"] = () =>
      Effect.gen(function* () {
        yield* reconcilePersistedActiveTurns().pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("provider.session.restart-reconcile.sweep-failed", {
              cause,
            }),
          ),
        );

        // Keep clearing sessions that lose their live adapter mid-life (e.g.
        // after a provider failover or an adapter crash): the projection can be
        // left at "running" with an active turn, which the UI renders as a
        // "working" spinner that never resolves. The startup reconcile above
        // only catches sessions already stranded when the server booted; this
        // periodic pass catches the ones stranded while it is running.
        yield* Effect.forkScoped(
          reconcilePersistedActiveTurns({ graceMs: reconcileGraceMs })
            .pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("provider.session.reconcile.sweep-failed", {
                  cause,
                }),
              ),
              Effect.repeat(Schedule.spaced(Duration.millis(reconcileIntervalMs))),
            )
            // Delay the first periodic pass by one interval: the startup
            // reconcile above already covered t=0, and this keeps the periodic
            // pass from double-acting on the same boot.
            .pipe(Effect.delay(Duration.millis(reconcileIntervalMs))),
        );

        yield* Effect.forkScoped(
          sweep.pipe(
            Effect.catch((error: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-failed", {
                error,
              }),
            ),
            Effect.catchDefect((defect: unknown) =>
              Effect.logWarning("provider.session.reaper.sweep-defect", {
                defect,
              }),
            ),
            Effect.repeat(Schedule.spaced(Duration.millis(sweepIntervalMs))),
          ),
        );

        yield* Effect.logInfo("provider.session.reaper.started", {
          inactivityThresholdMs,
          sweepIntervalMs,
          reconcileIntervalMs,
          reconcileGraceMs,
        });
      });

    return {
      start,
    } satisfies ProviderSessionReaperShape;
  });

export const makeProviderSessionReaperLive = (options?: ProviderSessionReaperLiveOptions) =>
  Layer.effect(ProviderSessionReaper, makeProviderSessionReaper(options));

export const ProviderSessionReaperLive = makeProviderSessionReaperLive();
