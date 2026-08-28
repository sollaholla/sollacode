import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProviderInstanceId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveStartupResumableThreads,
  isStartupAutoResumeRequested,
  shouldAutomaticallyResumeOnStartup,
  isStartupAutoResumeStalled,
  isStartupResumableThread,
  pruneStartupResumeSelection,
  shouldClearStartupResumePending,
  shouldAutoCloseStartupResume,
  startupAutoResumeIds,
} from "./StartupResumeCoordinator.logic";

const NOW = "2026-07-30T20:00:00.000Z";

describe("startup auto-resume request", () => {
  it("accepts the desktop startup marker", () => {
    expect(isStartupAutoResumeRequested("sollacode://app/?solla_auto_resume=1")).toBe(true);
    expect(isStartupAutoResumeRequested("sollacode-dev://app/?solla_auto_resume=1")).toBe(true);
  });

  it("does not let hosted URLs trigger automatic turns", () => {
    expect(isStartupAutoResumeRequested("https://example.com/?solla_auto_resume=1")).toBe(false);
    expect(isStartupAutoResumeRequested("sollacode://app/?solla_auto_resume=0")).toBe(false);
  });

  it("auto-sends resume when the startup setting is on or the desktop requested it", () => {
    expect(
      shouldAutomaticallyResumeOnStartup({ showOnStartup: true, autoResumeRequested: false }),
    ).toBe(true);
    expect(
      shouldAutomaticallyResumeOnStartup({ showOnStartup: false, autoResumeRequested: true }),
    ).toBe(true);
    expect(
      shouldAutomaticallyResumeOnStartup({ showOnStartup: false, autoResumeRequested: false }),
    ).toBe(false);
  });

  it("derives the same durable command and message ids on every client", () => {
    const input = {
      threadId: ThreadId.make("thread-shared"),
      incompleteTurnId: TurnId.make("turn-incomplete"),
    };

    expect(startupAutoResumeIds(input)).toEqual(startupAutoResumeIds(input));
    expect(startupAutoResumeIds(input)).toEqual({
      commandId: "startup-auto-resume-command:thread-shared:turn-incomplete",
      messageId: "startup-auto-resume-message:thread-shared:turn-incomplete",
    });
    expect(
      startupAutoResumeIds({
        ...input,
        incompleteTurnId: TurnId.make("turn-next"),
      }),
    ).not.toEqual(startupAutoResumeIds(input));
  });
});

function makeThread(
  id: string,
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    id: ThreadId.make(id),
    environmentId: EnvironmentId.make("local"),
    projectId: ProjectId.make("project"),
    title: id,
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.6-sol",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: {
      turnId: TurnId.make(`turn-${id}`),
      state: "incomplete",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: null,
    },
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    session: {
      threadId: ThreadId.make(id),
      status: "ready",
      providerName: "Codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    ...overrides,
  };
}

describe("startup resumable threads", () => {
  it("includes only incomplete, inactive sessions", () => {
    expect(isStartupResumableThread(makeThread("ready"))).toBe(true);
    expect(
      isStartupResumableThread(
        makeThread("running", {
          session: {
            ...makeThread("running").session!,
            status: "running",
            activeTurnId: TurnId.make("active"),
          },
        }),
      ),
    ).toBe(false);
    expect(
      isStartupResumableThread(
        makeThread("completed", {
          latestTurn: { ...makeThread("completed").latestTurn!, state: "completed" },
        }),
      ),
    ).toBe(false);
    expect(
      isStartupResumableThread(
        makeThread("error", {
          session: { ...makeThread("error").session!, status: "error" },
        }),
      ),
    ).toBe(false);
    expect(
      isStartupResumableThread(
        makeThread("interrupted", {
          session: { ...makeThread("interrupted").session!, status: "interrupted" },
        }),
      ),
    ).toBe(false);
  });

  it("excludes threads that were retired, need a human, or already own queued work", () => {
    expect(isStartupResumableThread(makeThread("archived", { archivedAt: NOW }))).toBe(false);
    expect(isStartupResumableThread(makeThread("settled", { settledOverride: "settled" }))).toBe(
      false,
    );
    expect(isStartupResumableThread(makeThread("approval", { hasPendingApprovals: true }))).toBe(
      false,
    );
    expect(isStartupResumableThread(makeThread("question", { hasPendingUserInput: true }))).toBe(
      false,
    );
    expect(
      isStartupResumableThread(
        makeThread("queued", {
          pendingWork: {
            kind: "active-turn-recovery",
            state: "pending",
            since: NOW,
          },
        }),
      ),
    ).toBe(false);
  });

  it("does not use cross-client timestamps as a startup authorization boundary", () => {
    expect(
      isStartupResumableThread(
        makeThread("clock-skewed", {
          latestTurn: {
            ...makeThread("clock-skewed").latestTurn!,
            completedAt: "2026-07-30T19:59:00.000Z",
          },
          latestUserMessageAt: "2026-07-31T20:00:00.000Z",
        }),
      ),
    ).toBe(true);
  });

  it("sorts the newest resumable work first", () => {
    const older = makeThread("older", { updatedAt: "2026-07-30T19:00:00.000Z" });
    const newer = makeThread("newer", { updatedAt: "2026-07-30T21:00:00.000Z" });
    expect(deriveStartupResumableThreads([older, newer]).map((thread) => thread.id)).toEqual([
      ThreadId.make("newer"),
      ThreadId.make("older"),
    ]);
  });
});

describe("startup resume pending handoff", () => {
  it("stays visible while the command is projected but the provider has not started", () => {
    expect(
      shouldClearStartupResumePending(
        makeThread("accepted", {
          latestTurn: { ...makeThread("accepted").latestTurn!, state: "running" },
          session: { ...makeThread("accepted").session!, status: "ready" },
        }),
      ),
    ).toBe(false);
  });

  it("hands off to normal working or failure state once the provider responds", () => {
    for (const status of ["starting", "running", "error"] as const) {
      expect(
        shouldClearStartupResumePending(
          makeThread(status, {
            session: { ...makeThread(status).session!, status },
          }),
        ),
      ).toBe(true);
    }
  });

  it("clears once a fast resumed turn has already settled", () => {
    expect(
      shouldClearStartupResumePending(
        makeThread("completed", {
          latestTurn: { ...makeThread("completed").latestTurn!, state: "completed" },
        }),
      ),
    ).toBe(true);
  });
});

describe("shouldAutoCloseStartupResume", () => {
  it("closes an open dialog once no candidates remain", () => {
    // The prompt is asking about nothing: the threads were resumed elsewhere,
    // their environment dropped, or they left the store.
    expect(shouldAutoCloseStartupResume({ open: true, busy: false, candidateCount: 0 })).toBe(true);
  });

  it("stays open while candidates remain", () => {
    expect(shouldAutoCloseStartupResume({ open: true, busy: false, candidateCount: 1 })).toBe(
      false,
    );
  });

  it("never closes while resuming", () => {
    // `resumeSelected` drains the candidate list as its own resumes land;
    // closing there would race its completion and skip the settings write.
    expect(shouldAutoCloseStartupResume({ open: true, busy: true, candidateCount: 0 })).toBe(false);
  });

  it("does nothing when the dialog is already closed", () => {
    expect(shouldAutoCloseStartupResume({ open: false, busy: false, candidateCount: 0 })).toBe(
      false,
    );
  });
});

describe("pruneStartupResumeSelection", () => {
  it("drops keys whose candidates disappeared", () => {
    // The stale key is what left the footer reading "Resume (1)" over an empty
    // list, with the button enabled but silently doing nothing.
    const pruned = pruneStartupResumeSelection(new Set(["env:a", "env:b"]), ["env:b"]);
    expect([...pruned]).toEqual(["env:b"]);
  });

  it("keeps every key that is still offered", () => {
    const pruned = pruneStartupResumeSelection(new Set(["env:a", "env:b"]), ["env:a", "env:b"]);
    expect(pruned.size).toBe(2);
  });

  it("empties the selection when every candidate is gone", () => {
    expect(pruneStartupResumeSelection(new Set(["env:a"]), []).size).toBe(0);
  });

  it("does not invent selections for newly offered candidates", () => {
    const pruned = pruneStartupResumeSelection(new Set(["env:a"]), ["env:a", "env:c"]);
    expect([...pruned]).toEqual(["env:a"]);
  });
});

describe("isStartupAutoResumeStalled", () => {
  const startedAt = "2026-08-05T13:50:00.000Z";
  const startedMs = Date.parse(startedAt);

  it("still counts a young resume as in progress", () => {
    // A real resume spawns a CLI first; ~10s of silence is normal.
    expect(isStartupAutoResumeStalled({ startedAt, nowMs: startedMs + 10_000 })).toBe(false);
  });

  it("gives up once the resume has plainly not taken", () => {
    // Observed: minutes of "Auto-resuming thread…" on a thread whose session
    // was stopped and whose resume obligation had been cancelled.
    expect(isStartupAutoResumeStalled({ startedAt, nowMs: startedMs + 120_000 })).toBe(true);
  });

  it("keeps showing progress when the timestamp is unusable", () => {
    // Absence of evidence is not evidence of a stall.
    expect(isStartupAutoResumeStalled({ startedAt: "not-a-date", nowMs: startedMs })).toBe(false);
  });
});
