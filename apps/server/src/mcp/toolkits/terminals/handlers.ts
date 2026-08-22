import { ThreadId, type TerminalSessionSnapshot, type TerminalSummary } from "@t3tools/contracts";
import {
  DEFAULT_TERMINAL_LIST_PREVIEW_CHARS,
  DEFAULT_TERMINAL_READ_CHARS,
  encodeTerminalWrite,
  visibleTerminalText,
} from "@t3tools/shared/terminalText";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { TerminalManager } from "../../../terminal/Manager.ts";
import { ThreadTerminalsToolkit } from "./tools.ts";
import {
  ThreadTerminalsCapabilityUnavailableError,
  ThreadTerminalsInvalidInputError,
  ThreadTerminalsNotFoundError,
  ThreadTerminalsOperationFailedError,
  type ThreadTerminalDetail,
  type ThreadTerminalsInput,
} from "./types.ts";

function compareTerminalDetails(left: ThreadTerminalDetail, right: ThreadTerminalDetail): number {
  if (left.hasRunningSubprocess !== right.hasRunningSubprocess) {
    return left.hasRunningSubprocess ? -1 : 1;
  }
  if (left.belongsToThisChat !== right.belongsToThisChat) {
    return left.belongsToThisChat ? -1 : 1;
  }
  const titleOrder = left.threadTitle.localeCompare(right.threadTitle);
  if (titleOrder !== 0) return titleOrder;
  return left.terminalId.localeCompare(right.terminalId);
}

export const handleThreadTerminals = Effect.fn("ThreadTerminals.handle")(function* (
  input: ThreadTerminalsInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("terminals")) {
    return yield* new ThreadTerminalsCapabilityUnavailableError({
      threadId: invocation.threadId,
    });
  }

  const terminalManager = yield* TerminalManager;
  const projection = yield* ProjectionSnapshotQuery;
  const callerThreadId = invocation.threadId;

  const listKnown = Effect.fn("ThreadTerminals.listKnown")(function* (threadId?: ThreadId) {
    return yield* terminalManager
      .list(threadId === undefined ? {} : { threadId })
      .pipe(
        Effect.mapError(
          () => new ThreadTerminalsOperationFailedError({ operation: "listing terminals" }),
        ),
      );
  });

  const threadTitles = yield* projection.getShellSnapshot().pipe(
    Effect.map(
      (snapshot) => new Map(snapshot.threads.map((thread) => [thread.id, thread.title] as const)),
    ),
    Effect.orElseSucceed(() => new Map<string, string>()),
  );

  const describe = Effect.fn("ThreadTerminals.describe")((
    terminal: TerminalSummary,
    snapshot: TerminalSessionSnapshot | undefined,
    previewLimit: number,
  ) => {
    const presented = visibleTerminalText(snapshot?.history ?? "", previewLimit);
    const threadId = ThreadId.make(terminal.threadId);
    return Effect.succeed({
      threadId,
      threadTitle: threadTitles.get(threadId) ?? terminal.threadId,
      belongsToThisChat: terminal.threadId === callerThreadId,
      terminalId: terminal.terminalId,
      label: snapshot?.label ?? terminal.label,
      status: snapshot?.status ?? terminal.status,
      hasRunningSubprocess: terminal.hasRunningSubprocess,
      cwd: snapshot?.cwd ?? terminal.cwd,
      preview: presented.text,
      previewTruncated: presented.truncated,
    } satisfies ThreadTerminalDetail);
  });

  const readSnapshot = Effect.fn("ThreadTerminals.readSnapshot")(function* (
    threadId: ThreadId,
    terminalId: string,
  ) {
    return yield* terminalManager.read({ threadId, terminalId }).pipe(Effect.option);
  });

  const requireTerminalId = Effect.fn("ThreadTerminals.requireTerminalId")(function* (
    threadId: ThreadId,
  ) {
    const explicit = input.terminalId?.trim() ?? "";
    if (explicit.length > 0) {
      return explicit;
    }
    const listed = yield* listKnown(threadId);
    if (listed.length === 1 && listed[0]) {
      return listed[0].terminalId;
    }
    return yield* new ThreadTerminalsInvalidInputError({
      action: input.action,
      missing: "terminalId",
    });
  });

  switch (input.action) {
    case "list_terminals": {
      const terminals = yield* listKnown(input.threadId);
      const details = yield* Effect.forEach(terminals, (terminal) =>
        Effect.gen(function* () {
          const snapshot = yield* readSnapshot(
            ThreadId.make(terminal.threadId),
            terminal.terminalId,
          );
          return yield* describe(
            terminal,
            Option.isSome(snapshot) ? snapshot.value : undefined,
            DEFAULT_TERMINAL_LIST_PREVIEW_CHARS,
          );
        }),
      );
      details.sort(compareTerminalDetails);
      return {
        action: "list_terminals" as const,
        callerThreadId,
        terminals: details,
        totalCount: details.length,
      };
    }

    case "read_terminal": {
      const threadId = input.threadId ?? callerThreadId;
      const terminalId = yield* requireTerminalId(threadId);
      const snapshot = yield* terminalManager.read({ threadId, terminalId }).pipe(
        Effect.mapError((error) =>
          error._tag === "TerminalSessionLookupError"
            ? new ThreadTerminalsNotFoundError({ threadId, terminalId })
            : new ThreadTerminalsOperationFailedError({
                operation: "reading a terminal",
                threadId,
              }),
        ),
      );
      const listed = yield* listKnown(threadId);
      const live = listed.find((terminal) => terminal.terminalId === terminalId);
      const presented = visibleTerminalText(snapshot.history, DEFAULT_TERMINAL_READ_CHARS);
      const terminal = yield* describe(
        live ?? {
          threadId,
          terminalId: snapshot.terminalId,
          cwd: snapshot.cwd,
          worktreePath: snapshot.worktreePath,
          status: snapshot.status,
          pid: snapshot.pid,
          exitCode: snapshot.exitCode,
          exitSignal: snapshot.exitSignal,
          hasRunningSubprocess: false,
          label: snapshot.label,
          updatedAt: snapshot.updatedAt,
        },
        snapshot,
        DEFAULT_TERMINAL_READ_CHARS,
      );
      return {
        action: "read_terminal" as const,
        callerThreadId,
        terminal,
        output: presented.text,
        truncated: presented.truncated,
      };
    }

    case "write_to_terminal": {
      const threadId = input.threadId ?? callerThreadId;
      const terminalId = yield* requireTerminalId(threadId);
      const submit = input.submit !== false;
      const payload = encodeTerminalWrite(input.data ?? "", submit);
      if (payload.length === 0) {
        return yield* new ThreadTerminalsInvalidInputError({
          action: input.action,
          missing: "data",
        });
      }
      const snapshot = yield* terminalManager.read({ threadId, terminalId }).pipe(
        Effect.mapError((error) =>
          error._tag === "TerminalSessionLookupError"
            ? new ThreadTerminalsNotFoundError({ threadId, terminalId })
            : new ThreadTerminalsOperationFailedError({
                operation: "reading a terminal",
                threadId,
              }),
        ),
      );
      if (snapshot.status !== "running") {
        return yield* new ThreadTerminalsOperationFailedError({
          operation: "writing to a terminal that is not running",
          threadId,
        });
      }
      yield* terminalManager.write({ threadId, terminalId, data: payload }).pipe(
        Effect.mapError(
          () =>
            new ThreadTerminalsOperationFailedError({
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
  }
});

const handlers = {
  thread_terminals: handleThreadTerminals,
} satisfies Parameters<typeof ThreadTerminalsToolkit.toLayer>[0];

export const ThreadTerminalsToolkitHandlersLive = ThreadTerminalsToolkit.toLayer(handlers);
