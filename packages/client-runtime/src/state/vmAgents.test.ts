import {
  DEFAULT_VM_AGENT_DELEGATION_LIMITS,
  ThreadId,
  VmAgentDelegationId,
  VmAgentDelegationMessageId,
  VmAgentId,
  VmAgentTaskId,
  VmId,
  type VmAgent,
  type VmAgentCollaborationSnapshot,
  type VmAgentLegacyCollaborationSnapshot,
  type VmAgentStreamEvent,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ConnectionWakeups from "../connection/wakeups.ts";
import {
  applyVmAgentRegistryEvent,
  collaborationResyncBackoffMs,
  COLLABORATION_RESYNC_MAX_BACKOFF_MS,
  LEGACY_COLLABORATION_REFRESH_INTERVAL_MS,
  MAX_CONSECUTIVE_COLLABORATION_RESYNCS,
  normalizeVmAgentCollaborationStreamItem,
  resubscribeCollaborationOnTerminalResync,
  resubscribeLegacyCollaborationStream,
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

const legacyCollaborationSnapshot = (): VmAgentLegacyCollaborationSnapshot => {
  const vmAgentId = VmAgentId.make("legacy-collaboration-agent");
  const delegationId = VmAgentDelegationId.make("legacy-collaboration-delegation");
  const identity = {
    vmAgentId,
    name: "Legacy agent",
    handle: "legacy-agent",
    purpose: "Legacy collaboration purpose",
  };
  const agent = {
    ...identity,
    status: "running" as const,
    controlMode: "agent" as const,
    availability: "available" as const,
    capabilities: ["workspace.consult"],
    providerInstanceId: null,
    model: null,
    activeDelegations: 1,
    canReceiveDelegation: true,
  };
  const createdAt = "2026-08-24T16:00:00.000Z";
  return {
    type: "snapshot",
    agents: [agent],
    delegations: [
      {
        delegation: {
          delegationId,
          rootVmAgentId: vmAgentId,
          sourceVmAgentId: vmAgentId,
          rootDelegationId: null,
          parentDelegationId: null,
          depth: 1,
          target: { kind: "ephemeral", label: "One-off helper" },
          targetVmAgentId: null,
          workerThreadId: null,
          rootAgentSnapshot: identity,
          sourceAgentSnapshot: identity,
          targetAgentSnapshot: null,
          taskId: VmAgentTaskId.make(`delegation-task:${delegationId}`),
          runId: null,
          title: "Legacy full-row handoff",
          task: "T".repeat(1_000),
          completionCriteria: [],
          requestedCapabilities: [],
          status: "running",
          followupCount: 0,
          messageCount: 1,
          effectiveLimits: DEFAULT_VM_AGENT_DELEGATION_LIMITS,
          revision: 1,
          createdAt,
          startedAt: createdAt,
          completedAt: null,
          expiresAt: createdAt,
          updatedAt: createdAt,
          result: null,
          error: null,
        },
        rootAgent: agent,
        sourceAgent: agent,
        targetAgent: null,
        latestMessage: {
          messageId: VmAgentDelegationMessageId.make("legacy-collaboration-message"),
          delegationId,
          sequence: 1,
          sender: "source-agent",
          senderVmAgentId: vmAgentId,
          kind: "note",
          delivery: "delivered",
          text: "M".repeat(1_000),
          createdAt,
        },
      },
    ],
  };
};

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

it("normalizes old full-row snapshots without falsely claiming compact-server capability", () => {
  const normalized = normalizeVmAgentCollaborationStreamItem(legacyCollaborationSnapshot());

  expect(normalized.type).toBe("snapshot");
  if (normalized.type !== "snapshot") return;
  expect(normalized.compact).toBeUndefined();
  expect(normalized.delegations).toHaveLength(1);
  expect(normalized.delegations[0]?.delegation.taskPreview).toEqual({
    text: `${"T".repeat(319)}…`,
    truncated: true,
  });
  expect(normalized.delegations[0]?.latestMessage).toMatchObject({
    text: `${"M".repeat(279)}…`,
    truncated: true,
  });
  expect(normalized.delegations[0]?.delegation).not.toHaveProperty("task");
});

it("passes compact snapshots through without copying them", () => {
  const compact: VmAgentCollaborationSnapshot = {
    type: "snapshot",
    compact: true,
    agents: [],
    delegations: [],
  };

  expect(normalizeVmAgentCollaborationStreamItem(compact)).toBe(compact);
});

it.effect("reopens only legacy collaboration streams to observe old-server worker mutations", () =>
  Effect.gen(function* () {
    const subscriptions = yield* Ref.make(0);
    const source = Stream.suspend(() =>
      Ref.updateAndGet(subscriptions, (count) => count + 1).pipe(
        Effect.as(legacyCollaborationSnapshot()),
        Stream.fromEffect,
        Stream.concat(Stream.never),
      ),
    );
    const fiber = yield* resubscribeLegacyCollaborationStream(source).pipe(
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true }),
    );

    while ((yield* Ref.get(subscriptions)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(LEGACY_COLLABORATION_REFRESH_INTERVAL_MS));
    while ((yield* Ref.get(subscriptions)) < 2) yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);

    expect(yield* Ref.get(subscriptions)).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("does not let the legacy refresh clock cancel a slow first snapshot", () =>
  Effect.gen(function* () {
    const firstSnapshot = yield* Deferred.make<VmAgentLegacyCollaborationSnapshot>();
    const subscriptions = yield* Ref.make(0);
    const source = Stream.suspend(() =>
      Ref.update(subscriptions, (count) => count + 1).pipe(
        Effect.flatMap(() => Deferred.await(firstSnapshot)),
        Stream.fromEffect,
        Stream.concat(Stream.never),
      ),
    );
    const fiber = yield* resubscribeLegacyCollaborationStream(source).pipe(
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true }),
    );

    while ((yield* Ref.get(subscriptions)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(LEGACY_COLLABORATION_REFRESH_INTERVAL_MS * 3));
    expect(yield* Ref.get(subscriptions)).toBe(1);

    yield* Deferred.succeed(firstSnapshot, legacyCollaborationSnapshot());
    yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(LEGACY_COLLABORATION_REFRESH_INTERVAL_MS));
    while ((yield* Ref.get(subscriptions)) < 2) yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);

    expect(yield* Ref.get(subscriptions)).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("keeps compact-capable collaboration streams push-driven", () =>
  Effect.gen(function* () {
    const subscriptions = yield* Ref.make(0);
    const compact: VmAgentCollaborationSnapshot = {
      type: "snapshot",
      compact: true,
      agents: [],
      delegations: [],
    };
    const source = Stream.suspend(() =>
      Ref.updateAndGet(subscriptions, (count) => count + 1).pipe(
        Effect.as(compact),
        Stream.fromEffect,
        Stream.concat(Stream.never),
      ),
    );
    const fiber = yield* resubscribeLegacyCollaborationStream(source).pipe(
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true }),
    );

    while ((yield* Ref.get(subscriptions)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(LEGACY_COLLABORATION_REFRESH_INTERVAL_MS * 3));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);

    expect(yield* Ref.get(subscriptions)).toBe(1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("permanently stops legacy refreshes after a rolling upgrade yields compact data", () =>
  Effect.gen(function* () {
    const subscriptions = yield* Ref.make(0);
    const compact: VmAgentCollaborationSnapshot = {
      type: "snapshot",
      compact: true,
      agents: [],
      delegations: [],
    };
    const source = Stream.suspend(() =>
      Ref.updateAndGet(subscriptions, (count) => count + 1).pipe(
        Effect.map((count) => (count === 1 ? legacyCollaborationSnapshot() : compact)),
        Stream.fromEffect,
        Stream.concat(Stream.never),
      ),
    );
    const fiber = yield* resubscribeLegacyCollaborationStream(source).pipe(
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true }),
    );

    while ((yield* Ref.get(subscriptions)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(LEGACY_COLLABORATION_REFRESH_INTERVAL_MS));
    while ((yield* Ref.get(subscriptions)) < 2) yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(LEGACY_COLLABORATION_REFRESH_INTERVAL_MS * 3));
    yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);

    expect(yield* Ref.get(subscriptions)).toBe(2);
  }).pipe(Effect.provide(TestClock.layer())),
);

it("caps collaboration resync backoff", () => {
  expect(collaborationResyncBackoffMs(1)).toBe(250);
  expect(collaborationResyncBackoffMs(2)).toBe(500);
  expect(collaborationResyncBackoffMs(99)).toBe(COLLABORATION_RESYNC_MAX_BACKOFF_MS);
});

it.effect("backs off consecutive resyncs, then fails with an actionable host error", () =>
  Effect.gen(function* () {
    const subscriptions = yield* Ref.make(0);
    const source = Stream.suspend(() =>
      Ref.update(subscriptions, (count) => count + 1).pipe(
        Effect.as({ type: "resync-required" as const, reason: "slow-consumer" as const }),
        Stream.fromEffect,
      ),
    );
    const fiber = yield* resubscribeCollaborationOnTerminalResync(source).pipe(
      Stream.runDrain,
      Effect.exit,
      Effect.forkChild({ startImmediately: true }),
    );

    while ((yield* Ref.get(subscriptions)) < 1) yield* Effect.yieldNow;
    for (let retry = 1; retry <= MAX_CONSECUTIVE_COLLABORATION_RESYNCS; retry += 1) {
      const delay = collaborationResyncBackoffMs(retry);
      yield* TestClock.adjust(Duration.millis(delay - 1));
      expect(yield* Ref.get(subscriptions)).toBe(retry);
      yield* TestClock.adjust(Duration.millis(1));
      while ((yield* Ref.get(subscriptions)) < retry + 1) yield* Effect.yieldNow;
    }

    const exit = yield* Fiber.join(fiber);
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isSuccess(exit)) return;
    const error = Cause.squash(exit.cause);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("Update Solla Code on the host");
    expect(yield* Ref.get(subscriptions)).toBe(MAX_CONSECUTIVE_COLLABORATION_RESYNCS + 1);
  }).pipe(Effect.provide(TestClock.layer())),
);

it.effect("resets the consecutive resync budget after any successful snapshot", () =>
  Effect.gen(function* () {
    const subscriptions = yield* Ref.make(0);
    const snapshots = yield* Ref.make(0);
    const compact: VmAgentCollaborationSnapshot = {
      type: "snapshot",
      compact: true,
      agents: [],
      delegations: [],
    };
    const source = Stream.suspend(() =>
      Ref.updateAndGet(subscriptions, (count) => count + 1).pipe(
        Effect.map((count) => {
          if (count === 1) {
            return Stream.make({
              type: "resync-required" as const,
              reason: "slow-consumer" as const,
            });
          }
          if (count === 2) {
            return Stream.make(compact, {
              type: "resync-required" as const,
              reason: "slow-consumer" as const,
            });
          }
          return Stream.never;
        }),
        Stream.unwrap,
      ),
    );
    const fiber = yield* resubscribeCollaborationOnTerminalResync(source).pipe(
      Stream.tap((item) =>
        item.type === "snapshot" ? Ref.update(snapshots, (count) => count + 1) : Effect.void,
      ),
      Stream.runDrain,
      Effect.forkChild({ startImmediately: true }),
    );

    while ((yield* Ref.get(subscriptions)) < 1) yield* Effect.yieldNow;
    yield* TestClock.adjust(Duration.millis(collaborationResyncBackoffMs(1)));
    while ((yield* Ref.get(subscriptions)) < 2) yield* Effect.yieldNow;
    while ((yield* Ref.get(snapshots)) < 1) yield* Effect.yieldNow;
    expect(yield* Ref.get(snapshots)).toBe(1);

    // The snapshot resets the second marker to attempt one (250 ms), rather
    // than carrying forward attempt two's 500 ms delay.
    yield* TestClock.adjust(Duration.millis(collaborationResyncBackoffMs(1) - 1));
    expect(yield* Ref.get(subscriptions)).toBe(2);
    yield* TestClock.adjust(Duration.millis(1));
    while ((yield* Ref.get(subscriptions)) < 3) yield* Effect.yieldNow;
    yield* Fiber.interrupt(fiber);

    expect(yield* Ref.get(subscriptions)).toBe(3);
  }).pipe(Effect.provide(TestClock.layer())),
);
