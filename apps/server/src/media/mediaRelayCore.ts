/**
 * The media relay's routing, as a synchronous state machine.
 *
 * Kept free of sockets and Effect so the policy - who gets which packet, when
 * a key frame is requested, what the publisher is told - can be driven
 * packet by packet in tests with a fake clock. `MediaRelay` owns the sockets
 * and feeds this; `send` and `close` here only enqueue.
 *
 * A topic has at most one publisher and any number of subscribers. Packets
 * fan out to every subscriber through its own `MediaFlowState`, so one slow
 * viewer drops frames without slowing anyone else down.
 */
import {
  MEDIA_CHANNEL_CLOSE_PROTOCOL,
  MEDIA_CHANNEL_CLOSE_REPLACED,
  MEDIA_CHANNEL_CLOSE_TOPIC_ENDED,
  MediaPublisherMessage,
  MediaPublisherNotice,
  MediaSubscriberMessage,
  MediaSubscriberNotice,
  type MediaSubscriberInfo,
} from "@t3tools/contracts";
import { decodeMediaAck, peekMediaPacket } from "@t3tools/shared/mediaPacket";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  acknowledge,
  admitPacket,
  createMediaFlow,
  DEFAULT_MEDIA_FLOW_OPTIONS,
  flowSnapshot,
  type MediaFlowOptions,
  type MediaFlowState,
  wantsKeyframe,
} from "./mediaFlowControl.ts";

export interface MediaRelayConnection {
  readonly id: string;
  /** Enqueues a message; never blocks. */
  readonly send: (data: string | Uint8Array) => void;
  readonly close: (code: number, reason: string) => void;
}

export interface MediaRelayEndpoint {
  readonly onMessage: (data: string | Uint8Array) => void;
  readonly disconnect: () => void;
}

interface Subscriber {
  readonly connection: MediaRelayConnection;
  info: MediaSubscriberInfo | null;
  readonly flow: MediaFlowState;
  lastStatsAt: number;
}

interface Topic {
  publisher: MediaRelayConnection | null;
  readonly subscribers: Map<string, Subscriber>;
  /** Latest broadcast per key, already encoded for subscribers. */
  readonly broadcasts: Map<string, string>;
  lastKeyframeRequestAt: number;
}

export interface MediaRelayCoreOptions {
  readonly now: () => number;
  readonly flow?: MediaFlowOptions;
  /** Minimum spacing between key frame requests to one publisher. */
  readonly keyframeRequestIntervalMs?: number;
  readonly statsIntervalMs?: number;
}

export interface MediaRelayCoreStats {
  readonly topics: number;
  readonly subscribers: number;
  readonly packetsRelayed: number;
  readonly packetsDropped: number;
}

const decodeSubscriberMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(MediaSubscriberMessage),
);
const decodePublisherMessage = Schema.decodeUnknownOption(
  Schema.fromJsonString(MediaPublisherMessage),
);
const encodePublisherNotice = Schema.encodeSync(Schema.fromJsonString(MediaPublisherNotice));
const encodeSubscriberNotice = Schema.encodeSync(Schema.fromJsonString(MediaSubscriberNotice));

export function createMediaRelayCore(options: MediaRelayCoreOptions) {
  const flowOptions = options.flow ?? DEFAULT_MEDIA_FLOW_OPTIONS;
  const keyframeInterval = options.keyframeRequestIntervalMs ?? 250;
  const statsInterval = options.statsIntervalMs ?? 250;
  const topics = new Map<string, Topic>();
  const counters = { packetsRelayed: 0, packetsDropped: 0 };

  const topicFor = (name: string): Topic => {
    let topic = topics.get(name);
    if (!topic) {
      topic = {
        publisher: null,
        subscribers: new Map(),
        broadcasts: new Map(),
        lastKeyframeRequestAt: Number.NEGATIVE_INFINITY,
      };
      topics.set(name, topic);
    }
    return topic;
  };

  const releaseIfEmpty = (name: string, topic: Topic) => {
    if (topic.publisher === null && topic.subscribers.size === 0 && topics.get(name) === topic) {
      topics.delete(name);
    }
  };

  const notifyPublisher = (topic: Topic, notice: MediaPublisherNotice) => {
    topic.publisher?.send(encodePublisherNotice(notice));
  };

  const announceSubscribers = (topic: Topic) => {
    const subscribers = [...topic.subscribers.values()].flatMap((subscriber) =>
      subscriber.info ? [subscriber.info] : [],
    );
    notifyPublisher(topic, { type: "subscribers", subscribers });
  };

  const requestKeyframe = (topic: Topic, force: boolean) => {
    const now = options.now();
    if (!force && now - topic.lastKeyframeRequestAt < keyframeInterval) return;
    if (!topic.publisher) return;
    topic.lastKeyframeRequestAt = now;
    notifyPublisher(topic, { type: "keyframe" });
  };

  const reportStats = (topic: Topic, subscriber: Subscriber, force: boolean) => {
    const now = options.now();
    if (!force && now - subscriber.lastStatsAt < statsInterval) return;
    subscriber.lastStatsAt = now;
    if (!topic.publisher) return;
    notifyPublisher(topic, {
      type: "stats",
      stats: { subscriber: subscriber.connection.id, ...flowSnapshot(subscriber.flow, now) },
    });
  };

  const relayPacket = (topic: Topic, bytes: Uint8Array) => {
    const header = peekMediaPacket(bytes);
    if (!header) return false;
    const now = options.now();
    for (const subscriber of topic.subscribers.values()) {
      if (!subscriber.info) continue;
      const decision = admitPacket(
        subscriber.flow,
        { sequence: header.sequence, bytes: bytes.length, key: header.key },
        now,
        flowOptions,
      );
      if (decision === "send") {
        counters.packetsRelayed += 1;
        subscriber.connection.send(bytes);
      } else {
        counters.packetsDropped += 1;
        reportStats(topic, subscriber, true);
        if (wantsKeyframe(subscriber.flow, now, flowOptions)) requestKeyframe(topic, false);
      }
    }
    return true;
  };

  const connectPublisher = (name: string, connection: MediaRelayConnection): MediaRelayEndpoint => {
    const topic = topicFor(name);
    const previous = topic.publisher;
    topic.publisher = connection;
    previous?.close(MEDIA_CHANNEL_CLOSE_REPLACED, "Another publisher took over this topic.");
    for (const subscriber of topic.subscribers.values()) {
      subscriber.connection.send(encodeSubscriberNotice({ type: "publisher", online: true }));
      Object.assign(subscriber.flow, createMediaFlow());
    }
    announceSubscribers(topic);
    if (topic.subscribers.size > 0) requestKeyframe(topic, true);
    return {
      onMessage: (data) => {
        if (topic.publisher !== connection) return;
        if (typeof data !== "string") {
          if (!relayPacket(topic, data)) {
            connection.close(MEDIA_CHANNEL_CLOSE_PROTOCOL, "Malformed media packet.");
          }
          return;
        }
        const message = decodePublisherMessage(data);
        if (Option.isNone(message)) return;
        if (message.value.type === "broadcast") {
          const encoded = encodeSubscriberNotice({
            type: "broadcast",
            key: message.value.key,
            body: message.value.body,
          });
          topic.broadcasts.set(message.value.key, encoded);
          for (const subscriber of topic.subscribers.values()) subscriber.connection.send(encoded);
          return;
        }
        topic.subscribers
          .get(message.value.subscriber)
          ?.connection.send(
            encodeSubscriberNotice({ type: "unsupported", reason: message.value.reason }),
          );
      },
      disconnect: () => {
        if (topic.publisher !== connection) return;
        topic.publisher = null;
        for (const subscriber of topic.subscribers.values()) {
          subscriber.connection.send(encodeSubscriberNotice({ type: "publisher", online: false }));
        }
        releaseIfEmpty(name, topic);
      },
    };
  };

  const connectSubscriber = (
    name: string,
    connection: MediaRelayConnection,
  ): MediaRelayEndpoint => {
    const topic = topicFor(name);
    const subscriber: Subscriber = {
      connection,
      info: null,
      flow: createMediaFlow(),
      lastStatsAt: Number.NEGATIVE_INFINITY,
    };
    topic.subscribers.set(connection.id, subscriber);
    connection.send(
      encodeSubscriberNotice({ type: "publisher", online: topic.publisher !== null }),
    );
    for (const encoded of topic.broadcasts.values()) connection.send(encoded);
    return {
      onMessage: (data) => {
        if (topic.subscribers.get(connection.id) !== subscriber) return;
        if (typeof data !== "string") {
          const sequence = decodeMediaAck(data);
          if (sequence === null) return;
          const now = options.now();
          acknowledge(subscriber.flow, sequence, now);
          reportStats(topic, subscriber, false);
          if (wantsKeyframe(subscriber.flow, now, flowOptions)) requestKeyframe(topic, false);
          return;
        }
        const message = decodeSubscriberMessage(data);
        if (Option.isNone(message)) return;
        switch (message.value.type) {
          case "hello": {
            const joined = subscriber.info === null;
            subscriber.info = {
              id: connection.id,
              codecs: message.value.codecs,
              view: message.value.view,
            };
            announceSubscribers(topic);
            if (joined) requestKeyframe(topic, true);
            return;
          }
          case "view":
            if (!subscriber.info) return;
            subscriber.info = { ...subscriber.info, view: message.value.view };
            announceSubscribers(topic);
            return;
          case "keyframe":
            subscriber.flow.waitingForKeyframe = true;
            subscriber.flow.keyframeWanted = true;
            requestKeyframe(topic, false);
            return;
        }
      },
      disconnect: () => {
        if (topic.subscribers.get(connection.id) !== subscriber) return;
        topic.subscribers.delete(connection.id);
        if (subscriber.info) announceSubscribers(topic);
        releaseIfEmpty(name, topic);
      },
    };
  };

  /** Ends a topic for good: every connection on it is closed. */
  const closeTopic = (name: string, reason: string) => {
    const topic = topics.get(name);
    if (!topic) return;
    topics.delete(name);
    topic.publisher?.close(MEDIA_CHANNEL_CLOSE_TOPIC_ENDED, reason);
    topic.publisher = null;
    for (const subscriber of topic.subscribers.values()) {
      subscriber.connection.close(MEDIA_CHANNEL_CLOSE_TOPIC_ENDED, reason);
    }
    topic.subscribers.clear();
  };

  /**
   * Retries key frame requests that were rate limited. A subscriber waiting
   * for a key frame drops every inter frame, so on a screen that has gone
   * still nothing else would ever ask again and it would keep showing a
   * picture older than the screen.
   */
  const tick = () => {
    const now = options.now();
    for (const topic of topics.values()) {
      for (const subscriber of topic.subscribers.values()) {
        if (subscriber.info && wantsKeyframe(subscriber.flow, now, flowOptions)) {
          requestKeyframe(topic, false);
          break;
        }
      }
    }
  };

  const stats = (): MediaRelayCoreStats => ({
    topics: topics.size,
    subscribers: [...topics.values()].reduce((sum, topic) => sum + topic.subscribers.size, 0),
    ...counters,
  });

  return { connectPublisher, connectSubscriber, closeTopic, tick, stats };
}

export type MediaRelayCore = ReturnType<typeof createMediaRelayCore>;
