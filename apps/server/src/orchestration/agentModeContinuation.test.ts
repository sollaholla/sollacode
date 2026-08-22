import {
  EventId,
  type OrchestrationEvent,
  type OrchestrationThreadActivity,
  type OrchestrationThreadShell,
  MessageId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_CONTINUE_PROMPT } from "@t3tools/shared/agentMode";
import {
  activeTurnMessageIdFromSourceTurnId,
  activeTurnWorkSourceId,
  agentAutoResumeIds,
  agentContinuationShouldAwaitBackgroundTask,
  BACKGROUND_TASK_CONTINUATION_GRACE_MS,
  isControlOnlyAgentTurn,
  KILLED_BACKGROUND_TASK_RESUME_MAX_AGE_MS,
  outstandingBackgroundTasks,
  threadLostBackgroundTaskAtRestart,
  providerAuthenticationResumeIds,
  shouldAutoContinueAgentThread,
  shouldResumeProviderAuthenticationPausedThread,
  startupAutoResumeIds,
  startupResumeSourceTurnId,
} from "./agentModeContinuation.ts";

const threadId = ThreadId.make("thread-agent");
const turnId = TurnId.make("turn-completed");

function shell(overrides: Partial<OrchestrationThreadShell> = {}): OrchestrationThreadShell {
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: "Agent task",
    modelSelection: ModelSelection.make({
      instanceId: ProviderInstanceId.make("claude"),
      model: "claude-opus-5",
    }),
    runtimeMode: "full-access",
    interactionMode: "agent",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: "2026-08-03T12:00:00.000Z",
      startedAt: "2026-08-03T12:00:01.000Z",
      completedAt: "2026-08-03T12:01:00.000Z",
      assistantMessageId: MessageId.make("assistant-1"),
    },
    createdAt: "2026-08-03T11:00:00.000Z",
    updatedAt: "2026-08-03T12:01:00.000Z",
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: {
      threadId,
      status: "ready",
      providerName: "claudeAgent",
      providerInstanceId: ProviderInstanceId.make("claude"),
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: "2026-08-03T12:01:00.000Z",
    },
    latestUserMessageAt: "2026-08-03T12:00:00.000Z",
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

function assistantEvent(text = "Implemented the next piece cleanly."): AssistantMessageEvent {
  return {
    sequence: 10,
    eventId: EventId.make("event-10"),
    aggregateKind: "thread",
    aggregateId: threadId,
    occurredAt: "2026-08-03T12:01:00.000Z",
    commandId: null,
    type: "thread.message-sent",
    payload: {
      threadId,
      messageId: MessageId.make("assistant-1"),
      role: "assistant",
      text,
      turnId,
      streaming: false,
      createdAt: "2026-08-03T12:00:01.000Z",
      updatedAt: "2026-08-03T12:01:00.000Z",
    },
  } as AssistantMessageEvent;
}

function authenticatedProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("claude"),
    driver: ProviderDriverKind.make("claudeAgent"),
    enabled: true,
    installed: true,
    version: "2.1.221",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-03T12:02:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

type AssistantMessageEvent = Extract<OrchestrationEvent, { type: "thread.message-sent" }>;

describe("server-owned Agent continuation", () => {
  it("continues a clean completed Agent turn without a mounted client", () => {
    expect(shouldAutoContinueAgentThread(shell(), assistantEvent())).toBe(true);
  });

  it("uses the projected final message after a completion event with an empty delta", () => {
    expect(
      shouldAutoContinueAgentThread(shell(), assistantEvent(""), "Projected final reply"),
    ).toBe(true);
  });

  it("honors the terminal stop token and pending human input", () => {
    expect(shouldAutoContinueAgentThread(shell(), assistantEvent("Finished. AGENT_STOP"))).toBe(
      false,
    );
    expect(
      shouldAutoContinueAgentThread(shell({ hasPendingUserInput: true }), assistantEvent()),
    ).toBe(false);
  });

  it("continues over a stopped session but never over a provider error", () => {
    // "stopped" only means the CLI exited between turns (idle exit, watchdog
    // restart, a deploy); dispatching the continuation spawns a fresh session
    // exactly like a startup resume, so it must not orphan the loop.
    expect(
      shouldAutoContinueAgentThread(
        shell({ session: { ...shell().session!, status: "stopped" } }),
        assistantEvent(),
      ),
    ).toBe(true);
    // "error" stays terminal: continuing would hammer a failing provider.
    expect(
      shouldAutoContinueAgentThread(
        shell({ session: { ...shell().session!, status: "error" } }),
        assistantEvent(),
      ),
    ).toBe(false);
  });

  it("does not continue a deterministic fast-mode credit rejection", () => {
    expect(
      shouldAutoContinueAgentThread(
        shell(),
        assistantEvent("Usage credits are required for fast mode."),
      ),
    ).toBe(false);
    expect(
      shouldAutoContinueAgentThread(
        shell(),
        assistantEvent("Fast mode disabled · usage credits exhausted"),
      ),
    ).toBe(false);
  });

  it("does not continue a stale assistant event or a non-Agent thread", () => {
    expect(
      shouldAutoContinueAgentThread(
        shell({ latestTurn: { ...shell().latestTurn!, turnId: TurnId.make("newer-turn") } }),
        assistantEvent(),
      ),
    ).toBe(false);
    expect(
      shouldAutoContinueAgentThread(shell({ interactionMode: "default" }), assistantEvent()),
    ).toBe(false);
    expect(shouldAutoContinueAgentThread(shell(), assistantEvent(), undefined, "default")).toBe(
      false,
    );
  });

  it("uses stable continuation identifiers for cross-client and replay dedupe", () => {
    expect(agentAutoResumeIds({ threadId, completedTurnId: turnId })).toEqual({
      commandId: "agent-auto-resume-command:thread-agent:turn-completed",
      messageId: "agent-auto-resume-message:thread-agent:turn-completed",
    });
    expect(AGENT_CONTINUE_PROMPT).toContain("AGENT_STOP");
  });

  it("resumes an auth-paused Agent thread only after a newer authenticated probe", () => {
    const paused = shell({
      session: {
        ...shell().session!,
        status: "error",
        lastError: "Failed to authenticate: OAuth session expired and could not be refreshed",
      },
    });
    expect(shouldResumeProviderAuthenticationPausedThread(paused, authenticatedProvider())).toBe(
      true,
    );
    expect(
      shouldResumeProviderAuthenticationPausedThread(
        paused,
        authenticatedProvider({ checkedAt: paused.session!.updatedAt }),
      ),
    ).toBe(false);
    expect(
      shouldResumeProviderAuthenticationPausedThread(
        paused,
        authenticatedProvider({ auth: { status: "unauthenticated" } }),
      ),
    ).toBe(false);
    expect(
      shouldResumeProviderAuthenticationPausedThread(
        { ...paused, archivedAt: "2026-08-03T12:01:30.000Z" },
        authenticatedProvider(),
      ),
    ).toBe(false);
  });

  it("uses distinct stable identifiers for post-login continuation", () => {
    expect(providerAuthenticationResumeIds({ threadId, completedTurnId: turnId })).toEqual({
      commandId: "provider-auth-auto-resume-command:thread-agent:turn-completed",
      messageId: "provider-auth-auto-resume-message:thread-agent:turn-completed",
    });
  });

  it("round-trips durable explicit-turn and startup-resume identities", () => {
    const messageId = MessageId.make("message-explicit-turn");
    const sourceTurnId = activeTurnWorkSourceId(messageId);
    expect(activeTurnMessageIdFromSourceTurnId(sourceTurnId)).toBe(messageId);
    expect(activeTurnMessageIdFromSourceTurnId(TurnId.make("provider-turn"))).toBeNull();

    const startupIds = startupAutoResumeIds({
      threadId,
      incompleteTurnId: turnId,
    });
    expect(startupIds).toEqual({
      commandId: "startup-auto-resume-command:thread-agent:turn-completed",
      messageId: "startup-auto-resume-message:thread-agent:turn-completed",
    });
    expect(startupResumeSourceTurnId({ threadId, messageId: startupIds.messageId })).toBe(turnId);
  });
});

const T0 = Date.parse("2026-08-06T12:00:00.000Z");
const isoAt = (epochMs: number) => DateTime.formatIso(DateTime.makeUnsafe(epochMs));

function taskActivity(input: {
  readonly kind: "task.started" | "task.progress" | "task.completed";
  readonly taskId: string;
  readonly offsetMs: number;
  readonly taskType?: string;
  readonly status?: string;
}): OrchestrationThreadActivity {
  return {
    id: EventId.make(`${input.kind}:${input.taskId}:${input.offsetMs}`),
    tone: "info",
    kind: input.kind,
    summary: input.kind,
    payload: {
      taskId: input.taskId,
      ...(input.taskType === undefined ? {} : { taskType: input.taskType }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    turnId: null,
    createdAt: isoAt(T0 + input.offsetMs),
  };
}

describe("outstandingBackgroundTasks", () => {
  it("reports a task that started and never reported terminal", () => {
    expect(
      outstandingBackgroundTasks([
        taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
      ]).map((task) => task.taskId),
    ).toEqual(["bash-1"]);
  });

  it("clears a task once it completes", () => {
    expect(
      outstandingBackgroundTasks([
        taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
        taskActivity({ kind: "task.completed", taskId: "bash-1", offsetMs: 10 }),
      ]),
    ).toEqual([]);
  });

  it("tracks each task independently", () => {
    expect(
      outstandingBackgroundTasks([
        taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
        taskActivity({ kind: "task.started", taskId: "agent-2", offsetMs: 1 }),
        taskActivity({ kind: "task.completed", taskId: "bash-1", offsetMs: 10 }),
      ]).map((task) => task.taskId),
    ).toEqual(["agent-2"]);
  });

  it("ignores plan tasks, which run outside the turn stream", () => {
    expect(
      outstandingBackgroundTasks([
        taskActivity({ kind: "task.started", taskId: "plan-1", offsetMs: 0, taskType: "plan" }),
      ]),
    ).toEqual([]);
  });

  it("advances lastActivityAt on progress so a reporting task keeps its window", () => {
    const [task] = outstandingBackgroundTasks([
      taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
      taskActivity({ kind: "task.progress", taskId: "bash-1", offsetMs: 5_000 }),
    ]);
    expect(task?.startedAt).toEqual(isoAt(T0));
    expect(task?.lastActivityAt).toEqual(isoAt(T0 + 5_000));
  });
});

describe("agentContinuationShouldAwaitBackgroundTask", () => {
  it("defers the continuation while a background task is still running", () => {
    expect(
      agentContinuationShouldAwaitBackgroundTask({
        activities: [taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 })],
        nowEpochMs: T0 + 1_000,
      })?.taskId,
    ).toBe("bash-1");
  });

  it("does not defer once the task reports terminal", () => {
    expect(
      agentContinuationShouldAwaitBackgroundTask({
        activities: [
          taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
          taskActivity({ kind: "task.completed", taskId: "bash-1", offsetMs: 10 }),
        ],
        nowEpochMs: T0 + 1_000,
      }),
    ).toBeNull();
  });

  it("ignores a task stranded by a restart instead of burning the whole grace window", () => {
    // The wait is only justified because the harness re-invokes the agent when
    // a task it owns exits. A task announced before this process started has no
    // live owner, so that signal can never arrive; only the lazy orphan sweep
    // ends it. Observed 2026-08-07: a restart at 10:49 left a task whose
    // "Task stopped" completion did not land until 15:36, and the thread sat on
    // "Agent auto-resuming" in the meantime.
    expect(
      agentContinuationShouldAwaitBackgroundTask({
        activities: [taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 })],
        nowEpochMs: T0 + 1_000,
        processStartedAtEpochMs: T0 + 500,
      }),
    ).toBeNull();
  });

  it("still waits on a task this process started", () => {
    expect(
      agentContinuationShouldAwaitBackgroundTask({
        activities: [taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 1_000 })],
        nowEpochMs: T0 + 2_000,
        processStartedAtEpochMs: T0 + 500,
      })?.taskId,
    ).toBe("bash-1");
  });

  it("keeps waiting on a pre-restart task whose progress continues under this process", () => {
    // Progress arriving after startup proves something is still driving it, so
    // the restart boundary must be read from the task's start, not its newest
    // activity — but a task that only *started* earlier is still discarded.
    const activities = [
      taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
      taskActivity({ kind: "task.progress", taskId: "bash-1", offsetMs: 2_000 }),
    ];
    expect(
      agentContinuationShouldAwaitBackgroundTask({
        activities,
        nowEpochMs: T0 + 3_000,
        processStartedAtEpochMs: T0 + 500,
      }),
    ).toBeNull();
  });

  it("keeps waiting when the start stamp is unparseable and cannot be proven stale", () => {
    // Progress supplies a usable lastActivityAt, so the task clears the grace
    // check and actually reaches the restart boundary. A start that cannot be
    // parsed is not evidence the task predates this process, so it must keep
    // its grace window rather than be discarded as orphaned.
    const started = taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 });
    expect(
      agentContinuationShouldAwaitBackgroundTask({
        activities: [
          { ...started, createdAt: "not-a-date" },
          taskActivity({ kind: "task.progress", taskId: "bash-1", offsetMs: 2_000 }),
        ],
        nowEpochMs: T0 + 3_000,
        processStartedAtEpochMs: T0 + 500,
      })?.taskId,
    ).toBe("bash-1");
  });

  it("gives up waiting after the grace window so a lost terminal cannot strand the thread", () => {
    expect(
      agentContinuationShouldAwaitBackgroundTask({
        activities: [taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 })],
        nowEpochMs: T0 + BACKGROUND_TASK_CONTINUATION_GRACE_MS,
      }),
    ).toBeNull();
  });

  it("extends the window from the newest progress report", () => {
    const activities = [
      taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
      taskActivity({
        kind: "task.progress",
        taskId: "bash-1",
        offsetMs: BACKGROUND_TASK_CONTINUATION_GRACE_MS,
      }),
    ];
    expect(
      agentContinuationShouldAwaitBackgroundTask({
        activities,
        nowEpochMs: T0 + BACKGROUND_TASK_CONTINUATION_GRACE_MS + 1_000,
      })?.taskId,
    ).toBe("bash-1");
  });

  it("does not defer when there are no task activities at all", () => {
    expect(
      agentContinuationShouldAwaitBackgroundTask({ activities: [], nowEpochMs: T0 }),
    ).toBeNull();
  });
});

describe("isControlOnlyAgentTurn", () => {
  const sourceTurnId = "turn-source";
  const SETTINGS_MESSAGE =
    "Settings updated: claude-opus-5 with high effort. Apply these settings.";

  function activity(kind: string, turn: string | null = sourceTurnId): OrchestrationThreadActivity {
    return {
      id: EventId.make(`${kind}:${turn}`),
      tone: "info",
      kind,
      summary: kind,
      payload: {},
      turnId: turn === null ? null : TurnId.make(turn),
      createdAt: isoAt(T0),
    };
  }

  it("skips a provider handoff that was the entire turn", () => {
    expect(
      isControlOnlyAgentTurn({
        activities: [activity("provider.handoff.completed"), activity("provider.usage.updated")],
        sourceTurnId,
      }),
    ).toBe(true);
  });

  it("skips a settings acknowledgement that ran no work", () => {
    expect(
      isControlOnlyAgentTurn({
        activities: [activity("thread.settings.applied"), activity("checkpoint.captured")],
        sourceTurnId,
        sourceUserMessageText: SETTINGS_MESSAGE,
      }),
    ).toBe(true);
  });

  // The reported shape: a handoff is stamped with the id of the turn it starts,
  // so the turn carrying the user's own prompt looked like pure bookkeeping and
  // its continuation was cancelled the instant it settled.
  it("continues a handoff-initiated turn that actually did work", () => {
    expect(
      isControlOnlyAgentTurn({
        activities: [
          activity("provider.handoff.completed"),
          activity("tool.started"),
          activity("tool.completed"),
          activity("checkpoint.captured"),
        ],
        sourceTurnId,
      }),
    ).toBe(false);
  });

  it("continues a settings-update turn that actually did work", () => {
    expect(
      isControlOnlyAgentTurn({
        activities: [activity("thread.settings.applied"), activity("tool.started")],
        sourceTurnId,
        sourceUserMessageText: SETTINGS_MESSAGE,
      }),
    ).toBe(false);
  });

  it("counts a backgrounded task as work", () => {
    expect(
      isControlOnlyAgentTurn({
        activities: [activity("provider.handoff.completed"), activity("task.started")],
        sourceTurnId,
      }),
    ).toBe(false);
  });

  it("ignores control activities that belong to another turn", () => {
    expect(
      isControlOnlyAgentTurn({
        activities: [
          activity("provider.handoff.completed", "turn-earlier"),
          activity("thread.settings.applied", null),
        ],
        sourceTurnId,
      }),
    ).toBe(false);
  });

  it("leaves an ordinary turn alone", () => {
    expect(isControlOnlyAgentTurn({ activities: [], sourceTurnId })).toBe(false);
    expect(isControlOnlyAgentTurn({ activities: [activity("tool.started")], sourceTurnId })).toBe(
      false,
    );
  });
});

describe("threadLostBackgroundTaskAtRestart", () => {
  // The reported shape: the agent backgrounds a test run, signs off to wait,
  // and the provider reports the task stopped as the app shuts down. Nothing is
  // left alive to re-invoke it.
  it("recovers a turn whose task was stopped by the shutdown", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [
          taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
          taskActivity({
            kind: "task.completed",
            taskId: "bash-1",
            offsetMs: 120_000,
            status: "stopped",
          }),
        ],
        turnCompletedAt: isoAt(T0 + 30_000),
        bootedAtEpochMs: T0 + 130_000,
      }),
    ).toBe(true);
  });

  // The process was killed outright, so no terminal record was ever written.
  it("recovers a turn whose task never reported terminal", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 })],
        turnCompletedAt: isoAt(T0 + 30_000),
        bootedAtEpochMs: T0 + 130_000,
      }),
    ).toBe(true);
  });

  it("leaves a turn alone when its task actually finished", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [
          taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
          taskActivity({
            kind: "task.completed",
            taskId: "bash-1",
            offsetMs: 10_000,
            status: "completed",
          }),
        ],
        turnCompletedAt: isoAt(T0 + 30_000),
        bootedAtEpochMs: T0 + 130_000,
      }),
    ).toBe(false);
  });

  // A task announced after the reply belongs to whatever ran next.
  it("ignores a task that started after the turn settled", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 60_000 })],
        turnCompletedAt: isoAt(T0 + 30_000),
        bootedAtEpochMs: T0 + 130_000,
      }),
    ).toBe(false);
  });

  // A restart should recover the session in progress, not resurrect old threads.
  it("leaves work older than the recovery window alone", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 })],
        turnCompletedAt: isoAt(T0 + 30_000),
        bootedAtEpochMs: T0 + KILLED_BACKGROUND_TASK_RESUME_MAX_AGE_MS + 60_000,
      }),
    ).toBe(false);
  });

  it("ignores plan tasks, which nothing waits on", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [
          taskActivity({ kind: "task.started", taskId: "plan-1", offsetMs: 0, taskType: "plan" }),
        ],
        turnCompletedAt: isoAt(T0 + 30_000),
        bootedAtEpochMs: T0 + 130_000,
      }),
    ).toBe(false);
  });

  // A task stopped before the reply is history the agent already saw and
  // reported on; only a stop that outlives the turn stranded it.
  it("ignores a task that was already terminal before the turn ended", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [
          taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
          taskActivity({
            kind: "task.completed",
            taskId: "bash-1",
            offsetMs: 10_000,
            status: "stopped",
          }),
        ],
        turnCompletedAt: isoAt(T0 + 30_000),
        bootedAtEpochMs: T0 + 130_000,
      }),
    ).toBe(false);
  });

  it("tracks each task separately", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [
          taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 }),
          taskActivity({
            kind: "task.completed",
            taskId: "bash-1",
            offsetMs: 10_000,
            status: "completed",
          }),
          taskActivity({ kind: "task.started", taskId: "bash-2", offsetMs: 12_000 }),
        ],
        turnCompletedAt: isoAt(T0 + 30_000),
        bootedAtEpochMs: T0 + 130_000,
      }),
    ).toBe(true);
  });

  it("does nothing without a parseable completion time", () => {
    expect(
      threadLostBackgroundTaskAtRestart({
        activities: [taskActivity({ kind: "task.started", taskId: "bash-1", offsetMs: 0 })],
        turnCompletedAt: "not-a-timestamp",
        bootedAtEpochMs: T0 + 130_000,
      }),
    ).toBe(false);
  });
});
