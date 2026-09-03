import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { Thread, ThreadShell } from "../types";
import {
  MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
  authoritativeThreadSettingsFingerprint,
  branchMismatchKey,
  buildExpiredTerminalContextToastCopy,
  buildLoadingThreadFromShell,
  resolveBlockedSend,
  resolveSendDisabledReason,
  buildThreadTurnInterruptInput,
  canQueueLocalMessageDuringReconnect,
  createLocalDispatchSnapshot,
  deriveComposerSendState,
  deriveActiveSessionProviderDriver,
  describePendingTurnStart,
  deriveLockedProvider,
  dismissBranchMismatchForSession,
  hasServerAcknowledgedLocalDispatch,
  isBranchMismatchDismissedForSession,
  isProviderOverloadRetrying,
  isThreadAlreadyExistsError,
  isThreadWorkInterruptible,
  reconcileRetainedMountedThreadIds,
  retainClosingSideChatThreadIds,
  shouldAutoFocusComposerOnThreadOpen,
  shouldRestoreComposerFocus,
  describeThreadErrorAge,
  resolveDraftThreadCreateModelSelection,
  resolveVisibleServerThreadError,
  resolveThreadMetadataUpdateForNextTurn,
  resolveSendEnvMode,
  startNewThreadForProject,
  shouldCreateServerThreadForTerminalStart,
  shouldShowBranchMismatchBanner,
  shouldConfirmRemoteProviderAccountSwitch,
  shouldPersistComposerModelDefaults,
  shouldWriteThreadErrorToCurrentServerThread,
} from "./ChatView.logic";

describe("canQueueLocalMessageDuringReconnect", () => {
  it("queues only a loaded local thread during a transient reconnect", () => {
    expect(
      canQueueLocalMessageDuringReconnect({
        targetKind: "PrimaryConnectionTarget",
        phase: "connecting",
        threadDetailLoaded: true,
      }),
    ).toBe(true);
    expect(
      canQueueLocalMessageDuringReconnect({
        targetKind: "PrimaryConnectionTarget",
        phase: "reconnecting",
        threadDetailLoaded: true,
      }),
    ).toBe(true);
  });

  it("does not queue remote, unloaded, blocked, or offline sends", () => {
    expect(
      canQueueLocalMessageDuringReconnect({
        targetKind: "BearerConnectionTarget",
        phase: "reconnecting",
        threadDetailLoaded: true,
      }),
    ).toBe(false);
    expect(
      canQueueLocalMessageDuringReconnect({
        targetKind: "PrimaryConnectionTarget",
        phase: "reconnecting",
        threadDetailLoaded: false,
      }),
    ).toBe(false);
    expect(
      canQueueLocalMessageDuringReconnect({
        targetKind: "PrimaryConnectionTarget",
        phase: "offline",
        threadDetailLoaded: true,
      }),
    ).toBe(false);
    expect(
      canQueueLocalMessageDuringReconnect({
        targetKind: "PrimaryConnectionTarget",
        phase: "error",
        threadDetailLoaded: true,
      }),
    ).toBe(false);
  });
});

describe("resolveVisibleServerThreadError", () => {
  it("hides only the exact persisted error the user dismissed", () => {
    expect(
      resolveVisibleServerThreadError(
        { message: null },
        "Persisted provider failure",
        "Persisted provider failure",
      ),
    ).toBeNull();
    expect(
      resolveVisibleServerThreadError(
        { message: null },
        "New genuine failure",
        "Persisted provider failure",
      ),
    ).toBe("New genuine failure");
  });

  it("shows the server error until it has a local override", () => {
    expect(resolveVisibleServerThreadError(undefined, "Genuine provider failure", null)).toBe(
      "Genuine provider failure",
    );
    expect(
      resolveVisibleServerThreadError({ message: "New local error" }, "Old server error"),
    ).toBe("New local error");
  });

  it("does not treat a model-fallback notice as a sticky thread error", () => {
    expect(
      resolveVisibleServerThreadError(
        undefined,
        "Claude · Opus 4.6 · Medium is temporarily unavailable. Falling back to Claude · Opus 4.1 · Medium.",
        null,
      ),
    ).toBeNull();
  });
});

const environmentId = EnvironmentId.make("environment-local");
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const now = "2026-03-29T00:00:00.000Z";

describe("shouldConfirmRemoteProviderAccountSwitch", () => {
  it("warns only when authentication will run on another environment", () => {
    const primaryEnvironmentId = EnvironmentId.make("environment-primary");
    expect(
      shouldConfirmRemoteProviderAccountSwitch({
        activeEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
      }),
    ).toBe(true);
    expect(
      shouldConfirmRemoteProviderAccountSwitch({
        activeEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
      }),
    ).toBe(false);
  });
});

describe("isProviderOverloadRetrying", () => {
  const latestTurn = {
    turnId: TurnId.make("turn-overloaded"),
    state: "running" as const,
    requestedAt: "2026-07-29T15:00:00.000Z",
    startedAt: "2026-07-29T15:00:01.000Z",
    completedAt: null,
    assistantMessageId: null,
  };
  const activity = {
    id: "event-overload" as never,
    createdAt: "2026-07-29T15:00:02.000Z",
    tone: "info" as const,
    kind: "provider.overload.retrying",
    summary: "Provider unavailable — retrying shortly",
    payload: { reason: "provider_overloaded:retrying;attempt=1" },
    turnId: latestTurn.turnId,
  };

  it("shows only a retry activity for the current working turn", () => {
    expect(
      isProviderOverloadRetrying({
        activities: [activity],
        latestTurn,
        isWorking: true,
      }),
    ).toBe(true);
    expect(
      isProviderOverloadRetrying({
        activities: [activity],
        latestTurn,
        isWorking: false,
      }),
    ).toBe(false);
  });

  it("ignores stale retry activity from a previous turn", () => {
    expect(
      isProviderOverloadRetrying({
        activities: [{ ...activity, createdAt: "2026-07-29T14:59:59.000Z", turnId: null }],
        latestTurn,
        isWorking: true,
      }),
    ).toBe(false);
  });
});

function makeThread(overrides: Partial<Thread> = {}): Thread {
  return {
    id: threadId,
    environmentId,
    projectId,
    title: "Thread",
    modelSelection: {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    session: null,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: null,
    worktreePath: null,
    ...overrides,
  };
}

const completedTurn = {
  turnId: TurnId.make("turn-1"),
  state: "completed" as const,
  requestedAt: now,
  startedAt: "2026-03-29T00:00:01.000Z",
  completedAt: "2026-03-29T00:00:10.000Z",
  assistantMessageId: null,
};

const readySession = {
  threadId,
  status: "ready" as const,
  providerName: "codex",
  providerInstanceId: ProviderInstanceId.make("codex"),
  runtimeMode: "full-access" as const,
  activeTurnId: null,
  lastError: null,
  updatedAt: "2026-03-29T00:00:10.000Z",
};

describe("buildLoadingThreadFromShell", () => {
  it("preserves shell metadata and supplies empty detail collections", () => {
    const shell = {
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: "main",
      worktreePath: null,
      latestTurn: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      snoozedUntil: null,
      snoozedAt: null,
      session: null,
      latestUserMessageAt: now,
      hasPendingApprovals: false,
      hasPendingUserInput: false,
      hasActionableProposedPlan: false,
    } satisfies ThreadShell;

    expect(buildLoadingThreadFromShell(shell)).toMatchObject({
      environmentId,
      id: threadId,
      projectId,
      title: "Loading thread",
      branch: "main",
      deletedAt: null,
      messages: [],
      proposedPlans: [],
      activities: [],
      checkpoints: [],
    });
  });
});

describe("resolveThreadMetadataUpdateForNextTurn", () => {
  const modelSelection = {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  };

  it("updates a stale local thread branch to the active checkout", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        currentBranch: "feature/thread",
        nextBranch: "feature/checkout",
      }),
    ).toEqual({ branch: "feature/checkout", worktreePath: null });
  });

  it("does not write metadata when the model and branch are unchanged", () => {
    expect(
      resolveThreadMetadataUpdateForNextTurn({
        currentModelSelection: modelSelection,
        nextModelSelection: modelSelection,
        currentBranch: "feature/current",
        nextBranch: "feature/current",
      }),
    ).toBeNull();
  });
});

describe("authoritativeThreadSettingsFingerprint", () => {
  it("changes for provider, model options, runtime mode, and interaction mode updates", () => {
    const base = makeThread();
    const fingerprint = authoritativeThreadSettingsFingerprint(base);

    expect(
      authoritativeThreadSettingsFingerprint({
        ...base,
        modelSelection: {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-fable",
        },
      }),
    ).not.toBe(fingerprint);
    expect(
      authoritativeThreadSettingsFingerprint({
        ...base,
        modelSelection: {
          ...base.modelSelection,
          options: [{ id: "reasoningEffort", value: "high" }],
        },
      }),
    ).not.toBe(fingerprint);
    expect(
      authoritativeThreadSettingsFingerprint({ ...base, runtimeMode: "approval-required" }),
    ).not.toBe(fingerprint);
    expect(authoritativeThreadSettingsFingerprint({ ...base, interactionMode: "plan" })).not.toBe(
      fingerprint,
    );
  });
});

describe("buildThreadTurnInterruptInput", () => {
  it("targets the session's active running turn", () => {
    const activeTurnId = TurnId.make("turn-running");

    expect(
      buildThreadTurnInterruptInput(
        makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId,
          },
        }),
      ),
    ).toEqual({ threadId, turnId: activeTurnId });
  });

  it("omits a turn id when the session is not running", () => {
    expect(buildThreadTurnInterruptInput(makeThread({ session: readySession }))).toEqual({
      threadId,
    });
  });
});

describe("isThreadWorkInterruptible", () => {
  it("keeps Stop available while a provider starts or retries a user turn", () => {
    expect(isThreadWorkInterruptible({ phase: "connecting", pendingWork: null })).toBe(true);
    expect(
      isThreadWorkInterruptible({
        phase: "disconnected",
        pendingWork: {
          kind: "active-turn-recovery",
          state: "sleeping",
          since: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toBe(true);
  });

  it("does not turn unrelated background or authentication waits into Stop", () => {
    expect(
      isThreadWorkInterruptible({
        phase: "ready",
        pendingWork: {
          kind: "agent-continuation",
          state: "pending",
          since: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toBe(false);
    expect(
      isThreadWorkInterruptible({
        phase: "disconnected",
        pendingWork: {
          kind: "active-turn-recovery",
          state: "blocked-authentication",
          since: "2026-01-01T00:00:00.000Z",
        },
      }),
    ).toBe(false);
  });
});

describe("deriveLockedProvider", () => {
  it("keeps provider selection unlocked while another provider turn is active", () => {
    expect(
      deriveLockedProvider({
        thread: makeThread({
          session: {
            ...readySession,
            status: "running",
            activeTurnId: TurnId.make("turn-running"),
          },
        }),
        selectedProvider: "claude",
        threadProvider: "codex",
      }),
    ).toBeNull();
  });
});

describe("deriveActiveSessionProviderDriver", () => {
  it("resolves the running provider even though the composer remains unlocked", () => {
    const thread = makeThread({
      session: {
        ...readySession,
        status: "running",
        providerName: "grok",
        providerInstanceId: ProviderInstanceId.make("grok"),
        activeTurnId: TurnId.make("turn-running"),
      },
    });

    expect(
      deriveLockedProvider({
        thread,
        selectedProvider: "codex",
        threadProvider: "grok",
      }),
    ).toBeNull();
    expect(deriveActiveSessionProviderDriver({ thread, providers: [] })).toBe("grok");
  });

  it("uses configured instance metadata for custom Grok instances", () => {
    const thread = makeThread({
      session: {
        ...readySession,
        status: "running",
        providerName: "custom-grok-provider",
        providerInstanceId: ProviderInstanceId.make("grok-work"),
        activeTurnId: TurnId.make("turn-running"),
      },
    });

    expect(
      deriveActiveSessionProviderDriver({
        thread,
        providers: [
          {
            instanceId: ProviderInstanceId.make("grok-work"),
            driver: ProviderDriverKind.make("grok"),
          },
        ],
      }),
    ).toBe("grok");
  });
});

describe("deriveComposerSendState", () => {
  it("treats expired terminal pills as non-sendable content", () => {
    const state = deriveComposerSendState({
      prompt: "\uFFFC",
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.sendableTerminalContexts).toEqual([]);
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(false);
  });

  it("keeps text sendable while excluding expired terminal pills", () => {
    const state = deriveComposerSendState({
      prompt: `yoo \uFFFC waddup`,
      imageCount: 0,
      terminalContexts: [
        {
          id: "ctx-expired",
          threadId,
          terminalId: "default",
          terminalLabel: "Terminal 1",
          lineStart: 4,
          lineEnd: 4,
          text: "",
          createdAt: now,
        },
      ],
    });

    expect(state.trimmedPrompt).toBe("yoo  waddup");
    expect(state.expiredTerminalContextCount).toBe(1);
    expect(state.hasSendableContent).toBe(true);
  });

  it("treats element contexts as sendable content (no text, no images, no terminals)", () => {
    const state = deriveComposerSendState({
      prompt: "",
      imageCount: 0,
      terminalContexts: [],
      elementContextCount: 1,
    });

    expect(state.trimmedPrompt).toBe("");
    expect(state.expiredTerminalContextCount).toBe(0);
    expect(state.hasSendableContent).toBe(true);
  });

  it("does NOT treat zero element contexts as sendable", () => {
    expect(
      deriveComposerSendState({
        prompt: "",
        imageCount: 0,
        terminalContexts: [],
        elementContextCount: 0,
      }).hasSendableContent,
    ).toBe(false);
  });
});

describe("buildExpiredTerminalContextToastCopy", () => {
  it("formats empty and omission guidance", () => {
    expect(buildExpiredTerminalContextToastCopy(1, "empty")).toEqual({
      title: "Expired terminal context won't be sent",
      description: "Remove it or re-add it to include terminal output.",
    });
    expect(buildExpiredTerminalContextToastCopy(2, "omitted")).toEqual({
      title: "Expired terminal contexts omitted from message",
      description: "Re-add it if you want that terminal output included.",
    });
  });
});

describe("resolveSendEnvMode", () => {
  it("keeps worktree mode only for git repositories", () => {
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: true })).toBe("worktree");
    expect(resolveSendEnvMode({ requestedEnvMode: "worktree", isGitRepo: false })).toBe("local");
  });
});

describe("branchMismatchKey", () => {
  it("builds a key from thread id and both branches", () => {
    expect(branchMismatchKey("thread-1", { threadBranch: "feat/a", currentBranch: "feat/b" })).toBe(
      "thread-1:feat/a:feat/b",
    );
  });

  it("returns null without a thread or mismatch", () => {
    expect(branchMismatchKey(null, { threadBranch: "a", currentBranch: "b" })).toBeNull();
    expect(branchMismatchKey("thread-1", null)).toBeNull();
  });
});

describe("shouldShowBranchMismatchBanner", () => {
  const base = {
    hasMismatch: true,
    isDismissed: false,
    composerHasContent: false,
    wasShownForCurrentMismatch: false,
  };

  it("stays hidden during passive browsing (even though the composer autofocuses)", () => {
    expect(shouldShowBranchMismatchBanner(base)).toBe(false);
  });

  it("shows once the composer has draft content", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, composerHasContent: true })).toBe(true);
  });

  it("stays mounted after the draft clears once shown for the current mismatch", () => {
    expect(shouldShowBranchMismatchBanner({ ...base, wasShownForCurrentMismatch: true })).toBe(
      true,
    );
  });

  it("never shows when dismissed or without a mismatch", () => {
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, isDismissed: true }),
    ).toBe(false);
    expect(
      shouldShowBranchMismatchBanner({ ...base, composerHasContent: true, hasMismatch: false }),
    ).toBe(false);
  });
});

describe("session branch mismatch dismissal", () => {
  it("tracks dismissed keys and treats other keys as active", () => {
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(false);
    dismissBranchMismatchForSession("t1:a:b");
    expect(isBranchMismatchDismissedForSession("t1:a:b")).toBe(true);
    expect(isBranchMismatchDismissedForSession("t1:a:c")).toBe(false);
    expect(isBranchMismatchDismissedForSession(null)).toBe(false);
  });
});

describe("reconcileRetainedMountedThreadIds", () => {
  it("retains hidden open threads and adds the active open thread", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-hidden")],
        openThreadIds: [ThreadId.make("thread-hidden")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: true,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual([ThreadId.make("thread-hidden"), ThreadId.make("thread-active")]);
  });

  it("can retain the active thread as hidden when it is inactive", () => {
    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds: [ThreadId.make("thread-active")],
        openThreadIds: [ThreadId.make("thread-active")],
        activeThreadId: ThreadId.make("thread-active"),
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
        retainInactiveActiveThread: true,
      }),
    ).toEqual([ThreadId.make("thread-active")]);
  });

  it("evicts the oldest hidden threads beyond the configured cap", () => {
    const currentThreadIds = Array.from(
      { length: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS + 2 },
      (_, index) => ThreadId.make(`thread-${index + 1}`),
    );

    expect(
      reconcileRetainedMountedThreadIds({
        currentThreadIds,
        openThreadIds: currentThreadIds,
        activeThreadId: null,
        activeThreadOpen: false,
        maxHiddenThreadCount: MAX_HIDDEN_MOUNTED_PREVIEW_THREADS,
      }),
    ).toEqual(currentThreadIds.slice(-MAX_HIDDEN_MOUNTED_PREVIEW_THREADS));
  });
});

describe("retainClosingSideChatThreadIds", () => {
  it("suppresses a closed child until its authoritative shell disappears", () => {
    const closing = new Set(["side-a", "side-b"]);

    expect(retainClosingSideChatThreadIds(closing, new Set(["side-a", "side-b"]))).toBe(closing);
    expect([...retainClosingSideChatThreadIds(closing, new Set(["side-b"]))]).toEqual(["side-b"]);
    expect([...retainClosingSideChatThreadIds(closing, new Set())]).toEqual([]);
  });
});

describe("shouldPersistComposerModelDefaults", () => {
  it("keeps side-chat model and trait changes out of global composer defaults", () => {
    expect(
      shouldPersistComposerModelDefaults({
        embeddedSideChat: true,
        threadIsSideChat: true,
      }),
    ).toBe(false);
    expect(
      shouldPersistComposerModelDefaults({
        embeddedSideChat: false,
        threadIsSideChat: true,
      }),
    ).toBe(false);
  });

  it("continues persisting explicit model choices from a normal main chat", () => {
    expect(
      shouldPersistComposerModelDefaults({
        embeddedSideChat: false,
        threadIsSideChat: false,
      }),
    ).toBe(true);
  });
});

describe("shouldWriteThreadErrorToCurrentServerThread", () => {
  it("writes errors for a shell-derived active server thread", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: { environmentId, id: threadId },
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(true);
  });

  it("requires an active server thread matching the environment, route, and target", () => {
    const routeThreadRef = { environmentId, threadId };

    expect(
      shouldWriteThreadErrorToCurrentServerThread({
        activeServerThread: null,
        routeThreadRef,
        targetThreadId: threadId,
      }),
    ).toBe(false);
  });
});

describe("shouldCreateServerThreadForTerminalStart", () => {
  it("persists only local drafts that are not already server threads", () => {
    expect(
      shouldCreateServerThreadForTerminalStart({
        isLocalDraftThread: true,
        isServerThread: false,
      }),
    ).toBe(true);
    expect(
      shouldCreateServerThreadForTerminalStart({
        isLocalDraftThread: false,
        isServerThread: true,
      }),
    ).toBe(false);
    expect(
      shouldCreateServerThreadForTerminalStart({
        isLocalDraftThread: true,
        isServerThread: true,
      }),
    ).toBe(false);
  });
});

describe("isThreadAlreadyExistsError", () => {
  it("recognizes a duplicate thread.create invariant", () => {
    expect(
      isThreadAlreadyExistsError(
        new Error("Thread 'thread-1' already exists and cannot be created twice."),
      ),
    ).toBe(true);
    expect(isThreadAlreadyExistsError("project already exists")).toBe(false);
    expect(isThreadAlreadyExistsError(new Error("network failed"))).toBe(false);
  });
});

describe("resolveDraftThreadCreateModelSelection", () => {
  const composerSelection = {
    instanceId: ProviderInstanceId.make("grok"),
    model: "grok-4",
  };
  const projectSelection = {
    instanceId: ProviderInstanceId.make("claude"),
    model: "opus",
  };

  it("prefers the composer selection, then the project default", () => {
    expect(
      resolveDraftThreadCreateModelSelection({
        composerModelSelection: composerSelection,
        projectDefaultModelSelection: projectSelection,
      }),
    ).toEqual(composerSelection);
    expect(
      resolveDraftThreadCreateModelSelection({
        composerModelSelection: { ...composerSelection, model: "" },
        projectDefaultModelSelection: projectSelection,
      }),
    ).toEqual(projectSelection);
    expect(
      resolveDraftThreadCreateModelSelection({
        composerModelSelection: null,
        projectDefaultModelSelection: { ...projectSelection, model: "" },
      }),
    ).toBeNull();
  });
});

describe("startNewThreadForProject", () => {
  it("starts a thread through the supplied shared handler for the active project", () => {
    const calls: Array<{ environmentId: EnvironmentId; projectId: ProjectId }> = [];
    const projectRef = { environmentId, projectId };

    expect(
      startNewThreadForProject(projectRef, (nextProjectRef) => {
        calls.push(nextProjectRef);
        return Promise.resolve();
      }),
    ).toBe(true);
    expect(calls).toEqual([projectRef]);
  });

  it("does nothing when the active project is unavailable", () => {
    let called = false;

    expect(
      startNewThreadForProject(null, () => {
        called = true;
        return Promise.resolve();
      }),
    ).toBe(false);
    expect(called).toBe(false);
  });
});

describe("hasServerAcknowledgedLocalDispatch", () => {
  it("does not acknowledge unchanged server state", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: completedTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: readySession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
  });

  it("acknowledges a settled newer turn", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const newerTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: "2026-03-29T00:01:30.000Z",
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "ready",
        latestTurn: newerTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: { ...readySession, updatedAt: newerTurn.completedAt },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("waits for the matching running turn before acknowledging", () => {
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({ latestTurn: completedTurn, session: readySession }),
    );
    const runningTurn = {
      ...completedTurn,
      turnId: TurnId.make("turn-2"),
      state: "running" as const,
      requestedAt: "2026-03-29T00:01:00.000Z",
      startedAt: "2026-03-29T00:01:01.000Z",
      completedAt: null,
    };

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: TurnId.make("turn-other"),
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(false);
    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: localDispatch.latestUserMessageId,
        session: {
          ...readySession,
          status: "running",
          activeTurnId: runningTurn.turnId,
        },
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges a steering message projected onto the current running turn", () => {
    const runningTurn = {
      ...completedTurn,
      state: "running" as const,
      completedAt: null,
    };
    const runningSession = {
      ...readySession,
      status: "running" as const,
      activeTurnId: runningTurn.turnId,
    };
    const localDispatch = createLocalDispatchSnapshot(
      makeThread({
        latestTurn: runningTurn,
        session: runningSession,
        messages: [
          {
            id: MessageId.make("message-before-steer"),
            role: "user",
            text: "Initial prompt",
            turnId: runningTurn.turnId,
            createdAt: runningTurn.requestedAt,
            updatedAt: runningTurn.requestedAt,
            streaming: false,
          },
        ],
      }),
    );

    expect(
      hasServerAcknowledgedLocalDispatch({
        localDispatch,
        phase: "running",
        latestTurn: runningTurn,
        latestUserMessageId: MessageId.make("message-steer"),
        session: runningSession,
        hasPendingApproval: false,
        hasPendingUserInput: false,
        threadError: null,
      }),
    ).toBe(true);
  });

  it("acknowledges pending user interaction and errors immediately", () => {
    const localDispatch = createLocalDispatchSnapshot(makeThread());
    const common = {
      localDispatch,
      phase: "ready" as const,
      latestTurn: null,
      latestUserMessageId: localDispatch.latestUserMessageId,
      session: null,
      hasPendingApproval: false,
      hasPendingUserInput: false,
      threadError: null,
    };

    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingApproval: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, hasPendingUserInput: true })).toBe(true);
    expect(hasServerAcknowledgedLocalDispatch({ ...common, threadError: "failed" })).toBe(true);
  });
});

describe("describeThreadErrorAge", () => {
  const now = Date.parse("2026-08-17T20:41:00Z");

  it("says how old a stale error is", () => {
    // The reported case: a spawn failure recorded at 18:48 was still shown at
    // 20:41 as though it were happening, so the user debugged a working CLI.
    expect(describeThreadErrorAge("2026-08-17T18:48:16Z", now)).toBe("1 hour ago");
  });

  it("scales through minutes, hours and days", () => {
    expect(describeThreadErrorAge("2026-08-17T20:36:00Z", now)).toBe("5 minutes ago");
    expect(describeThreadErrorAge("2026-08-17T15:41:00Z", now)).toBe("5 hours ago");
    expect(describeThreadErrorAge("2026-08-15T20:41:00Z", now)).toBe("2 days ago");
  });

  it("gets the singular right", () => {
    expect(describeThreadErrorAge("2026-08-17T20:40:00Z", now)).toBe("1 minute ago");
    expect(describeThreadErrorAge("2026-08-16T20:41:00Z", now)).toBe("1 day ago");
  });

  it("stays quiet for an error that just happened", () => {
    // "Just now" adds nothing to a banner that already appeared this second.
    expect(describeThreadErrorAge("2026-08-17T20:40:30Z", now)).toBeNull();
  });

  it("says nothing rather than claiming an error from the future", () => {
    expect(describeThreadErrorAge("2026-08-17T21:00:00Z", now)).toBeNull();
    expect(describeThreadErrorAge("not a date", now)).toBeNull();
    expect(describeThreadErrorAge(null, now)).toBeNull();
    expect(describeThreadErrorAge(undefined, now)).toBeNull();
  });
});

describe("shouldAutoFocusComposerOnThreadOpen", () => {
  const base = {
    hasThread: true,
    terminalSurfaceActive: false,
    previewFocused: false,
    usesOnScreenKeyboard: false,
  };

  it("places the caret when there is a real keyboard", () => {
    expect(shouldAutoFocusComposerOnThreadOpen(base)).toBe(true);
  });

  it("leaves the keyboard closed on a touch device", () => {
    // The regression this exists for: opening a thread summoned the on-screen
    // keyboard, which covers the conversation that was just opened.
    expect(shouldAutoFocusComposerOnThreadOpen({ ...base, usesOnScreenKeyboard: true })).toBe(
      false,
    );
  });

  it("does not depend on viewport size or orientation", () => {
    // A tablet and a phone held sideways both have a soft keyboard, and the
    // old phone-portrait guard matched neither.
    for (const usesOnScreenKeyboard of [true, false]) {
      expect(shouldAutoFocusComposerOnThreadOpen({ ...base, usesOnScreenKeyboard })).toBe(
        !usesOnScreenKeyboard,
      );
    }
  });

  it("yields to the terminal surface", () => {
    expect(shouldAutoFocusComposerOnThreadOpen({ ...base, terminalSurfaceActive: true })).toBe(
      false,
    );
  });

  it("yields to the preview browser", () => {
    expect(shouldAutoFocusComposerOnThreadOpen({ ...base, previewFocused: true })).toBe(false);
  });

  it("does nothing without a thread", () => {
    expect(shouldAutoFocusComposerOnThreadOpen({ ...base, hasThread: false })).toBe(false);
  });
});

describe("shouldRestoreComposerFocus", () => {
  it("restores the caret where a keyboard is already there", () => {
    expect(shouldRestoreComposerFocus({ previewFocused: false, usesOnScreenKeyboard: false })).toBe(
      true,
    );
  });

  it("leaves focus alone where restoring it would raise a keyboard", () => {
    // Every caller is an action settling — a menu closing, a branch picked.
    // None of them is the user saying they want to type.
    expect(shouldRestoreComposerFocus({ previewFocused: false, usesOnScreenKeyboard: true })).toBe(
      false,
    );
  });

  it("leaves focus in the preview browser", () => {
    // The regression this exists for: clicking into the preview and typing
    // (or pasting) put the text in the chat composer, because an unrelated
    // action settling pulled the caret back out of the guest page.
    expect(shouldRestoreComposerFocus({ previewFocused: true, usesOnScreenKeyboard: false })).toBe(
      false,
    );
  });
});

describe("resolveSendDisabledReason oversized prompt", () => {
  const base = { providerAuthenticationPaused: false, threadCatchingUp: false };

  it("blocks a prompt past the provider limit and says how much to cut", () => {
    // This is the exact failure it replaces: the server validates a trimmed
    // string with isMaxLength(120000) and rejects the turn in sendTurn.
    const reason = resolveSendDisabledReason({ ...base, promptLength: 120_500 });
    expect(reason).toBe("Message is 500 characters over the 120,000 limit");
  });

  it("allows a prompt exactly at the limit", () => {
    expect(resolveSendDisabledReason({ ...base, promptLength: 120_000 })).toBeNull();
  });

  it("leaves normal prompts and the omitted case alone", () => {
    expect(resolveSendDisabledReason({ ...base, promptLength: 42 })).toBeNull();
    expect(resolveSendDisabledReason(base)).toBeNull();
  });

  it("keeps sign-in the priority when both apply", () => {
    expect(
      resolveSendDisabledReason({
        ...base,
        providerAuthenticationPaused: true,
        promptLength: 999_999,
      }),
    ).toBe("Sign in to continue");
  });
});

describe("resolveSendDisabledReason", () => {
  it("leaves send pressable while the conversation catches up", () => {
    // The dead button: "Messages syncing" disabled send for the whole
    // ten-second fast-forward, so the press never reached the code that
    // would have queued it.
    expect(
      resolveSendDisabledReason({ providerAuthenticationPaused: false, threadCatchingUp: true }),
    ).toBeNull();
  });

  it("still disables send when the provider needs a sign-in", () => {
    expect(
      resolveSendDisabledReason({ providerAuthenticationPaused: true, threadCatchingUp: false }),
    ).toBe("Sign in to continue");
  });
});

describe("resolveBlockedSend", () => {
  const base = {
    hasThread: true,
    sendInFlight: false,
    providerAuthenticationPaused: false,
    connecting: false,
    threadCatchingUp: false,
    environmentUnavailable: false,
    canQueueLocalMessage: false,
    environmentLabel: "Soloman's MacBook Pro",
  };

  it("queues rather than refuses while the conversation is still catching up", () => {
    // Catching up can take ten seconds; making someone wait to type is the
    // thing being fixed.
    const outcome = resolveBlockedSend({ ...base, threadCatchingUp: true });
    expect(outcome.kind).toBe("queue");
    expect(outcome.kind === "queue" && outcome.message).toContain("will send itself");
  });

  it("queues while reconnecting, naming the host", () => {
    const outcome = resolveBlockedSend({ ...base, connecting: true });
    expect(outcome.kind).toBe("queue");
    expect(outcome.kind === "queue" && outcome.message).toContain("Soloman's MacBook Pro");
  });

  it("explains an unreachable host that cannot even queue", () => {
    const outcome = resolveBlockedSend({ ...base, environmentUnavailable: true });
    expect(outcome.kind).toBe("explain");
    expect(outcome.kind === "explain" && outcome.message).toContain("unreachable");
  });

  it("prefers queueing when an unreachable host can still take a queued message", () => {
    const outcome = resolveBlockedSend({
      ...base,
      environmentUnavailable: true,
      canQueueLocalMessage: true,
      connecting: true,
    });
    expect(outcome.kind).toBe("queue");
  });

  it("explains a paused provider sign-in, which waiting will not fix", () => {
    const outcome = resolveBlockedSend({ ...base, providerAuthenticationPaused: true });
    expect(outcome.kind).toBe("explain");
    expect(outcome.kind === "explain" && outcome.message).toContain("sign in");
  });

  it("stays quiet while a send is genuinely in flight", () => {
    expect(resolveBlockedSend({ ...base, sendInFlight: true, connecting: true }).kind).toBe(
      "silent",
    );
  });

  it("falls back to a host-agnostic phrasing with no label", () => {
    const outcome = resolveBlockedSend({ ...base, connecting: true, environmentLabel: null });
    expect(outcome.kind === "queue" && outcome.message).toContain("the host");
  });

  it("stays quiet when nothing is blocking the send", () => {
    expect(resolveBlockedSend(base).kind).toBe("silent");
  });
});

describe("describePendingTurnStart", () => {
  const queued = {
    kind: "active-turn-recovery",
    state: "claimed",
    since: "2026-09-01T19:49:15.000Z",
  } as const;

  it("names the provider a queued send is starting", () => {
    expect(
      describePendingTurnStart({
        pendingWork: queued,
        latestTurnState: "completed",
        sessionProviderInstanceId: "claudeAgent",
        requestedProviderInstanceId: "claudeAgent",
        providerName: "Claude",
      }),
    ).toBe("Starting Claude");
  });

  it("says a provider switch is in progress while the session still belongs to the old one", () => {
    expect(
      describePendingTurnStart({
        pendingWork: { ...queued, state: "executing" },
        latestTurnState: "completed",
        sessionProviderInstanceId: "grok",
        requestedProviderInstanceId: "claudeAgent",
        providerName: "Claude",
      }),
    ).toBe("Switching to Claude");
  });

  it("keeps the recovery wording for an interrupted turn", () => {
    expect(
      describePendingTurnStart({
        pendingWork: queued,
        latestTurnState: "incomplete",
        sessionProviderInstanceId: "claudeAgent",
        requestedProviderInstanceId: "claudeAgent",
        providerName: "Claude",
      }),
    ).toBe("Recovering the interrupted response");
  });

  it("is silent without queued delivery work", () => {
    const base = {
      latestTurnState: "completed",
      sessionProviderInstanceId: "claudeAgent",
      requestedProviderInstanceId: "claudeAgent",
      providerName: "Claude",
    };
    expect(describePendingTurnStart({ ...base, pendingWork: null })).toBeNull();
    expect(describePendingTurnStart({ ...base, pendingWork: undefined })).toBeNull();
    expect(
      describePendingTurnStart({ ...base, pendingWork: { ...queued, kind: "agent-continuation" } }),
    ).toBeNull();
    expect(
      describePendingTurnStart({ ...base, pendingWork: { ...queued, state: "waiting-approval" } }),
    ).toBeNull();
  });
});
