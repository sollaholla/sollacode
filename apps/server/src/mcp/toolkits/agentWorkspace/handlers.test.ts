import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  VmAgentBlockerId,
  VmAgentId,
  VmAgentTaskId,
  VmId,
  type VmAgent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import {
  VmAgentWorkspace,
  type CreateWorkspaceTaskInput,
  type UpdateWorkspaceTaskInput,
} from "../../../vm/VmAgentWorkspace.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { handleAgentWorkspace } from "./handlers.ts";

const threadId = ThreadId.make("thread-agent-workspace");
const vmAgentId = VmAgentId.make("agent-workspace");
const iso = "2026-08-21T20:00:00.000Z";
const agent: VmAgent = {
  vmAgentId,
  name: "Scout",
  handle: "scout",
  purpose: "Monitor dashboards",
  vmId: VmId.make("vm-agent-workspace"),
  threadId,
  status: "running",
  controlMode: "agent",
  guestIp: "127.0.0.1",
  lastError: null,
  createdAt: iso,
  updatedAt: iso,
};
const recurringTask = {
  taskId: VmAgentTaskId.make("recurring-task"),
  vmAgentId,
  title: "Daily dashboard",
  prompt: "Check the dashboard.",
  completionCriteria: [],
  status: "active" as const,
  schedule: { kind: "interval" as const, everyMinutes: 1_440 },
  nextRunAt: iso,
  createdBy: "user" as const,
  approvalState: "approved" as const,
  notificationPolicy: "always" as const,
  artifactId: null,
  createdAt: iso,
  updatedAt: iso,
};

const invocation = (
  capabilities = new Set<McpInvocationContext.McpCapability>(["vm"]),
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-agent-workspace"),
  threadId,
  providerSessionId: "session-agent-workspace",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

const makeHarness = (boundAgent: VmAgent | null = agent) => {
  const created: CreateWorkspaceTaskInput[] = [];
  const updated: UpdateWorkspaceTaskInput[] = [];
  const raised: Array<{ readonly title: string; readonly detail: string }> = [];
  const resolvedIds: string[] = [];
  let wakeCount = 0;
  const storeLayer = Layer.mock(VmAgentStore)({
    getByThreadId: () => Effect.succeed(Option.fromNullishOr(boundAgent)),
  });
  const workspaceLayer = Layer.mock(VmAgentWorkspace)({
    snapshot: () =>
      Effect.succeed({
        type: "snapshot" as const,
        vmAgentId,
        tasks: [recurringTask],
        runs: [],
        artifact: null,
        notifications: [],
        blockers: [],
        notificationPreferences: {
          vmAgentId,
          enabled: true,
          taskCompletions: true,
          taskFailures: true,
          agentMessages: true,
          updatedAt: iso,
        },
      }),
    createTask: (input) =>
      Effect.sync(() => {
        created.push(input);
        const recurring = input.schedule?.kind === "interval";
        return {
          taskId: VmAgentTaskId.make("created-task"),
          vmAgentId: input.vmAgentId,
          title: input.title,
          prompt: input.prompt,
          completionCriteria: input.completionCriteria,
          status: recurring ? "draft" : "active",
          schedule: input.schedule,
          nextRunAt: null,
          createdBy: "agent",
          approvalState: recurring ? "pending" : "approved",
          notificationPolicy: input.notificationPolicy ?? "always",
          artifactId: null,
          createdAt: iso,
          updatedAt: iso,
        };
      }),
    notify: () => Effect.succeed(false),
    raiseBlocker: (input) =>
      Effect.sync(() => {
        raised.push(input);
        return {
          blockerId: VmAgentBlockerId.make("blocker-raised"),
          vmAgentId: input.vmAgentId,
          title: input.title,
          detail: input.detail,
          url: input.url ?? null,
          createdAt: iso,
          updatedAt: iso,
          resolvedAt: null,
          resolvedBy: null,
        };
      }),
    resolveBlocker: (input) =>
      Effect.sync(() => {
        resolvedIds.push(input.blockerId);
        return input.blockerId === "blocker-raised"
          ? Option.some({
              blockerId: input.blockerId,
              vmAgentId: input.vmAgentId,
              title: "Google sign-in needs you",
              detail: "reCAPTCHA",
              url: null,
              createdAt: iso,
              updatedAt: iso,
              resolvedAt: iso,
              resolvedBy: "agent" as const,
            })
          : Option.none();
      }),
    updateTask: (input) =>
      Effect.sync(() => {
        updated.push(input);
        return {
          ...recurringTask,
          title: input.title ?? recurringTask.title,
          prompt: input.prompt ?? recurringTask.prompt,
          completionCriteria: input.completionCriteria ?? recurringTask.completionCriteria,
          status: input.status ?? recurringTask.status,
          schedule: input.schedule === undefined ? recurringTask.schedule : input.schedule,
          approvalState: input.approvalState ?? recurringTask.approvalState,
          notificationPolicy: input.notificationPolicy ?? recurringTask.notificationPolicy,
        };
      }),
  });
  const schedulerLayer = Layer.mock(VmAgentTaskScheduler)({
    wake: () => Effect.sync(() => void (wakeCount += 1)),
  });
  return {
    created,
    updated,
    raised,
    resolvedIds,
    wakeCount: () => wakeCount,
    layer: Layer.mergeAll(storeLayer, workspaceLayer, schedulerLayer),
  };
};

type Services = VmAgentStore | VmAgentWorkspace | VmAgentTaskScheduler;
const run = <A, E>(
  effect: Effect.Effect<A, E, McpInvocationContext.McpInvocationContext | Services>,
  layer: Layer.Layer<Services>,
  capabilities?: Set<McpInvocationContext.McpCapability>,
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext.McpInvocationContext, invocation(capabilities)),
    Effect.provide(layer),
  );

it.effect("rejects non-VM callers before resolving an agent", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const error = yield* Effect.flip(
      run(handleAgentWorkspace({ action: "list_tasks" }), harness.layer, new Set(["history"])),
    );
    assert.strictEqual(error._tag, "AgentWorkspaceCapabilityUnavailableError");
  }),
);

it.effect("report_blocker records a standing request and echoes the blocker", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* run(
      handleAgentWorkspace({
        action: "report_blocker",
        title: "Google sign-in needs you",
        blockerDetail: "Studio shows a reCAPTCHA only a human can pass.",
        blockerUrl: "https://studio.youtube.com/",
      }),
      harness.layer,
    );
    assert.strictEqual(harness.raised.length, 1);
    assert.strictEqual(result.blocker?.blockerId, "blocker-raised");
    assert.include(result.status, "standing request");
  }),
);

it.effect("report_blocker refuses a report with no detail to show the user", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const error = yield* Effect.flip(
      run(handleAgentWorkspace({ action: "report_blocker", title: "Blocked" }), harness.layer),
    );
    assert.strictEqual(error._tag, "AgentWorkspaceInvalidInputError");
    assert.strictEqual(harness.raised.length, 0);
  }),
);

it.effect("resolve_blocker reports an already-resolved id as a no-op, not an error", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const resolved = yield* run(
      handleAgentWorkspace({ action: "resolve_blocker", blockerId: "blocker-raised" }),
      harness.layer,
    );
    assert.strictEqual(resolved.blocker?.resolvedBy, "agent");
    const missing = yield* run(
      handleAgentWorkspace({ action: "resolve_blocker", blockerId: "blocker-gone" }),
      harness.layer,
    );
    assert.include(missing.status, "already be resolved");
    assert.deepStrictEqual(harness.resolvedIds, ["blocker-raised", "blocker-gone"]);
  }),
);

it.effect("never accepts an arbitrary target agent id", () =>
  Effect.gen(function* () {
    const harness = makeHarness(null);
    const error = yield* Effect.flip(
      run(
        handleAgentWorkspace({
          action: "create_task",
          title: "Try another agent",
          prompt: "Do work.",
        }),
        harness.layer,
      ),
    );
    assert.strictEqual(error._tag, "AgentWorkspaceNoAgentError");
    assert.strictEqual(harness.created.length, 0);
  }),
);

it.effect("passes recurring agent work through the approval boundary and wakes the scheduler", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* run(
      handleAgentWorkspace({
        action: "create_task",
        title: "Daily check",
        prompt: "Check the dashboard.",
        schedule: { kind: "interval", everyMinutes: 1_440 },
      }),
      harness.layer,
    );
    assert.strictEqual(result.task?.approvalState, "pending");
    assert.strictEqual(harness.created[0]?.vmAgentId, vmAgentId);
    assert.strictEqual(harness.created[0]?.createdBy, "agent");
    assert.strictEqual(harness.created[0]?.activate, true);
    assert.strictEqual(harness.wakeCount(), 1);
  }),
);

it.effect("reports when notification preferences suppress delivery", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* run(
      handleAgentWorkspace({
        action: "notify_user",
        title: "Dashboard update",
        notificationBody: "The report is ready.",
      }),
      harness.layer,
    );
    assert.include(result.status, "no notification was delivered");
  }),
);

it.effect("requires approval when an agent changes an existing recurring task", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* run(
      handleAgentWorkspace({
        action: "update_task",
        taskId: recurringTask.taskId,
        prompt: "Check the dashboard and compare it with yesterday.",
      }),
      harness.layer,
    );
    assert.strictEqual(harness.updated[0]?.status, "draft");
    assert.strictEqual(harness.updated[0]?.approvalState, "pending");
    assert.include(result.status, "waiting for user approval");
  }),
);
