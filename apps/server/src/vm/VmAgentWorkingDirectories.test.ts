import { ThreadId } from "@t3tools/contracts";
import { NodePath } from "@effect/platform-node";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { planAgentWorkingDirectoryMigration } from "./VmAgentWorkingDirectories.ts";

describe("planAgentWorkingDirectoryMigration", () => {
  it.effect("isolates a legacy shared-root agent deterministically", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const plan = planAgentWorkingDirectoryMigration({
        agent: { name: "Pet Channel" },
        agentsWorkspaceDir: "/state/agents",
        currentWorktreePath: null,
        path,
        threadId: ThreadId.make("thread-12345678"),
      });
      expect(plan.requiresUpdate).toBe(true);
      expect(plan.legacyRulesPath).toBe(path.join("/state/agents", "AGENTS.md"));
      expect(plan.desiredWorktreePath).toContain(path.join("state", "agents", "pet-channel-"));
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it.effect("does not rewrite a thread already using its dedicated directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = {
        agent: { name: "Pet Channel" },
        agentsWorkspaceDir: "/state/agents",
        currentWorktreePath: null,
        path,
        threadId: ThreadId.make("thread-12345678"),
      };
      const desired = planAgentWorkingDirectoryMigration(base).desiredWorktreePath;
      expect(
        planAgentWorkingDirectoryMigration({ ...base, currentWorktreePath: desired })
          .requiresUpdate,
      ).toBe(false);
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it.effect("keeps a renamed agent in the directory it already owns", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const threadId = ThreadId.make("thread-12345678");
      const plan = planAgentWorkingDirectoryMigration({
        agent: { name: "Logan" },
        agentsWorkspaceDir: "/state/agents",
        currentWorktreePath: "/state/agents/release-watcher--thread-12345678",
        path,
        threadId,
        ownDirectories: [
          {
            path: "/state/agents/release-watcher--thread-12345678",
            entries: ["AGENTS.md", "CLAUDE.md", "notes.md"],
          },
        ],
      });
      expect(plan.requiresUpdate).toBe(false);
      expect(plan.desiredWorktreePath).toBe("/state/agents/release-watcher--thread-12345678");
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it.effect("moves an agent back from a directory that only holds its copied rules", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const plan = planAgentWorkingDirectoryMigration({
        agent: { name: "Logan" },
        agentsWorkspaceDir: "/state/agents",
        currentWorktreePath: "/state/agents/logan--thread-12345678",
        path,
        threadId: ThreadId.make("thread-12345678"),
        ownDirectories: [
          {
            path: "/state/agents/logan--thread-12345678",
            entries: ["AGENTS.md", "CLAUDE.md"],
          },
          {
            path: "/state/agents/release-watcher--thread-12345678",
            entries: ["AGENTS.md", "CLAUDE.md", "notes.md", "scripts"],
          },
        ],
      });
      expect(plan.requiresUpdate).toBe(true);
      expect(plan.desiredWorktreePath).toBe("/state/agents/release-watcher--thread-12345678");
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it.effect("leaves a fresh agent alone while it has only its rules", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const own = "/state/agents/logan--thread-12345678";
      const plan = planAgentWorkingDirectoryMigration({
        agent: { name: "Logan" },
        agentsWorkspaceDir: "/state/agents",
        currentWorktreePath: own,
        path,
        threadId: ThreadId.make("thread-12345678"),
        ownDirectories: [{ path: own, entries: ["AGENTS.md", "CLAUDE.md"] }],
      });
      expect(plan.requiresUpdate).toBe(false);
    }).pipe(Effect.provide(NodePath.layer)),
  );
});
