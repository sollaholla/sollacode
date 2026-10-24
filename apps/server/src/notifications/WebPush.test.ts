import { assert, it } from "@effect/vitest";
import { AuthSessionId, type WebPushSubscription } from "@t3tools/contracts";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import { TestClock } from "effect/testing";
import { SqlClient } from "effect/unstable/sql";
import { describe, expect } from "vite-plus/test";
import webpush from "web-push";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import {
  isSupportedPushEndpoint,
  makeWebPush,
  WebPushTransport,
  type PushAttention,
} from "./WebPush.ts";

const sessionId = AuthSessionId.make("phone");
const secondSession = AuthSessionId.make("tablet");
const preferences = { agentAlerts: true, requests: true, includeDetails: false };
const subscription: WebPushSubscription = {
  endpoint: "https://web.push.apple.com/test-device",
  keys: {
    p256dh: webpush.generateVAPIDKeys().publicKey,
    auth: Buffer.alloc(16, 1).toString("base64url"),
  },
};
const messageSchema = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  path: Schema.String,
  tag: Schema.String,
});
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(messageSchema));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sent: { endpoint: string; payload: ReturnType<typeof decodeMessage>; publicKey: string }[] =
    [];
  let response = 201;
  const secretValues = new Map<string, Uint8Array>();
  const secretLayer = Layer.mock(ServerSecretStore)({
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(secretValues.get(key))),
    create: (key, value) =>
      Effect.sync(() => {
        secretValues.set(key, value);
      }),
  });
  const transportLayer = Layer.succeed(WebPushTransport, {
    send: (target, payload, keys) =>
      Effect.sync(() => {
        sent.push({
          endpoint: target.endpoint,
          payload: decodeMessage(payload),
          publicKey: keys.publicKey,
        });
        return response;
      }),
  });
  for (const id of [sessionId, secondSession]) {
    yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
      VALUES (${id}, 'test', '["orchestration:read","vm:operate"]', 'browser-session-cookie',
        '1970-01-01T00:00:00.000Z', '2099-01-01T00:00:00.000Z')`;
  }
  const push = yield* makeWebPush.pipe(Effect.provide(Layer.merge(secretLayer, transportLayer)));
  yield* push.drain;
  const event = (key: string, kind: "agent" | "request" = "agent"): Effect.Effect<PushAttention> =>
    Effect.map(DateTime.now, (now) => ({
      key,
      kind,
      title: "Private title",
      body: "Private contents",
      path: "/agents/host/agent",
      createdAt: DateTime.formatIso(now),
    }));
  return {
    push,
    sql,
    sent,
    event,
    secretValues,
    setResponse: (value: number) => {
      response = value;
    },
  };
});

function scenario<E, R>(run: (value: Effect.Success<typeof fixture>) => Effect.Effect<void, E, R>) {
  return Effect.flatMap(fixture, run).pipe(Effect.provide(SqlitePersistenceMemory), Effect.scoped);
}

describe("Web Push delivery", () => {
  it.effect("sends private notifications once per device and reuses the VAPID key", () =>
    scenario(({ push, sent, event, secretValues }) =>
      Effect.gen(function* () {
        const before = yield* push.status(sessionId);
        yield* push.subscribe(sessionId, { subscription, preferences });
        const attention = yield* event("notification:1");
        yield* push.publish(attention);
        yield* push.drain;
        yield* push.publish(attention);
        yield* push.drain;
        yield* push.subscribe(sessionId, { subscription, preferences });
        yield* push.publish(attention);
        yield* push.drain;
        assert.strictEqual(sent.length, 1);
        assert.strictEqual(sent[0]?.payload.title, "Solla Code");
        assert.strictEqual(sent[0]?.payload.body, "An agent sent you a notification.");
        assert.strictEqual(sent[0]?.payload.path, "/agents/host/agent");
        assert.strictEqual(sent[0]?.publicKey, before.publicKey);
        assert.strictEqual((yield* push.status(sessionId)).publicKey, before.publicKey);
        assert.strictEqual(secretValues.size, 1);
      }),
    ),
  );

  it.effect("honors categories and separately enabled message details", () =>
    scenario(({ push, sent, event }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, {
          subscription,
          preferences: { ...preferences, agentAlerts: false, includeDetails: true },
        });
        yield* push.publish(yield* event("notification:1"));
        yield* push.drain;
        assert.strictEqual(sent.length, 0);
        yield* push.publish(yield* event("approval:1", "request"));
        yield* push.drain;
        assert.strictEqual(sent[0]?.payload.title, "Private title");
        assert.strictEqual(sent[0]?.payload.body, "Private contents");
      }),
    ),
  );

  it.effect("does not replay history from before a device opted in", () =>
    scenario(({ push, sent, event }) =>
      Effect.gen(function* () {
        const old = yield* event("notification:old");
        yield* TestClock.adjust("1 second");
        yield* push.subscribe(sessionId, { subscription, preferences });
        yield* push.publish(old);
        yield* push.drain;
        assert.strictEqual(sent.length, 0);
        yield* push.publish(yield* event("notification:new"));
        yield* push.drain;
        assert.strictEqual(sent.length, 1);
      }),
    ),
  );

  it.effect("retries transient failures and permanently removes expired endpoints", () =>
    scenario(({ push, sent, event, setResponse }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, { subscription, preferences });
        setResponse(503);
        yield* push.publish(yield* event("notification:1"));
        yield* push.drain;
        yield* push.flush;
        assert.strictEqual(sent.length, 1);
        setResponse(410);
        yield* TestClock.adjust("30 seconds");
        yield* push.drain;
        yield* push.flush;
        assert.strictEqual(sent.length, 2);
        assert.isFalse((yield* push.status(sessionId, subscription.endpoint)).subscribed);
        yield* TestClock.adjust("1 minute");
        yield* push.drain;
        assert.strictEqual(sent.length, 2);
      }),
    ),
  );

  it.effect("cancels pending retries when a request is resolved", () =>
    scenario(({ push, sent, event, setResponse }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, { subscription, preferences });
        setResponse(429);
        yield* push.publish(yield* event("approval:1", "request"));
        yield* push.drain;
        yield* push.cancel("approval:1");
        yield* TestClock.adjust("1 minute");
        yield* push.drain;
        assert.strictEqual(sent.length, 1);
      }),
    ),
  );

  it.effect("withdraws queued details when preferences change", () =>
    scenario(({ push, sent, event, setResponse }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, {
          subscription,
          preferences: { ...preferences, includeDetails: true },
        });
        setResponse(503);
        yield* push.publish(yield* event("notification:1"));
        yield* push.drain;
        yield* push.subscribe(sessionId, { subscription, preferences });
        setResponse(201);
        yield* TestClock.adjust("1 minute");
        yield* push.drain;
        assert.strictEqual(sent.length, 1);
        yield* push.publish(yield* event("notification:2"));
        yield* push.drain;
        assert.strictEqual(sent[1]?.payload.title, "Solla Code");
      }),
    ),
  );

  it.effect("isolates devices and does not let another session test or unsubscribe one", () =>
    scenario(({ push, sent, event }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, { subscription, preferences });
        const tablet = { ...subscription, endpoint: "https://fcm.googleapis.com/tablet" };
        yield* push.subscribe(secondSession, { subscription: tablet, preferences });
        yield* push.unsubscribe(secondSession, subscription.endpoint);
        assert.isFalse((yield* push.status(secondSession, subscription.endpoint)).subscribed);
        assert.strictEqual(
          (yield* Effect.exit(push.test(secondSession, subscription.endpoint)))._tag,
          "Failure",
        );
        yield* push.publish(yield* event("notification:1"));
        yield* push.drain;
        assert.strictEqual(sent.length, 2);
        yield* push.unsubscribe(sessionId, subscription.endpoint);
        yield* push.publish(yield* event("notification:2"));
        yield* push.drain;
        assert.strictEqual(sent.length, 3);
        assert.strictEqual(sent[2]?.endpoint, tablet.endpoint);
      }),
    ),
  );

  for (const change of ["revoked", "expired", "scope"] as const) {
    it.effect(`stops pending deliveries after the session is ${change}`, () =>
      scenario(({ push, sql, sent, event, setResponse }) =>
        Effect.gen(function* () {
          yield* push.subscribe(sessionId, { subscription, preferences });
          setResponse(503);
          yield* push.publish(yield* event("notification:1"));
          yield* push.drain;
          if (change === "revoked")
            yield* sql`UPDATE auth_sessions SET revoked_at = '1970-01-01T00:00:00.000Z'`;
          if (change === "expired")
            yield* sql`UPDATE auth_sessions SET expires_at = '1970-01-01T00:00:00.000Z'`;
          if (change === "scope") yield* sql`UPDATE auth_sessions SET scopes = '[]'`;
          yield* TestClock.adjust("1 minute");
          yield* push.drain;
          assert.strictEqual(sent.length, 1);
          assert.isFalse((yield* push.status(sessionId, subscription.endpoint)).subscribed);
          assert.strictEqual(
            (yield* Effect.exit(push.subscribe(sessionId, { subscription, preferences })))._tag,
            "Failure",
          );
        }),
      ),
    );
  }

  it.effect("supports an explicit test and reports rejection without exposing the endpoint", () =>
    scenario(({ push, sent, setResponse }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, { subscription, preferences });
        yield* push.test(sessionId, subscription.endpoint);
        assert.strictEqual(sent[0]?.payload.tag, "solla-push-test");
        setResponse(403);
        const result = yield* Effect.result(push.test(sessionId, subscription.endpoint));
        assert.strictEqual(result._tag, "Failure");
        if (result._tag === "Failure")
          assert.notInclude(result.failure.message, subscription.endpoint);
      }),
    ),
  );
});

it("only accepts supported HTTPS push-service endpoints", () => {
  for (const url of [
    subscription.endpoint,
    "https://fcm.googleapis.com/abc",
    "https://updates.push.services.mozilla.com/wpush/v2/token",
    "https://wns2.notify.windows.com/token",
  ])
    expect(isSupportedPushEndpoint(url)).toBe(true);
  for (const url of [
    "http://fcm.googleapis.com/a",
    "https://127.0.0.1/a",
    "https://evil.test/a",
    "https://web.push.apple.com.evil.test/a",
    "https://user:secret@fcm.googleapis.com/a",
    "https://fcm.googleapis.com:8443/a",
  ])
    expect(isSupportedPushEndpoint(url)).toBe(false);
});
