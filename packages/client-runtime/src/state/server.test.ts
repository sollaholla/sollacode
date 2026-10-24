import {
  EnvironmentId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerLifecycleWelcomePayload,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import {
  applyServerConfigProjection,
  makeEnvironmentServerConfigState,
  projectServerWelcome,
  resolveServerConfigValue,
} from "./server.ts";

const CONFIG = {
  availableEditors: [],
  issues: [],
  keybindings: {},
  keybindingsConfigPath: null,
  observability: null,
  providers: [],
  settings: {},
} as unknown as ServerConfig;

const snapshotEvent = (config: ServerConfig): ServerConfigStreamEvent => ({
  version: 1,
  type: "snapshot",
  config,
});

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

function session(client: WsRpcProtocolClient): RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(CONFIG),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
}

describe("server state projection", () => {
  it("applies every config category to the projected snapshot", () => {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    const settings = {
      ...CONFIG.settings,
      enableAssistantStreaming: false,
    } as typeof CONFIG.settings;
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });

    const result = Option.getOrThrow(projected);
    expect(result.config.settings).toEqual(settings);
    expect(result.latestEvent.type).toBe("settingsUpdated");
  });

  it("keeps unchanged parts identical across pushes and reconnects", () => {
    const provider = (id: string, checkedAt: string) =>
      ({
        instanceId: id,
        driver: "codex",
        status: "ready",
        checkedAt,
        models: [{ slug: `${id}-model` }],
      }) as unknown as ServerConfig["providers"][number];
    const first = applyServerConfigProjection(
      Option.none(),
      snapshotEvent({ ...CONFIG, providers: [provider("codex", "t0"), provider("grok", "t0")] }),
    );
    const before = Option.getOrThrow(first).config;

    // A push that changes nothing keeps the whole list identical.
    const same = Option.getOrThrow(
      applyServerConfigProjection(first, {
        version: 1,
        type: "providerStatuses",
        payload: { providers: [provider("codex", "t0"), provider("grok", "t0")] },
      } as ServerConfigStreamEvent),
    ).config;
    expect(same.providers).toBe(before.providers);

    // One provider moving keeps the other, and its own unchanged models.
    const moved = Option.getOrThrow(
      applyServerConfigProjection(first, {
        version: 1,
        type: "providerStatuses",
        payload: { providers: [provider("codex", "t1"), provider("grok", "t0")] },
      } as ServerConfigStreamEvent),
    ).config;
    expect(moved.providers).not.toBe(before.providers);
    expect(moved.providers[0]?.checkedAt).toBe("t1");
    expect(moved.providers[0]?.models).toBe(before.providers[0]?.models);
    expect(moved.providers[1]).toBe(before.providers[1]);

    // A reconnect snapshot with the same config changes nothing it carries.
    const reconnected = Option.getOrThrow(
      applyServerConfigProjection(
        first,
        snapshotEvent({ ...CONFIG, providers: [provider("codex", "t0"), provider("grok", "t0")] }),
      ),
    ).config;
    expect(reconnected).toBe(before);
  });

  describe("provider status patches", () => {
    const provider = (id: string, extra: Record<string, unknown> = {}) =>
      ({
        instanceId: id,
        driver: "codex",
        status: "ready",
        checkedAt: "t0",
        slashCommands: [{ name: "big-catalogue" }],
        ...extra,
      }) as unknown as ServerConfig["providers"][number];
    const withProviders = (providers: ServerConfig["providers"]) =>
      Option.some({
        config: { ...CONFIG, providers },
        latestEvent: snapshotEvent(CONFIG),
        source: "live" as const,
      });
    const patchEvent = (payload: unknown): ServerConfigStreamEvent =>
      ({
        version: 1,
        type: "providerStatusesPatch",
        payload,
      }) as unknown as ServerConfigStreamEvent;

    it("lays volatile fields over the provider already held, leaving its catalogue alone", () => {
      const held = provider("codex", { usageGuard: { state: "ok" } });
      const next = applyServerConfigProjection(
        withProviders([held]),
        patchEvent({
          order: ["codex"],
          upserted: [],
          volatile: [{ instanceId: "codex", checkedAt: "t1", accountUsage: { used: 2 } }],
        }),
      );
      const [after] = Option.getOrThrow(next).config.providers as unknown as Array<
        Record<string, unknown>
      >;
      expect(after).toMatchObject({
        checkedAt: "t1",
        accountUsage: { used: 2 },
        usageGuard: { state: "ok" },
        slashCommands: [{ name: "big-catalogue" }],
      });
    });

    it("replaces an upserted provider whole and follows the display order", () => {
      const next = applyServerConfigProjection(
        withProviders([provider("codex"), provider("grok")]),
        patchEvent({
          order: ["grok", "opencode", "codex"],
          upserted: [provider("opencode"), provider("grok", { status: "error" })],
          volatile: [],
        }),
      );
      const providers = Option.getOrThrow(next).config.providers;
      expect(providers.map((entry) => entry.instanceId)).toEqual(["grok", "opencode", "codex"]);
      expect(providers[0]?.status).toBe("error");
    });

    it("drops a provider that is missing from the order", () => {
      const next = applyServerConfigProjection(
        withProviders([provider("codex"), provider("grok")]),
        patchEvent({ order: ["codex"], upserted: [], volatile: [] }),
      );
      expect(Option.getOrThrow(next).config.providers.map((entry) => entry.instanceId)).toEqual([
        "codex",
      ]);
    });

    it("ignores a volatile patch for a provider it never received", () => {
      const next = applyServerConfigProjection(
        withProviders([provider("codex")]),
        patchEvent({
          order: ["codex", "ghost"],
          upserted: [],
          volatile: [{ instanceId: "ghost", checkedAt: "t9" }],
        }),
      );
      expect(Option.getOrThrow(next).config.providers.map((entry) => entry.instanceId)).toEqual([
        "codex",
      ]);
    });
  });

  it("applies asynchronously discovered editors", () => {
    const snapshot = applyServerConfigProjection(Option.none(), {
      version: 1,
      type: "snapshot",
      config: CONFIG,
    });
    const projected = applyServerConfigProjection(snapshot, {
      version: 1,
      type: "editorsUpdated",
      payload: { availableEditors: ["vscode"] },
    });

    const result = Option.getOrThrow(projected);
    expect(result.config.availableEditors).toEqual(["vscode"]);
    expect(result.latestEvent.type).toBe("editorsUpdated");
  });

  it("retains welcome when a ready event follows in the same stream chunk", () => {
    const welcome = {
      environment: {} as ServerLifecycleWelcomePayload["environment"],
      cwd: "/repo",
      projectName: "repo",
    } as ServerLifecycleWelcomePayload;
    const [afterWelcome] = projectServerWelcome(Option.none(), {
      type: "welcome",
      payload: welcome,
    });
    const [afterReady, emitted] = projectServerWelcome(afterWelcome, {
      type: "ready",
      payload: {},
    });

    expect(Option.getOrThrow(afterReady)).toBe(welcome);
    expect(emitted).toEqual([]);
  });

  it("prefers an active session config over cache until a live event arrives", () => {
    const cached = { ...CONFIG, settings: { source: "cache" } } as unknown as ServerConfig;
    const initial = { ...CONFIG, settings: { source: "session" } } as unknown as ServerConfig;
    const live = { ...CONFIG, settings: { source: "live" } } as unknown as ServerConfig;

    expect(
      resolveServerConfigValue(
        {
          config: cached,
          latestEvent: snapshotEvent(cached),
          source: "cache",
        },
        initial,
      ),
    ).toBe(initial);
    expect(
      resolveServerConfigValue(
        {
          config: live,
          latestEvent: snapshotEvent(live),
          source: "live",
        },
        initial,
      ),
    ).toBe(live);
  });

  it.effect("starts from cached configuration and persists the live projection", () =>
    Effect.gen(function* () {
      const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.fromQueue(events),
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        Effect.gen(function* () {
          const state = yield* makeEnvironmentServerConfigState().pipe(
            Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
            Effect.provideService(Persistence.EnvironmentCacheStore, cache),
          );
          expect(Option.getOrThrow(yield* SubscriptionRef.get(state)).config).toBe(CONFIG);

          const providers: ServerConfig["providers"] = [];
          yield* Queue.offer(events, {
            version: 1,
            type: "providerStatuses",
            payload: { providers },
          });
          const projected = yield* SubscriptionRef.changes(state).pipe(
            Stream.filter((value) =>
              Option.match(value, {
                onNone: () => false,
                onSome: (projection) => projection.latestEvent.type === "providerStatuses",
              }),
            ),
            Stream.runHead,
          );
          expect(Option.getOrThrow(Option.getOrThrow(projected)).config.providers).toEqual(
            providers,
          );
        }),
      );

      expect((yield* Queue.take(savedConfigs)).providers).toEqual([]);
    }),
  );

  it.effect("does not rewrite cached configuration when no live update arrives", () =>
    Effect.gen(function* () {
      const client = {
        [WS_METHODS.subscribeServerConfig]: () => Stream.empty,
      } as unknown as WsRpcProtocolClient;
      const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
        target: TARGET,
        state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
        session: yield* SubscriptionRef.make(Option.some(session(client))),
        prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
      const savedConfigs = yield* Queue.unbounded<ServerConfig>();
      const cache = Persistence.EnvironmentCacheStore.of({
        loadShell: () => Effect.succeed(Option.none()),
        saveShell: () => Effect.void,
        loadThread: () => Effect.succeed(Option.none()),
        saveThread: () => Effect.void,
        removeThread: () => Effect.void,
        loadServerConfig: () => Effect.succeed(Option.some(CONFIG)),
        saveServerConfig: (_environmentId, config) => Queue.offer(savedConfigs, config),
        loadVcsRefs: () => Effect.succeed(Option.none()),
        saveVcsRefs: () => Effect.void,
        removeVcsRefs: () => Effect.void,
        clearVcsRefs: () => Effect.void,
        clear: () => Effect.void,
      });

      yield* Effect.scoped(
        makeEnvironmentServerConfigState().pipe(
          Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
          Effect.provideService(Persistence.EnvironmentCacheStore, cache),
        ),
      );

      expect(yield* Queue.poll(savedConfigs)).toEqual(Option.none());
    }),
  );
});
