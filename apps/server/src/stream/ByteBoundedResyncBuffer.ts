import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

interface BufferedItem<A> {
  readonly item: A;
  readonly bytes: number;
}

interface BufferState {
  readonly bytes: number;
  readonly items: number;
  readonly resyncRequired: boolean;
}

export interface ByteBoundedResyncBuffer<A> {
  readonly offer: (item: A) => Effect.Effect<boolean>;
  readonly stream: Stream.Stream<A>;
  readonly takeAll: Effect.Effect<ReadonlyArray<A>>;
  readonly state: Effect.Effect<BufferState>;
}

/**
 * A per-consumer bridge for high-volume disposable projections. When either
 * the byte or item budget is exhausted, queued deltas are atomically replaced
 * with one marker. The producer never waits for a disconnected client; the
 * marker tells that client to establish a new authoritative subscription.
 */
export const make = Effect.fn("ByteBoundedResyncBuffer.make")(function* <A>(input: {
  readonly maxBytes: number;
  readonly maxItems: number;
  readonly resyncItem: A;
  readonly sizeOf: (item: A) => number;
}): Effect.fn.Return<ByteBoundedResyncBuffer<A>> {
  const maxBytes = Math.max(1, Math.floor(input.maxBytes));
  const maxItems = Math.max(1, Math.floor(input.maxItems));
  const queue = yield* Queue.bounded<BufferedItem<A>>(maxItems);
  const state = yield* SynchronizedRef.make<BufferState>({
    bytes: 0,
    items: 0,
    resyncRequired: false,
  });
  const resyncBytes = Math.max(1, Math.floor(input.sizeOf(input.resyncItem)));

  const overflow = Effect.fn("ByteBoundedResyncBuffer.overflow")(function* () {
    yield* Queue.takeAll(queue);
    yield* Queue.offer(queue, { item: input.resyncItem, bytes: resyncBytes });
    return {
      bytes: resyncBytes,
      items: 1,
      resyncRequired: true,
    } satisfies BufferState;
  });

  const offer = Effect.fn("ByteBoundedResyncBuffer.offer")(function* (item: A) {
    const bytes = Math.max(1, Math.floor(input.sizeOf(item)));
    return yield* SynchronizedRef.modifyEffect(
      state,
      (current): Effect.Effect<readonly [boolean, BufferState]> => {
        if (current.resyncRequired) {
          return Effect.succeed([false, current] as const);
        }
        if (current.items >= maxItems || current.bytes + bytes > maxBytes || bytes > maxBytes) {
          return overflow().pipe(Effect.map((next) => [false, next] as const));
        }
        return Queue.offer(queue, { item, bytes }).pipe(
          Effect.flatMap((accepted): Effect.Effect<readonly [boolean, BufferState]> => {
            if (!accepted) {
              return overflow().pipe(Effect.map((next) => [false, next] as const));
            }
            return Effect.succeed([
              true,
              {
                bytes: current.bytes + bytes,
                items: current.items + 1,
                resyncRequired: false,
              },
            ] as const);
          }),
        );
      },
    );
  });

  const takeAll = Effect.gen(function* () {
    const buffered = yield* Queue.takeAll(queue);
    const removedBytes = buffered.reduce((sum, item) => sum + item.bytes, 0);
    yield* SynchronizedRef.update(state, (current) => ({
      ...current,
      bytes: Math.max(0, current.bytes - removedBytes),
      items: Math.max(0, current.items - buffered.length),
    }));
    return buffered.map((entry) => entry.item);
  });

  return {
    offer,
    stream: Stream.fromQueue(queue).pipe(
      Stream.mapEffect((buffered) =>
        SynchronizedRef.update(state, (current) => ({
          ...current,
          bytes: Math.max(0, current.bytes - buffered.bytes),
          items: Math.max(0, current.items - 1),
        })).pipe(Effect.as(buffered.item)),
      ),
    ),
    takeAll,
    state: SynchronizedRef.get(state),
  };
});
