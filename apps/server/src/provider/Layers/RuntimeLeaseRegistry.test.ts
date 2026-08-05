import { ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { RuntimeLeaseRegistry } from "../Services/RuntimeLeaseRegistry.ts";
import { RuntimeLeaseRegistryLive } from "./RuntimeLeaseRegistry.ts";

const layer = it.layer(RuntimeLeaseRegistryLive);

layer("RuntimeLeaseRegistry", (it) => {
  it.effect("fences stale owners and releases only the current lease", () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeLeaseRegistry;
      const threadId = ThreadId.make("thread-runtime-lease");
      const lease = {
        threadId,
        activeTurnId: TurnId.make("turn-runtime-lease"),
        phase: "provider-running" as const,
        lastHeartbeatAt: "2026-08-04T00:00:00.000Z",
        expiresAt: "2099-08-04T00:00:00.000Z",
      };

      const first = yield* registry.acquire(lease);
      assert.isTrue(Option.isSome(first));
      assert.isTrue(Option.isNone(yield* registry.acquire(lease)));

      const handle = Option.getOrThrow(first);
      assert.isFalse(
        yield* registry.heartbeat({
          threadId,
          leaseToken: "stale-token",
          phase: "tool-running",
          lastHeartbeatAt: "2026-08-04T00:01:00.000Z",
          expiresAt: "2099-08-04T00:01:00.000Z",
        }),
      );
      assert.isTrue(
        yield* registry.heartbeat({
          threadId,
          leaseToken: handle.leaseToken,
          phase: "tool-running",
          lastHeartbeatAt: "2026-08-04T00:01:00.000Z",
          expiresAt: "2099-08-04T00:01:00.000Z",
        }),
      );
      assert.strictEqual(
        Option.getOrThrow(yield* registry.getLive(threadId)).lease.phase,
        "tool-running",
      );
      assert.isFalse(yield* registry.release({ threadId, leaseToken: "stale-token" }));
      assert.isTrue(yield* registry.release({ threadId, leaseToken: handle.leaseToken }));
      assert.isFalse(yield* registry.hasLiveWork(threadId));
    }),
  );

  it.effect("prunes expired leases without a timer per thread", () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeLeaseRegistry;
      const threadId = ThreadId.make("thread-runtime-expired");
      assert.isTrue(
        Option.isNone(
          yield* registry.acquire({
            threadId,
            activeTurnId: null,
            phase: "context-compacting",
            lastHeartbeatAt: "1960-01-01T00:00:00.000Z",
            expiresAt: "1960-01-01T00:00:01.000Z",
          }),
        ),
      );
      assert.isFalse(yield* registry.hasLiveWork(threadId));
      assert.deepStrictEqual(yield* registry.listLive(), []);
    }),
  );

  it.effect("does not let an expired owner heartbeat back to life", () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeLeaseRegistry;
      const threadId = ThreadId.make("thread-runtime-expired-heartbeat");
      const now = yield* Clock.currentTimeMillis;
      const acquired = Option.getOrThrow(
        yield* registry.acquire({
          threadId,
          activeTurnId: null,
          phase: "provider-running",
          lastHeartbeatAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 1_000)),
        }),
      );
      yield* TestClock.adjust(Duration.seconds(2));
      assert.isFalse(
        yield* registry.heartbeat({
          threadId,
          leaseToken: acquired.leaseToken,
          phase: "provider-running",
          lastHeartbeatAt: DateTime.formatIso(DateTime.makeUnsafe(now + 2_000)),
          expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 10_000)),
        }),
      );
      assert.isFalse(yield* registry.hasLiveWork(threadId));
    }),
  );

  it.effect("reap reservations atomically block new runtime work", () =>
    Effect.gen(function* () {
      const registry = yield* RuntimeLeaseRegistry;
      const threadId = ThreadId.make("thread-runtime-reap-reservation");
      const reservation = Option.getOrThrow(yield* registry.tryReserveReap(threadId));
      assert.isTrue(
        Option.isNone(
          yield* registry.acquire({
            threadId,
            activeTurnId: null,
            phase: "tool-running",
            lastHeartbeatAt: "2026-08-04T00:00:00.000Z",
            expiresAt: "2099-08-04T00:00:00.000Z",
          }),
        ),
      );
      assert.isTrue(yield* registry.releaseReap(reservation));
      assert.isTrue(
        Option.isSome(
          yield* registry.acquire({
            threadId,
            activeTurnId: null,
            phase: "tool-running",
            lastHeartbeatAt: "2026-08-04T00:00:00.000Z",
            expiresAt: "2099-08-04T00:00:00.000Z",
          }),
        ),
      );
    }),
  );
});
