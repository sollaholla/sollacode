import {
  CommandId,
  isOrchestratorThreadId,
  MessageId,
  ThreadId,
  type OrchestrationThreadShell,
  type TerminalSummary,
} from "@t3tools/contracts";
import { encodeTerminalWrite, visibleTerminalText } from "@t3tools/shared/terminalText";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import { WorkspaceOrchestrationToolkit } from "./tools.ts";
import {
  WorkspaceOrchestrationInvalidInputError,
  WorkspaceOrchestrationOperationFailedError,
  WorkspaceOrchestrationScopeError,
  WorkspaceOrchestrationTerminalNotFoundError,
  WorkspaceOrchestrationThreadNotFoundError,
  type WorkspaceOrchestrationInput,
  type WorkspaceTerminalDetail,
  type WorkspaceTerminalSummary,
  type WorkspaceThreadSummary,
} from "./types.ts";

const WORKING_TURN_STATES = new Set(["running", "queued", "starting"]);

/**
 * Collapses a shell row into the small shape the orchestrator reasons about.
 * Everything here is derivable client-side too, but the model is talking to the
 * server, and sending it the raw shell would waste most of its context on
 * fields it never uses (worktree paths, model options, snooze bookkeeping).
 */
/** `sideChatOf` when this is a side chat whose parent is still present. */
function sideChatParentTitle(
  shell: OrchestrationThreadShell,
  threadsById: ReadonlyMap<string, OrchestrationThreadShell> | undefined,
): { readonly sideChatOf?: string } {
  if (shell.isSideChat !== true) return {};
  const parentId = shell.sideChatParentThreadId;
  if (parentId === undefined || parentId === null || threadsById === undefined) return {};
  const parent = threadsById.get(parentId);
  return parent === undefined ? {} : { sideChatOf: parent.title };
}

function compactTerminals(
  terminals: ReadonlyArray<TerminalSummary>,
): ReadonlyArray<WorkspaceTerminalSummary> {
  return terminals.map((terminal) => ({
    terminalId: terminal.terminalId,
    label: terminal.label,
    status: terminal.status,
    hasRunningSubprocess: terminal.hasRunningSubprocess,
  }));
}

export function summarizeThread(
  shell: OrchestrationThreadShell,
  /** All live threads, so a side chat can name the conversation it hangs off. */
  threadsById?: ReadonlyMap<string, OrchestrationThreadShell>,
  terminals: ReadonlyArray<TerminalSummary> = [],
): WorkspaceThreadSummary {
  const latestTurnState = shell.latestTurn?.state;
  const isWorking = latestTurnState !== undefined && WORKING_TURN_STATES.has(latestTurnState);

  // Approvals and input requests are raised by a turn that is still in flight,
  // so they are real while the thread works. A proposed plan is not: having a
  // plan in history is not a wait. Only a settled Plan-mode turn whose own
  // plan is still unimplemented is waiting for approval — same gate as the
  // sidebar's "Plan Ready" row. Mirrors resolveWaitingOn on the client.
  const latestTurn = shell.latestTurn;
  const stoppedForProposedPlan =
    !isWorking &&
    shell.interactionMode === "plan" &&
    shell.hasActionableProposedPlan &&
    Boolean(latestTurn?.startedAt) &&
    Boolean(latestTurn?.completedAt) &&
    shell.session?.status !== "running";
  const waitingOn = shell.hasPendingApprovals
    ? ("approval" as const)
    : shell.hasPendingUserInput
      ? ("user-input" as const)
      : stoppedForProposedPlan
        ? ("proposed-plan" as const)
        : ("nothing" as const);

  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    status: shell.session?.status ?? "idle",
    waitingOn,
    isWorking,
    isSideChat: shell.isSideChat === true,
    ...sideChatParentTitle(shell, threadsById),
    // `settledOverride` wins over the derived timestamp, matching the client's
    // effectiveSettled(): a user who explicitly reactivated a thread has not
    // settled it, however old settledAt is.
    settled:
      shell.settledOverride === "settled" ||
      (shell.settledOverride !== "active" && shell.settledAt !== null),
    ...(shell.updatedAt === undefined ? {} : { lastActivityAt: shell.updatedAt }),
    ...(latestTurnState === undefined ? {} : { latestTurnState }),
    terminals: compactTerminals(terminals),
  };
}

export const handleWorkspaceOrchestration = Effect.fn("WorkspaceOrchestration.handle")(function* (
  input: WorkspaceOrchestrationInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;

  // Gated on identity, not on a capability flag: this toolkit grants
  // whole-workspace write access, so it must not be grantable to an ordinary
  // thread by widening a capability set somewhere else.
  if (!isOrchestratorThreadId(invocation.threadId)) {
    return yield* new WorkspaceOrchestrationScopeError({ threadId: invocation.threadId });
  }

  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const terminalManager = yield* TerminalManager;

  const readThreads = Effect.fn("WorkspaceOrchestration.readThreads")(function* () {
    const snapshot = yield* projection
      .getShellSnapshot()
      .pipe(
        Effect.mapError(
          () => new WorkspaceOrchestrationOperationFailedError({ operation: "reading threads" }),
        ),
      );
    return snapshot.threads;
  });

  const requireThread = Effect.fn("WorkspaceOrchestration.requireThread")(function* (
    threadId: ThreadId,
  ) {
    const threads = yield* readThreads();
    const found = threads.find((thread) => thread.id === threadId);
    if (!found) {
      return yield* new WorkspaceOrchestrationThreadNotFoundError({ threadId });
    }
    return found;
  });

  // The input schema is a flat struct (MCP requires a top-level object
  // schema), so per-action required fields are enforced here.
  const requireThreadId = Effect.fn("WorkspaceOrchestration.requireThreadId")(function* () {
    if (input.threadId === undefined) {
      return yield* new WorkspaceOrchestrationInvalidInputError({
        action: input.action,
        missing: "threadId",
      });
    }
    return input.threadId;
  });

  const requireTerminalId = Effect.fn("WorkspaceOrchestration.requireTerminalId")(function* () {
    const terminalId = input.terminalId?.trim() ?? "";
    if (terminalId.length === 0) {
      return yield* new WorkspaceOrchestrationInvalidInputError({
        action: input.action,
        missing: "terminalId",
      });
    }
    return terminalId;
  });

  const listKnownTerminals = Effect.fn("WorkspaceOrchestration.listKnownTerminals")(function* (
    threadId?: ThreadId,
  ) {
    // An inventory failure must not take down list_threads. An empty list is
    // the honest answer when the terminal manager cannot be reached.
    return yield* terminalManager
      .list(threadId === undefined ? {} : { threadId })
      .pipe(Effect.catch(() => Effect.succeed([] as ReadonlyArray<TerminalSummary>)));
  });

  const describeTerminal = (
    terminal: TerminalSummary,
    threadsById: ReadonlyMap<string, OrchestrationThreadShell>,
  ): WorkspaceTerminalDetail => ({
    threadId: ThreadId.make(terminal.threadId),
    threadTitle: threadsById.get(terminal.threadId)?.title ?? terminal.threadId,
    terminalId: terminal.terminalId,
    label: terminal.label,
    status: terminal.status,
    hasRunningSubprocess: terminal.hasRunningSubprocess,
    cwd: terminal.cwd,
  });

  switch (input.action) {
    case "list_threads": {
      const threads = yield* readThreads();
      const terminals = yield* listKnownTerminals();
      const terminalsByThread = new Map<string, TerminalSummary[]>();
      for (const terminal of terminals) {
        const existing = terminalsByThread.get(terminal.threadId) ?? [];
        existing.push(terminal);
        terminalsByThread.set(terminal.threadId, existing);
      }
      const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
      const summaries = threads
        .filter((thread) => thread.archivedAt === null)
        // The orchestrator never needs to act on itself; listing it invites
        // the model to send itself messages and loop.
        .filter((thread) => !isOrchestratorThreadId(thread.id))
        .map((thread) =>
          summarizeThread(thread, threadsById, terminalsByThread.get(thread.id) ?? []),
        )
        .filter((thread) => (input.includeSideChats === true ? true : !thread.isSideChat))
        .filter((thread) => (input.includeSettled === true ? true : !thread.settled));

      return {
        action: "list_threads" as const,
        threads: summaries,
        totalCount: summaries.length,
      };
    }

    case "describe_thread": {
      const threadId = yield* requireThreadId();
      // The whole snapshot rather than just this thread: describing a side chat
      // without naming its parent is the case this is most often called for,
      // and `requireThread` already reads every thread to find one.
      const threads = yield* readThreads();
      const thread = threads.find((candidate) => candidate.id === threadId);
      if (!thread) {
        return yield* new WorkspaceOrchestrationThreadNotFoundError({ threadId });
      }
      const threadsById = new Map(threads.map((candidate) => [candidate.id, candidate] as const));
      const terminals = yield* listKnownTerminals(threadId);
      return {
        action: "describe_thread" as const,
        thread: summarizeThread(thread, threadsById, terminals),
      };
    }

    case "list_terminals": {
      const threads = yield* readThreads();
      const threadsById = new Map(threads.map((thread) => [thread.id, thread] as const));
      const terminals = yield* listKnownTerminals(input.threadId);
      const details = terminals
        .filter((terminal) => !isOrchestratorThreadId(terminal.threadId))
        .map((terminal) => describeTerminal(terminal, threadsById));
      return {
        action: "list_terminals" as const,
        terminals: details,
        totalCount: details.length,
      };
    }

    case "read_terminal": {
      const threadId = yield* requireThreadId();
      const terminalId = yield* requireTerminalId();
      const thread = yield* requireThread(threadId);
      const snapshot = yield* terminalManager.read({ threadId, terminalId }).pipe(
        Effect.mapError((error) =>
          error._tag === "TerminalSessionLookupError"
            ? new WorkspaceOrchestrationTerminalNotFoundError({ threadId, terminalId })
            : new WorkspaceOrchestrationOperationFailedError({
                operation: "reading a terminal",
                threadId,
              }),
        ),
      );
      const listed = yield* listKnownTerminals(threadId);
      const live = listed.find((terminal) => terminal.terminalId === terminalId);
      const presented = visibleTerminalText(snapshot.history);
      return {
        action: "read_terminal" as const,
        terminal: {
          threadId,
          threadTitle: thread.title,
          terminalId: snapshot.terminalId,
          label: snapshot.label,
          status: snapshot.status,
          hasRunningSubprocess: live?.hasRunningSubprocess ?? false,
          cwd: snapshot.cwd,
        },
        output: presented.text,
        truncated: presented.truncated,
      };
    }

    case "write_to_terminal": {
      const threadId = yield* requireThreadId();
      const terminalId = yield* requireTerminalId();
      yield* requireThread(threadId);
      const data = input.data ?? "";
      const submit = input.submit !== false;
      const payload = encodeTerminalWrite(data, submit);
      if (payload.length === 0) {
        return yield* new WorkspaceOrchestrationInvalidInputError({
          action: input.action,
          missing: "data",
        });
      }
      const snapshot = yield* terminalManager.read({ threadId, terminalId }).pipe(
        Effect.mapError((error) =>
          error._tag === "TerminalSessionLookupError"
            ? new WorkspaceOrchestrationTerminalNotFoundError({ threadId, terminalId })
            : new WorkspaceOrchestrationOperationFailedError({
                operation: "reading a terminal",
                threadId,
              }),
        ),
      );
      if (snapshot.status !== "running") {
        return yield* new WorkspaceOrchestrationOperationFailedError({
          operation: "writing to a terminal that is not running",
          threadId,
        });
      }
      yield* terminalManager.write({ threadId, terminalId, data: payload }).pipe(
        Effect.mapError(
          () =>
            new WorkspaceOrchestrationOperationFailedError({
              operation: "writing to a terminal",
              threadId,
            }),
        ),
      );
      return {
        action: "write_to_terminal" as const,
        threadId,
        terminalId,
        written: true,
        submitted: submit,
      };
    }

    case "send_to_thread": {
      const threadId = yield* requireThreadId();
      const message = input.message;
      if (message === undefined) {
        return yield* new WorkspaceOrchestrationInvalidInputError({
          action: input.action,
          missing: "message",
        });
      }
      if (isOrchestratorThreadId(threadId)) {
        // Writing into itself would start a turn that can call this tool again.
        return yield* new WorkspaceOrchestrationThreadNotFoundError({ threadId });
      }
      const thread = yield* requireThread(threadId);
      const now = DateTime.formatIso(yield* DateTime.now);
      const randomId = crypto.randomUUIDv4.pipe(
        Effect.mapError(
          () =>
            new WorkspaceOrchestrationOperationFailedError({
              operation: "generating command identifiers",
            }),
        ),
      );

      yield* engine
        .dispatch({
          type: "thread.turn.start",
          commandId: CommandId.make(yield* randomId),
          threadId: thread.id,
          message: {
            messageId: MessageId.make(yield* randomId),
            role: "user",
            text: message,
            attachments: [],
          },
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: now,
        })
        .pipe(
          Effect.mapError(
            () =>
              new WorkspaceOrchestrationOperationFailedError({
                operation: "sending a message",
                threadId: thread.id,
              }),
          ),
        );

      return { action: "send_to_thread" as const, threadId: thread.id, delivered: true };
    }

    case "interrupt_thread": {
      const thread = yield* requireThread(yield* requireThreadId());
      const randomId = crypto.randomUUIDv4.pipe(
        Effect.mapError(
          () =>
            new WorkspaceOrchestrationOperationFailedError({
              operation: "generating command identifiers",
            }),
        ),
      );
      const interruptedAt = DateTime.formatIso(yield* DateTime.now);

      yield* engine
        .dispatch({
          type: "thread.turn.interrupt",
          commandId: CommandId.make(yield* randomId),
          threadId: thread.id,
          createdAt: interruptedAt,
        })
        .pipe(
          Effect.mapError(
            () =>
              new WorkspaceOrchestrationOperationFailedError({
                operation: "interrupting a turn",
                threadId: thread.id,
              }),
          ),
        );

      return { action: "interrupt_thread" as const, threadId: thread.id, interrupted: true };
    }
  }
});

const handlers = {
  workspace_orchestration: handleWorkspaceOrchestration,
} satisfies Parameters<typeof WorkspaceOrchestrationToolkit.toLayer>[0];

export const WorkspaceOrchestrationToolkitHandlersLive =
  WorkspaceOrchestrationToolkit.toLayer(handlers);

export const __testing = {
  summarizeThread,
};
