import {
  ThreadId,
  VmAgentId,
  VmId,
  type VmAgent,
  type VmAgentStreamEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ConnectionWakeups from "../connection/wakeups.ts";
import {
  applyVmAgentRegistryEvent,
  resubscribeVmStreamOnApplicationActive,
  type VmAgentRegistryView,
} from "./vmAgents.ts";

const makeAgent = (id: string, name: string, status: VmAgent["status"] = "running"): VmAgent => ({
  vmAgentId: VmAgentId.make(id),
  name,
  handle: name.toLowerCase(),
  purpose: `${name} purpose`,
  vmId: VmId.make(`vm-${id}`),
  threadId: ThreadId.make(`thread-${id}`),
  status,
  controlMode: "agent",
  guestIp: "127.0.0.1",
  lastError: null,
  createdAt: "2026-08-21T00:00:00.000Z",
  updatedAt: "2026-08-21T00:00:00.000Z",
});

const fold = (events: ReadonlyArray<VmAgentStreamEvent>): VmAgentRegistryView =>
  events.reduce(applyVmAgentRegistryEvent, { type: "snapshot", agents: [] });

it("folds registry snapshots and delta events without blanking the agent list", () => {
  const scout = makeAgent("scout", "Scout");
  const builder = makeAgent("builder", "Builder");
  const stoppedScout = makeAgent("scout", "Scout", "stopped");

  const view = fold([
    { type: "snapshot", agents: [scout] },
    { type: "upsert", agent: builder },
    { type: "upsert", agent: stoppedScout },
    { type: "remove", vmAgentId: builder.vmAgentId },
  ]);

  expect(view).toEqual({ type: "snapshot", agents: [stoppedScout] });
});

it("replaces stale registry state with the next authoritative snapshot", () => {
  const stale = makeAgent("stale", "Stale");
  const current = makeAgent("current", "Current");

  const view = fold([
    { type: "snapshot", agents: [stale] },
    { type: "snapshot", agents: [current] },
  ]);

  expect(view).toEqual({ type: "snapshot", agents: [current] });
});

it.effect("reopens a VM subscription when a suspended client becomes active", () =>
  Effect.gen(function* () {
    const wakeups = yield* Queue.unbounded<ConnectionWakeups.ConnectionWakeup>();
    const subscriptions = yield* Ref.make(0);
    const source = Stream.suspend(() =>
      Ref.updateAndGet(subscriptions, (count) => count + 1).pipe(
        Effect.map((subscription) => ({ subscription })),
        Stream.fromEffect,
        Stream.concat(Stream.never),
      ),
    );
    const fiber = yield* resubscribeVmStreamOnApplicationActive(source).pipe(
      Stream.take(2),
      Stream.runCollect,
      Effect.provideService(ConnectionWakeups.ConnectionWakeups, {
        changes: Stream.fromQueue(wakeups),
      }),
      Effect.forkChild({ startImmediately: true }),
    );

    while ((yield* Ref.get(subscriptions)) < 1) {
      yield* Effect.yieldNow;
    }
    yield* Queue.offer(wakeups, "application-active");

    expect(yield* Fiber.join(fiber)).toEqual([{ subscription: 1 }, { subscription: 2 }]);
    expect(yield* Ref.get(subscriptions)).toBe(2);
  }),
);
