import type {
  PreviewAutomationStreamEvent,
  PreviewTabAudioEvent,
  PreviewTabAudioPublishInput,
  PreviewTabAudioTarget,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";

/**
 * Events buffered per listener (about three seconds of 100 ms batches). Audio
 * is live: a listener that falls further behind loses the oldest, never the
 * newest.
 */
const LISTENER_BUFFER = 32;

interface Channel {
  readonly target: PreviewTabAudioTarget;
  readonly listeners: number;
  readonly audible: boolean;
  readonly events: PubSub.PubSub<PreviewTabAudioEvent>;
}

interface Joined {
  readonly channel: Channel;
  /** This listener opened the channel, so the desktop has to hear of it. */
  readonly created: boolean;
}

const channelKey = (target: PreviewTabAudioTarget) => `${target.threadId}\u0000${target.tabId}`;

/**
 * Carries a browser tab's sound from the desktop that renders it to remote
 * viewers. The relay only counts who is listening: the desktop learns which
 * tabs have listeners (`demand`) and captures a tab only while it is both
 * listened to and actually making sound, so a quiet or unwatched tab sends
 * nothing at all.
 */
export class TabAudioRelay extends Context.Service<
  TabAudioRelay,
  {
    readonly listen: (target: PreviewTabAudioTarget) => Stream.Stream<PreviewTabAudioEvent>;
    readonly publish: (input: PreviewTabAudioPublishInput) => Effect.Effect<void>;
    /** Every tab with at least one listener; the current set first, then each change. */
    readonly demand: Stream.Stream<ReadonlyArray<PreviewTabAudioTarget>>;
  }
>()("t3/preview/TabAudioRelay") {}

export const make = Effect.gen(function* () {
  const channels = yield* SynchronizedRef.make(new Map<string, Channel>());
  const demand = yield* SubscriptionRef.make<ReadonlyArray<PreviewTabAudioTarget>>([]);
  // The spans below are the relay's evidence in the server trace: who is
  // listening, what the desktop was asked for, and what it actually sent.
  const announce = (next: ReadonlyMap<string, Channel>) =>
    SubscriptionRef.set(
      demand,
      Array.from(next.values(), (channel) => channel.target),
    ).pipe(
      Effect.withSpan("preview.tabAudio.demand", { attributes: { "tabAudio.tabs": next.size } }),
    );

  /** Announces from inside the lock, so a stale set can never land last. */
  const announceCurrent = SynchronizedRef.updateEffect(channels, (current) =>
    Effect.as(announce(current), current),
  );

  const joined = (channel: Channel, created: boolean): Joined => ({ channel, created });

  const join = (target: PreviewTabAudioTarget): Effect.Effect<Joined> =>
    SynchronizedRef.modifyEffect(channels, (current) =>
      Effect.gen(function* () {
        const key = channelKey(target);
        const next = new Map(current);
        const existing = current.get(key);
        if (existing) {
          next.set(key, { ...existing, listeners: existing.listeners + 1 });
          return [joined(existing, false), next] as const;
        }
        const channel: Channel = {
          target,
          listeners: 1,
          audible: false,
          events: yield* PubSub.sliding<PreviewTabAudioEvent>(LISTENER_BUFFER),
        };
        next.set(key, channel);
        return [joined(channel, true), next] as const;
      }),
    );

  const leave = (target: PreviewTabAudioTarget): Effect.Effect<void> =>
    SynchronizedRef.updateEffect(channels, (current) =>
      Effect.gen(function* () {
        const key = channelKey(target);
        const existing = current.get(key);
        if (!existing) return current;
        const next = new Map(current);
        if (existing.listeners > 1) {
          next.set(key, { ...existing, listeners: existing.listeners - 1 });
          return next;
        }
        next.delete(key);
        yield* PubSub.shutdown(existing.events);
        yield* announce(next);
        return next;
      }),
    );

  const listen: TabAudioRelay["Service"]["listen"] = (target) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const { channel, created } = yield* Effect.acquireRelease(
          join(target).pipe(
            Effect.tap(({ channel: joinedChannel }) =>
              Effect.annotateCurrentSpan("tabAudio.listeners", joinedChannel.listeners),
            ),
            Effect.withSpan("preview.tabAudio.listenerJoined", {
              attributes: { "tabAudio.threadId": target.threadId, "tabAudio.tabId": target.tabId },
            }),
          ),
          () =>
            leave(target).pipe(
              Effect.withSpan("preview.tabAudio.listenerLeft", {
                attributes: {
                  "tabAudio.threadId": target.threadId,
                  "tabAudio.tabId": target.tabId,
                },
              }),
            ),
        );
        const subscription = yield* PubSub.subscribe(channel.events);
        // Only now tell the desktop: its first packets must find a listener.
        if (created) yield* announceCurrent;
        // A second listener arriving mid-sound learns it at once rather than
        // at the next change.
        return channel.audible
          ? Stream.concat(
              Stream.succeed<PreviewTabAudioEvent>({ type: "audible", audible: true }),
              Stream.fromSubscription(subscription),
            )
          : Stream.fromSubscription(subscription);
      }),
    );

  const publish: TabAudioRelay["Service"]["publish"] = (input) =>
    SynchronizedRef.modify(channels, (current) => {
      const key = channelKey(input);
      const channel = current.get(key);
      if (!channel || input.event.type !== "audible" || channel.audible === input.event.audible) {
        return [channel, current] as const;
      }
      const next = new Map(current);
      next.set(key, { ...channel, audible: input.event.audible });
      return [channel, next] as const;
    }).pipe(
      Effect.tap((channel) =>
        Effect.annotateCurrentSpan({
          "tabAudio.event": input.event.type,
          "tabAudio.listeners": channel?.listeners ?? 0,
          ...(input.event.type === "packets"
            ? {
                "tabAudio.packets": input.event.packets.length,
                "tabAudio.bytes": input.event.packets.reduce(
                  (total, packet) => total + packet.data.length,
                  0,
                ),
              }
            : {
                "tabAudio.audible": input.event.audible,
                ...(input.event.reason === undefined
                  ? {}
                  : { "tabAudio.reason": input.event.reason }),
              }),
        }),
      ),
      Effect.flatMap((channel) =>
        channel ? PubSub.publish(channel.events, input.event) : Effect.void,
      ),
      Effect.asVoid,
    );

  return TabAudioRelay.of({ listen, publish, demand: SubscriptionRef.changes(demand) });
});

export const layer = Layer.effect(TabAudioRelay, make);

/**
 * Adds the relay's demand to a desktop host's automation stream. Hosts file
 * every event under the connection it arrived on, so demand waits for the
 * stream's own `connected` event and ends with it.
 */
export const withTabAudioDemand = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  demand: Stream.Stream<ReadonlyArray<PreviewTabAudioTarget>>,
): Stream.Stream<PreviewAutomationStreamEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connected = yield* Deferred.make<PreviewAutomationStreamEvent["connectionId"]>();
      const hostEvents = events.pipe(
        Stream.tap((event) =>
          event.type === "connected"
            ? Deferred.succeed(connected, event.connectionId)
            : Effect.void,
        ),
      );
      const demandEvents = Stream.unwrap(
        Effect.map(Deferred.await(connected), (connectionId) =>
          demand.pipe(
            Stream.tap((tabs) =>
              Effect.withSpan(Effect.void, "preview.tabAudio.demandSent", {
                attributes: { "tabAudio.connectionId": connectionId, "tabAudio.tabs": tabs.length },
              }),
            ),
            Stream.map(
              (tabs): PreviewAutomationStreamEvent => ({ type: "audioDemand", connectionId, tabs }),
            ),
          ),
        ),
      );
      return Stream.merge(hostEvents, demandEvents, { haltStrategy: "left" });
    }),
  );
