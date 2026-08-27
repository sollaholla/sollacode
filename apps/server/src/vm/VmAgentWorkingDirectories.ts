import { CommandId, type ThreadId, type VmAgent } from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { agentWorkingDirectoryName } from "./agentThread.ts";
import {
  ensureVmAgentClaudeRulesPointer,
  VM_AGENT_CLAUDE_RULES_FILE_NAME,
  VM_AGENT_RULES_FILE_NAME,
} from "./VmAgentRules.ts";

export interface AgentWorkingDirectoryMigrationPlan {
  readonly desiredWorktreePath: string;
  readonly legacyRulesPath: string;
  readonly requiresUpdate: boolean;
}

export function planAgentWorkingDirectoryMigration(input: {
  readonly agent: Pick<VmAgent, "name">;
  readonly agentsWorkspaceDir: string;
  readonly currentWorktreePath: string | null;
  readonly path: Path.Path;
  readonly threadId: ThreadId;
}): AgentWorkingDirectoryMigrationPlan {
  const desiredWorktreePath = input.path.resolve(
    input.agentsWorkspaceDir,
    agentWorkingDirectoryName(input.agent.name, input.threadId),
  );
  const legacyRoot = input.path.resolve(input.currentWorktreePath ?? input.agentsWorkspaceDir);
  return {
    desiredWorktreePath,
    legacyRulesPath: input.path.join(legacyRoot, "AGENTS.md"),
    requiresUpdate: legacyRoot !== desiredWorktreePath,
  };
}

/**
 * Older named agents inherited the shared `agents/` project root. Move their
 * thread metadata to deterministic per-agent children without deleting or
 * moving any legacy files. Only AGENTS.md is copied so durable rules survive;
 * ambiguous shared work products remain untouched at the old root. A local
 * CLAUDE.md import is then created or amended so Claude reads those rules too.
 */
export const migrateVmAgentWorkingDirectories = Effect.gen(function* () {
  const agents = yield* VmAgentStore;
  const config = yield* ServerConfig.ServerConfig;
  const crypto = yield* Crypto.Crypto;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const projection = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;

  const registeredAgents = yield* agents.list();
  yield* Effect.forEach(
    registeredAgents,
    (agent) =>
      Effect.gen(function* () {
        if (agent.threadId === null) return;
        const thread = yield* projection.getThreadShellById(agent.threadId);
        if (Option.isNone(thread)) return;
        const plan = planAgentWorkingDirectoryMigration({
          agent,
          agentsWorkspaceDir: config.agentsWorkspaceDir,
          currentWorktreePath: thread.value.worktreePath,
          path,
          threadId: agent.threadId,
        });
        yield* fileSystem.makeDirectory(plan.desiredWorktreePath, { recursive: true });
        const nextRulesPath = path.join(plan.desiredWorktreePath, VM_AGENT_RULES_FILE_NAME);
        const [legacyRulesExist, nextRulesExist] = yield* Effect.all([
          fileSystem.exists(plan.legacyRulesPath),
          fileSystem.exists(nextRulesPath),
        ]);
        if (plan.requiresUpdate && legacyRulesExist && !nextRulesExist) {
          const rules = yield* fileSystem.readFileString(plan.legacyRulesPath);
          yield* fileSystem.writeFileString(nextRulesPath, rules);
        }

        const durableRulesExist = nextRulesExist || (plan.requiresUpdate && legacyRulesExist);
        if (durableRulesExist) {
          const claudeRulesPath = path.join(
            plan.desiredWorktreePath,
            VM_AGENT_CLAUDE_RULES_FILE_NAME,
          );
          const claudeRulesExist = yield* fileSystem.exists(claudeRulesPath);
          const currentClaudeRules = claudeRulesExist
            ? yield* fileSystem.readFileString(claudeRulesPath)
            : "";
          const nextClaudeRules = ensureVmAgentClaudeRulesPointer(currentClaudeRules);
          if (nextClaudeRules !== currentClaudeRules) {
            yield* fileSystem.writeFileString(claudeRulesPath, nextClaudeRules);
          }
        }

        if (!plan.requiresUpdate) return;

        const commandUuid = yield* crypto.randomUUIDv4;
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: CommandId.make(`agent-working-directory:${commandUuid}`),
          threadId: agent.threadId,
          worktreePath: plan.desiredWorktreePath,
        });
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to isolate named agent working directory", {
            cause,
            vmAgentId: agent.vmAgentId,
          }),
        ),
      ),
    { discard: true },
  );
});
