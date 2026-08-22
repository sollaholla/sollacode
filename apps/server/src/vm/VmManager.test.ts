import { VmAgent, VmAgentId, VmScreenFrame, VmScreenStreamEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmAgentStoreLive } from "../persistence/Layers/VmAgents.ts";
import { VmProviderMockLive } from "./MockVmProvider.ts";
import { make, VmManager, VmManagerLive } from "./VmManager.ts";

const managerLayer = it.layer(
  VmManagerLive.pipe(
    Layer.provide(VmProviderMockLive),
    // provideMerge keeps VmAgentStore in the output context so tests can poll it.
    Layer.provideMerge(VmAgentStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

// Boot is deliberately forked so the registry stream shows provisioning→running
// transitions live. Poll the store until the agent settles at the target status.
const waitForStatus = (vmAgentId: VmAgentId, status: VmAgent["status"]) =>
  Effect.gen(function* () {
    const store = yield* VmAgentStore;
    for (let attempt = 0; attempt < 200; attempt++) {
      const latest = yield* store.getById(vmAgentId);
      if (Option.isSome(latest) && latest.value.status === status) return latest.value;
      yield* TestClock.adjust(Duration.millis(10));
    }
    return assert.fail(`agent ${vmAgentId} never reached status ${status}`);
  });

managerLayer("VmManager", (it) => {
  it.effect("creates a named agent, boots it, and lists it in the registry snapshot", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;

      const agent = yield* manager.create({
        name: "Scout Ranger",
        purpose: "browse the web",
        threadId: null,
      });
      assert.strictEqual(agent.name, "Scout Ranger");
      assert.strictEqual(agent.handle, "scout-ranger");

      const running = yield* waitForStatus(agent.vmAgentId, "running");
      assert.strictEqual(running.status, "running");
      assert.strictEqual(running.guestIp, "127.0.0.1");
    }),
  );

  it.effect("rejects a duplicate name (case-insensitively)", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      yield* manager.create({ name: "Archivist", purpose: "file things", threadId: null });
      const conflict = yield* Effect.flip(
        manager.create({ name: "archivist", purpose: "file other things", threadId: null }),
      );
      assert.strictEqual(conflict._tag, "VmAgentNameConflictError");
    }),
  );

  it.effect("waits for a stopped agent to be running before returning", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const agent = yield* manager.create({
        name: "Scheduler",
        purpose: "run durable work",
        threadId: null,
      });
      yield* waitForStatus(agent.vmAgentId, "running");
      yield* manager.stop(agent.vmAgentId);

      const running = yield* manager.ensureRunning(agent.vmAgentId);
      assert.strictEqual(running.status, "running");
      assert.strictEqual(running.guestIp, "127.0.0.1");
    }),
  );

  it.effect("streams live screen frames for a running agent", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const agent = yield* manager.create({
        name: "Pixel",
        purpose: "watch pixels",
        threadId: null,
      });
      yield* waitForStatus(agent.vmAgentId, "running");

      const frames: VmScreenStreamEvent[] = [];
      const unsubscribe = yield* manager.subscribeScreen(agent.vmAgentId, (event) =>
        Effect.sync(() => {
          frames.push(event);
        }),
      );

      // The pump runs at ~7fps; a few hundred ms yields several frames.
      yield* TestClock.adjust(Duration.millis(500));
      unsubscribe();

      const imageFrames = frames.filter((event) => event.type === "frame");
      assert.isAtLeast(imageFrames.length, 2);
      const first = imageFrames[0];
      assert.strictEqual(first?.type === "frame" ? first.format : null, "png");
      assert.isTrue(first?.type === "frame" ? first.data.length > 0 : false);

      // The agent's cursor rides on the frame so the viewer can overlay it.
      assert.isTrue(first?.type === "frame" && first.cursor !== undefined);
      if (first?.type === "frame" && first.cursor) {
        assert.isTrue(Number.isInteger(first.cursor.x));
        assert.isTrue(Number.isInteger(first.cursor.y));
      }
    }),
  );

  it.effect("resumes frames for an agent persisted as running after a manager restart", () =>
    Effect.gen(function* () {
      const first = yield* VmManager;
      const agent = yield* first.create({
        name: "Rebooter",
        purpose: "survive restarts",
        threadId: null,
      });
      yield* waitForStatus(agent.vmAgentId, "running");

      // Simulate a process restart: a brand-new manager over the SAME store,
      // whose in-memory provider and runningVms start empty. The row still
      // says "running", so without startup reconciliation the frame pump could
      // never start and the live view would hang on "waiting for first frame".
      const second = yield* make.pipe(Effect.provide(VmProviderMockLive));

      const frames: VmScreenStreamEvent[] = [];
      const unsubscribe = yield* second.subscribeScreen(agent.vmAgentId, (event) =>
        Effect.sync(() => {
          frames.push(event);
        }),
      );

      // Reconciliation re-boots on a forked fiber; step the clock until the
      // freshly-restarted provider begins delivering frames.
      for (
        let attempt = 0;
        attempt < 300 && frames.filter((e) => e.type === "frame").length === 0;
        attempt++
      ) {
        yield* TestClock.adjust(Duration.millis(10));
      }
      unsubscribe();

      assert.isAtLeast(frames.filter((e) => e.type === "frame").length, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("takeover flips control mode and notifies the screen stream", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const agent = yield* manager.create({ name: "Handoff", purpose: "hand off", threadId: null });
      yield* waitForStatus(agent.vmAgentId, "running");

      const controls: string[] = [];
      const unsubscribe = yield* manager.subscribeScreen(agent.vmAgentId, (event) =>
        Effect.sync(() => {
          if (event.type === "control") controls.push(event.controlMode);
        }),
      );

      const updated = yield* manager.setControlMode({
        vmAgentId: agent.vmAgentId,
        controlMode: "user",
      });
      assert.strictEqual(updated.controlMode, "user");
      yield* TestClock.adjust(Duration.millis(50));
      unsubscribe();

      // Opens with the current mode ("agent"), then receives the "user" flip.
      assert.deepStrictEqual(controls, ["agent", "user"]);
    }),
  );

  it.effect("forwards user input to the guest only while the user holds control", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const agent = yield* manager.create({ name: "Driver", purpose: "drive", threadId: null });
      yield* waitForStatus(agent.vmAgentId, "running");

      const frames: VmScreenFrame[] = [];
      const unsubscribe = yield* manager.subscribeScreen(agent.vmAgentId, (event) =>
        Effect.sync(() => {
          if (event.type === "frame") frames.push(event);
        }),
      );

      // The mock denormalizes (0.25, 0.75) onto its 320×200 frame.
      const targetX = Math.round(0.25 * (320 - 1));
      const targetY = Math.round(0.75 * (200 - 1));
      const pointer = { x: 0.25, y: 0.75, button: "left" as const };

      // Agent mode: input is ignored, so the reported cursor never pins to it.
      yield* manager.sendInput({
        vmAgentId: agent.vmAgentId,
        input: { type: "pointer", action: "move", ...pointer },
      });
      yield* TestClock.adjust(Duration.millis(200));
      const beforeControl = frames.at(-1);
      assert.isTrue(
        !!beforeControl &&
          (beforeControl.cursor?.x !== targetX || beforeControl.cursor?.y !== targetY),
      );

      // Take control: the same input now drives the guest cursor.
      yield* manager.setControlMode({ vmAgentId: agent.vmAgentId, controlMode: "user" });
      yield* manager.sendInput({
        vmAgentId: agent.vmAgentId,
        input: { type: "pointer", action: "down", ...pointer },
      });
      yield* TestClock.adjust(Duration.millis(200));
      unsubscribe();

      const afterControl = frames.at(-1);
      assert.strictEqual(afterControl?.cursor?.x, targetX);
      assert.strictEqual(afterControl?.cursor?.y, targetY);
    }),
  );

  it.effect("deletes an agent and removes it from the registry", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const agent = yield* manager.create({
        name: "Ephemeral",
        purpose: "not for long",
        threadId: null,
      });
      yield* waitForStatus(agent.vmAgentId, "running");

      yield* manager.deleteAgent(agent.vmAgentId);

      let snapshot: ReadonlyArray<VmAgent> = [];
      const unsubscribe = yield* manager.subscribeAgents((event) =>
        Effect.sync(() => {
          if (event.type === "snapshot") snapshot = event.agents;
        }),
      );
      unsubscribe();
      assert.isUndefined(snapshot.find((a) => a.vmAgentId === agent.vmAgentId));

      const missing = yield* Effect.flip(manager.deleteAgent(agent.vmAgentId));
      assert.strictEqual(missing._tag, "VmAgentNotFoundError");
    }),
  );
});
