import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { make } from "./ByteBoundedResyncBuffer.ts";

it.effect("replaces queued deltas with one marker when the byte budget is exceeded", () =>
  Effect.gen(function* () {
    const buffer = yield* make<string>({
      maxBytes: 5,
      maxItems: 8,
      resyncItem: "!",
      sizeOf: (item) => item.length,
    });

    expect(yield* buffer.offer("abc")).toBe(true);
    expect(yield* buffer.offer("de")).toBe(true);
    expect(yield* buffer.offer("f")).toBe(false);
    expect(yield* buffer.offer("ignored")).toBe(false);
    expect(yield* buffer.takeAll).toEqual(["!"]);
    expect((yield* buffer.state).resyncRequired).toBe(true);
  }),
);

it.effect("releases byte capacity as a consumer drains the stream", () =>
  Effect.gen(function* () {
    const buffer = yield* make<string>({
      maxBytes: 5,
      maxItems: 2,
      resyncItem: "!",
      sizeOf: (item) => item.length,
    });

    expect(yield* buffer.offer("abc")).toBe(true);
    expect(Option.getOrThrow(yield* Stream.runHead(buffer.stream))).toBe("abc");
    expect(yield* buffer.offer("de")).toBe(true);
    expect(yield* buffer.offer("fgh")).toBe(true);
    expect(yield* buffer.takeAll).toEqual(["de", "fgh"]);
    expect((yield* buffer.state).bytes).toBe(0);
  }),
);
