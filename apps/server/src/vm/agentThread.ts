/**
 * Lifecycle of an agent's dedicated chat thread.
 *
 * Kept out of {@link VmManager} so the manager stays free of orchestration
 * dependencies (which would complicate its layer). These are plain Effects that
 * require the orchestration engine + server config in context; the ws handler,
 * which already has both, runs them alongside the VM lifecycle.
 */
import {
  AGENT_BUILDER_THREAD_PREFIX,
  AGENTS_PROJECT_ID,
  AGENTS_PROJECT_NAME,
  CommandId,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  MessageId,
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

/** Derives a readable thread title from the builder request's first line. */
export const agentBuilderThreadTitle = (prompt: string): string => {
  const firstLine = prompt.trim().split("\n", 1)[0]?.replace(/\s+/gu, " ").trim() ?? "";
  const seed = firstLine.length > 0 ? firstLine : "Agent Builder";
  return seed.length > 60 ? `${seed.slice(0, 59).trimEnd()}…` : seed;
};

/**
 * The kickoff turn the builder chat starts on. The thread's prefixed id grants
 * it the agent_builder MCP tool; this message tells the model to use it to take
 * the single request all the way to a fully configured, verified agent.
 */
export const agentBuilderKickoffMessage = (prompt: string): string =>
  [
    "You are in an Agent Builder chat. Your agent_builder tool creates and configures custom agents — each a named worker with its own persistent computer, dedicated chat, scheduled tasks, notification preferences, and one structured artifact.",
    "",
    "Build the agent this request describes, end to end, without waiting for further input:",
    "1. Design first: pick a short memorable name (it doubles as the @mention handle) and a crisp purpose.",
    "2. create_agent, then configure everything the request implies — chat model or access mode (configure_agent_chat), tasks with complete unattended prompts, completion criteria, schedules and notification policies (create_task), notification preferences, and define_artifact when the agent should maintain a dashboard-style surface.",
    "3. Verify with get_agent and finish with a short report of what now exists and how to reach it.",
    "Everything you create is live immediately. If the request is ambiguous, choose sensible defaults and say what you chose.",
    "",
    "The request:",
    prompt.trim(),
  ].join("\n");

/**
 * Starts an Agent Builder chat: one atomic thread.turn.start that creates a
 * thread under the reserved agents project and immediately runs the kickoff
 * turn on the caller's chosen model. Unlike {@link createAgentThread}, failures
 * propagate — with no thread there is nothing to fall back on.
 */
export const createAgentBuilderThread = (input: {
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
}) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngine.OrchestrationEngineService;
    const config = yield* ServerConfig.ServerConfig;
    const createdAt = DateTime.formatIso(yield* DateTime.now);

    // Idempotent: the reserved project exists after the first agent; a repeat
    // create fails the decider's absent-invariant, which we swallow.
    yield* engine
      .dispatch({
        type: "project.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        projectId: AGENTS_PROJECT_ID,
        title: AGENTS_PROJECT_NAME,
        workspaceRoot: config.agentsWorkspaceDir,
        defaultModelSelection: agentDefaultModelSelection(),
        createdAt,
      })
      .pipe(Effect.catch(() => Effect.void));

    const threadId = ThreadId.make(`${AGENT_BUILDER_THREAD_PREFIX}${NodeCrypto.randomUUID()}`);
    const title = agentBuilderThreadTitle(input.prompt);
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId,
      message: {
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        role: "user",
        text: agentBuilderKickoffMessage(input.prompt),
        attachments: [],
      },
      modelSelection: input.modelSelection,
      titleSeed: title,
      runtimeMode: "full-access",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      bootstrap: {
        createThread: {
          projectId: AGENTS_PROJECT_ID,
          title,
          modelSelection: input.modelSelection,
          runtimeMode: "full-access",
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          branch: null,
          worktreePath: null,
          createdAt,
        },
      },
      createdAt,
    });
    return threadId;
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
