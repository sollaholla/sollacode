import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { make } from "./ProjectionLiveBuffer.ts";

describe("ProjectionLiveBuffer", () => {
  it.effect("replaces an overflowing live tail with one resynchronization marker", () =>
    Effect.gen(function* () {
      const buffer = yield* make<number>({ capacity: 2, resyncItem: -1 });

      expect(yield* buffer.offer(1)).toBe(true);
      expect(yield* buffer.offer(2)).toBe(true);
      expect(yield* buffer.offer(3)).toBe(false);
      expect(yield* buffer.offer(4)).toBe(false);

      expect(yield* buffer.takeAll).toEqual([-1]);
      expect(yield* buffer.resyncRequired).toBe(true);
    }),
  );

  it.effect("continues normally while the consumer keeps pace", () =>
    Effect.gen(function* () {
      const buffer = yield* make<number>({ capacity: 2, resyncItem: -1 });

      expect(yield* buffer.offer(1)).toBe(true);
      expect(Option.getOrThrow(yield* Stream.runHead(buffer.stream))).toBe(1);
      expect(yield* buffer.offer(2)).toBe(true);
      expect(yield* buffer.offer(3)).toBe(true);

      expect(yield* buffer.takeAll).toEqual([2, 3]);
      expect(yield* buffer.resyncRequired).toBe(false);
    }),
  );
});
