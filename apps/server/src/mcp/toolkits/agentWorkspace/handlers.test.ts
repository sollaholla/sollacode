import {
  EnvironmentId,
  ORCHESTRATOR_THREAD_ID,
  ProviderInstanceId,
  ThreadId,
  VmAgentBlockerId,
  VmAgentDelegationId,
  VmAgentId,
  VmAgentTaskId,
  VmId,
  type OrchestrationThreadShell,
  type VmAgent,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionTurnTrigger,
} from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { PersistenceSqlError } from "../../../persistence/Errors.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import {
  VmAgentWorkspace,
  type CreateWorkspaceTaskInput,
  type UpdateWorkspaceTaskInput,
} from "../../../vm/VmAgentWorkspace.ts";
import { VmAgentTaskScheduler } from "../../../vm/VmAgentTaskScheduler.ts";
import { VmManager } from "../../../vm/VmManager.ts";
import {
  AgentCalls,
  type AgentCallRingOutcome,
  type AgentCallsShape,
} from "../../../vm/AgentCalls.ts";
import { handleAgentWorkspace } from "./handlers.ts";

const threadId = ThreadId.make("thread-agent-workspace");
/** A side chat the person forked from the agent's chat. */
const sideChatThreadId = ThreadId.make("thread-agent-workspace-side-chat");
/** A delegated worker forked from the agent's chat. */
const workerThreadId = ThreadId.make("delegation-worker:delegation-agent-workspace");
/** Who started the caller's turn: a delegation, another chat, or the orchestrator. */
const delegatedTurn: ProjectionTurnTrigger = {
  senderThreadId: ThreadId.make("thread-other-agent"),
  delegationId: VmAgentDelegationId.make("delegation-agent-workspace"),
};
const otherChatTurn: ProjectionTurnTrigger = {
  senderThreadId: ThreadId.make("thread-plain-chat"),
  delegationId: null,
};
const orchestratorTurn: ProjectionTurnTrigger = {
  senderThreadId: ThreadId.make(ORCHESTRATOR_THREAD_ID),
  delegationId: null,
};
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
  icon: null,
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
const onceTask = {
  ...recurringTask,
  taskId: VmAgentTaskId.make("once-task"),
  title: "Send the report",
  prompt: "Send the weekly report.",
  schedule: { kind: "once" as const, runAt: "2026-08-22T20:00:00.000Z" },
  createdBy: "agent" as const,
};

const invocation = (
  capabilities = new Set<McpInvocationContext.McpCapability>(["vm"]),
  callerThreadId: ThreadId = threadId,
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("env-agent-workspace"),
  threadId: callerThreadId,
  providerSessionId: "session-agent-workspace",
  providerInstanceId: ProviderInstanceId.make("codex"),
  capabilities,
  issuedAt: 1,
});

const makeHarness = (
  boundAgent: VmAgent | null = agent,
  autoApprovesTasks = false,
  ringOutcome: AgentCallRingOutcome["status"] = "disabled",
  /** The caller's turn trigger; "unreadable" makes the lookup fail. */
  trigger: ProjectionTurnTrigger | null | "unreadable" = null,
) => {
  const rings: Array<Parameters<AgentCallsShape["ring"]>[0]> = [];
  const created: CreateWorkspaceTaskInput[] = [];
  const updated: UpdateWorkspaceTaskInput[] = [];
  const raised: Array<{ readonly title: string; readonly detail: string }> = [];
  const resolvedIds: string[] = [];
  let wakeCount = 0;
  const storeLayer = Layer.mock(VmAgentStore)({
    getByThreadId: (id) =>
      Effect.succeed(Option.fromNullishOr(boundAgent?.threadId === id ? boundAgent : null)),
  });
  const projectionLayer = Layer.mock(ProjectionSnapshotQuery)({
    getThreadShellById: (id) =>
      Effect.succeed(
        id === sideChatThreadId || id === workerThreadId
          ? Option.some({
              id,
              isSideChat: true,
              sideChatParentThreadId: threadId,
            } as OrchestrationThreadShell)
          : Option.none(),
      ),
    getTurnTrigger: () =>
      trigger === "unreadable"
        ? Effect.fail(new PersistenceSqlError({ operation: "getTurnTrigger" }))
        : Effect.succeed(Option.fromNullishOr(trigger)),
  });
  const workspaceLayer = Layer.mock(VmAgentWorkspace)({
    snapshot: () =>
      Effect.succeed({
        type: "snapshot" as const,
        vmAgentId,
        tasks: [recurringTask, onceTask],
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
        // Mirrors VmAgentWorkspace.createTask's agent rule.
        const mayActivate =
          autoApprovesTasks || (input.activate === true && input.schedule?.kind !== "interval");
        return {
          taskId: VmAgentTaskId.make("created-task"),
          vmAgentId: input.vmAgentId,
          title: input.title,
          prompt: input.prompt,
          completionCriteria: input.completionCriteria,
          status: mayActivate ? (input.status ?? "active") : "draft",
          schedule: input.schedule,
          nextRunAt: null,
          createdBy: "agent",
          approvalState: mayActivate ? "approved" : "pending",
          notificationPolicy: input.notificationPolicy ?? "always",
          artifactId: null,
          createdAt: iso,
          updatedAt: iso,
        };
      }),
    notify: () => Effect.succeed(false),
    autoApprovesTasks: () => Effect.succeed(autoApprovesTasks),
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
        const base = input.taskId === onceTask.taskId ? onceTask : recurringTask;
        return {
          ...base,
          title: input.title ?? base.title,
          prompt: input.prompt ?? base.prompt,
          completionCriteria: input.completionCriteria ?? base.completionCriteria,
          status: input.status ?? base.status,
          schedule: input.schedule === undefined ? base.schedule : input.schedule,
          approvalState: input.approvalState ?? base.approvalState,
          notificationPolicy: input.notificationPolicy ?? base.notificationPolicy,
        };
      }),
  });
  const schedulerLayer = Layer.mock(VmAgentTaskScheduler)({
    wake: () => Effect.sync(() => void (wakeCount += 1)),
  });
  const icons: Array<VmAgent["icon"]> = [];
  const managerLayer = Layer.mock(VmManager)({
    setIcon: (_vmAgentId, icon) =>
      Effect.sync(() => {
        icons.push(icon);
        return { ...agent, icon };
      }),
  });
  const callsLayer = Layer.mock(AgentCalls)({
    ring: (input) =>
      Effect.sync(() => {
        rings.push(input);
        return { status: ringOutcome } as AgentCallRingOutcome;
      }),
  });
  return {
    created,
    updated,
    raised,
    resolvedIds,
    icons,
    rings,
    wakeCount: () => wakeCount,
    layer: Layer.mergeAll(
      storeLayer,
      projectionLayer,
      workspaceLayer,
      schedulerLayer,
      managerLayer,
      callsLayer,
    ),
  };
};

type Services =
  | VmAgentStore
  | ProjectionSnapshotQuery
  | VmAgentWorkspace
  | VmAgentTaskScheduler
  | VmManager
  | AgentCalls;
const run = <A, E>(
  effect: Effect.Effect<A, E, McpInvocationContext.McpInvocationContext | Services>,
  layer: Layer.Layer<Services>,
  capabilities?: Set<McpInvocationContext.McpCapability>,
  callerThreadId?: ThreadId,
) =>
  effect.pipe(
    Effect.provideService(
      McpInvocationContext.McpInvocationContext,
      invocation(capabilities, callerThreadId),
    ),
    Effect.provide(layer),
  );

it.effect("rejects non-VM callers before resolving an agent", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const error = yield* Effect.flip(
      run(handleAgentWorkspace({ action: "list_tasks" }), harness.layer, new Set(["history"])),
    );
    assert.strictEqual(error._tag, "AgentWorkspaceCapabilityUnavailableError");
    // A plain chat that wants the person called goes through an agent.
    assert.include(error.message, "workspace_consult ask");
    assert.include(error.message, "call_user");
  }),
);

it.effect("acts as the owning agent from one of the agent's side chats", () =>
  Effect.gen(function* () {
    const harness = makeHarness(agent, false, "ringing");
    yield* run(
      handleAgentWorkspace({ action: "create_task", title: "Follow up", prompt: "Check again." }),
      harness.layer,
      undefined,
      sideChatThreadId,
    );
    assert.strictEqual(harness.created[0]?.vmAgentId, vmAgentId);

    const call = yield* run(
      handleAgentWorkspace({ action: "call_user", callReason: "Which account?" }),
      harness.layer,
      undefined,
      sideChatThreadId,
    );
    assert.strictEqual(harness.rings[0]?.vmAgentId, vmAgentId);
    // The answered call talks in the agent's main chat, never in this side chat.
    assert.match(call.status, /^ringing/);
    assert.include(call.status, "main chat, not this one");
  }),
);

it.effect("a delegated worker's create_task is a draft even when the main chat auto-approves", () =>
  Effect.gen(function* () {
    // The agent's main chat runs in Agent mode, so createTask alone would approve.
    const harness = makeHarness(agent, true, "disabled", delegatedTurn);
    const result = yield* run(
      handleAgentWorkspace({
        action: "create_task",
        title: "Send it",
        prompt: "Send the email to X.",
        schedule: { kind: "once", runAt: "2026-08-22T20:00:00.000Z" },
      }),
      harness.layer,
      undefined,
      workerThreadId,
    );
    assert.strictEqual(harness.created[0]?.vmAgentId, vmAgentId);
    assert.strictEqual(harness.created[0]?.activate, false);
    // Never schedulable, not even between the two writes.
    assert.strictEqual(harness.created[0]?.status, "draft");
    assert.deepStrictEqual(harness.updated, [
      {
        vmAgentId,
        taskId: VmAgentTaskId.make("created-task"),
        status: "draft",
        approvalState: "pending",
      },
    ]);
    assert.strictEqual(result.task?.approvalState, "pending");
    assert.strictEqual(result.task?.status, "draft");
    assert.include(result.status, "another chat started this turn");
  }),
);

it.effect("a turn another chat's message started cannot activate a task", () =>
  Effect.gen(function* () {
    const harness = makeHarness(agent, false, "disabled", otherChatTurn);
    const result = yield* run(
      handleAgentWorkspace({ action: "create_task", title: "Send it", prompt: "Send the email." }),
      harness.layer,
    );
    assert.strictEqual(harness.created[0]?.activate, false);
    // createTask already saved a pending draft; nothing to withdraw.
    assert.strictEqual(harness.updated.length, 0);
    assert.strictEqual(result.task?.approvalState, "pending");
    assert.include(result.status, "waiting for user approval");
  }),
);

it.effect("an unreadable turn trigger fails closed to a draft", () =>
  Effect.gen(function* () {
    const harness = makeHarness(agent, false, "disabled", "unreadable");
    const result = yield* run(
      handleAgentWorkspace({ action: "create_task", title: "Send it", prompt: "Send the email." }),
      harness.layer,
    );
    assert.strictEqual(harness.created[0]?.activate, false);
    assert.strictEqual(result.task?.approvalState, "pending");
  }),
);

it.effect("person and orchestrator turns still activate one-off work", () =>
  Effect.gen(function* () {
    for (const trigger of [null, orchestratorTurn]) {
      const harness = makeHarness(agent, false, "disabled", trigger);
      const result = yield* run(
        handleAgentWorkspace({ action: "create_task", title: "Check", prompt: "Check again." }),
        harness.layer,
      );
      assert.strictEqual(harness.created[0]?.activate, true);
      assert.strictEqual(harness.created[0]?.status, undefined);
      assert.strictEqual(harness.updated.length, 0);
      assert.strictEqual(result.task?.approvalState, "approved");
    }
  }),
);

it.effect("update_task from another chat's turn sends changed work back for approval", () =>
  Effect.gen(function* () {
    const changed = makeHarness(agent, true, "disabled", delegatedTurn);
    const result = yield* run(
      handleAgentWorkspace({
        action: "update_task",
        taskId: onceTask.taskId,
        prompt: "Send the email to X with Y.",
      }),
      changed.layer,
      undefined,
      workerThreadId,
    );
    assert.strictEqual(changed.updated[0]?.status, "draft");
    assert.strictEqual(changed.updated[0]?.approvalState, "pending");
    assert.include(result.status, "another chat started this turn");

    // Recurring work never borrows the main chat's auto-approval either.
    const recurring = makeHarness(agent, true, "disabled", otherChatTurn);
    yield* run(
      handleAgentWorkspace({ action: "update_task", taskId: recurringTask.taskId }),
      recurring.layer,
    );
    assert.strictEqual(recurring.updated[0]?.approvalState, "pending");

    // Settings that do not change the work keep the approval it has.
    const quiet = makeHarness(agent, false, "disabled", otherChatTurn);
    const quietResult = yield* run(
      handleAgentWorkspace({
        action: "update_task",
        taskId: onceTask.taskId,
        notificationPolicy: "failure",
      }),
      quiet.layer,
    );
    assert.strictEqual(quiet.updated[0]?.approvalState, undefined);
    assert.strictEqual(quiet.updated[0]?.status, undefined);
    assert.strictEqual(quietResult.status, "Task updated.");

    // The person's own turn keeps editing approved one-off work in place.
    const own = makeHarness(agent, false, "disabled", null);
    yield* run(
      handleAgentWorkspace({ action: "update_task", taskId: onceTask.taskId, prompt: "Again." }),
      own.layer,
    );
    assert.strictEqual(own.updated[0]?.approvalState, undefined);
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
    assert.include(result.status, "standing alert");
    assert.include(result.status, "do not call notify_user");
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

it.effect("update_task keeps recurring work active when auto-approval applies", () =>
  Effect.gen(function* () {
    const harness = makeHarness(agent, true);
    const result = yield* run(
      handleAgentWorkspace({
        action: "update_task",
        taskId: "recurring-task",
        prompt: "Check the dashboard twice.",
      }),
      harness.layer,
    );
    assert.strictEqual(harness.updated[0]?.status, "active");
    assert.strictEqual(harness.updated[0]?.approvalState, "approved");
    assert.include(result.status, "auto-approved: the agent's main chat runs in Agent mode");
  }),
);

it.effect("set_icon stores the agent's outlined glyph through the registry", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const result = yield* run(
      handleAgentWorkspace({ action: "set_icon", icon: "globe" }),
      harness.layer,
    );
    assert.deepStrictEqual(harness.icons, ["globe"]);
    assert.include(result.status, "globe");
  }),
);

it.effect("set_icon without an icon is an invalid input, not a silent no-op", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const error = yield* Effect.flip(
      run(handleAgentWorkspace({ action: "set_icon" }), harness.layer),
    );
    assert.strictEqual(error._tag, "AgentWorkspaceInvalidInputError");
    assert.strictEqual(harness.icons.length, 0);
  }),
);

it.effect("reports stopped scheduling instead of promising execution", () =>
  Effect.gen(function* () {
    const harness = makeHarness({ ...agent, status: "stopped" });
    const result = yield* run(
      handleAgentWorkspace({
        action: "create_task",
        title: "Resume tomorrow",
        prompt: "Continue the work.",
        schedule: { kind: "once", runAt: "2026-08-22T20:00:00.000Z" },
      }),
      harness.layer,
    );
    assert.include(result.status, "agent is stopped");
    assert.include(result.status, "will not run");
    assert.strictEqual(result.task?.status, "active");
    const updated = yield* run(
      handleAgentWorkspace({ action: "update_task", taskId: "recurring-task" }),
      harness.layer,
    );
    assert.include(updated.status, "approval");
  }),
);

it.effect("call_user rings as an explicit request and reports each gate in words", () =>
  Effect.gen(function* () {
    const ringing = makeHarness(agent, false, "ringing");
    const result = yield* run(
      handleAgentWorkspace({ action: "call_user", callReason: "  Which account should I use?  " }),
      ringing.layer,
    );
    assert.match(result.status, /^ringing/);
    assert.include(result.status, "arrives in this chat, the agent's main chat");
    assert.strictEqual(ringing.rings.length, 1);
    assert.strictEqual(ringing.rings[0]?.reason, "request");
    assert.strictEqual(ringing.rings[0]?.vmAgentId, vmAgentId);
    assert.strictEqual(ringing.rings[0]?.topic, "Which account should I use?");
    assert.match(ringing.rings[0]?.key ?? "", /^request:/);

    for (const [outcome, status] of [
      ["disabled", "calls are turned off"],
      ["already-ringing", "already ringing"],
      ["rate-limited", "rate-limited — use report_blocker instead"],
    ] as const) {
      const harness = makeHarness(agent, false, outcome);
      const gated = yield* run(handleAgentWorkspace({ action: "call_user" }), harness.layer);
      assert.strictEqual(gated.status, status);
      assert.strictEqual(harness.rings[0]?.topic, null);
    }
  }),
);
