import { describe, expect, it } from "vite-plus/test";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ORCHESTRATOR_THREAD_ID,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type IsoDateTime,
  type OrchestratorSpokenEvents,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";

import { buildWorld, diffWorlds, EVENT_REANNOUNCE_WINDOW_MS, shouldAnnounceEvent } from "./events";
import { describeEventFallback } from "./completionSummary";

const createdAt = "2026-08-16T12:00:00.000Z" as IsoDateTime;
const environmentId = EnvironmentId.make("env-1");

const ALL_ON: OrchestratorSpokenEvents = {
  threadFinished: true,
  taskCompleted: true,
  approvalNeeded: true,
  inputNeeded: true,
  threadFailed: true,
  autoResumeStuck: true,
};

const makeShell = (
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell =>
  ({
    environmentId,
    id: ThreadId.make(id),
    projectId: ProjectId.make("project-1"),
    title: id,
    isSideChat: false,
    sideChatParentThreadId: null,
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt,
    updatedAt: createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  }) as EnvironmentThreadShell;

const working = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
  makeShell(id, {
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "running",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: null,
      assistantMessageId: null,
    },
    ...overrides,
  });

const idle = (id: string, overrides: Partial<EnvironmentThreadShell> = {}) =>
  makeShell(id, {
    latestTurn: {
      turnId: TurnId.make("turn-1"),
      state: "completed",
      requestedAt: createdAt,
      startedAt: createdAt,
      completedAt: createdAt,
      assistantMessageId: null,
    },
    ...overrides,
  });

describe("buildWorld", () => {
  it("does not call a thread working on a stale turn row alone", () => {
    // The Gloria misreport: turns only settle when their session leaves
    // `running`, so a turn row can sit on `running` long after everything
    // stopped. The session saying "stopped" is the current fact; the turn row
    // is history. The sidebar got this precedence first (see the "8m+ spinners
    // on idle threads" note in Sidebar.logic.ts); the world model must agree
    // with it or the orchestrator contradicts the screen the user is looking at.
    const world = buildWorld([
      working("thread-a", {
        session: { status: "stopped" } as EnvironmentThreadShell["session"],
      }),
    ]);
    expect(world.get(`${environmentId}:thread-a`)?.isWorking).toBe(false);
  });

  it("trusts a running session even when the turn row lags behind", () => {
    const world = buildWorld([
      idle("thread-a", {
        session: { status: "running" } as EnvironmentThreadShell["session"],
      }),
    ]);
    expect(world.get(`${environmentId}:thread-a`)?.isWorking).toBe(true);
  });

  it("still reads the turn when there is no session row to consult", () => {
    // The resume window: a turn can start before the session projection
    // flips, and a shell can arrive with no session at all.
    const world = buildWorld([working("thread-a")]);
    expect(world.get(`${environmentId}:thread-a`)?.isWorking).toBe(true);
  });

  it("excludes the orchestrator so it never announces its own turns", () => {
    const world = buildWorld([working(ORCHESTRATOR_THREAD_ID), working("thread-a")]);
    expect([...world.values()].map((snapshot) => snapshot.threadId)).toEqual(["thread-a"]);
  });

  it("excludes archived threads", () => {
    const world = buildWorld([makeShell("thread-a", { archivedAt: createdAt })]);
    expect(world.size).toBe(0);
  });

  it("names the background agent a thread belongs to", () => {
    // Interaction mode cannot answer this: Scout's chat runs in default mode,
    // and an ordinary chat can run in agent mode.
    const world = buildWorld(
      [makeShell("scout-thread"), makeShell("plain-thread", { interactionMode: "agent" })],
      new Set(),
      new Map(),
      new Map([[`${environmentId}:scout-thread`, "Scout"]]),
    );
    expect(world.get(`${environmentId}:scout-thread`)?.backgroundAgentName).toBe("Scout");
    expect(world.get(`${environmentId}:plain-thread`)?.backgroundAgentName).toBeNull();
  });

  it("derives what a thread is blocked on", () => {
    const world = buildWorld([
      makeShell("approval", { hasPendingApprovals: true }),
      makeShell("input", { hasPendingUserInput: true }),
      idle("plan", { hasActionableProposedPlan: true, interactionMode: "plan" }),
      makeShell("free"),
    ]);
    expect(world.get(`${environmentId}:approval`)?.waitingOn).toBe("approval");
    expect(world.get(`${environmentId}:input`)?.waitingOn).toBe("user-input");
    expect(world.get(`${environmentId}:plan`)?.waitingOn).toBe("proposed-plan");
    expect(world.get(`${environmentId}:free`)?.waitingOn).toBe("nothing");
  });

  it("does not call a working thread blocked on the plan it is carrying out", () => {
    // Reported: a thread mid-build read as "waiting on proposed plan". The plan
    // record stays actionable until the work it describes finishes, so the flag
    // is still set long after the user approved it and the agent got going.
    const world = buildWorld([working("building", { hasActionableProposedPlan: true })]);
    const thread = world.get(`${environmentId}:building`);
    expect(thread?.isWorking).toBe(true);
    expect(thread?.waitingOn).toBe("nothing");
  });

  it("still reports the plan once the thread stops", () => {
    const world = buildWorld([
      idle("stopped", { hasActionableProposedPlan: true, interactionMode: "plan" }),
    ]);
    expect(world.get(`${environmentId}:stopped`)?.waitingOn).toBe("proposed-plan");
  });

  it("does not call an idle default-mode thread blocked on a leftover plan", () => {
    // Having a plan in history is not a wait.
    const world = buildWorld([idle("free", { hasActionableProposedPlan: true })]);
    expect(world.get(`${environmentId}:free`)?.waitingOn).toBe("nothing");
  });

  it("does not call an idle agent-mode thread blocked on a leftover plan", () => {
    const world = buildWorld([
      idle("agent", { hasActionableProposedPlan: true, interactionMode: "agent" }),
    ]);
    expect(world.get(`${environmentId}:agent`)?.waitingOn).toBe("nothing");
  });

  it("does not treat an old unimplemented plan as a wait on a later turn", () => {
    // The denormalized flag is latest-turn only. A leftover record from turn-1
    // must not make turn-2 look blocked, even while the thread is still in
    // Plan mode.
    const world = buildWorld([
      idle("later", {
        hasActionableProposedPlan: false,
        interactionMode: "plan",
        latestTurn: {
          turnId: TurnId.make("turn-2"),
          state: "completed",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          assistantMessageId: null,
        },
      }),
    ]);
    expect(world.get(`${environmentId}:later`)?.waitingOn).toBe("nothing");
  });

  it("does not treat a plan-mode thread with no settled turn as waiting on a plan", () => {
    const world = buildWorld([
      makeShell("no-turn", { hasActionableProposedPlan: true, interactionMode: "plan" }),
    ]);
    expect(world.get(`${environmentId}:no-turn`)?.waitingOn).toBe("nothing");
  });

  it("does not treat a working plan-mode thread as waiting on a plan", () => {
    const world = buildWorld([
      working("building-plan", { hasActionableProposedPlan: true, interactionMode: "plan" }),
    ]);
    expect(world.get(`${environmentId}:building-plan`)?.waitingOn).toBe("nothing");
  });

  it("keeps approvals and input requests visible while a turn runs", () => {
    // Unlike a plan, these are raised *by* a turn that is still in flight —
    // suppressing them while working would hide the thing most worth saying.
    const world = buildWorld([
      working("approval", { hasPendingApprovals: true }),
      working("input", { hasPendingUserInput: true }),
    ]);
    expect(world.get(`${environmentId}:approval`)?.waitingOn).toBe("approval");
    expect(world.get(`${environmentId}:input`)?.waitingOn).toBe("user-input");
  });
});

describe("diffWorlds", () => {
  it("says nothing on the first snapshot, however much is blocked", () => {
    // Opening the app must not trigger a monologue about pre-existing state.
    const next = buildWorld([
      working("thread-a"),
      makeShell("thread-b", { hasPendingApprovals: true }),
    ]);
    expect(diffWorlds(new Map(), next, ALL_ON)).toEqual([]);
  });

  it("says nothing when a thread merely re-renders unchanged", () => {
    const world = buildWorld([working("thread-a")]);
    const identical = buildWorld([working("thread-a")]);
    expect(diffWorlds(world, identical, ALL_ON)).toEqual([]);
  });

  it("emits thread-finished when work stops", () => {
    const before = buildWorld([working("thread-a")]);
    const after = buildWorld([idle("thread-a")]);
    const events = diffWorlds(before, after, ALL_ON);
    expect(events.map((event) => event.kind)).toEqual(["thread-finished"]);
    expect(events[0]?.threadId).toBe("thread-a");
  });

  it("does not call a turnless spawn gap a finish", () => {
    // A fresh side chat projects `starting → ready → running` inside a second,
    // and the turnless `ready` reads as not-working. Nothing settled, so
    // nothing finished — announcing it re-narrated one side-chat creation
    // four times back to back.
    const spawning = buildWorld([
      makeShell("side-chat", {
        session: { status: "starting" } as EnvironmentThreadShell["session"],
      }),
    ]);
    const readyBeforeTurn = buildWorld([
      makeShell("side-chat", {
        session: { status: "ready" } as EnvironmentThreadShell["session"],
      }),
    ]);
    expect(diffWorlds(spawning, readyBeforeTurn, ALL_ON)).toEqual([]);
  });

  it("emits thread-failed instead of thread-finished when the turn errored", () => {
    const before = buildWorld([working("thread-a")]);
    const after = buildWorld([
      makeShell("thread-a", {
        latestTurn: {
          turnId: TurnId.make("turn-1"),
          state: "error",
          requestedAt: createdAt,
          startedAt: createdAt,
          completedAt: createdAt,
          assistantMessageId: null,
        },
      }),
    ]);
    expect(diffWorlds(before, after, ALL_ON).map((event) => event.kind)).toEqual(["thread-failed"]);
  });

  it("emits approval-needed only on the transition into blocked", () => {
    const before = buildWorld([makeShell("thread-a")]);
    const blocked = buildWorld([makeShell("thread-a", { hasPendingApprovals: true })]);

    expect(diffWorlds(before, blocked, ALL_ON).map((event) => event.kind)).toEqual([
      "approval-needed",
    ]);
    // Still blocked on the next tick — must not repeat every render.
    expect(diffWorlds(blocked, blocked, ALL_ON)).toEqual([]);
  });

  it("emits input-needed on the transition into waiting for an answer", () => {
    const before = buildWorld([makeShell("thread-a")]);
    const after = buildWorld([makeShell("thread-a", { hasPendingUserInput: true })]);
    expect(diffWorlds(before, after, ALL_ON).map((event) => event.kind)).toEqual(["input-needed"]);
  });

  it("stays silent about a thread whose host went offline mid-turn", () => {
    const before = buildWorld([working("thread-a")]);
    // The row freezes as-is while unreachable; announcing "finished" would be a lie.
    const after = buildWorld([working("thread-a")], new Set([environmentId]));
    expect(diffWorlds(before, after, ALL_ON)).toEqual([]);
  });

  it("respects the per-event settings", () => {
    const before = buildWorld([working("thread-a")]);
    const after = buildWorld([idle("thread-a")]);
    const muted: OrchestratorSpokenEvents = { ...ALL_ON, threadFinished: false };
    expect(diffWorlds(before, after, muted)).toEqual([]);
  });

  it("uses the shipped defaults without blowing up", () => {
    const before = buildWorld([working("thread-a")]);
    const after = buildWorld([idle("thread-a")]);
    const events = diffWorlds(before, after, DEFAULT_UNIFIED_SETTINGS.orchestrator.spokenEvents);
    expect(events.map((event) => event.kind)).toEqual(["thread-finished"]);
  });

  it("ignores threads that disappeared", () => {
    const before = buildWorld([working("thread-a")]);
    expect(diffWorlds(before, new Map(), ALL_ON)).toEqual([]);
  });
});

describe("describeEventFallback", () => {
  it("produces a short spoken line for every kind", () => {
    const base = {
      threadKey: `${environmentId}:thread-a`,
      threadId: ThreadId.make("thread-a"),
      environmentId,
      title: "Rover",
      projectName: "Rover Project",
      outcome: "completed" as const,
    };
    expect(describeEventFallback({ kind: "thread-finished", ...base })).toBe("Rover finished.");
    expect(describeEventFallback({ kind: "approval-needed", ...base })).toBe(
      "Rover needs your approval.",
    );
    expect(describeEventFallback({ kind: "thread-failed", ...base })).toBe("Rover hit an error.");
  });
});

describe("shouldAnnounceEvent", () => {
  const finished = { threadKey: "env:thread-a", kind: "thread-finished" } as const;

  it("speaks the first occurrence and suppresses repeats inside the window", () => {
    const announced = new Map<string, number>();
    expect(shouldAnnounceEvent(announced, finished, 1_000)).toBe(true);
    // A capped provider retries and fails again seconds later.
    expect(shouldAnnounceEvent(announced, finished, 9_000)).toBe(false);
    expect(shouldAnnounceEvent(announced, finished, 1_000 + EVENT_REANNOUNCE_WINDOW_MS)).toBe(true);
  });

  it("limits per thread and kind, not globally", () => {
    const announced = new Map<string, number>();
    expect(shouldAnnounceEvent(announced, finished, 1_000)).toBe(true);
    expect(
      shouldAnnounceEvent(announced, { threadKey: "env:thread-a", kind: "thread-failed" }, 2_000),
    ).toBe(true);
    expect(
      shouldAnnounceEvent(announced, { threadKey: "env:thread-b", kind: "thread-finished" }, 2_000),
    ).toBe(true);
  });
});
