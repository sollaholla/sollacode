import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthSessionId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import * as AuthSessions from "./AuthSessions.ts";

const sessionId = AuthSessionId.make("stable-desktop-session");
const issuedAt = DateTime.makeUnsafe("2026-07-29T12:00:00.000Z");
const connectedAt = DateTime.makeUnsafe("2026-07-29T12:01:00.000Z");
const refreshedAt = DateTime.makeUnsafe("2026-07-29T13:00:00.000Z");
const expiresAt = DateTime.makeUnsafe("2026-08-28T12:00:00.000Z");
const refreshedExpiresAt = DateTime.makeUnsafe("2026-08-28T13:00:00.000Z");
const authSessionsLayer = AuthSessions.layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

it.layer(NodeServices.layer)("AuthSessionRepository", (it) => {
  it.effect("upserts a stable session without duplicating it or losing connection history", () =>
    Effect.gen(function* () {
      const sessions = yield* AuthSessions.AuthSessionRepository;
      const original = {
        sessionId,
        subject: "desktop-bootstrap",
        scopes: ["orchestration:read" as const],
        method: "bearer-access-token" as const,
        client: {
          label: "Solla Code Desktop",
          ipAddress: "127.0.0.1",
          userAgent: null,
          deviceType: "desktop" as const,
          os: "macOS",
          browser: null,
        },
        issuedAt,
        expiresAt,
      };

      yield* sessions.create(original);
      yield* sessions.setLastConnectedAt({ sessionId, lastConnectedAt: connectedAt });
      yield* sessions.revoke({ sessionId, revokedAt: connectedAt });
      yield* sessions.upsert({
        ...original,
        client: {
          ...original.client,
          ipAddress: "127.0.0.2",
        },
        issuedAt: refreshedAt,
        expiresAt: refreshedExpiresAt,
      });

      const active = yield* sessions.listActive({ now: refreshedAt });

      expect(active).toHaveLength(1);
      expect(active[0]?.sessionId).toBe(sessionId);
      expect(active[0]?.client.ipAddress).toBe("127.0.0.2");
      expect(active[0]?.lastConnectedAt?.toString()).toBe(connectedAt.toString());
      expect(active[0]?.revokedAt).toBeNull();
      expect(active[0]?.issuedAt.toString()).toBe(refreshedAt.toString());
    }).pipe(Effect.provide(authSessionsLayer)),
  );
});
