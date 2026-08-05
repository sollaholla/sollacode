import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { ThreadSubscriptionRegistry } from "../Services/ThreadSubscriptionRegistry.ts";
import { ThreadSubscriptionRegistryLive } from "./ThreadSubscriptionRegistry.ts";

const layer = it.layer(ThreadSubscriptionRegistryLive);

layer("ThreadSubscriptionRegistry", (it) => {
  it.effect("tracks shell and per-thread detail leases with idempotent release", () =>
    Effect.gen(function* () {
      const registry = yield* ThreadSubscriptionRegistry;
      const threadA = ThreadId.make("thread-subscription-a");
      const threadB = ThreadId.make("thread-subscription-b");
      const shell = yield* registry.acquireShell();
      const detailA1 = yield* registry.acquireDetail(threadA);
      const detailA2 = yield* registry.acquireDetail(threadA);
      const detailB = yield* registry.acquireDetail(threadB);

      const active = yield* registry.snapshot;
      assert.strictEqual(active.shellSubscriptions, 1);
      assert.strictEqual(active.detailSubscriptions, 3);
      assert.deepStrictEqual(new Set(active.detailedThreadIds), new Set([threadA, threadB]));

      assert.isTrue(yield* registry.release(detailA1));
      assert.isFalse(yield* registry.release(detailA1));
      assert.isTrue(yield* registry.release(shell));
      assert.isTrue(yield* registry.release(detailA2));
      assert.isTrue(yield* registry.release(detailB));
      assert.deepStrictEqual(yield* registry.snapshot, {
        shellSubscriptions: 0,
        detailSubscriptions: 0,
        detailedThreadIds: new Set<ReturnType<typeof ThreadId.make>>(),
      });
    }),
  );
});
