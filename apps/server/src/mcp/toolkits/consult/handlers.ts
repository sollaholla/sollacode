import {
  CommandId,
  isAgentsProjectId,
  isOrchestratorThreadId,
  MessageId,
  type OrchestrationThreadShell,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { WorkspaceConsultToolkit } from "./tools.ts";
import {
  WorkspaceConsultFailedError,
  WorkspaceConsultInvalidInputError,
  WorkspaceConsultNotAnAgentError,
  WorkspaceConsultNotFoundError,
  WorkspaceConsultUnavailableError,
  type WorkspaceConsultInput,
} from "./types.ts";

/** Ceiling on how long one `ask` may block before handing back a poll instead. */
const MAX_WAIT_MS = 120_000;
const DEFAULT_WAIT_MS = 60_000;
const POLL_INTERVAL_MS = 1_000;
const DEFAULT_MESSAGE_LIMIT = 10;
const MAX_MESSAGE_LIMIT = 50;
/** Replies are for reading, not archiving: keep them well inside a tool result. */
const MAX_MESSAGE_CHARS = 4_000;

const truncate = (text: string): string =>
  text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`;

const isWorkingThread = (thread: OrchestrationThreadShell): boolean =>
  thread.latestTurn?.state === "running";

/** A title for a thread opened from a question, when the caller gave none. */
const titleFromQuestion = (question: string): string => {
  const firstLine = question.trim().split("\n")[0] ?? question.trim();
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79)}…`;
};

export const handleWorkspaceConsult = Effect.fn("WorkspaceConsult.handle")(function* (
  input: WorkspaceConsultInput,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("vm")) {
    return yield* new WorkspaceConsultUnavailableError({ threadId: invocation.threadId });
  }

  const store = yield* VmAgentStore;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

  // Only VM agents get this door, mirroring how the orchestrator's toolkit is
  // gated on its reserved thread id.
  const callerAgent = yield* store.getByThreadId(invocation.threadId).pipe(
    Effect.mapError(
      () =>
        new WorkspaceConsultFailedError({
          operation: "resolving the calling agent",
          detail: "store error",
        }),
    ),
  );
  if (Option.isNone(callerAgent)) {
    return yield* new WorkspaceConsultNotAnAgentError({ threadId: invocation.threadId });
  }

  const failed = (operation: string) => (cause: unknown) =>
    new WorkspaceConsultFailedError({
      operation,
      detail: cause instanceof Error && cause.message ? cause.message : "unexpected failure",
    });

  const randomId = crypto.randomUUIDv4.pipe(
    Effect.mapError(() =>
      failed("generating command identifiers")(new Error("id generation failed")),
    ),
  );

  const readShell = () =>
    projection.getShellSnapshot().pipe(Effect.mapError(failed("reading the workspace")));

  /**
   * Threads this agent may address. Its own thread is excluded (writing to it
   * would start a turn that can call this tool again) and so is the
   * orchestrator, which owns the workspace rather than answering questions.
   */
  const addressableThreads = (threads: ReadonlyArray<OrchestrationThreadShell>) =>
    threads.filter(
      (thread) =>
        thread.id !== invocation.threadId &&
        !isOrchestratorThreadId(thread.id) &&
        thread.archivedAt === null,
    );

  switch (input.action) {
    case "list_projects": {
      const shell = yield* readShell();
      const threadCounts = new Map<string, number>();
      for (const thread of shell.threads) {
        if (thread.archivedAt !== null) continue;
        threadCounts.set(thread.projectId, (threadCounts.get(thread.projectId) ?? 0) + 1);
      }
      const projects = shell.projects
        // The agents project is internal plumbing: agents reach each other by
        // thread, not by opening threads inside it.
        .filter((project) => !isAgentsProjectId(project.id))
        .map((project) => ({
          projectId: project.id,
          title: project.title,
          workspaceRoot: project.workspaceRoot,
          threadCount: threadCounts.get(project.id) ?? 0,
        }));
      return {
        action: "list_projects" as const,
        status: `Found ${projects.length} project(s).`,
        projects,
      };
    }

    case "list_threads": {
      const shell = yield* readShell();
      const projectsById = new Map(shell.projects.map((project) => [project.id, project] as const));
      const threads = addressableThreads(shell.threads)
        .filter((thread) =>
          input.projectId === undefined ? true : thread.projectId === input.projectId,
        )
        .map((thread) => {
          const project = projectsById.get(thread.projectId);
          return {
            threadId: thread.id,
            title: thread.title,
            projectId: thread.projectId,
            ...(project ? { projectTitle: project.title } : {}),
            ...(thread.latestTurn ? { state: thread.latestTurn.state } : {}),
            isWorking: isWorkingThread(thread),
            isAgent: isAgentsProjectId(thread.projectId),
            ...(thread.latestUserMessageAt ? { lastActivityAt: thread.updatedAt } : {}),
          };
        });
      return {
        action: "list_threads" as const,
        status: `Found ${threads.length} conversation(s).`,
        threads,
      };
    }

    case "read_thread": {
      if (input.threadId === undefined) {
        return yield* new WorkspaceConsultInvalidInputError({
          action: input.action,
          missing: "threadId",
        });
      }
      const limit = Math.min(
        MAX_MESSAGE_LIMIT,
        Math.max(1, Math.trunc(input.limit ?? DEFAULT_MESSAGE_LIMIT)),
      );
      const detail = yield* projection
        .getThreadDetailById(input.threadId)
        .pipe(Effect.mapError(failed("reading the conversation")));
      if (Option.isNone(detail)) {
        return yield* new WorkspaceConsultNotFoundError({
          kind: "conversation",
          id: input.threadId,
        });
      }
      const messages = detail.value.messages
        .filter((message) => message.text.trim().length > 0)
        .slice(-limit)
        .map((message) => ({
          role: message.role,
          text: truncate(message.text),
          createdAt: message.createdAt,
        }));
      return {
        action: "read_thread" as const,
        status: `Read the last ${messages.length} message(s).`,
        threadId: input.threadId,
        messages,
      };
    }

    case "ask": {
      const question = input.question;
      if (question === undefined || question.trim().length === 0) {
        return yield* new WorkspaceConsultInvalidInputError({
          action: input.action,
          missing: "question",
        });
      }
      const shell = yield* readShell();
      const now = DateTime.formatIso(yield* DateTime.now);

      // Either continue an existing conversation, or open a fresh thread in a
      // project so the exchange stays self-contained.
      let targetId: ThreadId;
      let opened = false;
      // The turn already on the thread before we ask. Any answer we accept must
      // come from a *later* turn, or a thread with prior history would hand back
      // its previous reply as though it answered this question.
      let priorTurnId: string | null = null;
      if (input.threadId !== undefined) {
        const target = addressableThreads(shell.threads).find(
          (thread) => thread.id === input.threadId,
        );
        if (!target) {
          return yield* new WorkspaceConsultNotFoundError({
            kind: "conversation",
            id: input.threadId,
          });
        }
        targetId = target.id;
        priorTurnId = target.latestTurn?.turnId ?? null;
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(yield* randomId),
            threadId: targetId,
            message: {
              messageId: MessageId.make(yield* randomId),
              role: "user",
              text: question,
              attachments: [],
            },
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt: now,
          })
          .pipe(Effect.mapError(failed("asking the conversation")));
      } else {
        if (input.projectId === undefined) {
          return yield* new WorkspaceConsultInvalidInputError({
            action: input.action,
            missing: "projectId or threadId",
          });
        }
        const project = shell.projects.find(
          (candidate) => candidate.id === (input.projectId as ProjectId),
        );
        if (!project) {
          return yield* new WorkspaceConsultNotFoundError({
            kind: "project",
            id: input.projectId,
          });
        }
        // Inherit the project's own default model rather than the agent's: the
        // thread belongs to that project and should behave like its others.
        const modelSelection =
          project.defaultModelSelection ?? shell.threads[0]?.modelSelection ?? null;
        if (modelSelection === null) {
          return yield* new WorkspaceConsultFailedError({
            operation: "choosing a model for the new conversation",
            detail: "the project has no default model",
          });
        }
        targetId = ThreadId.make(yield* randomId);
        opened = true;
        const callerThread = shell.threads.find((thread) => thread.id === invocation.threadId);
        yield* engine
          .dispatch({
            type: "thread.create",
            commandId: CommandId.make(yield* randomId),
            threadId: targetId,
            projectId: project.id,
            title: input.title ?? titleFromQuestion(question),
            createdByThreadId: invocation.threadId,
            browserProfileThreadId: callerThread?.browserProfileThreadId ?? invocation.threadId,
            modelSelection,
            interactionMode: "default",
            // `auto` rather than the app default `full-access`: a consulted
            // thread must be able to investigate without a human approving each
            // step (or `ask` would always time out), but a thread an agent
            // opened in someone's real project should not silently receive the
            // highest privilege tier.
            runtimeMode: "auto",
            branch: null,
            worktreePath: null,
            createdAt: now,
          })
          .pipe(Effect.mapError(failed("opening a conversation")));
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(yield* randomId),
            threadId: targetId,
            message: {
              messageId: MessageId.make(yield* randomId),
              role: "user",
              text: question,
              attachments: [],
            },
            modelSelection,
            titleSeed: input.title ?? titleFromQuestion(question),
            runtimeMode: "auto",
            interactionMode: "default",
            createdAt: now,
          })
          .pipe(Effect.mapError(failed("asking the question")));
      }

      // Wait for the reply, but never indefinitely — the caller gets the thread
      // id either way and can poll `read_thread`.
      const waitMs = Math.min(
        MAX_WAIT_MS,
        Math.max(0, Math.trunc(input.waitMs ?? DEFAULT_WAIT_MS)),
      );
      const deadlinePolls = Math.ceil(waitMs / POLL_INTERVAL_MS);
      let answer: string | null = null;
      // Check first, sleep between: an answer that is already settled comes back
      // without paying a poll interval.
      for (let poll = 0; poll <= deadlinePolls; poll++) {
        if (poll > 0) yield* Effect.sleep(Duration.millis(POLL_INTERVAL_MS));
        const current = yield* projection
          .getThreadShellById(targetId)
          .pipe(Effect.mapError(failed("waiting for the reply")));
        if (Option.isNone(current)) continue;
        const latest = current.value.latestTurn;
        // Only a settled turn from *this* exchange carries our answer: a running
        // turn is still writing, and the prior turn answered a different question.
        if (latest === null || latest.state === "running" || latest.turnId === priorTurnId) {
          continue;
        }
        const detail = yield* projection
          .getThreadDetailById(targetId)
          .pipe(Effect.mapError(failed("reading the reply")));
        if (Option.isNone(detail)) continue;
        const replies = detail.value.messages.filter(
          (message) =>
            message.role === "assistant" && !message.streaming && message.text.trim().length > 0,
        );
        const reply = replies.find((message) => message.turnId === latest.turnId) ?? replies.at(-1);
        if (reply) {
          answer = truncate(reply.text);
          break;
        }
        // Settled with nothing to say (interrupted, errored): stop waiting.
        if (latest.state === "error" || latest.state === "interrupted") break;
      }

      const where = opened ? "a new conversation" : "that conversation";
      return {
        action: "ask" as const,
        status:
          answer !== null
            ? `Asked ${where} and received a reply.`
            : `Asked ${where}; it is still working. Poll read_thread with this threadId for the reply.`,
        threadId: targetId,
        answered: answer !== null,
        ...(answer !== null ? { answer } : {}),
      };
    }
  }
});

const handlers = {
  workspace_consult: handleWorkspaceConsult,
} satisfies Parameters<typeof WorkspaceConsultToolkit.toLayer>[0];

export const WorkspaceConsultToolkitHandlersLive = WorkspaceConsultToolkit.toLayer(handlers);
