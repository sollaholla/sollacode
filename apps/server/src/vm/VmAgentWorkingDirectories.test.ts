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
        agent: { name: "Pawstalgia Tunes" },
        agentsWorkspaceDir: "/state/agents",
        currentWorktreePath: null,
        path,
        threadId: ThreadId.make("thread-12345678"),
      });
      expect(plan.requiresUpdate).toBe(true);
      expect(plan.legacyRulesPath).toBe(path.join("/state/agents", "AGENTS.md"));
      expect(plan.desiredWorktreePath).toContain(path.join("state", "agents", "pawstalgia-tunes-"));
    }).pipe(Effect.provide(NodePath.layer)),
  );

  it.effect("does not rewrite a thread already using its dedicated directory", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const base = {
        agent: { name: "Pawstalgia Tunes" },
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
});
