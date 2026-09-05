import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import { PersistenceSqlError } from "../persistence/Errors.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import * as AuthSessions from "../persistence/AuthSessions.ts";
import * as SessionStore from "./SessionStore.ts";
import * as ServerSecretStore from "./ServerSecretStore.ts";

const makeServerConfigLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  Layer.effect(
    ServerConfig.ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfig.ServerConfig["Service"];
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-auth-session-test-" })));

const makeSessionStoreLayer = (
  overrides?: Partial<Pick<ServerConfig.ServerConfig["Service"], "desktopBootstrapToken">>,
) =>
  SessionStore.layer.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStore.layer),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const repositoryFailure = new PersistenceSqlError({
  operation: "AuthSessionRepository.getById:query",
  detail: "sqlite is unavailable",
});

const failingSessionLookupRepositoryLayer = Layer.succeed(AuthSessions.AuthSessionRepository, {
  create: () => Effect.void,
  upsert: () => Effect.void,
  getById: () => Effect.fail(repositoryFailure),
  listActive: () => Effect.succeed([]),
  revoke: () => Effect.fail(repositoryFailure),
  revokeAllExcept: () => Effect.fail(repositoryFailure),
  setLastConnectedAt: () => Effect.void,
});

const failingSessionLookupCredentialLayer = Layer.effect(
  SessionStore.SessionStore,
  SessionStore.make,
).pipe(
  Layer.provide(failingSessionLookupRepositoryLayer),
  Layer.provide(ServerSecretStore.layer),
  Layer.provide(SqlitePersistenceMemory),
  Layer.provide(makeServerConfigLayer()),
);

it.layer(NodeServices.layer)("SessionStore.layer", (it) => {
  it.effect("issues and verifies signed browser session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("browser-session-cookie");
      expect(verified.subject).toBe("desktop-bootstrap");
      expect(verified.scopes).toEqual(["orchestration:read", "access:write"]);
      expect(verified.client.label).toBe("Desktop app");
      expect(verified.client.browser).toBe("Electron");
      expect(verified.expiresAt?.toString()).toBe(issued.expiresAt.toString());
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
  it.effect("uses persisted scope grants when a signed browser session is migrated", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const repository = yield* AuthSessions.AuthSessionRepository;
      const issued = yield* sessions.issue({
        subject: "legacy-standard-browser",
        scopes: [
          "orchestration:read",
          "orchestration:operate",
          "terminal:operate",
          "review:write",
          "relay:read",
        ],
        client: {
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
        },
      });
      const stored = yield* repository.getById({ sessionId: issued.sessionId });
      if (Option.isNone(stored)) throw new Error("Expected issued session to be persisted.");

      yield* repository.upsert({
        sessionId: stored.value.sessionId,
        subject: stored.value.subject,
        scopes: [...stored.value.scopes, "vm:operate"],
        method: stored.value.method,
        client: stored.value.client,
        issuedAt: stored.value.issuedAt,
        expiresAt: stored.value.expiresAt,
      });

      const verified = yield* sessions.verify(issued.token);
      expect(verified.scopes).toEqual([
        "orchestration:read",
        "orchestration:operate",
        "terminal:operate",
        "review:write",
        "relay:read",
        "vm:operate",
      ]);
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
  it.effect("rejects malformed session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

      expect(error._tag).toBe("MalformedSessionTokenError");
      expect(error.message).toContain("Malformed session token");
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );
  it.effect("preserves repository failures while verifying session and websocket credentials", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "repository-failure",
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      const sessionError = yield* Effect.flip(sessions.verify(issued.token));
      const websocketError = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      const revokeError = yield* Effect.flip(sessions.revoke(issued.sessionId));
      const revokeOthersError = yield* Effect.flip(sessions.revokeAllExcept(issued.sessionId));

      expect(sessionError._tag).toBe("SessionCredentialVerificationError");
      expect(websocketError._tag).toBe("WebSocketTokenVerificationError");
      expect(sessionError.cause).toBe(repositoryFailure);
      expect(websocketError.cause).toBe(repositoryFailure);
      if (sessionError._tag === "SessionCredentialVerificationError") {
        expect(sessionError.sessionId).toBe(issued.sessionId);
      }
      if (websocketError._tag === "WebSocketTokenVerificationError") {
        expect(websocketError.sessionId).toBe(issued.sessionId);
      }
      expect(revokeError).toMatchObject({
        _tag: "SessionRevocationError",
        sessionId: issued.sessionId,
        cause: repositoryFailure,
      });
      expect(revokeOthersError).toMatchObject({
        _tag: "OtherSessionsRevocationError",
        currentSessionId: issued.sessionId,
        cause: repositoryFailure,
      });
    }).pipe(Effect.provide(failingSessionLookupCredentialLayer)),
  );
  it.effect("verifies session tokens against the Effect clock", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "test-clock",
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("bearer-access-token");
      expect(verified.subject).toBe("test-clock");
      expect(verified.scopes).toEqual([...AuthStandardClientScopes]);
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error._tag).toBe("WebSocketSessionExpiredError");
      if (error._tag === "WebSocketSessionExpiredError") {
        expect(error.sessionId).toBe(issued.sessionId);
        expect(error.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(error.observedAt.epochMilliseconds).toBeGreaterThan(
          error.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("includes expiry context when session and websocket tokens expire", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "short-lived-token",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId, {
        ttl: Duration.seconds(1),
      });

      yield* TestClock.adjust(Duration.seconds(2));

      const sessionError = yield* Effect.flip(sessions.verify(issued.token));
      const websocketError = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));

      expect(sessionError._tag).toBe("SessionTokenExpiredError");
      if (sessionError._tag === "SessionTokenExpiredError") {
        expect(sessionError.sessionId).toBe(issued.sessionId);
        expect(sessionError.expiresAt.epochMilliseconds).toBe(issued.expiresAt.epochMilliseconds);
        expect(sessionError.observedAt.epochMilliseconds).toBeGreaterThan(
          sessionError.expiresAt.epochMilliseconds,
        );
      }
      expect(websocketError._tag).toBe("WebSocketTokenExpiredError");
      if (websocketError._tag === "WebSocketTokenExpiredError") {
        expect(websocketError.sessionId).toBe(issued.sessionId);
        expect(websocketError.expiresAt.epochMilliseconds).toBe(
          websocket.expiresAt.epochMilliseconds,
        );
        expect(websocketError.observedAt.epochMilliseconds).toBeGreaterThan(
          websocketError.expiresAt.epochMilliseconds,
        );
      }
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("renews an expired device credential inside the grace window", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "renewable-device",
        ttl: Duration.seconds(1),
      });

      yield* TestClock.adjust(Duration.seconds(2));
      const verifyError = yield* Effect.flip(sessions.verify(issued.token));
      expect(verifyError._tag).toBe("SessionTokenExpiredError");

      const renewed = yield* sessions.renew(issued.token);
      expect(renewed.token).not.toBe(issued.token);
      expect(renewed.method).toBe("bearer-access-token");

      const verified = yield* sessions.verify(renewed.token);
      expect(verified.sessionId).not.toBe(issued.sessionId);
      expect(verified.subject).toBe("renewable-device");
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("refuses renewal once the grace window has closed", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "past-grace",
        ttl: Duration.seconds(1),
      });

      // Device grace is 180 days past expiry; jump past that.
      yield* TestClock.adjust(Duration.days(181));
      const error = yield* Effect.flip(sessions.renew(issued.token));
      expect(error._tag).toBe("SessionTokenExpiredError");
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  for (const scenario of [
    { name: "migrated agent access", scopes: [...AuthStandardClientScopes] },
    { name: "restricted access", scopes: ["orchestration:read"] as const },
  ]) {
    it.effect(`retains persisted ${scenario.name} when renewing an old token`, () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const repository = yield* AuthSessions.AuthSessionRepository;
        const issued = yield* sessions.issue({
          method: "bearer-access-token",
          subject: "one-time-token",
          scopes: [
            "orchestration:read",
            "orchestration:operate",
            "terminal:operate",
            "review:write",
            "relay:read",
          ],
          ttl: Duration.seconds(1),
          client: { label: "Nearby Solla Code: Windows", deviceType: "desktop", os: "Win32" },
        });
        const stored = yield* repository.getById({ sessionId: issued.sessionId });
        if (Option.isNone(stored)) throw new Error("Expected issued session to be persisted.");
        yield* repository.upsert({
          sessionId: stored.value.sessionId,
          subject: stored.value.subject,
          scopes: scenario.scopes,
          method: stored.value.method,
          client: stored.value.client,
          issuedAt: stored.value.issuedAt,
          expiresAt: stored.value.expiresAt,
        });

        yield* TestClock.adjust(Duration.seconds(2));
        const renewed = yield* sessions.renew(issued.token);
        expect(renewed.scopes).toEqual(scenario.scopes);
        const verified = yield* sessions.verify(renewed.token);
        expect(verified.scopes).toEqual(scenario.scopes);
        const ticket = yield* sessions.issueWebSocketToken(renewed.sessionId);
        const websocket = yield* sessions.verifyWebSocketToken(ticket.token);
        expect(websocket.scopes).toEqual(scenario.scopes);
      }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
    );
  }

  it.effect("refuses renewal of a revoked device credential", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        method: "bearer-access-token",
        subject: "revoked-device",
        ttl: Duration.seconds(1),
      });
      yield* sessions.revoke(issued.sessionId);
      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.renew(issued.token));
      expect(error._tag).toBe("SessionTokenRevokedError");
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const administrative = yield* sessions.issue({
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read", "access:write"],
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        scopes: ["orchestration:read"],
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });
      const clientWebSocket = yield* sessions.issueWebSocketToken(client.sessionId);

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(administrative.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));
      const revokedClientWebSocket = yield* Effect.flip(
        sessions.verifyWebSocketToken(clientWebSocket.token),
      );

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === administrative.sessionId)?.client
          .deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(administrative.sessionId);
      expect(revokedClient._tag).toBe("SessionTokenRevokedError");
      if (revokedClient._tag === "SessionTokenRevokedError") {
        expect(revokedClient.sessionId).toBe(client.sessionId);
        expect(revokedClient.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
      expect(revokedClientWebSocket._tag).toBe("WebSocketSessionRevokedError");
      if (revokedClientWebSocket._tag === "WebSocketSessionRevokedError") {
        expect(revokedClientWebSocket.sessionId).toBe(client.sessionId);
        expect(revokedClientWebSocket.revokedAt.epochMilliseconds).toBeGreaterThanOrEqual(0);
      }
    }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect(
    "reuses the internal desktop session identity and only removes disconnected exact duplicates",
    () =>
      Effect.gen(function* () {
        const sessions = yield* SessionStore.SessionStore;
        const desktopClient = {
          label: "Solla Code Desktop",
          deviceType: "desktop" as const,
          ipAddress: "127.0.0.1",
        };
        const connectedLegacy = yield* sessions.issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          scopes: ["orchestration:read", "access:write"],
          client: desktopClient,
        });
        const disconnectedLegacy = yield* sessions.issue({
          subject: "desktop-bootstrap",
          method: "bearer-access-token",
          scopes: ["orchestration:read", "access:write"],
          client: desktopClient,
        });
        const unrelatedRemote = yield* sessions.issue({
          subject: "one-time-token",
          method: "bearer-access-token",
          scopes: ["orchestration:read"],
          client: {
            label: "Solla Code Desktop",
            deviceType: "mobile",
            ipAddress: "192.168.1.88",
          },
        });

        yield* sessions.markConnected(connectedLegacy.sessionId);
        const first = yield* sessions.issueDesktopBootstrapAccessToken({
          scopes: ["orchestration:read", "access:write"],
          client: desktopClient,
        });
        const afterFirstExchange = yield* sessions.listActive();

        expect(
          afterFirstExchange.some((session) => session.sessionId === connectedLegacy.sessionId),
        ).toBe(true);
        expect(
          afterFirstExchange.some((session) => session.sessionId === disconnectedLegacy.sessionId),
        ).toBe(false);
        expect(
          afterFirstExchange.some((session) => session.sessionId === unrelatedRemote.sessionId),
        ).toBe(true);

        yield* sessions.markDisconnected(connectedLegacy.sessionId);
        const second = yield* sessions.issueDesktopBootstrapAccessToken({
          scopes: ["orchestration:read", "access:write"],
          client: {
            ...desktopClient,
            ipAddress: "127.0.0.2",
          },
        });
        const afterRestart = yield* sessions.listActive();

        expect(second.sessionId).toBe(first.sessionId);
        expect(afterRestart).toHaveLength(2);
        expect(
          afterRestart.filter((session) => session.subject === "desktop-bootstrap"),
        ).toHaveLength(1);
        expect(
          afterRestart.find((session) => session.sessionId === first.sessionId)?.client.ipAddress,
        ).toBe("127.0.0.2");
        expect(
          afterRestart.some((session) => session.sessionId === unrelatedRemote.sessionId),
        ).toBe(true);
      }).pipe(Effect.provide(makeSessionStoreLayer())),
  );

  it.effect("persists lastConnectedAt on first connect and updates it after reconnect", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionStore.SessionStore;
      const issued = yield* sessions.issue({
        subject: "reconnect-test",
        method: "bearer-access-token",
      });

      const beforeConnect = yield* sessions.listActive();
      expect(beforeConnect[0]?.lastConnectedAt).toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const firstConnect = yield* sessions.listActive();
      const firstConnectedAt = firstConnect[0]?.lastConnectedAt;

      expect(firstConnect[0]?.connected).toBe(true);
      expect(firstConnectedAt).not.toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const stillConnected = yield* sessions.listActive();

      expect(stillConnected[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* sessions.markDisconnected(issued.sessionId);
      yield* sessions.markDisconnected(issued.sessionId);
      const afterDisconnect = yield* sessions.listActive();

      expect(afterDisconnect[0]?.connected).toBe(false);
      expect(afterDisconnect[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const afterReconnect = yield* sessions.listActive();

      expect(afterReconnect[0]?.connected).toBe(true);
      expect(afterReconnect[0]?.lastConnectedAt).not.toBeNull();
      expect(afterReconnect[0]?.lastConnectedAt?.toString()).not.toBe(firstConnectedAt?.toString());
    }).pipe(Effect.provide(Layer.merge(makeSessionStoreLayer(), TestClock.layer()))),
  );
});

it("gives a paired device a credential that outlives a month away from the machine", () => {
  // A device that sat unused for five weeks used to come back to a dead
  // credential and no way in but pairing again.
  expect(
    Duration.toMillis(
      SessionStore.resolveSessionTtl({ kind: "random", method: "bearer-access-token" }),
    ),
  ).toBeGreaterThan(Duration.toMillis(Duration.days(35)));
});

it("leaves browser and DPoP credentials short-lived", () => {
  expect(
    Duration.equals(
      SessionStore.resolveSessionTtl({ kind: "random", method: "browser-session-cookie" }),
      Duration.days(30),
    ),
  ).toBe(true);
  expect(
    Duration.equals(
      SessionStore.resolveSessionTtl({
        kind: "random",
        method: "dpop-access-token",
        ttl: Duration.hours(1),
      }),
      Duration.hours(1),
    ),
  ).toBe(true);
  expect(
    Duration.equals(
      SessionStore.resolveSessionTtl({ kind: "desktop-bootstrap" }),
      Duration.days(30),
    ),
  ).toBe(true);
});
