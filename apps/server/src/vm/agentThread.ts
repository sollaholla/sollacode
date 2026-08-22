/**
 * Lifecycle of an agent's dedicated chat thread.
 *
 * Kept out of {@link VmManager} so the manager stays free of orchestration
 * dependencies (which would complicate its layer). These are plain Effects that
 * require the orchestration engine + server config in context; the ws handler,
 * which already has both, runs them alongside the VM lifecycle.
 */
import {
  AGENTS_PROJECT_ID,
  AGENTS_PROJECT_NAME,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ModelSelection,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as ServerConfig from "../config.ts";
import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";

const agentDefaultModelSelection = (): ModelSelection => ({
  instanceId: ProviderInstanceId.make("codex"),
  model: DEFAULT_MODEL,
});

/**
 * Create the agent's dedicated single chat thread under the reserved (hidden)
 * agents project. Returns the new thread id, or null if creation failed — the
 * agent is still usable, its chat is just unavailable.
 */
export const createAgentThread = (name: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const config = yield* ServerConfig.ServerConfig;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const modelSelection = agentDefaultModelSelection();

    // Idempotent: the reserved project exists after the first agent; a repeat
    // create fails the decider's absent-invariant, which we swallow.
    yield* engine
      .dispatch({
        type: "project.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        projectId: AGENTS_PROJECT_ID,
        title: AGENTS_PROJECT_NAME,
        workspaceRoot: config.agentsWorkspaceDir,
        defaultModelSelection: modelSelection,
        createdAt,
      })
      .pipe(Effect.catch(() => Effect.void));

    const threadId = ThreadId.make(NodeCrypto.randomUUID());
    return yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
        projectId: AGENTS_PROJECT_ID,
        title: name,
        modelSelection,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "full-access",
        branch: null,
        worktreePath: null,
        createdAt,
      })
      .pipe(
        Effect.as<ThreadId | null>(threadId),
        Effect.orElseSucceed((): ThreadId | null => null),
      );
  });

/** Delete an agent's chat thread when the agent is removed. Best-effort. */
export const deleteAgentThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    yield* engine
      .dispatch({
        type: "thread.delete",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId,
      })
      .pipe(Effect.catch(() => Effect.void));
  });
