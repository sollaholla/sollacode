import {
  PreviewTabId,
  ThreadId,
  type PreviewAutomationStreamEvent,
  type PreviewTabAudioEvent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as TabAudioRelay from "./TabAudioRelay.ts";

const tab = { threadId: ThreadId.make("thread-1"), tabId: PreviewTabId.make("tab-1") };
const otherTab = { threadId: ThreadId.make("thread-1"), tabId: PreviewTabId.make("tab-2") };

const packets: PreviewTabAudioEvent = {
  type: "packets",
  format: { codec: "opus", sampleRate: 48_000, numberOfChannels: 2 },
  packets: [{ timestamp: 0, duration: 20_000, data: "AAEC" }],
};

/** Resolves once the relay's demand has exactly `count` tabs. */
const demandOf = (relay: TabAudioRelay.TabAudioRelay["Service"], count: number) =>
  relay.demand.pipe(
    Stream.filter((tabs) => tabs.length === count),
    Stream.runHead,
  );

describe("TabAudioRelay", () => {
  it.effect("asks for a tab while someone listens, and stops asking when they leave", () =>
    Effect.gen(function* () {
      const relay = yield* TabAudioRelay.make;
      expect(yield* relay.demand.pipe(Stream.runHead)).toEqual(Option.some([]));

      const first = yield* relay.listen(tab).pipe(Stream.runDrain, Effect.forkChild);
      yield* demandOf(relay, 1);
      // A playing tab greets each new listener, which is how this test knows
      // the second one has joined.
      yield* relay.publish({ ...tab, event: { type: "audible", audible: true } });
      const joined = yield* Deferred.make<void>();
      const second = yield* relay.listen(tab).pipe(
        Stream.tap(() => Deferred.succeed(joined, undefined)),
        Stream.runDrain,
        Effect.forkChild,
      );
      yield* Deferred.await(joined);

      yield* Fiber.interrupt(first);
      // Still one listener, so the tab is still wanted.
      expect(yield* relay.demand.pipe(Stream.runHead)).toEqual(Option.some([tab]));

      yield* Fiber.interrupt(second);
      yield* demandOf(relay, 0);
    }),
  );

  it.effect("delivers a tab's sound only to that tab's listeners", () =>
    Effect.gen(function* () {
      const relay = yield* TabAudioRelay.make;
      const heard = yield* relay
        .listen(tab)
        .pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      yield* demandOf(relay, 1);

      yield* relay.publish({ ...otherTab, event: packets });
      yield* relay.publish({ ...tab, event: { type: "audible", audible: true } });
      yield* relay.publish({ ...tab, event: packets });

      expect(yield* Fiber.join(heard)).toEqual([{ type: "audible", audible: true }, packets]);
      // The listener left once it had what it wanted.
      yield* demandOf(relay, 0);
    }),
  );

  it.effect("tells a listener who joins mid-sound that the tab is playing", () =>
    Effect.gen(function* () {
      const relay = yield* TabAudioRelay.make;
      const first = yield* relay.listen(tab).pipe(Stream.runDrain, Effect.forkChild);
      yield* demandOf(relay, 1);
      yield* relay.publish({ ...tab, event: { type: "audible", audible: true } });

      const late = yield* relay.listen(tab).pipe(Stream.take(1), Stream.runCollect);
      expect(late).toEqual([{ type: "audible", audible: true }]);
      yield* Fiber.interrupt(first);
    }),
  );
});

describe("withTabAudioDemand", () => {
  it.effect("tags demand with the host's connection and ends with the host stream", () =>
    Effect.gen(function* () {
      const hostEvents = yield* Queue.unbounded<PreviewAutomationStreamEvent>();
      const demand = yield* Queue.unbounded<ReadonlyArray<typeof tab>>();
      yield* Queue.offer(demand, [tab]);

      const merged = yield* TabAudioRelay.withTabAudioDemand(
        Stream.fromQueue(hostEvents),
        Stream.fromQueue(demand),
      ).pipe(Stream.take(2), Stream.runCollect, Effect.forkChild);
      // Nothing about demand goes out before the host knows its connection.
      yield* Queue.offer(hostEvents, { type: "connected", connectionId: "connection-1" });

      expect(yield* Fiber.join(merged)).toEqual([
        { type: "connected", connectionId: "connection-1" },
        { type: "audioDemand", connectionId: "connection-1", tabs: [tab] },
      ]);

      const ended = yield* TabAudioRelay.withTabAudioDemand(Stream.empty, Stream.never).pipe(
        Stream.runCollect,
      );
      expect(ended).toEqual([]);
    }),
  );
});
