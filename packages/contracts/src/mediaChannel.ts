import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * Control messages of the media channel (`/ws/media`).
 *
 * Media itself travels as binary WebSocket messages (see
 * `@t3tools/shared/mediaPacket`); these are the JSON text messages around it.
 * The relay is topic-generic: a topic has one publisher and any number of
 * subscribers, and the relay understands only what it needs to pace and
 * route. What a `broadcast` body means is up to the topic's owner.
 */

/** The path the media channel upgrades on, under the dev proxy's `/ws` prefix. */
export const MEDIA_CHANNEL_PATH = "/ws/media";

/** Where a subscriber shows the picture, so the publisher can size it. */
export const MediaViewport = Schema.Struct({
  /** CSS pixels the picture may occupy (the pane, before letterboxing). */
  width: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 16_384 })),
  height: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 16_384 })),
  devicePixelRatio: Schema.Number.check(Schema.isBetween({ minimum: 0.25, maximum: 8 })),
  /** Viewer-side magnification of the picture (pinch zoom). */
  zoom: Schema.Number.check(Schema.isBetween({ minimum: 1, maximum: 16 })),
});
export type MediaViewport = typeof MediaViewport.Type;

const MediaCodecList = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(64))).check(
  Schema.isMaxLength(16),
);

const MediaSubscriberId = TrimmedNonEmptyString.check(Schema.isMaxLength(64));

/** Subscriber → relay. */
export const MediaSubscriberMessage = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("hello"),
    /** Codec strings this subscriber can decode, most preferred first. */
    codecs: MediaCodecList,
    view: MediaViewport,
  }),
  Schema.Struct({ type: Schema.Literal("view"), view: MediaViewport }),
  Schema.Struct({ type: Schema.Literal("keyframe") }),
]);
export type MediaSubscriberMessage = typeof MediaSubscriberMessage.Type;

export const MediaSubscriberInfo = Schema.Struct({
  id: MediaSubscriberId,
  codecs: MediaCodecList,
  view: MediaViewport,
});
export type MediaSubscriberInfo = typeof MediaSubscriberInfo.Type;

/**
 * What the relay measured for one subscriber, from its acknowledgements.
 * The publisher's bitrate controller runs on these.
 */
export const MediaSubscriberStats = Schema.Struct({
  subscriber: MediaSubscriberId,
  /** Newest send→ack round trip. */
  rttMs: Schema.Number,
  /** Smallest round trip seen recently: the link's floor. */
  minRttMs: Schema.Number,
  /** Age of the oldest unacknowledged packet: queueing on the path. */
  queueMs: Schema.Number,
  /** Bits acknowledged over the last second. */
  deliveredBitsPerSecond: Schema.Number,
  /** Packets the relay dropped for this subscriber since the last report. */
  dropped: Schema.Number,
});
export type MediaSubscriberStats = typeof MediaSubscriberStats.Type;

/** Relay → publisher. */
export const MediaPublisherNotice = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("subscribers"),
    subscribers: Schema.Array(MediaSubscriberInfo),
  }),
  Schema.Struct({ type: Schema.Literal("keyframe") }),
  Schema.Struct({ type: Schema.Literal("stats"), stats: MediaSubscriberStats }),
]);
export type MediaPublisherNotice = typeof MediaPublisherNotice.Type;

const MediaBroadcastKey = TrimmedNonEmptyString.check(Schema.isMaxLength(32));

/** Publisher → relay. */
export const MediaPublisherMessage = Schema.Union([
  /**
   * Topic metadata every subscriber should see, retained per key so a late
   * subscriber gets the latest value on join.
   */
  Schema.Struct({
    type: Schema.Literal("broadcast"),
    key: MediaBroadcastKey,
    body: Schema.Json,
  }),
  /** None of this subscriber's codecs can be produced here. */
  Schema.Struct({
    type: Schema.Literal("unsupported"),
    subscriber: MediaSubscriberId,
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
]);
export type MediaPublisherMessage = typeof MediaPublisherMessage.Type;

/** Relay → subscriber. */
export const MediaSubscriberNotice = Schema.Union([
  Schema.Struct({ type: Schema.Literal("publisher"), online: Schema.Boolean }),
  Schema.Struct({
    type: Schema.Literal("broadcast"),
    key: MediaBroadcastKey,
    body: Schema.Json,
  }),
  Schema.Struct({
    type: Schema.Literal("unsupported"),
    reason: TrimmedNonEmptyString.check(Schema.isMaxLength(256)),
  }),
]);
export type MediaSubscriberNotice = typeof MediaSubscriberNotice.Type;

/** Close codes the relay uses; clients treat 4000-4099 as "do not retry". */
export const MEDIA_CHANNEL_CLOSE_TOPIC_ENDED = 4000;
export const MEDIA_CHANNEL_CLOSE_REPLACED = 4001;
export const MEDIA_CHANNEL_CLOSE_PROTOCOL = 4002;

/** A single-use credential for one media-channel connection. */
export const MediaChannelTicket = Schema.Struct({
  ticket: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  /** How long the ticket stays redeemable. */
  expiresInMs: Schema.Int.check(Schema.isGreaterThan(0)),
});
export type MediaChannelTicket = typeof MediaChannelTicket.Type;
