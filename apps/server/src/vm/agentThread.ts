/**
 * Lifecycle of an agent's dedicated chat thread.
 *
 * Kept out of {@link VmManager} so the manager stays free of orchestration
 * dependencies (which would complicate its layer). These are plain Effects that
 * require the orchestration engine + server config in context; the ws handler,
 * which already has both, runs them alongside the VM lifecycle.
 */
import {
  AGENT_BUILDER_THREAD_ID,
  AGENT_BUILDER_THREAD_TITLE,
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

/**
 * Greets the user once, when the singleton builder thread is first created.
 * The text also sits at the top of the model's transcript, so it doubles as
 * standing instructions; the agent_builder tool description carries the rest.
 */
export const AGENT_BUILDER_WELCOME = [
  "This is the Agent Builder — describe an agent in one message and it gets designed and created end to end: a named worker with its own computer, dedicated chat, scheduled tasks, notification preferences, and a structured artifact when it needs a dashboard.",
  "",
  "Pick the model for the build with the model picker below, then say what the agent should do. Sensible defaults fill any gaps, everything created is live immediately and verified with get_agent, and this chat stays open for adjustments — renaming, rescheduling, or deleting agents included.",
].join("\n");

/**
 * Ensures the singleton Agent Builder chat exists and returns its id.
 *
 * One persistent thread, not one per request: like the orchestrator, it is
 * seeded lazily (first click), guarded from deletion in the decider, and
 * reused forever. Idempotent by construction — the create commands fail the
 * decider's absent-invariants on a repeat and are swallowed; the welcome is
 * only posted on the run that actually created the thread.
 */
export const openAgentBuilderThread = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const config = yield* ServerConfig.ServerConfig;
  const createdAt = DateTime.formatIso(yield* DateTime.now);

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

  const created = yield* engine
    .dispatch({
      type: "thread.create",
      commandId: CommandId.make(NodeCrypto.randomUUID()),
      threadId: AGENT_BUILDER_THREAD_ID,
      projectId: AGENTS_PROJECT_ID,
      title: AGENT_BUILDER_THREAD_TITLE,
      modelSelection: agentDefaultModelSelection(),
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt,
    })
    .pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    );

  if (created) {
    // Streamed then completed, the ordinary shape of an assistant message.
    // Keyed commandIds make a rerun of this pair an engine-level duplicate
    // rather than a second welcome.
    const messageId = MessageId.make("agent-builder-welcome");
    yield* engine
      .dispatch({
        type: "thread.message.assistant.delta",
        commandId: CommandId.make("agent-builder-welcome"),
        threadId: AGENT_BUILDER_THREAD_ID,
        messageId,
        delta: AGENT_BUILDER_WELCOME,
        createdAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    yield* engine
      .dispatch({
        type: "thread.message.assistant.complete",
        commandId: CommandId.make("agent-builder-welcome-end"),
        threadId: AGENT_BUILDER_THREAD_ID,
        messageId,
        createdAt,
      })
      .pipe(Effect.ignoreCause({ log: true }));
  }

  return AGENT_BUILDER_THREAD_ID;
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
