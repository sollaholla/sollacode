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
  kind: Schema.optional(Schema.String),
  expiresAt: Schema.optional(Schema.String),
});
const decodeMessage = Schema.decodeUnknownSync(Schema.fromJsonString(messageSchema));
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sent: {
    endpoint: string;
    payload: ReturnType<typeof decodeMessage>;
    publicKey: string;
    ttlSeconds: number | undefined;
  }[] = [];
  let response = 201;
  // Runs while a send is in flight, before the push service answers.
  let duringSend: Effect.Effect<void> = Effect.void;
  const secretValues = new Map<string, Uint8Array>();
  const secretLayer = Layer.mock(ServerSecretStore)({
    get: (key) => Effect.sync(() => Option.fromUndefinedOr(secretValues.get(key))),
    create: (key, value) =>
      Effect.sync(() => {
        secretValues.set(key, value);
      }),
  });
  const transportLayer = Layer.succeed(WebPushTransport, {
    send: (target, payload, keys, options) =>
      Effect.sync(() => {
        sent.push({
          endpoint: target.endpoint,
          payload: decodeMessage(payload),
          publicKey: keys.publicKey,
          ttlSeconds: options?.ttlSeconds,
        });
      }).pipe(Effect.andThen(Effect.suspend(() => duringSend)), Effect.as(response)),
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
    setDuringSend: (effect: Effect.Effect<void>) => {
      duringSend = effect;
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

  it.effect("a ring withdrawn while its send is in flight is never retried", () =>
    scenario(({ push, sent, setResponse, setDuringSend }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, { subscription, preferences });
        const now = yield* DateTime.now;
        // The call is answered on another device while the push service is
        // still answering, and then the send fails.
        setDuringSend(push.cancel("call:one").pipe(Effect.orDie));
        setResponse(503);
        yield* push.publish({
          key: "call:one",
          kind: "call",
          tag: "call:one",
          title: "Scout is calling",
          body: "Sign in to Google",
          path: "/call/host/one",
          createdAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { seconds: 45 })),
        });
        yield* push.drain;
        assert.strictEqual(sent.length, 1);
        // Still inside the ring window: a retry would ring again.
        yield* TestClock.adjust("30 seconds");
        yield* push.drain;
        yield* push.flush;
        assert.strictEqual(sent.length, 1);
      }),
    ),
  );

  it.effect("rings with a call notification that stops being delivered when the ring ends", () =>
    scenario(({ push, sent, setResponse }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, { subscription, preferences });
        const now = yield* DateTime.now;
        const call: PushAttention = {
          key: "call:one",
          kind: "call",
          tag: "call:one",
          title: "Scout is calling",
          body: "Sign in to Google",
          path: "/call/host/one",
          createdAt: DateTime.formatIso(now),
          expiresAt: DateTime.formatIso(DateTime.add(now, { seconds: 45 })),
        };
        setResponse(503);
        yield* push.publish(call);
        yield* push.drain;
        assert.deepStrictEqual(sent[0]?.payload, {
          title: "Incoming call",
          body: "One of your agents is calling.",
          path: "/call/host/one",
          tag: "call:one",
          kind: "call",
          expiresAt: call.expiresAt,
        });
        assert.strictEqual(sent[0]?.ttlSeconds, 45);
        // A retry inside the ring window only lives as long as the ring.
        yield* TestClock.adjust("30 seconds");
        yield* push.drain;
        assert.strictEqual(sent.length, 2);
        assert.strictEqual(sent[1]?.ttlSeconds, 15);
        // Past the ring window the delivery settles instead of ringing late.
        yield* TestClock.adjust("1 minute");
        yield* push.drain;
        yield* push.flush;
        assert.strictEqual(sent.length, 2);

        setResponse(201);
        yield* push.publish({
          key: "call:one:missed",
          kind: "missed-call",
          tag: "call:one",
          title: "Missed call from Scout",
          body: "Sign in to Google",
          path: "/agents/host/scout",
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* push.drain;
        assert.strictEqual(sent[2]?.payload.title, "Missed call");
        assert.strictEqual(sent[2]?.payload.tag, "call:one");
        assert.strictEqual(sent[2]?.payload.kind, "missed-call");
        assert.strictEqual(sent[2]?.ttlSeconds, 3600);

        // A ring that was answered elsewhere is replaced quietly, privately worded.
        const endedAt = yield* DateTime.now;
        yield* push.publish({
          key: "call:one:ended",
          kind: "call-ended",
          tag: "call:one",
          title: "Answered on Office Mac",
          body: "Call with Scout.",
          path: "/call/host/one",
          createdAt: DateTime.formatIso(endedAt),
          expiresAt: DateTime.formatIso(DateTime.add(endedAt, { minutes: 10 })),
        });
        yield* push.drain;
        assert.deepStrictEqual(sent[3]?.payload, {
          title: "Call ended",
          body: "A call from one of your agents stopped ringing.",
          path: "/call/host/one",
          tag: "call:one",
          kind: "call-ended",
          expiresAt: DateTime.formatIso(DateTime.add(endedAt, { minutes: 10 })),
        });
        assert.strictEqual(sent[3]?.ttlSeconds, 600);
      }),
    ),
  );

  it.effect("shows who is calling only to devices that opted in to details", () =>
    scenario(({ push, sent }) =>
      Effect.gen(function* () {
        yield* push.subscribe(sessionId, {
          subscription,
          preferences: { ...preferences, includeDetails: true },
        });
        yield* push.publish({
          key: "call:two",
          kind: "call",
          tag: "call:two",
          title: "Scout is calling",
          body: "Sign in to Google",
          path: "/call/host/two",
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* push.drain;
        assert.strictEqual(sent[0]?.payload.title, "Scout is calling");
        assert.strictEqual(sent[0]?.payload.body, "Sign in to Google");
        // Calls follow the requests preference.
        yield* push.subscribe(sessionId, {
          subscription,
          preferences: { ...preferences, requests: false },
        });
        yield* push.publish({
          key: "call:three",
          kind: "call",
          title: "Scout is calling",
          body: "",
          path: "/call/host/three",
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
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
