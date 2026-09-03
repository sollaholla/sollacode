import { type VmAgentStreamEvent } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { VmAgentStoreLive } from "../persistence/Layers/VmAgents.ts";
import { VmManager, VmManagerLive } from "./VmManager.ts";

const managerLayer = it.layer(
  VmManagerLive.pipe(
    // provideMerge keeps VmAgentStore in the output context so tests can poll it.
    Layer.provideMerge(VmAgentStoreLive.pipe(Layer.provideMerge(SqlitePersistenceMemory))),
  ),
);

managerLayer("VmManager", (it) => {
  it.effect("creates a named agent that is immediately ready", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const store = yield* VmAgentStore;

      const agent = yield* manager.create({
        name: "Scout Ranger",
        purpose: "browse the web",
        threadId: null,
      });
      assert.strictEqual(agent.name, "Scout Ranger");
      assert.strictEqual(agent.handle, "scout-ranger");
      // No VM to boot: an agent is usable the moment its row exists.
      assert.strictEqual(agent.status, "running");
      assert.strictEqual(agent.controlMode, "agent");

      const persisted = yield* store.getById(agent.vmAgentId);
      assert.isTrue(Option.isSome(persisted));
      if (Option.isSome(persisted)) {
        assert.strictEqual(persisted.value.status, "running");
      }
    }),
  );

  it.effect("stops and starts an agent, persisting the status and re-broadcasting", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const store = yield* VmAgentStore;
      const snapshots: VmAgentStreamEvent[] = [];
      const agent = yield* manager.create({
        name: "Night Watch",
        purpose: "watch",
        threadId: null,
      });
      const unsubscribe = yield* manager.subscribeAgents((event) =>
        Effect.sync(() => {
          snapshots.push(event);
        }),
      );

      const stopped = yield* manager.setStatus(agent.vmAgentId, "stopped");
      assert.strictEqual(stopped.status, "stopped");
      const persistedStopped = yield* store.getById(agent.vmAgentId);
      assert.strictEqual(Option.getOrThrow(persistedStopped).status, "stopped");

      // Idempotent: stopping a stopped agent neither rewrites nor re-broadcasts.
      const broadcastsAfterStop = snapshots.length;
      yield* manager.setStatus(agent.vmAgentId, "stopped");
      assert.strictEqual(snapshots.length, broadcastsAfterStop);

      const started = yield* manager.setStatus(agent.vmAgentId, "running");
      assert.strictEqual(started.status, "running");
      const persistedStarted = yield* store.getById(agent.vmAgentId);
      assert.strictEqual(Option.getOrThrow(persistedStarted).status, "running");
      assert.isTrue(snapshots.length > broadcastsAfterStop);

      const missing = yield* Effect.flip(
        manager.setStatus((agent.vmAgentId + "-missing") as never, "stopped"),
      );
      assert.strictEqual(missing._tag, "VmAgentNotFoundError");
      unsubscribe();
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

  it.effect("streams a registry snapshot on subscribe and on every change", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const snapshots: VmAgentStreamEvent[] = [];
      const unsubscribe = yield* manager.subscribeAgents((event) =>
        Effect.sync(() => {
          snapshots.push(event);
        }),
      );

      const initial = snapshots.at(-1);
      assert.strictEqual(initial?.type, "snapshot");

      const agent = yield* manager.create({
        name: "Streamer",
        purpose: "appear in the registry",
        threadId: null,
      });
      const afterCreate = snapshots.at(-1);
      assert.strictEqual(afterCreate?.type, "snapshot");
      if (afterCreate?.type === "snapshot") {
        assert.isTrue(afterCreate.agents.some((entry) => entry.vmAgentId === agent.vmAgentId));
      }

      yield* manager.deleteAgent(agent.vmAgentId);
      const afterDelete = snapshots.at(-1);
      assert.strictEqual(afterDelete?.type, "snapshot");
      if (afterDelete?.type === "snapshot") {
        assert.isFalse(afterDelete.agents.some((entry) => entry.vmAgentId === agent.vmAgentId));
      }

      unsubscribe();
    }),
  );

  it.effect("deleteAgent removes the row and returns the chat thread id", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const store = yield* VmAgentStore;
      const agent = yield* manager.create({
        name: "Ephemeral",
        purpose: "be deleted",
        threadId: null,
      });

      const threadId = yield* manager.deleteAgent(agent.vmAgentId);
      assert.isNull(threadId);
      const gone = yield* store.getById(agent.vmAgentId);
      assert.isTrue(Option.isNone(gone));

      const missing = yield* Effect.flip(manager.deleteAgent(agent.vmAgentId));
      assert.strictEqual(missing._tag, "VmAgentNotFoundError");
    }),
  );
});
