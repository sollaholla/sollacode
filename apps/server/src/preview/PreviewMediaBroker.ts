import {
  PreviewMediaAccessDeniedError,
  type AuthSessionId,
  type EnvironmentId,
  type MediaChannelTicket,
  type PreviewAutomationStreamEvent,
  type PreviewHostMediaTicketInput,
  type PreviewMediaDemand,
  type PreviewMediaTicketInput,
  type PreviewMediaWatchEvent,
  type PreviewMediaWatchInput,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { MediaRelay } from "../media/MediaRelay.ts";
import { PreviewAutomationBroker, type PreviewMediaHost } from "../mcp/PreviewAutomationBroker.ts";
import { resolveOwningThreadIdWith } from "../mcp/owningThread.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PreviewManager } from "./Manager.ts";

export class PreviewMediaBroker extends Context.Service<
  PreviewMediaBroker,
  {
    readonly watch: (
      input: PreviewMediaWatchInput,
      sessionId: AuthSessionId,
    ) => Stream.Stream<PreviewMediaWatchEvent>;
    readonly issueTicket: (
      input: PreviewMediaTicketInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<MediaChannelTicket, PreviewMediaAccessDeniedError>;
    readonly issueHostTicket: (
      input: PreviewHostMediaTicketInput,
      sessionId: AuthSessionId,
    ) => Effect.Effect<MediaChannelTicket, PreviewMediaAccessDeniedError>;
    readonly demand: (connectionId: string) => Stream.Stream<ReadonlyArray<PreviewMediaDemand>>;
  }
>()("t3/preview/PreviewMediaBroker") {}

interface Watcher {
  readonly sessionId: AuthSessionId;
  readonly events: SubscriptionRef.SubscriptionRef<PreviewMediaWatchEvent>;
  watchId: string | null;
}
interface Channel {
  readonly target: PreviewMediaDemand;
  readonly viewers: Set<Watcher>;
  host: PreviewMediaHost | undefined;
  topic: string | null;
  closed: boolean;
}
interface Demand {
  readonly connectionId: string;
  readonly target: PreviewMediaDemand;
}
const keyOf = (target: { readonly threadId: string; readonly tabId: string }) =>
  `${target.threadId}\u0000${target.tabId}`;
const sameHost = (left: PreviewMediaHost | undefined, right: PreviewMediaHost | undefined) =>
  left?.connectionId === right?.connectionId &&
  left?.clientId === right?.clientId &&
  left?.sessionId === right?.sessionId;
const sameTargets = (
  left: ReadonlyArray<PreviewMediaDemand>,
  right: ReadonlyArray<PreviewMediaDemand>,
) =>
  left.length === right.length &&
  left.every(
    (target, index) =>
      target.threadId === right[index]?.threadId && target.tabId === right[index]?.tabId,
  );
const sameDemand = (left: ReadonlyArray<Demand>, right: ReadonlyArray<Demand>) =>
  left.length === right.length &&
  left.every(
    (demand, index) =>
      demand.connectionId === right[index]?.connectionId &&
      demand.target.threadId === right[index]?.target.threadId &&
      demand.target.tabId === right[index]?.target.tabId,
  );
const unavailable: PreviewMediaWatchEvent = {
  type: "unavailable",
  reason: "This tab has no connected video host; using preview frames instead.",
};

/** The media relay stays generic. Tab ownership and short-lived grants live here. */
export const make = (dependencies: {
  readonly automation: Pick<
    PreviewAutomationBroker["Service"],
    "mediaHostFor" | "mediaRoutingChanges"
  >;
  readonly manager: Pick<PreviewManager["Service"], "hasSession" | "subscribeEvents">;
  readonly relay: MediaRelay["Service"];
  readonly environmentId: EnvironmentId;
  readonly owningThreadId: (threadId: ThreadId) => Effect.Effect<ThreadId>;
}) =>
  Effect.gen(function* () {
    const { automation, manager, relay, environmentId } = dependencies;
    const crypto = yield* Crypto.Crypto;
    const lock = yield* Semaphore.make(1);
    const channels = new Map<string, Channel>();
    const watches = new Map<string, { readonly channel: Channel; readonly viewer: Watcher }>();
    const demandRef = yield* SubscriptionRef.make<ReadonlyArray<Demand>>([]);

    const selectedHost = (channel: Channel) =>
      !channel.closed && manager.hasSession(channel.target)
        ? automation.mediaHostFor({ ...channel.target, environmentId })
        : undefined;
    const active = (channel: Channel, topic: string) =>
      channels.get(keyOf(channel.target)) === channel &&
      channel.topic === topic &&
      channel.viewers.size > 0 &&
      channel.host !== undefined &&
      sameHost(channel.host, selectedHost(channel));

    const announce = Effect.fn("PreviewMediaBroker.announce")(function* () {
      const next = Array.from(channels.values()).flatMap((channel): Demand[] =>
        channel.host && channel.topic
          ? [{ connectionId: channel.host.connectionId, target: channel.target }]
          : [],
      );
      const previous = yield* SubscriptionRef.get(demandRef);
      if (!sameDemand(next, previous)) yield* SubscriptionRef.set(demandRef, next);
    });

    const invalidate = Effect.fn("PreviewMediaBroker.invalidate")(function* (channel: Channel) {
      const topic = channel.topic;
      channel.topic = null;
      channel.host = undefined;
      for (const viewer of channel.viewers) {
        if (viewer.watchId !== null) watches.delete(viewer.watchId);
        viewer.watchId = null;
      }
      if (topic !== null) yield* relay.closeTopic(topic, "Preview video ended.");
    });

    const ready = Effect.fn("PreviewMediaBroker.ready")(function* (
      channel: Channel,
      viewer: Watcher,
    ) {
      const watchId = yield* crypto.randomUUIDv4.pipe(Effect.orDie);
      viewer.watchId = watchId;
      watches.set(watchId, { channel, viewer });
      yield* SubscriptionRef.set(viewer.events, { type: "ready", watchId });
    });

    const reconcile = Effect.fn("PreviewMediaBroker.reconcile")(function* () {
      for (const channel of channels.values()) {
        const host = selectedHost(channel);
        if (sameHost(channel.host, host)) continue;
        yield* invalidate(channel);
        if (host) {
          channel.host = host;
          channel.topic = `preview:${yield* crypto.randomUUIDv4.pipe(Effect.orDie)}`;
        }
        for (const viewer of channel.viewers) {
          if (host) yield* ready(channel, viewer);
          else yield* SubscriptionRef.set(viewer.events, unavailable);
        }
      }
      yield* announce();
    });

    const leave = Effect.fn("PreviewMediaBroker.leave")(function* (
      channel: Channel,
      viewer: Watcher,
    ) {
      if (viewer.watchId !== null) watches.delete(viewer.watchId);
      viewer.watchId = null;
      channel.viewers.delete(viewer);
      if (channel.viewers.size === 0) {
        yield* invalidate(channel);
        channels.delete(keyOf(channel.target));
        yield* announce();
      }
    });

    const join = Effect.fn("PreviewMediaBroker.join")(function* (
      target: PreviewMediaDemand,
      sessionId: AuthSessionId,
    ) {
      const key = keyOf(target);
      let channel = channels.get(key);
      if (!channel) {
        channel = { target, viewers: new Set(), host: undefined, topic: null, closed: false };
        channels.set(key, channel);
      }
      // Reconcile existing viewers before adding this one so each receives one
      // ready event per generation, including a host replacement during join.
      yield* reconcile();
      const viewer: Watcher = {
        sessionId,
        events: yield* SubscriptionRef.make<PreviewMediaWatchEvent>(unavailable),
        watchId: null,
      };
      channel.viewers.add(viewer);
      if (channel.host) yield* ready(channel, viewer);
      yield* announce();
      return { channel, viewer };
    });

    const watch: PreviewMediaBroker["Service"]["watch"] = (input, sessionId) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const threadId = yield* dependencies.owningThreadId(input.threadId);
          const target = { threadId, tabId: input.tabId };
          const joined = yield* Effect.acquireRelease(
            lock.withPermit(join(target, sessionId)),
            ({ channel, viewer }) => lock.withPermit(leave(channel, viewer)),
          );
          return SubscriptionRef.changes(joined.viewer.events);
        }),
      );

    const denied = () =>
      new PreviewMediaAccessDeniedError({
        message: "This preview video watch or desktop connection is no longer authorized.",
      });
    const issueTicket = Effect.fn("PreviewMediaBroker.issueTicket")(function* (
      input: PreviewMediaTicketInput,
      sessionId: AuthSessionId,
    ) {
      const watched = watches.get(input.watchId);
      if (
        !watched ||
        watched.viewer.sessionId !== sessionId ||
        watched.channel.topic === null ||
        !active(watched.channel, watched.channel.topic)
      )
        return yield* denied();
      const { channel, viewer } = watched;
      const topic = watched.channel.topic;
      return yield* relay.issueTicket({
        topic,
        role: "subscribe",
        isActive: () =>
          watches.get(input.watchId) === watched &&
          viewer.sessionId === sessionId &&
          active(channel, topic),
      });
    });
    const issueHostTicket = Effect.fn("PreviewMediaBroker.issueHostTicket")(function* (
      input: PreviewHostMediaTicketInput,
      sessionId: AuthSessionId,
    ) {
      const threadId = yield* dependencies.owningThreadId(input.threadId);
      const channel = channels.get(keyOf({ threadId, tabId: input.tabId }));
      if (
        !channel ||
        channel.topic === null ||
        channel.host?.sessionId !== sessionId ||
        channel.host.clientId !== input.clientId ||
        channel.host.connectionId !== input.connectionId ||
        !active(channel, channel.topic)
      )
        return yield* denied();
      const topic = channel.topic;
      return yield* relay.issueTicket({
        topic,
        role: "publish",
        isActive: () =>
          active(channel, topic) &&
          channel.host?.sessionId === sessionId &&
          channel.host.clientId === input.clientId &&
          channel.host.connectionId === input.connectionId,
      });
    });

    // Subscribe before serving watches, so a close racing a new watch cannot be
    // missed. The synchronous grant check also observes tab removal immediately.
    const previewEvents = yield* manager.subscribeEvents;
    yield* Stream.fromSubscription(previewEvents).pipe(
      Stream.filter((event) => event.type === "closed"),
      Stream.runForEach((event) =>
        lock.withPermit(
          Effect.gen(function* () {
            const channel = channels.get(keyOf(event));
            if (!channel) return;
            // Manager publishes while committing its mutation. Honor the close
            // receipt itself even if its synchronous state read still sees the tab.
            channel.closed = true;
            yield* invalidate(channel);
            for (const viewer of channel.viewers)
              yield* SubscriptionRef.set(viewer.events, unavailable);
            yield* announce();
          }),
        ),
      ),
      Effect.forkScoped,
    );
    yield* automation.mediaRoutingChanges.pipe(
      Stream.runForEach(() => lock.withPermit(reconcile())),
      Effect.forkScoped,
    );
    yield* Effect.addFinalizer(() =>
      lock.withPermit(Effect.forEach(channels.values(), invalidate, { discard: true })),
    );

    return PreviewMediaBroker.of({
      watch,
      issueTicket: (input, sessionId) => lock.withPermit(issueTicket(input, sessionId)),
      issueHostTicket: (input, sessionId) => lock.withPermit(issueHostTicket(input, sessionId)),
      demand: (connectionId) =>
        SubscriptionRef.changes(demandRef).pipe(
          Stream.map((demands) =>
            demands
              .filter((demand) => demand.connectionId === connectionId)
              .map((demand) => demand.target),
          ),
          Stream.changesWith(sameTargets),
        ),
    });
  });

export const layer = Layer.effect(
  PreviewMediaBroker,
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    return yield* make({
      automation: yield* PreviewAutomationBroker,
      manager: yield* PreviewManager,
      relay: yield* MediaRelay,
      environmentId: yield* (yield* ServerEnvironment).getEnvironmentId,
      owningThreadId: (threadId) => resolveOwningThreadIdWith(projections, threadId),
    });
  }),
);

/** New demand events are opt-in; old JPEG and native clients never see them. */
export const withPreviewMediaDemand = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  broker: PreviewMediaBroker["Service"],
): Stream.Stream<PreviewAutomationStreamEvent> =>
  Stream.unwrap(
    Effect.gen(function* () {
      const connected = yield* Deferred.make<string>();
      const hostEvents = events.pipe(
        Stream.tap((event) =>
          event.type === "connected"
            ? Deferred.succeed(connected, event.connectionId)
            : Effect.void,
        ),
      );
      const demandEvents = Stream.unwrap(
        Effect.gen(function* () {
          const connectionId = yield* Deferred.await(connected);
          return broker.demand(connectionId).pipe(
            Stream.map(
              (tabs): PreviewAutomationStreamEvent => ({
                type: "mediaDemand",
                connectionId,
                tabs,
              }),
            ),
          );
        }),
      );
      return Stream.merge(hostEvents, demandEvents, { haltStrategy: "left" });
    }),
  );
