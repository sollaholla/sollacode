import {
  DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL,
  type ServerProvider,
  ServerSettingsError,
} from "@t3tools/contracts";
import { resolveServerBackgroundActivitySettings } from "@t3tools/shared/backgroundActivitySettings";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import type { ServerProviderShape } from "./Services/ServerProvider.ts";

interface ProviderSnapshotState {
  readonly snapshot: ServerProvider;
  readonly enrichmentGeneration: number;
  readonly transientFailureSince: number | null;
  /** When the usage reading first drifted past the freshness budget; null while fresh. */
  readonly usageDriftSince: number | null;
}

export const PROVIDER_TRANSIENT_FAILURE_GRACE_MS = 2 * 60_000;
const PROVIDER_TRANSIENT_FAILURE_RETRY = Duration.seconds(30);

/**
 * How old a usage reading may get before the refresh loop stops waiting out
 * its full interval and starts retrying.
 *
 * Half the client's own 20-minute staleness window
 * (`PROVIDER_USAGE_STALE_AFTER_MS`), deliberately: by the time a reading is
 * this old, the card is halfway to saying "Stale", and that is the moment to
 * try harder rather than to sleep another five minutes.
 */
export const PROVIDER_USAGE_FRESHNESS_BUDGET_MS = 10 * 60_000;

/**
 * Retry cadence while a usage reading is drifting toward stale.
 *
 * The reported bug: usage is refreshed only as a side effect of the health
 * probe, on a five-minute interval, and a refresh that fails to produce a
 * reading carries the previous one forward *with its original timestamp*. So
 * four consecutive misses - one slow network answer every five minutes - is
 * all it takes to reach the client's 20-minute window and show "Stale", and
 * nothing tries any harder than every five minutes to get out of it.
 *
 * Retrying once a minute while a reading is drifting turns that into roughly
 * ten attempts across the same span. Reaching "Stale" now requires a
 * sustained outage rather than one unlucky round trip.
 */
const PROVIDER_USAGE_DRIFT_RETRY = Duration.seconds(60);
/** Re-check cadence while a deferred refresh is owed. */
const DEFERRED_REFRESH_RECHECK = Duration.seconds(30);

/**
 * How long a drifting reading is chased at the fast cadence before the loop
 * goes back to its configured interval.
 *
 * The chase exists to survive one unlucky round trip, not a dead endpoint: a
 * provider whose usage call fails every time would otherwise be probed every
 * minute for as long as the app runs. An hour is ten times the freshness
 * budget -- if nothing has answered in that long the outage is sustained, and
 * the ordinary interval finds the recovery just as well.
 */
export const PROVIDER_USAGE_DRIFT_CHASE_MAX_MS = 60 * 60_000;

/**
 * Whether this provider's usage reading is old enough to chase.
 *
 * Only for providers that actually report usage to begin with: a provider
 * whose status is `unsupported` has no reading to go stale, and treating its
 * permanent absence as drift would put it in a sixty-second retry loop
 * forever for no benefit.
 */
export function providerUsageIsDrifting(provider: ServerProvider, nowMs: number): boolean {
  if (!provider.enabled) return false;
  if (provider.auth.status !== "authenticated") return false;
  const usageState = provider.accountUsageStatus?.state;
  if (usageState === "unsupported") return false;
  // No status and no reading at all: nothing here claims usage exists, so
  // this is a provider that does not report it rather than one that is late.
  if (usageState === undefined && provider.accountUsage === undefined) return false;

  const reportedAt = provider.accountUsageReportedAt;
  if (reportedAt === undefined) return true;
  const reportedMs = Date.parse(reportedAt);
  // An unparseable timestamp is not evidence of freshness.
  if (!Number.isFinite(reportedMs)) return true;
  return nowMs - reportedMs > PROVIDER_USAGE_FRESHNESS_BUDGET_MS;
}

/**
 * How long the refresh loop sleeps before its next probe.
 *
 * Pure so the cadence is testable: the loop only supplies the clock and the
 * state. Precedence, fastest first -- a transient failure, a usage reading
 * drifting toward stale (for at most PROVIDER_USAGE_DRIFT_CHASE_MAX_MS from
 * when it began drifting), a deferred refresh owed, then the configured
 * interval. A faster cadence never applies when it would be slower than the
 * configured one.
 */
export function resolveProviderRefreshDelay(input: {
  readonly configuredMs: number;
  readonly transientFailure: boolean;
  readonly usageDriftSince: number | null;
  readonly refreshOwed: boolean;
  readonly nowMs: number;
}): Duration.Duration {
  if (input.configuredMs <= 0) return Duration.seconds(60);
  if (
    input.transientFailure &&
    Duration.toMillis(PROVIDER_TRANSIENT_FAILURE_RETRY) < input.configuredMs
  ) {
    return PROVIDER_TRANSIENT_FAILURE_RETRY;
  }
  const chasingDrift =
    input.usageDriftSince !== null &&
    input.nowMs - input.usageDriftSince < PROVIDER_USAGE_DRIFT_CHASE_MAX_MS;
  if (chasingDrift && Duration.toMillis(PROVIDER_USAGE_DRIFT_RETRY) < input.configuredMs) {
    return PROVIDER_USAGE_DRIFT_RETRY;
  }
  if (input.refreshOwed && Duration.toMillis(DEFERRED_REFRESH_RECHECK) < input.configuredMs) {
    return DEFERRED_REFRESH_RECHECK;
  }
  return Duration.millis(input.configuredMs);
}

export function stabilizeProviderSnapshot(input: {
  readonly previous: ServerProvider;
  readonly next: ServerProvider;
  readonly transientFailureSince: number | null;
}): { readonly snapshot: ServerProvider; readonly transientFailureSince: number | null } {
  const { previous, next } = input;
  const isTransientFailure =
    previous.instanceId === next.instanceId &&
    previous.enabled &&
    previous.installed &&
    previous.auth.status === "authenticated" &&
    next.enabled &&
    next.installed &&
    next.auth.status === "unknown" &&
    (next.status === "warning" || next.status === "error") &&
    next.availability !== "unavailable";
  if (!isTransientFailure) {
    return { snapshot: next, transientFailureSince: null };
  }

  const checkedAt = Date.parse(next.checkedAt);
  const failureSince = input.transientFailureSince ?? checkedAt;
  if (
    !Number.isFinite(checkedAt) ||
    !Number.isFinite(failureSince) ||
    checkedAt - failureSince >= PROVIDER_TRANSIENT_FAILURE_GRACE_MS
  ) {
    return { snapshot: next, transientFailureSince: null };
  }

  const providerName = next.displayName?.trim() || next.driver;
  return {
    transientFailureSince: failureSince,
    snapshot: {
      ...next,
      status: "warning",
      auth: previous.auth,
      version: next.version ?? previous.version,
      message: `Reconnecting to ${providerName}. Showing the last confirmed account status while Solla Code retries.`,
      ...(previous.accountUsage !== undefined
        ? {
            accountUsage: previous.accountUsage,
            ...(previous.accountUsageReportedAt
              ? { accountUsageReportedAt: previous.accountUsageReportedAt }
              : {}),
          }
        : {}),
      models: next.models.length > 0 ? next.models : previous.models,
      slashCommands: next.slashCommands.length > 0 ? next.slashCommands : previous.slashCommands,
      skills: next.skills.length > 0 ? next.skills : previous.skills,
    },
  };
}

export const makeManagedServerProvider = Effect.fn("makeManagedServerProvider")(function* <
  Settings,
>(input: {
  readonly maintenanceCapabilities: ServerProviderShape["maintenanceCapabilities"];
  readonly getSettings: Effect.Effect<Settings, ServerSettingsError>;
  readonly streamSettings: Stream.Stream<Settings>;
  readonly haveSettingsChanged: (previous: Settings, next: Settings) => boolean;
  readonly initialSnapshot: (settings: Settings) => Effect.Effect<ServerProvider>;
  readonly checkProvider: Effect.Effect<ServerProvider, ServerSettingsError>;
  readonly enrichSnapshot?: (input: {
    readonly settings: Settings;
    readonly snapshot: ServerProvider;
    readonly getSnapshot: Effect.Effect<ServerProvider>;
    readonly publishSnapshot: (snapshot: ServerProvider) => Effect.Effect<void>;
  }) => Effect.Effect<void>;
  readonly refreshInterval?: Duration.Input;
  /** Skip the immediate second probe when initialSnapshot already fetched live status. */
  readonly refreshOnCreate?: boolean;
}): Effect.fn.Return<
  ServerProviderShape,
  ServerSettingsError,
  Scope.Scope | BackgroundPolicy.BackgroundPolicy | ServerSettingsService
> {
  const backgroundPolicy = yield* BackgroundPolicy.BackgroundPolicy;
  const serverSettings = yield* ServerSettingsService;
  const refreshSemaphore = yield* Semaphore.make(1);
  const changesPubSub = yield* Effect.acquireRelease(
    PubSub.unbounded<ServerProvider>(),
    PubSub.shutdown,
  );
  const initialSettings = yield* input.getSettings;
  const initialSnapshot = yield* input.initialSnapshot(initialSettings);
  const snapshotStateRef = yield* Ref.make<ProviderSnapshotState>({
    snapshot: initialSnapshot,
    enrichmentGeneration: 0,
    transientFailureSince: null,
    usageDriftSince: null,
  });
  const settingsRef = yield* Ref.make(initialSettings);
  const enrichmentFiberRef = yield* Ref.make<Fiber.Fiber<void, unknown> | null>(null);
  const scope = yield* Effect.scope;

  const publishEnrichedSnapshot = Effect.fn("publishEnrichedSnapshot")(function* (
    generation: number,
    nextSnapshot: ServerProvider,
  ) {
    const snapshotToPublish = yield* Ref.modify(snapshotStateRef, (state) => {
      if (state.enrichmentGeneration !== generation || Equal.equals(state.snapshot, nextSnapshot)) {
        return [null, state] as const;
      }
      return [
        nextSnapshot,
        {
          ...state,
          snapshot: nextSnapshot,
        },
      ] as const;
    });
    if (snapshotToPublish === null) {
      return;
    }
    yield* PubSub.publish(changesPubSub, snapshotToPublish);
  });

  const restartSnapshotEnrichment = Effect.fn("restartSnapshotEnrichment")(function* (
    settings: Settings,
    snapshot: ServerProvider,
    generation: number,
  ) {
    const previousFiber = yield* Ref.getAndSet(enrichmentFiberRef, null);
    if (previousFiber) {
      yield* Fiber.interrupt(previousFiber).pipe(Effect.ignore);
    }

    if (!input.enrichSnapshot) {
      return;
    }

    const fiber = yield* input
      .enrichSnapshot({
        settings,
        snapshot,
        getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
        publishSnapshot: (nextSnapshot) => publishEnrichedSnapshot(generation, nextSnapshot),
      })
      .pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(scope));

    yield* Ref.set(enrichmentFiberRef, fiber);
  });

  const applySnapshotBase = Effect.fn("applySnapshot")(function* (
    nextSettings: Settings,
    options?: { readonly forceRefresh?: boolean },
  ) {
    const forceRefresh = options?.forceRefresh === true;
    const previousSettings = yield* Ref.get(settingsRef);
    if (!forceRefresh && !input.haveSettingsChanged(previousSettings, nextSettings)) {
      yield* Ref.set(settingsRef, nextSettings);
      return yield* Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot));
    }

    const checkedSnapshot = yield* input.checkProvider;
    const checkedAtMs = yield* Clock.currentTimeMillis;
    const applied = yield* Ref.modify(snapshotStateRef, (state) => {
      const stabilized = stabilizeProviderSnapshot({
        previous: state.snapshot,
        next: checkedSnapshot,
        transientFailureSince: state.transientFailureSince,
      });
      const generation = input.enrichSnapshot
        ? state.enrichmentGeneration + 1
        : state.enrichmentGeneration;
      return [
        { generation, snapshot: stabilized.snapshot },
        {
          snapshot: stabilized.snapshot,
          enrichmentGeneration: generation,
          transientFailureSince: stabilized.transientFailureSince,
          // A fresh reading ends the chase; a still-drifting one keeps its
          // original start so the chase is bounded from when it began.
          usageDriftSince: providerUsageIsDrifting(stabilized.snapshot, checkedAtMs)
            ? (state.usageDriftSince ?? checkedAtMs)
            : null,
        },
      ] as const;
    });
    yield* Ref.set(settingsRef, nextSettings);
    yield* PubSub.publish(changesPubSub, applied.snapshot);
    yield* restartSnapshotEnrichment(nextSettings, applied.snapshot, applied.generation);
    return applied.snapshot;
  });
  const applySnapshot = (nextSettings: Settings, options?: { readonly forceRefresh?: boolean }) =>
    refreshSemaphore.withPermits(1)(applySnapshotBase(nextSettings, options));

  const refreshSnapshot = Effect.fn("refreshSnapshot")(function* () {
    const nextSettings = yield* input.getSettings;
    return yield* applySnapshot(nextSettings, { forceRefresh: true });
  });

  const hasProviderStatusDemand = Effect.gen(function* () {
    const state = yield* Ref.get(snapshotStateRef);
    const instanceId = state.snapshot.instanceId;
    const [genericDemand, instanceDemand] = yield* Effect.all([
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status" }),
      backgroundPolicy.shouldRunScopeWork({ type: "provider-status", instanceId }),
    ]);
    return genericDemand || instanceDemand;
  });

  const getRefreshInterval =
    input.refreshInterval !== undefined
      ? Effect.succeed(input.refreshInterval)
      : serverSettings.getSettings.pipe(
          Effect.map(
            (settings) =>
              resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
          ),
          Effect.orElseSucceed(() => DEFAULT_PROVIDER_HEALTH_REFRESH_INTERVAL),
        );

  const refreshIntervalChanges = yield* Queue.sliding<void>(1);
  if (input.refreshInterval === undefined) {
    const serverSettingsChanges = yield* serverSettings.subscribeChanges;
    yield* serverSettingsChanges.pipe(
      Stream.map((settings) =>
        Duration.toMillis(
          resolveServerBackgroundActivitySettings(settings).providerHealthRefreshInterval,
        ),
      ),
      Stream.changes,
      Stream.runForEach(() => Queue.offer(refreshIntervalChanges, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    );
  }

  yield* Stream.runForEach(input.streamSettings, (nextSettings) =>
    Effect.asVoid(applySnapshot(nextSettings)),
  ).pipe(Effect.forkScoped);

  /**
   * How soon to re-check after a tick was skipped for lack of demand.
   *
   * A skipped tick used to cost a whole refresh interval: the loop asked
   * "is anyone watching?" exactly once every five minutes and, on a `no`, slept
   * another five. Watching an agent work without touching the mouse is enough
   * to miss it — the demand lease needs a *foreground* client — so the provider
   * snapshot, and with it the Claude usage bar, could sit frozen indefinitely
   * while the app was open and plainly in use.
   *
   * Re-checking on a short cadence keeps the idle-work saving (nothing runs
   * while there is genuinely no demand) but collapses the cost of a miss from
   * one full interval to this.
   */
  const refreshOwedRef = yield* Ref.make(false);

  yield* Effect.forever(
    getRefreshInterval.pipe(
      Effect.flatMap((refreshInterval) =>
        Effect.gen(function* () {
          const configuredMs = Duration.toMillis(Duration.fromInputUnsafe(refreshInterval));
          const refreshOwed = yield* Ref.get(refreshOwedRef);
          const state = yield* Ref.get(snapshotStateRef);
          const transientFailure = state.transientFailureSince !== null;
          const nowMs = yield* Clock.currentTimeMillis;
          // A usage reading drifting toward the client's staleness window is
          // chased rather than waited out -- for a bounded while. See
          // PROVIDER_USAGE_DRIFT_RETRY and PROVIDER_USAGE_DRIFT_CHASE_MAX_MS.
          const driftSince = providerUsageIsDrifting(state.snapshot, nowMs)
            ? (state.usageDriftSince ?? nowMs)
            : null;
          if (driftSince !== state.usageDriftSince) {
            yield* Ref.update(snapshotStateRef, (current) => ({
              ...current,
              usageDriftSince: driftSince,
            }));
          }
          const sleepFor = resolveProviderRefreshDelay({
            configuredMs,
            transientFailure,
            usageDriftSince: driftSince,
            refreshOwed,
            nowMs,
          });
          const intervalElapsed = yield* Effect.raceFirst(
            Effect.sleep(sleepFor).pipe(Effect.as(true)),
            Queue.take(refreshIntervalChanges).pipe(Effect.as(false)),
          );
          if (!intervalElapsed || configuredMs <= 0) return;
          const shouldRefresh = yield* hasProviderStatusDemand;
          if (!shouldRefresh) {
            // Remember the miss so the next check comes quickly rather than a
            // full interval later.
            yield* Ref.set(refreshOwedRef, true);
            return;
          }
          yield* Ref.set(refreshOwedRef, false);
          yield* refreshSnapshot().pipe(Effect.asVoid);
        }),
      ),
      Effect.ignoreCause({ log: true }),
    ),
  ).pipe(Effect.forkScoped);

  if (input.refreshOnCreate !== false) {
    yield* applySnapshot(initialSettings, { forceRefresh: true }).pipe(
      Effect.ignoreCause({ log: true }),
      Effect.forkScoped,
    );
  }

  return {
    maintenanceCapabilities: input.maintenanceCapabilities,
    getSnapshot: Ref.get(snapshotStateRef).pipe(Effect.map((state) => state.snapshot)),
    refresh: refreshSnapshot().pipe(Effect.tapError(Effect.logError), Effect.orDie),
    get streamChanges() {
      return Stream.fromPubSub(changesPubSub);
    },
  } satisfies ServerProviderShape;
});
