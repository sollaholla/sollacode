import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { resubscribeOnTerminalResync } from "./terminalResync.ts";

it.effect("re-establishes a terminal subscription after a slow-consumer marker", () =>
  Effect.gen(function* () {
    type TestEvent =
      | { readonly type: "value"; readonly value: number }
      | { readonly type: "resync-required"; readonly reason: "slow-consumer" };
    let subscriptions = 0;
    const source = Stream.suspend((): Stream.Stream<TestEvent> => {
      subscriptions += 1;
      return subscriptions === 1
        ? Stream.make(
            { type: "value" as const, value: 1 },
            { type: "resync-required" as const, reason: "slow-consumer" as const },
          )
        : Stream.make({ type: "value" as const, value: 2 });
    });

    const values = yield* resubscribeOnTerminalResync(source).pipe(
      Stream.take(2),
      Stream.runCollect,
    );

    expect(values).toEqual([
      { type: "value", value: 1 },
      { type: "value", value: 2 },
    ]);
    expect(subscriptions).toBe(2);
  }),
);
