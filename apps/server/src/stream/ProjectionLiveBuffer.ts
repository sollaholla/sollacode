import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

export interface ProjectionLiveBuffer<A> {
  readonly offer: (item: A) => Effect.Effect<boolean>;
  readonly stream: Stream.Stream<A>;
  readonly takeAll: Effect.Effect<ReadonlyArray<A>>;
  readonly resyncRequired: Effect.Effect<boolean>;
}

/**
 * Bridges the snapshot/replay phase of a projection subscription to its live
 * tail without allowing a slow client to retain domain events indefinitely.
 * Once capacity is exceeded, all disposable projection deltas are replaced by
 * one authoritative resynchronization marker and later deltas are ignored.
 */
export const make = Effect.fn("ProjectionLiveBuffer.make")(function* <A>(input: {
  readonly capacity: number;
  readonly resyncItem: A;
}): Effect.fn.Return<ProjectionLiveBuffer<A>> {
  const queue = yield* Queue.dropping<A>(input.capacity);
  const resyncRequired = yield* SynchronizedRef.make(false);

  const offerWithState = Effect.fn("ProjectionLiveBuffer.offerWithState")(function* (state: {
    readonly item: A;
    readonly overflowed: boolean;
  }): Effect.fn.Return<readonly [accepted: boolean, overflowed: boolean]> {
    if (state.overflowed) {
      return [false, true];
    }
    if (yield* Queue.offer(queue, state.item)) {
      return [true, false];
    }
    yield* Queue.takeAll(queue);
    yield* Queue.offer(queue, input.resyncItem);
    return [false, true];
  });

  const offer = Effect.fn("ProjectionLiveBuffer.offer")(function* (item: A) {
    return yield* SynchronizedRef.modifyEffect(resyncRequired, (overflowed) =>
      offerWithState({ item, overflowed }),
    );
  });

  return {
    offer,
    stream: Stream.fromQueue(queue),
    takeAll: Queue.takeAll(queue),
    resyncRequired: SynchronizedRef.get(resyncRequired),
  };
});
