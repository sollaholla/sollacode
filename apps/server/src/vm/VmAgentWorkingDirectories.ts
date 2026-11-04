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

/** One directory under the agents folder that belongs to the agent, and what it holds. */
export interface AgentOwnDirectory {
  readonly path: string;
  readonly entries: ReadonlyArray<string>;
}

/** The files a directory holds when it was only ever set up, never worked in. */
const SETUP_ONLY_ENTRIES = new Set([VM_AGENT_RULES_FILE_NAME, VM_AGENT_CLAUDE_RULES_FILE_NAME]);
const holdsWork = (directory: AgentOwnDirectory) =>
  directory.entries.some((entry) => !SETUP_ONLY_ENTRIES.has(entry) && entry !== ".DS_Store");

/** Whether `name` is one of this agent's own directory names, under any name it has had. */
export const isAgentOwnDirectoryName = (name: string, threadId: ThreadId): boolean =>
  name.endsWith(`--${threadId}`);

/**
 * Where an agent's chat should work. An agent already in a directory of its
 * own stays there: the directory name carries the agent's name only for
 * reading, so a rename never moves it, since its files, and the provider
 * conversations recorded against that path, live there. The one exception
 * repairs 0.1.795, which moved renamed agents into a fresh directory holding
 * only their rules: the directory the agent actually worked in wins back.
 */
export function planAgentWorkingDirectoryMigration(input: {
  readonly agent: Pick<VmAgent, "name">;
  readonly agentsWorkspaceDir: string;
  readonly currentWorktreePath: string | null;
  readonly path: Path.Path;
  readonly threadId: ThreadId;
  /** The agent's own directories under the agents folder, under any name. */
  readonly ownDirectories?: ReadonlyArray<AgentOwnDirectory>;
}): AgentWorkingDirectoryMigrationPlan {
  const agentsDir = input.path.resolve(input.agentsWorkspaceDir);
  const current =
    input.currentWorktreePath === null ? null : input.path.resolve(input.currentWorktreePath);
  const own = (input.ownDirectories ?? []).map((directory) => ({
    ...directory,
    path: input.path.resolve(directory.path),
  }));
  const worked = own
    .filter(holdsWork)
    .toSorted((left, right) => right.entries.length - left.entries.length)[0];
  const currentIsOwn =
    current !== null &&
    input.path.dirname(current) === agentsDir &&
    isAgentOwnDirectoryName(input.path.basename(current), input.threadId);
  const currentDirectory = own.find((directory) => directory.path === current);
  const desiredWorktreePath = currentIsOwn
    ? worked !== undefined && currentDirectory !== undefined && !holdsWork(currentDirectory)
      ? worked.path
      : current
    : (worked?.path ??
      input.path.resolve(agentsDir, agentWorkingDirectoryName(input.agent.name, input.threadId)));
  const legacyRoot = current ?? agentsDir;
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
        const threadId = agent.threadId;
        const names = yield* fileSystem
          .readDirectory(config.agentsWorkspaceDir)
          .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
        const ownDirectories = yield* Effect.forEach(
          names.filter((name) => isAgentOwnDirectoryName(name, threadId)),
          (name) => {
            const directory = path.join(config.agentsWorkspaceDir, name);
            return fileSystem.readDirectory(directory).pipe(
              Effect.map((entries) => [{ path: directory, entries }]),
              Effect.orElseSucceed(() => []),
            );
          },
        ).pipe(Effect.map((found) => found.flat()));
        const plan = planAgentWorkingDirectoryMigration({
          agent,
          agentsWorkspaceDir: config.agentsWorkspaceDir,
          currentWorktreePath: thread.value.worktreePath,
          path,
          threadId,
          ownDirectories,
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
