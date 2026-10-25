import { PreviewTabId, ThreadId, type PreviewRemoteFrameEvent } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as Stream from "effect/Stream";
import * as RemoteFrameRelay from "./RemoteFrameRelay.ts";

const target = { threadId: ThreadId.make("thread"), tabId: PreviewTabId.make("tab") };
const watch = { ...target, maxWidth: 640, maxHeight: 480, patches: true };
const keyframe: PreviewRemoteFrameEvent = {
  type: "keyframe",
  sequence: 0,
  width: 64,
  height: 64,
  mimeType: "image/jpeg",
  data: "frame",
};
const demandOf = (relay: RemoteFrameRelay.RemoteFrameRelay["Service"], count: number) =>
  relay.demand.pipe(
    Stream.filter((tabs) => tabs.length === count),
    Stream.runHead,
  );

describe("RemoteFrameRelay", () => {
  it.effect("captures only while a viewer is subscribed and releases demand on disconnect", () =>
    Effect.gen(function* () {
      const relay = yield* RemoteFrameRelay.make();
      yield* relay.hostConnected("host");
      expect(yield* relay.demand.pipe(Stream.runHead)).toEqual(Option.some([]));
      const viewer = yield* relay.watch(watch).pipe(Stream.runDrain, Effect.forkChild);
      const demand = yield* demandOf(relay, 1);
      expect(Option.getOrThrow(demand)[0]).toMatchObject(watch);
      yield* Fiber.interrupt(viewer);
      expect(yield* demandOf(relay, 0)).toEqual(Option.some([]));
    }),
  );
  it.effect("tells viewers to poll when there is no streaming desktop", () =>
    Effect.gen(function* () {
      const relay = yield* RemoteFrameRelay.make();
      const first = yield* relay.watch(watch).pipe(Stream.runHead);
      expect(Option.getOrThrow(first).type).toBe("unavailable");
      expect(yield* demandOf(relay, 0)).toEqual(Option.some([]));
    }),
  );
  it.effect("ignores disconnected publishers and delivers only the watched tab", () =>
    Effect.gen(function* () {
      const relay = yield* RemoteFrameRelay.make();
      yield* relay.hostConnected("host");
      const viewer = yield* relay.watch(watch).pipe(Stream.runHead, Effect.forkChild);
      yield* demandOf(relay, 1);
      yield* relay.publish({
        ...target,
        connectionId: "disconnected",
        events: [{ ...keyframe, data: "wrong-host" }],
      });
      yield* relay.publish({
        ...target,
        tabId: PreviewTabId.make("other"),
        connectionId: "host",
        events: [{ ...keyframe, data: "wrong-tab" }],
      });
      yield* relay.publish({ ...target, connectionId: "host", events: [keyframe] });
      expect(yield* Fiber.join(viewer)).toEqual(Option.some(keyframe));
    }),
  );
  it.effect("requests a fresh keyframe for a broken chain", () =>
    Effect.gen(function* () {
      const relay = yield* RemoteFrameRelay.make();
      yield* relay.hostConnected("host");
      const viewer = yield* relay.watch(watch).pipe(Stream.runDrain, Effect.forkChild);
      yield* demandOf(relay, 1);
      yield* relay.publish({
        ...target,
        connectionId: "host",
        events: [
          {
            type: "patch",
            sequence: 4,
            after: 3,
            width: 64,
            height: 64,
            mimeType: "image/jpeg",
            patches: [],
          },
        ],
      });
      expect(Option.getOrThrow(yield* relay.demand.pipe(Stream.runHead))[0]?.keyframeRequest).toBe(
        1,
      );
      yield* Fiber.interrupt(viewer);
    }),
  );
  it.effect(
    "falls back immediately when the publishing host disconnects even with another host connected",
    () =>
      Effect.gen(function* () {
        const relay = yield* RemoteFrameRelay.make();
        const publisher = yield* Scope.make();
        yield* relay.hostConnected("host").pipe(Scope.provide(publisher));
        yield* relay.hostConnected("other-host");
        const received = yield* Queue.unbounded<PreviewRemoteFrameEvent>();
        const viewer = yield* relay.watch(watch).pipe(
          Stream.runForEach((event) => Queue.offer(received, event)),
          Effect.forkChild,
        );
        yield* demandOf(relay, 1);
        yield* relay.publish({ ...target, connectionId: "host", events: [keyframe] });
        expect(yield* Queue.take(received)).toEqual(keyframe);
        yield* Scope.close(publisher, Exit.void);
        expect((yield* Queue.take(received)).type).toBe("unavailable");
        yield* relay.publish({
          ...target,
          connectionId: "other-host",
          events: [{ ...keyframe, data: "new-host" }],
        });
        expect(yield* Queue.take(received)).toEqual({ ...keyframe, data: "new-host" });
        yield* Fiber.interrupt(viewer);
      }),
  );
});
