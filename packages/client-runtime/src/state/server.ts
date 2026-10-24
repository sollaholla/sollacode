import {
  type EnvironmentId,
  type ServerConfig,
  type ServerConfigProviderStatusesPatchPayload,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/unstable/reactivity";

import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { safeErrorLogAttributes } from "../errors/safeLog.ts";
import { EnvironmentCacheStore } from "../platform/persistence.ts";
import { subscribe, type EnvironmentRpcInput } from "../rpc/client.ts";
import { followStreamInEnvironment } from "./runtime.ts";

export interface ServerConfigProjection {
  readonly config: ServerConfig;
  readonly latestEvent: ServerConfigStreamEvent;
  readonly source: "cache" | "live";
}

/**
 * Rebuilds the provider list from a patch: `order` decides which providers
 * exist and where, `upserted` replaces a provider whole, and `volatile` lays
 * its few fields over the provider already held. A volatile patch for a
 * provider this client does not have is dropped; the server only sends one for
 * a provider it already delivered on this same subscription.
 */
export function applyProviderStatusesPatch(
  current: ServerConfig["providers"],
  patch: ServerConfigProviderStatusesPatchPayload,
): ServerConfig["providers"] {
  const byId = new Map(current.map((provider) => [provider.instanceId, provider]));
  for (const provider of patch.upserted) byId.set(provider.instanceId, provider);
  for (const { instanceId, ...fields } of patch.volatile) {
    const base = byId.get(instanceId);
    if (base !== undefined) byId.set(instanceId, { ...base, ...fields });
  }
  return patch.order.flatMap((instanceId) => {
    const provider = byId.get(instanceId);
    return provider === undefined ? [] : [provider];
  });
}

/**
 * Returns `next` with every part deep-equal to `previous` replaced by the
 * previous object. A provider status push or a reconnect snapshot re-sends
 * whole providers and settings when often only a timestamp moved; keeping the
 * unchanged parts identical lets atoms and memoized UI skip them.
 */
export function reuseUnchanged<T>(previous: unknown, next: T): T {
  if (Object.is(previous, next)) return next;
  if (
    typeof previous !== "object" ||
    typeof next !== "object" ||
    previous === null ||
    next === null ||
    Array.isArray(previous) !== Array.isArray(next)
  ) {
    return next;
  }
  if (Array.isArray(next)) {
    const before = previous as ReadonlyArray<unknown>;
    let same = before.length === next.length;
    const merged = next.map((item, index) => {
      const reused = reuseUnchanged(before[index], item);
      if (reused !== before[index]) same = false;
      return reused;
    });
    return (same ? previous : merged) as T;
  }
  if (Object.getPrototypeOf(next) !== Object.prototype) return next;
  const before = previous as Record<string, unknown>;
  const after = next as Record<string, unknown>;
  const keys = Object.keys(after);
  let same = keys.length === Object.keys(before).length;
  const merged: Record<string, unknown> = {};
  for (const key of keys) {
    const reused = reuseUnchanged(before[key], after[key]);
    if (reused !== before[key] || !(key in before)) same = false;
    merged[key] = reused;
  }
  return (same ? previous : merged) as T;
}

export function applyServerConfigProjection(
  current: Option.Option<ServerConfigProjection>,
  event: ServerConfigStreamEvent,
): Option.Option<ServerConfigProjection> {
  switch (event.type) {
    case "snapshot":
      return Option.some({
        // Every reconnect re-sends the whole config, usually unchanged.
        config: Option.isSome(current)
          ? reuseUnchanged(current.value.config, event.config)
          : event.config,
        latestEvent: event,
        source: "live",
      });
    case "keybindingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          keybindings: reuseUnchanged(projection.config.keybindings, event.payload.keybindings),
          issues: reuseUnchanged(projection.config.issues, event.payload.issues),
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatuses":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: reuseUnchanged(projection.config.providers, event.payload.providers),
        },
        latestEvent: event,
        source: "live",
      }));
    case "providerStatusesPatch":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          providers: reuseUnchanged(
            projection.config.providers,
            applyProviderStatusesPatch(projection.config.providers, event.payload),
          ),
        },
        latestEvent: event,
        source: "live",
      }));
    case "settingsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          settings: reuseUnchanged(projection.config.settings, event.payload.settings),
        },
        latestEvent: event,
        source: "live",
      }));
    case "editorsUpdated":
      return Option.map(current, (projection) => ({
        config: {
          ...projection.config,
          availableEditors: reuseUnchanged(
            projection.config.availableEditors,
            event.payload.availableEditors,
          ),
        },
        latestEvent: event,
        source: "live",
      }));
  }
}

const cachedConfigSnapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

/**
 * Keeps a complete server configuration available during reconnects. Server
 * config carries the provider/model catalogue used by task creation, so it is
 * useful—and safe—to retain after a transport session ends.
 */
export const makeEnvironmentServerConfigState = Effect.fn("EnvironmentServerConfigState.make")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor;
    const cache = yield* EnvironmentCacheStore;
    const environmentId = supervisor.target.environmentId;
    const cachedConfig = yield* cache.loadServerConfig(environmentId).pipe(
      Effect.catch((error) =>
        Effect.logWarning("Could not load cached server configuration.").pipe(
          Effect.annotateLogs({
            environmentId,
            ...safeErrorLogAttributes(error),
          }),
          Effect.as(Option.none<ServerConfig>()),
        ),
      ),
    );
    const state = yield* SubscriptionRef.make<Option.Option<ServerConfigProjection>>(
      Option.map(cachedConfig, (config) => ({
        config,
        latestEvent: cachedConfigSnapshotEvent(config),
        source: "cache" as const,
      })),
    );
    const persistence = yield* Queue.sliding<ServerConfig>(1);
    const pendingPersistence = yield* Ref.make<Option.Option<ServerConfig>>(Option.none());

    const persist = Effect.fn("EnvironmentServerConfigState.persist")(function* (
      config: ServerConfig,
    ) {
      return yield* cache.saveServerConfig(environmentId, config).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          Effect.logWarning("Could not persist cached server configuration.").pipe(
            Effect.annotateLogs({
              environmentId,
              ...safeErrorLogAttributes(error),
            }),
            Effect.as(false),
          ),
        ),
      );
    });

    const persistPending = Effect.fn("EnvironmentServerConfigState.persistPending")(function* (
      config: ServerConfig,
    ) {
      if (!(yield* persist(config))) {
        return;
      }
      yield* Ref.update(pendingPersistence, (pending) =>
        Option.isSome(pending) && pending.value === config ? Option.none() : pending,
      );
    });

    yield* Stream.fromQueue(persistence).pipe(
      Stream.debounce("500 millis"),
      Stream.runForEach(persistPending),
      Effect.forkScoped,
    );

    yield* subscribe(WS_METHODS.subscribeServerConfig, { acceptsProviderPatches: true }).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const next = applyServerConfigProjection(yield* SubscriptionRef.get(state), event);
          if (Option.isNone(next)) {
            return;
          }
          yield* Ref.set(pendingPersistence, Option.some(next.value.config));
          yield* SubscriptionRef.set(state, next);
          yield* Queue.offer(persistence, next.value.config);
        }),
      ),
      Effect.forkScoped,
    );

    yield* Effect.addFinalizer(() =>
      Ref.get(pendingPersistence).pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (config) => persist(config).pipe(Effect.asVoid),
          }),
        ),
      ),
    );

    return state;
  },
);

export function serverConfigStateChanges(environmentId: EnvironmentId) {
  return followStreamInEnvironment(
    environmentId,
    Stream.unwrap(
      makeEnvironmentServerConfigState().pipe(
        Effect.map((state) =>
          SubscriptionRef.changes(state).pipe(
            Stream.filterMap((projection) =>
              Option.match(projection, {
                onNone: () => Result.failVoid,
                onSome: (value) => Result.succeed(value),
              }),
            ),
          ),
        ),
      ),
    ),
  );
}

export function projectServerWelcome(
  current: Option.Option<ServerLifecycleWelcomePayload>,
  event: {
    readonly type: "welcome" | "ready";
    readonly payload: unknown;
  },
): readonly [
  Option.Option<ServerLifecycleWelcomePayload>,
  ReadonlyArray<ServerLifecycleWelcomePayload>,
] {
  if (event.type !== "welcome") {
    return [current, []];
  }
  const welcome = event.payload as ServerLifecycleWelcomePayload;
  return [Option.some(welcome), [welcome]];
}

export function resolveServerConfigValue(
  projection: ServerConfigProjection | null,
  initialConfig: ServerConfig | null,
): ServerConfig | null {
  if (projection?.source === "live") return projection.config;
  return initialConfig ?? projection?.config ?? null;
}

export function createServerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | EnvironmentCacheStore | R, E>,
  options: {
    readonly initialConfigValueAtom: (
      environmentId: EnvironmentId,
    ) => Atom.Atom<ServerConfig | null>;
  },
) {
  const configScheduler = createAtomCommandScheduler();
  const configConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId }: { readonly environmentId: string }) => environmentId,
  };
  const configProjectionFamily = Atom.family((environmentId: EnvironmentId) =>
    runtime
      .atom(serverConfigStateChanges(environmentId))
      .pipe(
        Atom.setIdleTTL(5 * 60_000),
        Atom.withLabel(`environment-data:server:config-projection:${environmentId}`),
      ),
  );
  const configProjection = (target: {
    readonly environmentId: EnvironmentId;
    readonly input: EnvironmentRpcInput<typeof WS_METHODS.subscribeServerConfig>;
  }) => configProjectionFamily(target.environmentId);
  const emptyConfigAtom = Atom.make<ServerConfig | null>(null).pipe(
    Atom.withLabel("environment-data:server:config:empty"),
  );
  const configValueAtom = Atom.family((environmentId: EnvironmentId | null) => {
    if (environmentId === null) {
      return emptyConfigAtom;
    }
    return Atom.make((get): ServerConfig | null => {
      const projection = Option.getOrNull(
        AsyncResult.value(get(configProjection({ environmentId, input: {} }))),
      );
      return resolveServerConfigValue(
        projection,
        get(options.initialConfigValueAtom(environmentId)),
      );
    }).pipe(Atom.withLabel(`environment-data:server:config:${environmentId}`));
  });
  const settingsValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.settings ?? null).pipe(
      Atom.withLabel(`environment-data:server:settings:${environmentId}`),
    ),
  );
  const providersValueAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) => get(configValueAtom(environmentId))?.providers ?? null).pipe(
      Atom.withLabel(`environment-data:server:providers:${environmentId}`),
    ),
  );

  return {
    configValueAtom,
    settingsValueAtom,
    providersValueAtom,
    traceDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:trace-diagnostics",
      tag: WS_METHODS.serverGetTraceDiagnostics,
    }),
    processDiagnostics: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-diagnostics",
      tag: WS_METHODS.serverGetProcessDiagnostics,
    }),
    processResourceHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:process-resource-history",
      tag: WS_METHODS.serverGetProcessResourceHistory,
    }),
    resourceTelemetry: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry",
      tag: WS_METHODS.subscribeResourceTelemetry,
      idleTtlMs: 0,
    }),
    // Battery and disk of the machine an environment runs on. Idle TTL 0 stops
    // the server sampling the moment the last glance-able header unmounts.
    hostVitals: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:host-vitals",
      tag: WS_METHODS.subscribeHostVitals,
      idleTtlMs: 0,
    }),
    resourceTelemetryHistory: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:server:resource-telemetry-history",
      tag: WS_METHODS.serverGetResourceTelemetryHistory,
      staleTimeMs: 5_000,
    }),
    configProjection,
    welcome: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:server:welcome",
      tag: WS_METHODS.subscribeServerLifecycle,
      transform: (stream) =>
        stream.pipe(
          Stream.mapAccum(Option.none<ServerLifecycleWelcomePayload>, projectServerWelcome),
        ),
    }),
    refreshProviders: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:refresh-providers",
      tag: WS_METHODS.serverRefreshProviders,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    consumeProviderUsageReset: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:consume-provider-usage-reset",
      tag: WS_METHODS.serverConsumeProviderUsageReset,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
      },
    }),
    resumeUsageGuard: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:resume-usage-guard",
      tag: WS_METHODS.serverResumeUsageGuard,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.threadId}`,
      },
    }),
    startProviderAccountSwitch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:start-provider-account-switch",
      tag: WS_METHODS.serverStartProviderAccountSwitch,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}`,
      },
    }),
    getProviderAccountSwitch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:get-provider-account-switch",
      tag: WS_METHODS.serverGetProviderAccountSwitch,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          `${environmentId}:${input.instanceId}:${input.switchId ?? "active"}`,
      },
    }),
    openProviderAccountSwitchAuthLink: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:open-provider-account-switch-auth-link",
      tag: WS_METHODS.serverOpenProviderAccountSwitchAuthLink,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}:${input.switchId}`,
      },
    }),
    submitProviderAccountSwitchCode: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:submit-provider-account-switch-code",
      tag: WS_METHODS.serverSubmitProviderAccountSwitchCode,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}:${input.switchId}`,
      },
    }),
    cancelProviderAccountSwitch: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:cancel-provider-account-switch",
      tag: WS_METHODS.serverCancelProviderAccountSwitch,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.instanceId}:${input.switchId}`,
      },
    }),
    updateProvider: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-provider",
      tag: WS_METHODS.serverUpdateProvider,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateServer: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-server",
      tag: WS_METHODS.serverUpdateServer,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    upsertKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:upsert-keybinding",
      tag: WS_METHODS.serverUpsertKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    removeKeybinding: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:remove-keybinding",
      tag: WS_METHODS.serverRemoveKeybinding,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    updateSettings: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:update-settings",
      tag: WS_METHODS.serverUpdateSettings,
      scheduler: configScheduler,
      concurrency: configConcurrency,
    }),
    correctVoiceTranscript: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:voice-transcript-correct",
      tag: WS_METHODS.voiceTranscriptCorrect,
      concurrency: {
        mode: "latest",
        key: ({ environmentId }) => environmentId,
      },
    }),
    signalProcess: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:signal-process",
      tag: WS_METHODS.serverSignalProcess,
    }),
    retryResourceTelemetry: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:retry-resource-telemetry",
      tag: WS_METHODS.serverRetryResourceTelemetry,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    webPushStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:web-push-status",
      tag: WS_METHODS.webPushStatus,
    }),
    webPushSubscribe: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:web-push-subscribe",
      tag: WS_METHODS.webPushSubscribe,
    }),
    webPushUnsubscribe: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:web-push-unsubscribe",
      tag: WS_METHODS.webPushUnsubscribe,
    }),
    webPushTest: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:web-push-test",
      tag: WS_METHODS.webPushTest,
    }),
    startStorageCleanup: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:start-storage-cleanup",
      tag: WS_METHODS.serverStartStorageCleanup,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
    startHostRepair: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:server:start-host-repair",
      tag: WS_METHODS.serverStartHostRepair,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId }) => environmentId,
      },
    }),
  };
}
