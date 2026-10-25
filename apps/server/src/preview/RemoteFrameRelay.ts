import type {
  PreviewAutomationStreamEvent,
  PreviewRemoteFrameDemand,
  PreviewRemoteFrameEvent,
  PreviewRemoteFramePageState,
  PreviewRemoteFramePublishInput,
  PreviewRemoteFrameWatchInput,
} from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as SynchronizedRef from "effect/SynchronizedRef";

import {
  appendPixels,
  budgetWaitMs,
  catchUp,
  emptyChain,
  fullBudget,
  initialCursor,
  pictureBytes,
  sameDemand,
  spendBudget,
  tabDemand,
  viewerRequest,
  type PixelChain,
  type ViewerBudget,
  type ViewerCursor,
  type ViewerRequest,
} from "./remoteFrameChannel.ts";

/**
 * A viewer may be sent about this much picture data per second on average;
 * a single change is never held back (see `burstBytes`). Under continuous
 * motion (a video, a scroll) the viewer gets fewer, newer pictures rather
 * than a growing queue, which keeps a phone's data use near what polling
 * cost while every isolated change still arrives at once.
 */
export const DEFAULT_VIEWER_BUDGET: ViewerBudget = {
  bytesPerSecond: 160_000,
  burstBytes: 640_000,
};

const NO_STREAMING_HOST =
  "No desktop that can stream this tab is connected, so the viewer is polling instead.";

interface Viewer {
  readonly request: ViewerRequest;
  readonly wake: Queue.Queue<void>;
}

interface Channel {
  readonly target: Pick<PreviewRemoteFrameDemand, "threadId" | "tabId">;
  readonly viewers: ReadonlyMap<number, Viewer>;
  readonly chain: PixelChain;
  readonly state: PreviewRemoteFramePageState | null;
  readonly stateVersion: number;
  readonly unavailable: { readonly reason: string; readonly version: number } | null;
  /** The host connection whose pictures this tab shows; one desktop at a time. */
  readonly publisher: string | null;
  readonly keyframeRequest: number;
}

interface RelayState {
  readonly channels: ReadonlyMap<string, Channel>;
  /** Connected hosts that can stream, by connection id (a host may reconnect under one id). */
  readonly hosts: ReadonlyMap<string, number>;
  readonly nextViewerId: number;
  readonly unavailableSequence: number;
}

const channelKey = (target: { readonly threadId: string; readonly tabId: string }) =>
  `${target.threadId}\u0000${target.tabId}`;

const wakeAll = (channel: Channel | undefined) =>
  channel === undefined
    ? Effect.void
    : Effect.forEach(channel.viewers.values(), (viewer) => Queue.offer(viewer.wake, undefined), {
        discard: true,
      });

/**
 * Carries a browser tab's pictures from the desktop that renders it to remote
 * viewers. Viewers subscribe with the size they can show; the relay tells
 * streaming-capable desktops which tabs are watched (`demand`), and they push
 * a keyframe followed by patches as the page changes. Each viewer is caught
 * up from the latest keyframe and patch chain whenever it is ready for more,
 * so a slow viewer gets fewer, newer pictures and never a backlog: the RPC
 * stream sends the next batch only after the viewer acknowledged the last.
 */
export class RemoteFrameRelay extends Context.Service<
  RemoteFrameRelay,
  {
    readonly watch: (input: PreviewRemoteFrameWatchInput) => Stream.Stream<PreviewRemoteFrameEvent>;
    readonly publish: (input: PreviewRemoteFramePublishInput) => Effect.Effect<void>;
    /** Every watched tab and what to send for it; the current set first, then each change. */
    readonly demand: Stream.Stream<ReadonlyArray<PreviewRemoteFrameDemand>>;
    /** Counts a streaming-capable host as connected for the life of the returned scope. */
    readonly hostConnected: (connectionId: string) => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/preview/RemoteFrameRelay") {}

export const make = (budget: ViewerBudget = DEFAULT_VIEWER_BUDGET) =>
  Effect.gen(function* () {
    const stateRef = yield* SynchronizedRef.make<RelayState>({
      channels: new Map(),
      hosts: new Map(),
      nextViewerId: 0,
      unavailableSequence: 0,
    });
    const demandRef = yield* SubscriptionRef.make<ReadonlyArray<PreviewRemoteFrameDemand>>([]);

    const demandOf = (channels: ReadonlyMap<string, Channel>) => {
      const tabs: Array<PreviewRemoteFrameDemand> = [];
      for (const channel of channels.values()) {
        const demand = tabDemand(
          channel.target,
          Array.from(channel.viewers.values(), (viewer) => viewer.request),
          channel.keyframeRequest,
        );
        if (demand !== null) tabs.push(demand);
      }
      return tabs;
    };

    /** Announces from inside the lock, so a stale set can never land last. */
    const announce = (state: RelayState) =>
      Effect.gen(function* () {
        const next = demandOf(state.channels);
        const current = yield* SubscriptionRef.get(demandRef);
        if (!sameDemand(current, next)) yield* SubscriptionRef.set(demandRef, next);
      }).pipe(
        Effect.withSpan("preview.remoteFrames.demand", {
          attributes: { "remoteFrames.tabs": state.channels.size },
        }),
      );

    const join = (input: PreviewRemoteFrameWatchInput, wake: Queue.Queue<void>) =>
      SynchronizedRef.modifyEffect(stateRef, (current) =>
        Effect.gen(function* () {
          const key = channelKey(input);
          const id = current.nextViewerId;
          const request = viewerRequest(input);
          const existing = current.channels.get(key);
          const viewers = new Map(existing?.viewers ?? []);
          viewers.set(id, { request, wake });
          const unavailableSequence = current.unavailableSequence + 1;
          let channel: Channel = existing
            ? { ...existing, viewers }
            : {
                target: { threadId: input.threadId, tabId: input.tabId },
                viewers,
                chain: emptyChain,
                state: null,
                stateVersion: 0,
                unavailable: null,
                publisher: null,
                keyframeRequest: 0,
              };
          if (current.hosts.size === 0 && channel.chain.keyframe === null) {
            channel = {
              ...channel,
              unavailable: { reason: NO_STREAMING_HOST, version: unavailableSequence },
            };
          }
          // A viewer that cannot draw patches needs a whole picture of now, not
          // the keyframe the patches since were drawn over.
          if (!request.patches && channel.chain.patches.length > 0) {
            channel = { ...channel, keyframeRequest: channel.keyframeRequest + 1 };
          }
          const channels = new Map(current.channels);
          channels.set(key, channel);
          const next: RelayState = {
            ...current,
            channels,
            nextViewerId: id + 1,
            unavailableSequence,
          };
          yield* announce(next);
          return [id, next] as const;
        }),
      );

    const leave = (input: PreviewRemoteFrameWatchInput, id: number) =>
      SynchronizedRef.updateEffect(stateRef, (current) =>
        Effect.gen(function* () {
          const key = channelKey(input);
          const existing = current.channels.get(key);
          if (!existing?.viewers.has(id)) return current;
          const channels = new Map(current.channels);
          const viewers = new Map(existing.viewers);
          viewers.delete(id);
          // The last viewer leaving drops the tab's pictures; the next one
          // starts the desktop's capture afresh.
          if (viewers.size === 0) channels.delete(key);
          else channels.set(key, { ...existing, viewers });
          const next = { ...current, channels };
          yield* announce(next);
          return next;
        }),
      );

    const watch: RemoteFrameRelay["Service"]["watch"] = (input) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const wake = yield* Queue.sliding<void>(1);
          yield* Effect.acquireRelease(
            join(input, wake).pipe(
              Effect.withSpan("preview.remoteFrames.viewerJoined", {
                attributes: {
                  "remoteFrames.threadId": input.threadId,
                  "remoteFrames.tabId": input.tabId,
                  "remoteFrames.maxWidth": input.maxWidth,
                  "remoteFrames.maxHeight": input.maxHeight,
                  "remoteFrames.patches": input.patches === true,
                },
              }),
            ),
            (joined) =>
              leave(input, joined).pipe(
                Effect.withSpan("preview.remoteFrames.viewerLeft", {
                  attributes: {
                    "remoteFrames.threadId": input.threadId,
                    "remoteFrames.tabId": input.tabId,
                  },
                }),
              ),
          );
          const drawsPatches = input.patches === true;
          let cursor: ViewerCursor = initialCursor;
          let spent = fullBudget(budget, yield* Clock.currentTimeMillis);
          // Runs only when the RPC layer is ready to send: the previous batch
          // was acknowledged. Whatever changed meanwhile goes out as one batch.
          const pull = Effect.gen(function* () {
            while (true) {
              const channel = (yield* SynchronizedRef.get(stateRef)).channels.get(
                channelKey(input),
              );
              const caught = channel === undefined ? null : catchUp(channel, cursor, drawsPatches);
              if (caught !== null && Arr.isReadonlyArrayNonEmpty(caught.events)) {
                const bytes = pictureBytes(caught.events);
                if (bytes > 0) {
                  const now = yield* Clock.currentTimeMillis;
                  const waitMs = budgetWaitMs(budget, spent, now);
                  if (waitMs > 0) {
                    // Wait, then catch up afresh: anything newer replaces this batch.
                    yield* Effect.sleep(Duration.millis(waitMs));
                    continue;
                  }
                  spent = spendBudget(budget, spent, bytes, now);
                }
                cursor = caught.cursor;
                return caught.events;
              }
              yield* Queue.take(wake);
            }
          });
          return Stream.fromPull(Effect.succeed(pull));
        }),
      );

    const publish: RemoteFrameRelay["Service"]["publish"] = (input) =>
      SynchronizedRef.modifyEffect(stateRef, (current) =>
        Effect.gen(function* () {
          const key = channelKey(input);
          const existing = current.channels.get(key);
          // Nobody is watching: the desktop has not seen the demand drop yet.
          if (existing === undefined || !current.hosts.has(input.connectionId))
            return [undefined, current] as const;
          // Fold into a private copy, then publish it atomically under the lock.
          const channel = { ...existing };
          let unavailableSequence = current.unavailableSequence;
          let keyframeNeeded = false;
          const owns = channel.publisher === null || channel.publisher === input.connectionId;
          for (const event of input.events) {
            switch (event.type) {
              case "keyframe":
              case "patch": {
                if (!owns) break;
                const appended = appendPixels(channel.chain, event);
                keyframeNeeded ||= appended.needsKeyframe;
                Object.assign(channel, {
                  chain: appended.chain,
                  publisher: input.connectionId,
                  unavailable: appended.accepted ? null : channel.unavailable,
                });
                break;
              }
              case "state": {
                if (!owns) break;
                Object.assign(channel, {
                  state: event.state,
                  stateVersion: channel.stateVersion + 1,
                });
                break;
              }
              case "unavailable": {
                if (!owns) break;
                unavailableSequence += 1;
                // The desktop showing this tab cannot capture it any more:
                // viewers keep their last picture and poll until it can.
                Object.assign(channel, {
                  chain: emptyChain,
                  publisher: null,
                  unavailable: { reason: event.reason, version: unavailableSequence },
                });
                break;
              }
            }
          }
          if (keyframeNeeded) channel.keyframeRequest += 1;
          const channels = new Map(current.channels);
          channels.set(key, channel);
          const next: RelayState = { ...current, channels, unavailableSequence };
          if (keyframeNeeded) yield* announce(next);
          return [channel, next] as const;
        }),
      ).pipe(
        Effect.tap(wakeAll),
        Effect.tap((channel) =>
          Effect.annotateCurrentSpan({
            "remoteFrames.threadId": input.threadId,
            "remoteFrames.tabId": input.tabId,
            "remoteFrames.events": input.events.map((event) => event.type).join(","),
            "remoteFrames.bytes": pictureBytes(input.events),
            "remoteFrames.viewers": channel?.viewers.size ?? 0,
          }),
        ),
        Effect.asVoid,
      );

    const setHostCount = (connectionId: string, delta: 1 | -1) =>
      SynchronizedRef.modifyEffect(stateRef, (current) =>
        Effect.gen(function* () {
          const hosts = new Map(current.hosts);
          const count = (hosts.get(connectionId) ?? 0) + delta;
          if (count > 0) hosts.set(connectionId, count);
          else hosts.delete(connectionId);
          let unavailableSequence = current.unavailableSequence;
          const channels = new Map<string, Channel>();
          const changed: Array<Channel> = [];
          for (const [key, channel] of current.channels) {
            let next = channel;
            if (delta === -1 && count <= 0 && channel.publisher === connectionId) {
              // Its desktop went away: another one may pick the tab up.
              unavailableSequence += 1;
              next = {
                ...next,
                publisher: null,
                chain: emptyChain,
                keyframeRequest: next.keyframeRequest + 1,
                unavailable: { reason: NO_STREAMING_HOST, version: unavailableSequence },
              };
            }
            if (hosts.size === 0 && next.chain.keyframe === null) {
              unavailableSequence += 1;
              next = {
                ...next,
                unavailable: { reason: NO_STREAMING_HOST, version: unavailableSequence },
              };
            }
            if (next !== channel) changed.push(next);
            channels.set(key, next);
          }
          const next = { ...current, hosts, channels, unavailableSequence };
          yield* announce(next);
          return [changed, next] as const;
        }),
      ).pipe(Effect.flatMap((changed) => Effect.forEach(changed, wakeAll, { discard: true })));

    const hostConnected: RemoteFrameRelay["Service"]["hostConnected"] = (connectionId) =>
      Effect.acquireRelease(setHostCount(connectionId, 1), () => setHostCount(connectionId, -1));

    return RemoteFrameRelay.of({
      watch,
      publish,
      demand: SubscriptionRef.changes(demandRef),
      hostConnected,
    });
  });

export const layer = Layer.effect(RemoteFrameRelay, make());

/**
 * Adds the relay's demand to a streaming-capable desktop host's automation
 * stream, and counts the host as connected while that stream lives. Hosts file
 * every event under the connection it arrived on, so demand waits for the
 * stream's own `connected` event and ends with it.
 */
export const withRemoteFrameDemand = (
  events: Stream.Stream<PreviewAutomationStreamEvent>,
  relay: RemoteFrameRelay["Service"],
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
        Effect.gen(function* () {
          const connectionId = yield* Deferred.await(connected);
          yield* relay.hostConnected(connectionId);
          return relay.demand.pipe(
            Stream.map(
              (tabs): PreviewAutomationStreamEvent => ({
                type: "frameDemand",
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
