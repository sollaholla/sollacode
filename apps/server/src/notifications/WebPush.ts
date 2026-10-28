import * as NodeCrypto from "node:crypto";
import webpush from "web-push";
import { Context, DateTime, Effect, Layer, Option, Predicate, Schema, Semaphore } from "effect";
import { SqlClient } from "effect/unstable/sql";
import {
  AuthOrchestrationReadScope,
  AuthVmOperateScope,
  WebPushError,
  WebPushPreferences,
  WebPushSubscription,
  type AuthSessionId,
  type WebPushStatus,
  type WebPushSubscribeInput,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { ServerSecretStore, isSecretAlreadyExistsError } from "../auth/ServerSecretStore.ts";

const DEFAULT_PREFERENCES: WebPushPreferences = {
  agentAlerts: true,
  requests: true,
  includeDetails: false,
};
const DAY_MS = 24 * 60 * 60 * 1000;
const VapidKeys = Schema.Struct({ publicKey: Schema.String, privateKey: Schema.String });
type VapidKeys = typeof VapidKeys.Type;
const PushKind = Schema.Literals(["agent", "request", "call", "call-ended", "missed-call"]);
/**
 * The service-worker payload. `kind: "call"` asks the worker for a ringing
 * notification (require interaction, renotify, vibrate); a later message with
 * the same `tag` replaces it on the device: `call-ended` quietly ("Answered on
 * <device>", "Call ended"), `missed-call` as a missed-call notice. `expiresAt`
 * bounds delivery: the push TTL counts down to it and an undelivered message
 * settles once past it.
 */
const PushMessage = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  path: Schema.String,
  tag: Schema.String,
  kind: Schema.optionalKey(PushKind),
  expiresAt: Schema.optionalKey(Schema.String),
});
const encodeKeys = Schema.encodeEffect(Schema.fromJsonString(VapidKeys));
const decodeKeys = Schema.decodeUnknownEffect(Schema.fromJsonString(VapidKeys));
const decodeSubscription = Schema.decodeUnknownEffect(Schema.fromJsonString(WebPushSubscription));
const decodePreferences = Schema.decodeUnknownEffect(Schema.fromJsonString(WebPushPreferences));
const isWebPushError = Schema.is(WebPushError);
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(PushMessage));
const decodeMessage = Schema.decodeUnknownOption(Schema.fromJsonString(PushMessage));
const encodeSubscription = Schema.encodeSync(Schema.fromJsonString(WebPushSubscription));
const encodePreferences = Schema.encodeSync(Schema.fromJsonString(WebPushPreferences));
export interface PushAttention {
  readonly key: string;
  /** `agent` is gated by the agent-alerts preference; every other kind by requests. */
  readonly kind: typeof PushKind.Type;
  readonly title: string;
  readonly body: string;
  readonly path: string;
  readonly createdAt: string;
  /** Notification tag; defaults to a hash of `key`. Same tag, same notification slot. */
  readonly tag?: string;
  /** When the message stops being worth delivering; omitted means one hour of push TTL. */
  readonly expiresAt?: string;
}

const DEFAULT_TTL_SECONDS = 3600;
/** What a device shows when its owner did not opt in to message details. */
const PRIVATE_TEXT: Record<PushAttention["kind"], { title: string; body: string }> = {
  agent: { title: "Solla Code", body: "An agent sent you a notification." },
  request: { title: "Solla Code", body: "Your approval or input is needed." },
  call: { title: "Incoming call", body: "One of your agents is calling." },
  "call-ended": { title: "Call ended", body: "A call from one of your agents stopped ringing." },
  "missed-call": { title: "Missed call", body: "You missed a call from one of your agents." },
};

/** Push endpoints are capabilities, not arbitrary authenticated HTTP destinations. */
export function isSupportedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      (!url.port || url.port === "443") &&
      (url.hostname === "fcm.googleapis.com" ||
        url.hostname.endsWith(".push.apple.com") ||
        url.hostname === "push.services.mozilla.com" ||
        url.hostname.endsWith(".push.services.mozilla.com") ||
        url.hostname.endsWith(".notify.windows.com"))
    );
  } catch {
    return false;
  }
}

/** Keep endpoint credentials and provider error bodies out of logs and RPC errors. */
export class WebPushTransport extends Context.Service<
  WebPushTransport,
  {
    readonly send: (
      subscription: WebPushSubscription,
      payload: string,
      keys: VapidKeys,
      options?: { readonly ttlSeconds?: number },
    ) => Effect.Effect<number>;
  }
>()("t3/notifications/WebPush/WebPushTransport") {
  static readonly layer = Layer.succeed(this, {
    send: (subscription, payload, keys, options) =>
      Effect.tryPromise({
        try: () =>
          webpush.sendNotification(subscription, payload, {
            vapidDetails: { subject: "https://github.com/sollaholla/sollacode", ...keys },
            TTL: options?.ttlSeconds ?? DEFAULT_TTL_SECONDS,
            urgency: "high",
            timeout: 10_000,
          }),
        catch: (error) =>
          Predicate.isObject(error) && "statusCode" in error && typeof error.statusCode === "number"
            ? error.statusCode
            : 0,
      }).pipe(
        Effect.map((response) => response.statusCode),
        Effect.catch((status) => Effect.succeed(status)),
      ),
  });
}

export class WebPush extends Context.Service<
  WebPush,
  {
    readonly status: (
      sessionId: AuthSessionId,
      endpoint?: string,
    ) => Effect.Effect<WebPushStatus, WebPushError>;
    readonly subscribe: (
      sessionId: AuthSessionId,
      input: WebPushSubscribeInput,
    ) => Effect.Effect<void, WebPushError>;
    readonly unsubscribe: (
      sessionId: AuthSessionId,
      endpoint: string,
    ) => Effect.Effect<void, WebPushError>;
    readonly test: (
      sessionId: AuthSessionId,
      endpoint: string,
    ) => Effect.Effect<void, WebPushError>;
    readonly publish: (attention: PushAttention) => Effect.Effect<void, WebPushError>;
    readonly cancel: (key: string) => Effect.Effect<void, WebPushError>;
    readonly flush: Effect.Effect<void, WebPushError>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/notifications/WebPush") {}

const idFor = (endpoint: string) => NodeCrypto.createHash("sha256").update(endpoint).digest("hex");
const safeFailure = () =>
  new WebPushError({ message: "Unable to manage push notifications. Try again." });
const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

export const makeWebPush = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const secrets = yield* ServerSecretStore;
  const transport = yield* WebPushTransport;
  const lock = yield* Semaphore.make(1);
  const keys = yield* Effect.cached(
    Effect.gen(function* () {
      let stored = yield* secrets.get("web-push-vapid.json");
      if (Option.isNone(stored)) {
        const generated = webpush.generateVAPIDKeys();
        yield* secrets
          .create("web-push-vapid.json", new TextEncoder().encode(yield* encodeKeys(generated)))
          .pipe(
            Effect.catch((error) =>
              isSecretAlreadyExistsError(error) ? Effect.void : Effect.fail(error),
            ),
          );
        stored = yield* secrets.get("web-push-vapid.json");
      }
      if (Option.isNone(stored)) return yield* safeFailure();
      return yield* decodeKeys(new TextDecoder().decode(stored.value));
    }).pipe(Effect.mapError(safeFailure)),
  );

  const flush = Effect.gen(function* () {
    const now = yield* nowIso;
    const cutoff = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { hours: 24 }));
    // Revocation and expiry stop delivery even while the browser is closed.
    yield* sql`DELETE FROM web_push_subscriptions WHERE session_id NOT IN (
      SELECT session_id FROM auth_sessions WHERE revoked_at IS NULL AND expires_at > ${now}
      AND EXISTS (SELECT 1 FROM json_each(scopes) WHERE value = ${AuthVmOperateScope})
      AND EXISTS (SELECT 1 FROM json_each(scopes) WHERE value = ${AuthOrchestrationReadScope})
    )`;
    yield* sql`DELETE FROM web_push_deliveries WHERE created_at < ${cutoff}`;
    const rows = yield* sql<{
      id: string;
      eventKey: string;
      subscription: string;
      payload: string;
      attempts: number;
    }>`
      SELECT s.id, d.event_key AS "eventKey", s.subscription_json AS subscription,
        d.payload_json AS payload, d.attempts
      FROM web_push_deliveries d JOIN web_push_subscriptions s ON s.id = d.subscription_id
      WHERE d.settled_at IS NULL AND d.next_attempt_at <= ${now}
      ORDER BY d.created_at LIMIT 100`;
    if (rows.length === 0) return;
    const vapid = yield* keys;
    yield* Effect.forEach(
      rows,
      Effect.fn("WebPush.deliver")(function* (row) {
        const expiresAt = decodeMessage(row.payload).pipe(
          Option.flatMap((message) => Option.fromUndefinedOr(message.expiresAt)),
          Option.map((iso) => Date.parse(iso)),
        );
        const remainingSeconds = Option.isSome(expiresAt)
          ? Math.ceil((expiresAt.value - Date.parse(now)) / 1_000)
          : DEFAULT_TTL_SECONDS;
        // A ring nobody received in time is not worth delivering late.
        if (remainingSeconds <= 0) {
          yield* sql`UPDATE web_push_deliveries SET settled_at = ${now}
          WHERE subscription_id = ${row.id} AND event_key = ${row.eventKey}`;
          return;
        }
        const subscription = yield* decodeSubscription(row.subscription);
        const status = yield* transport.send(subscription, row.payload, vapid, {
          ttlSeconds: Math.min(DEFAULT_TTL_SECONDS, remainingSeconds),
        });
        if (status === 404 || status === 410) {
          yield* sql`DELETE FROM web_push_subscriptions WHERE id = ${row.id}`;
          return;
        }
        const settled =
          (status >= 200 && status < 300) ||
          (status >= 400 && status < 500 && status !== 429) ||
          row.attempts >= 7;
        const nextAttempt = DateTime.formatIso(
          DateTime.add(yield* DateTime.now, { seconds: Math.min(3600, 30 * 2 ** row.attempts) }),
        );
        // `cancel` and a preference change settle rows without the lock, so a
        // row settled while its send was in flight stays settled.
        yield* sql`UPDATE web_push_deliveries SET attempts = attempts + 1,
        next_attempt_at = ${nextAttempt}, settled_at = COALESCE(settled_at, ${settled ? now : null})
        WHERE subscription_id = ${row.id} AND event_key = ${row.eventKey}`;
      }),
      { concurrency: 4, discard: true },
    );
  }).pipe(lock.withPermits(1), Effect.mapError(safeFailure));
  const worker = yield* makeDrainableWorker((_item: void) =>
    flush.pipe(Effect.ignoreCause({ log: true })),
  );
  yield* Effect.sleep("30 seconds").pipe(
    Effect.andThen(worker.enqueue()),
    Effect.forever,
    Effect.forkScoped,
  );

  const status = Effect.fn("WebPush.status")(function* (
    sessionId: AuthSessionId,
    endpoint?: string,
  ) {
    const rows = endpoint
      ? yield* sql<{ preferences: string }>`SELECT preferences_json AS preferences
      FROM web_push_subscriptions WHERE id = ${idFor(endpoint)} AND session_id = ${sessionId}`
      : [];
    return {
      publicKey: (yield* keys).publicKey,
      subscribed: rows.length > 0,
      preferences: rows[0] ? yield* decodePreferences(rows[0].preferences) : DEFAULT_PREFERENCES,
    };
  }, Effect.mapError(safeFailure));

  const subscribe = Effect.fn("WebPush.subscribe")(
    function* (sessionId: AuthSessionId, input: WebPushSubscribeInput) {
      if (
        !isSupportedPushEndpoint(input.subscription.endpoint) ||
        Buffer.from(input.subscription.keys.p256dh, "base64url").length !== 65 ||
        Buffer.from(input.subscription.keys.auth, "base64url").length !== 16
      ) {
        return yield* new WebPushError({
          message: "This browser returned an unsupported push subscription.",
        });
      }
      const now = yield* nowIso;
      const session =
        yield* sql`SELECT session_id FROM auth_sessions WHERE session_id = ${sessionId}
      AND revoked_at IS NULL AND expires_at > ${now}
      AND EXISTS (SELECT 1 FROM json_each(scopes) WHERE value = ${AuthOrchestrationReadScope})
      AND EXISTS (SELECT 1 FROM json_each(scopes) WHERE value = ${AuthVmOperateScope})`;
      if (session.length === 0)
        return yield* new WebPushError({
          message:
            "Pair this device with access to threads and agents before enabling push notifications.",
        });
      const id = idFor(input.subscription.endpoint);
      const count = yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM web_push_subscriptions WHERE id != ${id}`;
      if ((count[0]?.count ?? 0) >= 256)
        return yield* new WebPushError({ message: "The host has reached its push-device limit." });
      const preferencesJson = encodePreferences(input.preferences);
      yield* sql.withTransaction(
        Effect.gen(function* () {
          // Withdrawing consent or details also withdraws queued messages.
          yield* sql`UPDATE web_push_deliveries SET settled_at = ${now}
        WHERE subscription_id = ${id} AND settled_at IS NULL AND EXISTS (
          SELECT 1 FROM web_push_subscriptions WHERE id = ${id} AND preferences_json != ${preferencesJson}
        )`;
          yield* sql`INSERT INTO web_push_subscriptions (id, session_id, subscription_json, preferences_json, created_at)
      VALUES (${id}, ${sessionId}, ${encodeSubscription(input.subscription)}, ${preferencesJson}, ${now})
      ON CONFLICT(id) DO UPDATE SET session_id = excluded.session_id,
      subscription_json = excluded.subscription_json, preferences_json = excluded.preferences_json`;
        }),
      );
    },
    Effect.mapError((error) => (isWebPushError(error) ? error : safeFailure())),
  );

  const unsubscribe = Effect.fn("WebPush.unsubscribe")(function* (
    sessionId: AuthSessionId,
    endpoint: string,
  ) {
    yield* sql`DELETE FROM web_push_subscriptions WHERE id = ${idFor(endpoint)} AND session_id = ${sessionId}`;
  }, Effect.mapError(safeFailure));

  const publish = Effect.fn("WebPush.publish")(function* (attention: PushAttention) {
    const now = yield* nowIso;
    if (Date.parse(now) - Date.parse(attention.createdAt) > DAY_MS) return;
    const rows = yield* sql<{
      id: string;
      preferences: string;
    }>`SELECT id, preferences_json AS preferences
      FROM web_push_subscriptions WHERE created_at <= ${attention.createdAt}`;
    for (const row of rows) {
      const prefs = yield* decodePreferences(row.preferences);
      if (attention.kind === "agent" ? !prefs.agentAlerts : !prefs.requests) continue;
      const payload = encodeMessage({
        title: prefs.includeDetails
          ? attention.title.slice(0, 120)
          : PRIVATE_TEXT[attention.kind].title,
        body: prefs.includeDetails
          ? attention.body.slice(0, 300)
          : PRIVATE_TEXT[attention.kind].body,
        path: attention.path,
        tag: attention.tag ?? idFor(attention.key),
        kind: attention.kind,
        ...(attention.expiresAt === undefined ? {} : { expiresAt: attention.expiresAt }),
      });
      yield* sql`INSERT OR IGNORE INTO web_push_deliveries
        (subscription_id, event_key, payload_json, created_at, next_attempt_at)
        VALUES (${row.id}, ${attention.key}, ${payload}, ${attention.createdAt}, ${now})`;
    }
    yield* worker.enqueue();
  }, Effect.mapError(safeFailure));

  const cancel = Effect.fn("WebPush.cancel")(function* (key: string) {
    yield* sql`UPDATE web_push_deliveries SET settled_at = ${yield* nowIso}
      WHERE event_key = ${key} AND settled_at IS NULL`;
  }, Effect.mapError(safeFailure));

  const test = Effect.fn("WebPush.test")(
    function* (sessionId: AuthSessionId, endpoint: string) {
      const rows = yield* sql<{ subscription: string }>`SELECT subscription_json AS subscription
      FROM web_push_subscriptions WHERE id = ${idFor(endpoint)} AND session_id = ${sessionId}`;
      if (!rows[0])
        return yield* new WebPushError({ message: "Enable notifications on this device first." });
      const subscription = yield* decodeSubscription(rows[0].subscription);
      const result = yield* transport.send(
        subscription,
        encodeMessage({
          title: "Solla Code",
          body: "Push notifications are working on this device.",
          path: "/settings/agents",
          tag: "solla-push-test",
        }),
        yield* keys,
      );
      if (result < 200 || result >= 300)
        return yield* new WebPushError({
          message:
            "The push service did not accept the test. Re-enable notifications and try again.",
        });
    },
    Effect.mapError((error) => (isWebPushError(error) ? error : safeFailure())),
  );
  yield* worker.enqueue();
  return WebPush.of({
    status,
    subscribe,
    unsubscribe,
    test,
    publish,
    cancel,
    flush,
    drain: worker.drain,
  });
});

export const WebPushLive = Layer.effect(WebPush, makeWebPush);
