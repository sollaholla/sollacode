import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  VmAgentId,
  VmId,
  type OrchestrationCommand,
  type VmAgent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Path from "effect/Path";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as OrchestrationEngine from "../../../orchestration/Services/OrchestrationEngine.ts";
import * as ServerConfig from "../../../config.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { VmAgentWorkspace, type CreateWorkspaceTaskInput } from "../../../vm/VmAgentWorkspace.ts";
import { VmManager } from "../../../vm/VmManager.ts";
import { handleAgentBuilder } from "./handlers.ts";

const builderThreadId = ThreadId.make("agent-builder:handlers-test");
const iso = "2026-08-22T10:00:00.000Z";
const agentThreadId = ThreadId.make("thread-built-agent");
const agent: VmAgent = {
  vmAgentId: VmAgentId.make("agent-built"),
  name: "Scout",
  handle: "scout",
  purpose: "Monitor dashboards",
  vmId: VmId.make("vm-built-agent"),
  threadId: agentThreadId,
  status: "running",
  controlMode: "agent",
  guestIp: "127.0.0.1",
  lastError: null,
  createdAt: iso,
  updatedAt: iso,
};

const invocation = (
  capabilities = new Set<McpInvocationContext.McpCapability>(["agent-builder"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-agent-builder"),
  threadId: builderThreadId,
  providerSessionId: "session-agent-builder",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

const makeHarness = (existingAgents: ReadonlyArray<VmAgent> = [agent]) => {
  const dispatched: OrchestrationCommand[] = [];
  const createdAgents: Array<{ name: string; purpose: string; threadId: ThreadId | null }> = [];
  const createdTasks: CreateWorkspaceTaskInput[] = [];
  const deletedAgents: string[] = [];
  let wakeCount = 0;

  const engineLayer = Layer.mock(OrchestrationEngine.OrchestrationEngineService)({
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  });
  const storeLayer = Layer.mock(VmAgentStore)({
    list: () => Effect.succeed(existingAgents),
  });
  const managerLayer = Layer.mock(VmManager)({
    create: (input) =>
      Effect.sync(() => {
        createdAgents.push(input);
        return { ...agent, name: input.name, purpose: input.purpose, threadId: input.threadId };
      }),
    deleteAgent: (vmAgentId) =>
      Effect.sync(() => {
        deletedAgents.push(vmAgentId);
        return agentThreadId;
      }),
  });
  const workspaceLayer = Layer.mock(VmAgentWorkspace)({
    ensure: () => Effect.void,
    createTask: (input) =>
      Effect.sync(() => {
        createdTasks.push(input);
        return {
          taskId: "created-task" as never,
          vmAgentId: input.vmAgentId,
          title: input.title,
          prompt: input.prompt,
          completionCriteria: input.completionCriteria,
          status: "active" as const,
          schedule: input.schedule,
          nextRunAt: null,
          createdBy: input.createdBy,
          approvalState: "approved" as const,
          notificationPolicy: input.notificationPolicy ?? ("always" as const),
          artifactId: null,
          createdAt: iso,
          updatedAt: iso,
        };
      }),
  });
  const schedulerLayer = Layer.mock(VmAgentTaskScheduler)({
    wake: () => Effect.sync(() => void (wakeCount += 1)),
  });

  return {
    dispatched,
    createdAgents,
    createdTasks,
    deletedAgents,
    wakeCount: () => wakeCount,
    layer: Layer.mergeAll(engineLayer, storeLayer, managerLayer, workspaceLayer, schedulerLayer),
  };
};

const configLayer = ServerConfig.ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-agent-builder-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type Services =
  | OrchestrationEngine.OrchestrationEngineService
  | VmAgentStore
  | VmManager
  | VmAgentWorkspace
  | VmAgentTaskScheduler;
const run = <A, E>(
  effect: Effect.Effect<
    A,
    E,
    | McpInvocationContext.McpInvocationContext
    | ServerConfig.ServerConfig
    | FileSystem.FileSystem
    | Path.Path
    | Services
  >,
  layer: Layer.Layer<Services>,
  capabilities?: Set<McpInvocationContext.McpCapability>,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    Effect.provide(Layer.merge(layer, configLayer)),
  );

it.effect("is unreachable outside an Agent Builder chat", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const error = yield* Effect.flip(
      run(handleAgentBuilder({ action: "list_agents" }), harness.layer, new Set(["vm"])),
    );
    assert.strictEqual(error._tag, "AgentBuilderCapabilityUnavailableError");
  }),
);

it.effect("create_agent makes the chat thread, the agent, and applies chat configuration", () =>
  Effect.gen(function* () {
    const harness = makeHarness([]);
    const result = yield* run(
      handleAgentBuilder({
        action: "create_agent",
        name: "Lighthouse",
        purpose: "Watch the fleet.",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
      }),
      harness.layer,
    );
    assert.strictEqual(harness.createdAgents[0]?.name, "Lighthouse");
    // The dedicated chat existed before the agent record pointed at it.
    assert.isNotNull(harness.createdAgents[0]?.threadId);
    const types = harness.dispatched.map((command) => command.type);
    assert.include(types, "thread.create");
    assert.include(types, "thread.meta.update");
    assert.include(result.status, "Lighthouse");
  }),
);

it.effect("targets agents by exact name only, case-insensitively", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const found = yield* run(
      handleAgentBuilder({ action: "get_agent", agentName: "sCOUT" }).pipe(
        Effect.provide(
          Layer.mock(VmAgentWorkspace)({
            snapshot: () =>
              Effect.succeed({
                type: "snapshot" as const,
                vmAgentId: agent.vmAgentId,
                tasks: [],
                runs: [],
                artifact: null,
                notifications: [],
                blockers: [],
                notificationPreferences: {
                  vmAgentId: agent.vmAgentId,
                  enabled: true,
                  taskCompletions: true,
                  taskFailures: true,
                  agentMessages: true,
                  updatedAt: iso,
                },
              }),
          }),
        ),
      ),
      harness.layer,
    );
    assert.strictEqual(found.agent?.vmAgentId, agent.vmAgentId);

    const missing = yield* Effect.flip(
      run(handleAgentBuilder({ action: "get_agent", agentName: "Scot" }), harness.layer),
    );
    assert.strictEqual(missing._tag, "AgentBuilderUnknownAgentError");
  }),
);

it.effect(
  "create_task writes with the user's pen — active immediately — and wakes the scheduler",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* run(
        handleAgentBuilder({
          action: "create_task",
          agentName: "Scout",
          title: "Morning sweep",
          prompt: "Check every dashboard.",
          schedule: { kind: "interval", everyMinutes: 1_440 },
        }),
        harness.layer,
      );
      assert.strictEqual(harness.createdTasks[0]?.createdBy, "user");
      assert.strictEqual(harness.createdTasks[0]?.activate, true);
      assert.strictEqual(harness.wakeCount(), 1);
    }),
);

it.effect("delete_agent demands the exact name before destroying anything", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const refused = yield* Effect.flip(
      run(
        handleAgentBuilder({ action: "delete_agent", agentName: "Scout", confirmName: "scout" }),
        harness.layer,
      ),
    );
    assert.strictEqual(refused._tag, "AgentBuilderInvalidInputError");
    assert.lengthOf(harness.deletedAgents, 0);

    yield* run(
      handleAgentBuilder({ action: "delete_agent", agentName: "Scout", confirmName: "Scout" }),
      harness.layer,
    );
    assert.deepStrictEqual(harness.deletedAgents, [agent.vmAgentId]);
    // The dedicated chat goes with the agent.
    assert.include(
      harness.dispatched.map((command) => command.type),
      "thread.delete",
    );
  }),
);
