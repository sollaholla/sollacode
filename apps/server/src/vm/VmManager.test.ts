import { ThreadId, VmAgentId, type VmAgentStreamEvent } from "@t3tools/contracts";
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
  it.effect("keeps the voice chosen for an agent's calls, and clears it back to automatic", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const store = yield* VmAgentStore;
      const agent = yield* manager.create({ name: "Voice Test", purpose: "talk", threadId: null });
      assert.isNull(Option.getOrThrow(yield* store.getById(agent.vmAgentId)).voice);

      const voiced = yield* manager.setVoice(agent.vmAgentId, "willow");
      assert.strictEqual(voiced.voice, "willow");
      assert.strictEqual(Option.getOrThrow(yield* store.getById(agent.vmAgentId)).voice, "willow");
      const listed = (yield* store.list()).find((row) => row.vmAgentId === agent.vmAgentId);
      assert.strictEqual(listed?.voice, "willow");

      yield* manager.setVoice(agent.vmAgentId, null);
      assert.isNull(Option.getOrThrow(yield* store.getById(agent.vmAgentId)).voice);
    }),
  );

  it.effect(
    "renames persistently and broadcasts while preserving routing, history and character",
    () =>
      Effect.gen(function* () {
        const manager = yield* VmManager;
        const store = yield* VmAgentStore;
        const original = yield* manager.create({
          name: "Rename Original",
          purpose: "keep this",
          threadId: ThreadId.make("rename-chat"),
        });
        const voiced = yield* manager.setVoice(original.vmAgentId, "willow");
        const agent = yield* manager.setStatus(voiced.vmAgentId, "stopped");
        const snapshots: VmAgentStreamEvent[] = [];
        const unsubscribe = yield* manager.subscribeAgents((event) =>
          Effect.sync(() => {
            snapshots.push(event);
          }),
        );
        const renamed = yield* manager.rename(agent.vmAgentId, "  New Identity  ");
        assert.deepStrictEqual(renamed, {
          ...agent,
          name: "New Identity",
          updatedAt: renamed.updatedAt,
        });
        assert.deepStrictEqual(Option.getOrThrow(yield* store.getById(agent.vmAgentId)), renamed);
        assert.deepStrictEqual(Option.getOrThrow(yield* store.getByHandle(agent.handle)), renamed);
        assert.isTrue(Option.isNone(yield* store.getByNameLower("rename original")));
        assert.deepStrictEqual(
          Option.getOrThrow(yield* store.getByNameLower("new identity")),
          renamed,
        );
        const snapshot = snapshots.at(-1);
        assert.strictEqual(snapshot?.type, "snapshot");
        if (snapshot?.type === "snapshot")
          assert.deepStrictEqual(
            snapshot.agents.find((a) => a.vmAgentId === agent.vmAgentId),
            renamed,
          );
        const afterRename = snapshots.length;
        assert.deepStrictEqual(yield* manager.rename(agent.vmAgentId, " New Identity "), renamed);
        assert.strictEqual(snapshots.length, afterRename);
        const casing = yield* manager.rename(agent.vmAgentId, "NEW IDENTITY");
        assert.strictEqual(casing.name, "NEW IDENTITY");
        assert.strictEqual(casing.handle, agent.handle);
        unsubscribe();
      }),
  );

  it.effect("rejects missing agents and invalid display names without mutation", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const store = yield* VmAgentStore;
      const agent = yield* manager.create({
        name: "Valid Before Rename",
        purpose: "persist",
        threadId: null,
      });
      for (const name of ["", "  ", "x".repeat(65)]) {
        const failure = yield* Effect.flip(manager.rename(agent.vmAgentId, name));
        assert.strictEqual(failure._tag, "VmAgentInvalidNameError");
      }
      assert.deepStrictEqual(Option.getOrThrow(yield* store.getById(agent.vmAgentId)), agent);
      const missing = yield* Effect.flip(
        manager.rename(VmAgentId.make("missing-rename-id"), "Valid"),
      );
      assert.strictEqual(missing._tag, "VmAgentNotFoundError");
    }),
  );

  it.effect("rejects case-insensitive conflicts, including concurrent rename requests", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const store = yield* VmAgentStore;
      const first = yield* manager.create({ name: "Race One", purpose: "race", threadId: null });
      const second = yield* manager.create({ name: "Race Two", purpose: "race", threadId: null });
      const failure = yield* Effect.flip(manager.rename(first.vmAgentId, "rACE tWO"));
      assert.strictEqual(failure._tag, "VmAgentNameConflictError");
      assert.deepStrictEqual(Option.getOrThrow(yield* store.getById(first.vmAgentId)), first);
      const results = yield* Effect.all(
        [
          manager.rename(first.vmAgentId, "Race Winner"),
          manager.rename(second.vmAgentId, "RACE WINNER"),
        ].map((effect) =>
          effect.pipe(
            Effect.map((agent) => ({ kind: "renamed" as const, agent })),
            Effect.catch((error) => Effect.succeed({ kind: "rejected" as const, error })),
          ),
        ),
        { concurrency: "unbounded" },
      );
      assert.strictEqual(results.filter((result) => result.kind === "renamed").length, 1);
      assert.strictEqual(results.filter((result) => result.kind === "rejected").length, 1);
      const rejected = results.find((result) => result.kind === "rejected");
      assert.strictEqual(rejected?.error._tag, "VmAgentNameConflictError");
      const winner = Option.getOrThrow(yield* store.getByNameLower("race winner"));
      assert.include([first.vmAgentId, second.vmAgentId], winner.vmAgentId);
    }),
  );

  it.effect("keeps create-versus-rename name races typed and preserves the original handle", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const store = yield* VmAgentStore;
      const agent = yield* manager.create({
        name: "Original Mention",
        purpose: "route",
        threadId: null,
      });
      yield* manager.rename(agent.vmAgentId, "Updated Mention");
      const occupiedHandle = yield* Effect.flip(
        manager.create({ name: "Original Mention", purpose: "reuse", threadId: null }),
      );
      assert.strictEqual(occupiedHandle._tag, "VmAgentNameConflictError");
      assert.include(occupiedHandle.message, "mention handle @original-mention");
      const results = yield* Effect.all(
        [
          manager.create({ name: "Contested Identity", purpose: "race", threadId: null }),
          manager.rename(agent.vmAgentId, "Contested Identity"),
        ].map((effect) =>
          effect.pipe(
            Effect.map(() => "saved"),
            Effect.catch((error) => Effect.succeed(error._tag)),
          ),
        ),
        { concurrency: "unbounded" },
      );
      assert.deepStrictEqual([...results].sort(), ["VmAgentNameConflictError", "saved"]);
      assert.strictEqual(
        Option.getOrThrow(yield* store.getById(agent.vmAgentId)).handle,
        agent.handle,
      );
    }),
  );

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
      assert.isNumber(agent.avatarColor);

      const persisted = yield* store.getById(agent.vmAgentId);
      assert.isTrue(Option.isSome(persisted));
      if (Option.isSome(persisted)) {
        assert.strictEqual(persisted.value.status, "running");
        assert.strictEqual(persisted.value.avatarColor, agent.avatarColor);
      }
    }),
  );

  it.effect(
    "assigns distinct colors during concurrent creation and preserves survivors on deletion",
    () =>
      Effect.gen(function* () {
        const manager = yield* VmManager;
        const store = yield* VmAgentStore;
        const agents = yield* Effect.all(
          Array.from({ length: 8 }, (_, index) =>
            manager.create({ name: `Color ${index}`, purpose: "color audit", threadId: null }),
          ),
          { concurrency: "unbounded" },
        );
        assert.strictEqual(new Set(agents.map((agent) => agent.avatarColor)).size, 8);
        yield* manager.deleteAgent(agents[0]!.vmAgentId);
        const next = yield* manager.create({
          name: "Next color",
          purpose: "color audit",
          threadId: null,
        });
        for (const agent of agents.slice(1)) {
          const persisted = Option.getOrThrow(yield* store.getById(agent.vmAgentId));
          assert.strictEqual(persisted.avatarColor, agent.avatarColor);
          assert.notStrictEqual(persisted.avatarColor, next.avatarColor);
        }
      }),
  );

  it.effect("wears a requested character when it is free and the lowest free one when not", () =>
    Effect.gen(function* () {
      const manager = yield* VmManager;
      const store = yield* VmAgentStore;
      const lowestFree = Effect.map(store.list(), (agents) => {
        const taken = new Set(agents.map((agent) => agent.avatarColor));
        let index = 0;
        while (taken.has(index)) index += 1;
        return index;
      });
      const picked = yield* manager.create({
        name: "Lantern",
        purpose: "picked in the intro",
        threadId: null,
        avatarColor: 40,
      });
      assert.strictEqual(picked.avatarColor, 40);

      const expectedClash = yield* lowestFree;
      const clash = yield* manager.create({
        name: "Also lantern",
        purpose: "same pick",
        threadId: null,
        avatarColor: 40,
      });
      assert.strictEqual(clash.avatarColor, expectedClash);

      const expectedAuto = yield* lowestFree;
      const auto = yield* manager.create({ name: "Auto", purpose: "no pick", threadId: null });
      assert.strictEqual(auto.avatarColor, expectedAuto);
      assert.isBelow(auto.avatarColor ?? Infinity, 40);
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
