import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { EnvironmentId, ProviderInstanceId, ProjectId, ThreadId, TurnId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  deriveStartupResumableThreads,
  isStartupResumableThread,
} from "./StartupResumeCoordinator.logic";

const NOW = "2026-07-30T20:00:00.000Z";

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
