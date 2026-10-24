import { Schema } from "effect";

const Endpoint = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));
const PushKey = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9_-]+={0,2}$/),
  Schema.isMaxLength(128),
);

export const WebPushSubscription = Schema.Struct({
  endpoint: Endpoint,
  keys: Schema.Struct({ p256dh: PushKey, auth: PushKey }),
});
export type WebPushSubscription = typeof WebPushSubscription.Type;

export const WebPushPreferences = Schema.Struct({
  agentAlerts: Schema.Boolean,
  requests: Schema.Boolean,
  includeDetails: Schema.Boolean,
});
export type WebPushPreferences = typeof WebPushPreferences.Type;

export const WebPushStatusInput = Schema.Struct({ endpoint: Schema.optional(Endpoint) });
export const WebPushSubscribeInput = Schema.Struct({
  subscription: WebPushSubscription,
  preferences: WebPushPreferences,
});
export type WebPushSubscribeInput = typeof WebPushSubscribeInput.Type;
export const WebPushEndpointInput = Schema.Struct({ endpoint: Endpoint });
export const WebPushStatus = Schema.Struct({
  publicKey: Schema.String,
  subscribed: Schema.Boolean,
  preferences: WebPushPreferences,
});
export type WebPushStatus = typeof WebPushStatus.Type;

export class WebPushError extends Schema.TaggedErrorClass<WebPushError>()("WebPushError", {
  message: Schema.String,
}) {}
