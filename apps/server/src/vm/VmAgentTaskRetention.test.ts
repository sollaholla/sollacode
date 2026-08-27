import { VmAgentId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import { VmAgentWorkspaceStore } from "../persistence/Services/VmAgentWorkspaces.ts";
import { VmAgentWorkspace } from "./VmAgentWorkspace.ts";
import {
  COMPLETED_AGENT_TASK_RETENTION_HOURS,
  purgeExpiredCompletedAgentTasks,
  startVmAgentTaskRetention,
} from "./VmAgentTaskRetention.ts";

const vmAgentId = VmAgentId.make("retention-agent");

it.effect("purges completed tasks one hour after completion and refreshes affected agents", () =>
  Effect.gen(function* () {
    let receivedCutoff: string | null = null;
    const refreshed: VmAgentId[] = [];
    const dependencies = Layer.mergeAll(
      Layer.mock(VmAgentWorkspaceStore)({
        purgeCompletedTasks: ({ cutoff }) =>
          Effect.sync(() => {
            receivedCutoff = cutoff;
            return [vmAgentId];
          }),
      }),
      Layer.mock(VmAgentWorkspace)({
        refresh: (affectedVmAgentId) =>
          Effect.sync(() => {
            refreshed.push(affectedVmAgentId);
          }),
      }),
    );

    const affected = yield* purgeExpiredCompletedAgentTasks(
      DateTime.makeUnsafe("2026-08-21T12:00:00.000Z"),
    ).pipe(Effect.provide(dependencies));

    assert.strictEqual(COMPLETED_AGENT_TASK_RETENTION_HOURS, 1);
    assert.strictEqual(receivedCutoff, "2026-08-21T11:00:00.000Z");
    assert.deepStrictEqual(affected, [vmAgentId]);
    assert.deepStrictEqual(refreshed, [vmAgentId]);
  }),
);

it.effect("runs the retention sweep immediately and once per minute", () =>
  Effect.gen(function* () {
    const firstSweep = yield* Deferred.make<void>();
    const secondSweep = yield* Deferred.make<void>();
    let sweepCount = 0;
    const dependencies = Layer.mergeAll(
      Layer.mock(VmAgentWorkspaceStore)({
        purgeCompletedTasks: () =>
          Effect.gen(function* () {
            sweepCount += 1;
            if (sweepCount === 1) yield* Deferred.succeed(firstSweep, undefined);
            if (sweepCount === 2) yield* Deferred.succeed(secondSweep, undefined);
            return [];
          }),
      }),
      Layer.mock(VmAgentWorkspace)({}),
    );

    const fiber = yield* startVmAgentTaskRetention.pipe(
      Effect.provide(dependencies),
      Effect.forkChild({ startImmediately: true }),
    );
    yield* Deferred.await(firstSweep);
    assert.strictEqual(sweepCount, 1);

    yield* TestClock.adjust(Duration.minutes(1));
    yield* Deferred.await(secondSweep);
    assert.strictEqual(sweepCount, 2);
    yield* Fiber.interrupt(fiber);
  }),
);
