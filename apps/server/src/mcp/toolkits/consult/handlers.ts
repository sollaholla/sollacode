import {
  CommandId,
  isAgentBuilderThreadId,
  isAgentsProjectId,
  isOrchestratorProjectId,
  isOrchestratorThreadId,
  MessageId,
  ORCHESTRATOR_THREAD_TITLE,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../../../persistence/Services/VmAgents.ts";
import { resolveOwningVmAgent } from "../../../vm/owningAgent.ts";
import { resolveRelatedChats } from "../collaboration/relationships.ts";
import { WorkspaceConsultToolkit } from "./tools.ts";
import {
  WorkspaceConsultFailedError,
  WorkspaceConsultInvalidInputError,
  WorkspaceConsultNotFoundError,
  WorkspaceConsultRefusedError,
  WorkspaceConsultUnavailableError,
  type WorkspaceConsultInput,
} from "./types.ts";

/** Ceiling on how long one `ask` may block before handing back a poll instead. */
const MAX_WAIT_MS = 120_000;
const DEFAULT_WAIT_MS = 60_000;
const DEFAULT_MESSAGE_LIMIT = 10;
const MAX_MESSAGE_LIMIT = 50;
/** Newest messages one reply check reads: the reply is always among the latest. */
const REPLY_READ_LIMIT = 20;
/** Replies are for reading, not archiving: keep them well inside a tool result. */
const MAX_MESSAGE_CHARS = 4_000;
/** Chats one request may already have passed through before the next must answer itself. */
const MAX_RELAY_DEPTH = 3;
/** Longest sender chain walked looking for the person who started a request. */
const MAX_CHAIN_HOPS = 4;
/** Chats whose own senders one upstream walk may read. */
const MAX_CHAIN_LOOKUPS = 16;
/** Sliding-window budget of `ask`s per calling chat. */
const MAX_ASKS_PER_WINDOW = 20;
const ASK_WINDOW_MS = 10 * 60_000;
/** Unarchived threads one chat may have opened with `ask` + projectId. */
const MAX_OPEN_CREATED_THREADS = 10;
/** Delegated work runs in these threads; they answer only through agent_collaboration. */
const DELEGATION_WORKER_THREAD_PREFIX = "delegation-worker:";
/** The sender label for a chat with no usable title of its own. */
const ANOTHER_CHAT_LABEL = "Another chat";

/**
 * Recent `ask` times per calling chat, for the sliding-window rate limit. One
 * log lives as long as the handlers layer, shared by every invocation.
 */
export type ConsultAskLog = Map<ThreadId, ReadonlyArray<number>>;

const truncate = (text: string): string =>
  text.length <= MAX_MESSAGE_CHARS ? text : `${text.slice(0, MAX_MESSAGE_CHARS)}…[truncated]`;

const isWorkingThread = (thread: OrchestrationThreadShell): boolean =>
  thread.latestTurn?.state === "running";

/** Projects that are app plumbing rather than places to open a conversation. */
const isInternalProject = (projectId: string): boolean =>
  isAgentsProjectId(projectId) || isOrchestratorProjectId(projectId);

/** A title for a thread opened from a question, when the caller gave none. */
const titleFromQuestion = (question: string): string => {
  const firstLine = question.trim().split("\n")[0] ?? question.trim();
  return firstLine.length <= 80 ? firstLine : `${firstLine.slice(0, 79)}…`;
};

/** Events on the asked thread that can settle its reply; streaming deltas cannot. */
const wakesReplyWait = (event: OrchestrationEvent, threadId: ThreadId): boolean =>
  event.aggregateKind === "thread" &&
  event.aggregateId === threadId &&
  !(event.type === "thread.message-sent" && event.payload.streaming);

export const handleWorkspaceConsult = Effect.fn("WorkspaceConsult.handle")(function* (
  input: WorkspaceConsultInput,
  askLog: ConsultAskLog,
) {
  const invocation = yield* McpInvocationContext.McpInvocationContext;
  if (!invocation.capabilities.has("collaboration")) {
    return yield* new WorkspaceConsultUnavailableError({ threadId: invocation.threadId });
  }

  const store = yield* VmAgentStore;
  const projection = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;

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

  /** The custom agent a thread belongs to: its own chat, or one of that chat's side chats. */
  const owningAgentOf = (threadId: ThreadId) =>
    resolveOwningVmAgent({
      threadId,
      getAgentByThreadId: store.getByThreadId,
      getThreadShellById: projection.getThreadShellById,
    });

  /**
   * Who is calling and which threads are its own. An agent's chat, its side
   * chats and its delegated workers speak as the agent; any other chat speaks
   * as itself. The family is the caller's connected side chats, their parent,
   * and the owning agent's chat: that turn may be the one blocked in this
   * very `ask`, so a question into it would deadlock.
   */
  const resolveCaller = Effect.fn("WorkspaceConsult.resolveCaller")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
  ) {
    const agent = yield* owningAgentOf(invocation.threadId).pipe(
      Effect.mapError(failed("resolving the calling chat")),
    );
    const family = new Set<ThreadId>([invocation.threadId]);
    for (const related of resolveRelatedChats(threads, invocation.threadId)?.related ?? []) {
      family.add(related.id);
    }
    if (Option.isSome(agent) && agent.value.threadId !== null) family.add(agent.value.threadId);
    return { agent: Option.getOrNull(agent), family };
  });

  /** Why the caller may not address `thread`, or null when it may. */
  const refusalFor = (
    thread: OrchestrationThreadShell,
    family: ReadonlySet<ThreadId>,
  ): string | null => {
    if (family.has(thread.id)) {
      return "That conversation is this chat or part of its own side-chat family (its parent chat, its side chats, or its agent's chat). Use thread_collaboration to work with related chats.";
    }
    if (isOrchestratorThreadId(thread.id)) {
      return "The orchestrator does not take questions from other chats.";
    }
    if (isAgentBuilderThreadId(thread.id)) {
      return "Agent Builder chats cannot be messaged from other chats.";
    }
    if (thread.id.startsWith(DELEGATION_WORKER_THREAD_PREFIX)) {
      return "Delegated worker chats answer only the agent that delegated to them.";
    }
    return null;
  };

  /** Threads the caller may list and ask: none of its family, internal chats, or archives. */
  const addressableThreads = (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    family: ReadonlySet<ThreadId>,
  ) =>
    threads.filter((thread) => thread.archivedAt === null && refusalFor(thread, family) === null);

  /** The named thread, or a refusal that says why it is off limits. */
  const requireTarget = Effect.fn("WorkspaceConsult.requireTarget")(function* (
    threads: ReadonlyArray<OrchestrationThreadShell>,
    threadId: ThreadId,
    family: ReadonlySet<ThreadId>,
    options: { readonly allowArchived: boolean },
  ) {
    const target = threads.find((thread) => thread.id === threadId);
    if (!target || (!options.allowArchived && target.archivedAt !== null)) {
      return yield* new WorkspaceConsultNotFoundError({ kind: "conversation", id: threadId });
    }
    const refusal = refusalFor(target, family);
    if (refusal !== null) return yield* new WorkspaceConsultRefusedError({ reason: refusal });
    return target;
  });

  /**
   * The chats upstream of the caller in the work it is doing now: every chat
   * whose message started or joined that work (steered into a running turn
   * included), the chats upstream of each of those, and so on. The person ends
   * a chain: a message with no sender, or one the orchestrator sent on their
   * behalf. `chats` holds them all and `depth` is the longest chain;
   * `delegated` says whether delegated work reached the caller's own work.
   */
  const readUpstream = Effect.fn("WorkspaceConsult.readUpstream")(function* () {
    const getTurnTrigger = projection.getTurnTrigger;
    if (getTurnTrigger === undefined) {
      return yield* new WorkspaceConsultFailedError({
        operation: "checking who started this request",
        detail: "turn provenance is unavailable",
      });
    }
    const readSenders = (threadId: ThreadId) =>
      getTurnTrigger(threadId).pipe(
        Effect.mapError(failed("checking who started this request")),
        Effect.map(
          Option.match({
            onNone: () => ({ senders: [] as ReadonlyArray<ThreadId>, delegated: false }),
            onSome: (trigger) => ({
              senders:
                trigger.senderThreadIds ??
                (trigger.senderThreadId === null ? [] : [trigger.senderThreadId]),
              delegated: trigger.delegationId !== null,
            }),
          }),
        ),
      );
    const own = yield* readSenders(invocation.threadId);
    const upstream = new Set<ThreadId>();
    let depth = 0;
    let lookups = 0;
    let frontier = own.senders;
    while (depth < MAX_CHAIN_HOPS) {
      const next = new Set(
        frontier.filter(
          (id) => !isOrchestratorThreadId(id) && id !== invocation.threadId && !upstream.has(id),
        ),
      );
      if (next.size === 0) break;
      depth += 1;
      for (const id of next) upstream.add(id);
      const nextFrontier: Array<ThreadId> = [];
      for (const id of next) {
        if (depth >= MAX_CHAIN_HOPS || lookups >= MAX_CHAIN_LOOKUPS) break;
        lookups += 1;
        nextFrontier.push(...(yield* readSenders(id)).senders);
      }
      frontier = nextFrontier;
    }
    return { chats: upstream, depth, delegated: own.delegated };
  });

  switch (input.action) {
    case "list_projects": {
      const shell = yield* readShell();
      const threadCounts = new Map<string, number>();
      for (const thread of shell.threads) {
        if (thread.archivedAt !== null) continue;
        threadCounts.set(thread.projectId, (threadCounts.get(thread.projectId) ?? 0) + 1);
      }
      const projects = shell.projects
        // Agents reach each other by thread, not by opening threads inside the
        // agents project; the orchestrator's project is its own.
        .filter((project) => !isInternalProject(project.id))
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
      const { family } = yield* resolveCaller(shell.threads);
      const agentThreadIds = new Set(
        (yield* store.list().pipe(Effect.mapError(failed("listing agents")))).flatMap((agent) =>
          agent.threadId === null ? [] : [agent.threadId],
        ),
      );
      const projectsById = new Map(shell.projects.map((project) => [project.id, project] as const));
      const threads = addressableThreads(shell.threads, family)
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
            isAgent: agentThreadIds.has(thread.id),
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
      const shell = yield* readShell();
      const { family } = yield* resolveCaller(shell.threads);
      // An archived conversation stays readable: the caller may be collecting
      // a reply from a thread it opened and someone has since archived.
      const target = yield* requireTarget(shell.threads, input.threadId, family, {
        allowArchived: true,
      });
      const detail = yield* projection
        // Twice the limit leaves room for the empty tool-only rows dropped below.
        .getThreadDetailById(target.id, { messageLimit: limit * 2, activityLimit: 0 })
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
      const caller = yield* resolveCaller(shell.threads);
      const callerThread = shell.threads.find((thread) => thread.id === invocation.threadId);
      // The sender label the asked chat shows. Only the orchestrator thread
      // itself is ever labelled as the orchestrator, whatever another chat or
      // agent happens to be named.
      const ownLabel =
        caller.agent?.name.trim() || callerThread?.title.trim() || ANOTHER_CHAT_LABEL;
      const senderThreadTitle = isOrchestratorThreadId(invocation.threadId)
        ? ORCHESTRATOR_THREAD_TITLE
        : ownLabel.toLowerCase() === ORCHESTRATOR_THREAD_TITLE.toLowerCase()
          ? ANOTHER_CHAT_LABEL
          : ownLabel;
      const upstream = yield* readUpstream();

      // Either continue an existing conversation, or open a fresh thread in a
      // project so the exchange stays self-contained.
      let destination:
        | { readonly kind: "thread"; readonly thread: OrchestrationThreadShell }
        | { readonly kind: "project"; readonly project: OrchestrationProjectShell };
      if (input.threadId !== undefined) {
        const target = yield* requireTarget(shell.threads, input.threadId, caller.family, {
          allowArchived: false,
        });
        // A stopped agent stays idle until the person starts it; a question
        // must not wake it, or one of its side chats, behind their back.
        const targetAgent = yield* owningAgentOf(target.id).pipe(
          Effect.mapError(failed("checking the asked agent")),
        );
        if (
          Option.isSome(targetAgent) &&
          (targetAgent.value.status === "stopped" || targetAgent.value.status === "stopping")
        ) {
          return yield* new WorkspaceConsultRefusedError({
            reason: `${targetAgent.value.name} is stopped, so it cannot answer. The person can start it again from its chat.`,
          });
        }
        destination = { kind: "thread", thread: target };
      } else {
        if (input.projectId === undefined) {
          return yield* new WorkspaceConsultInvalidInputError({
            action: input.action,
            missing: "projectId or threadId",
          });
        }
        const projectId = input.projectId;
        const project = shell.projects.find(
          (candidate) => candidate.id === projectId && !isInternalProject(candidate.id),
        );
        if (!project) {
          return yield* new WorkspaceConsultNotFoundError({ kind: "project", id: projectId });
        }
        // Delegated work stays one generation deep: a worker, or work a
        // delegation reached, may ask existing threads, but opening new ones
        // would let it fan out unbounded work. A named agent's own chat is not
        // delegated work merely because a delegation to it is still queued.
        if (upstream.delegated || invocation.threadId.startsWith(DELEGATION_WORKER_THREAD_PREFIX)) {
          return yield* new WorkspaceConsultRefusedError({
            reason:
              "Delegated work cannot open new conversations. Ask an existing thread with threadId instead.",
          });
        }
        // Only threads `ask` itself opens count: side chats and delegated
        // workers also record their creator, but they are not conversations
        // opened in a project.
        const openCreated = shell.threads.filter(
          (thread) =>
            thread.createdByThreadId === invocation.threadId &&
            thread.archivedAt === null &&
            thread.isSideChat !== true &&
            !isInternalProject(thread.projectId),
        ).length;
        if (openCreated >= MAX_OPEN_CREATED_THREADS) {
          return yield* new WorkspaceConsultRefusedError({
            reason: `This chat already has ${openCreated} open conversations it opened with ask. Continue one of them with threadId, or ask the person to archive some.`,
          });
        }
        destination = { kind: "project", project };
      }

      // Loop guard: a request travels at most MAX_RELAY_DEPTH chats, and never
      // back into a chat that is waiting on it (A asking B while answering B).
      if (destination.kind === "thread" && upstream.chats.has(destination.thread.id)) {
        return yield* new WorkspaceConsultRefusedError({
          reason: `"${destination.thread.title}" is waiting on this chat's answer, so asking it back would loop. Reply in this chat instead.`,
        });
      }
      if (upstream.depth >= MAX_RELAY_DEPTH) {
        return yield* new WorkspaceConsultRefusedError({
          reason: `This request is already ${upstream.depth} chats deep. Answer with what you have instead of asking another chat.`,
        });
      }

      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const recentAsks = (askLog.get(invocation.threadId) ?? []).filter(
        (at) => nowMs - at < ASK_WINDOW_MS,
      );
      if (recentAsks.length >= MAX_ASKS_PER_WINDOW) {
        return yield* new WorkspaceConsultRefusedError({
          reason: `This chat has asked other chats ${recentAsks.length} times in the last 10 minutes. Wait a few minutes before asking again; poll read_thread for replies already on their way.`,
        });
      }
      for (const [threadId, times] of askLog) {
        if (times.every((at) => nowMs - at >= ASK_WINDOW_MS)) askLog.delete(threadId);
      }
      askLog.set(invocation.threadId, [...recentAsks, nowMs]);

      const askedAt = DateTime.formatIso(now);
      let targetId: ThreadId;
      // The turn already on the thread before we ask. Its reply answered an
      // earlier message, unless it was running and our question joined it.
      let priorTurnId: TurnId | null = null;
      let priorTurnWasRunning = false;
      if (destination.kind === "thread") {
        const target = destination.thread;
        targetId = target.id;
        priorTurnId = target.latestTurn?.turnId ?? null;
        priorTurnWasRunning = target.latestTurn?.state === "running";
        yield* engine
          .dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(yield* randomId),
            threadId: targetId,
            message: {
              messageId: MessageId.make(yield* randomId),
              role: "user",
              senderThreadId: invocation.threadId,
              senderThreadTitle,
              text: question,
              attachments: [],
            },
            runtimeMode: target.runtimeMode,
            interactionMode: target.interactionMode,
            createdAt: askedAt,
          })
          .pipe(Effect.mapError(failed("asking the conversation")));
      } else {
        const project = destination.project;
        // Inherit the project's own default model rather than the caller's:
        // the thread belongs to that project and should behave like its others.
        const modelSelection =
          project.defaultModelSelection ?? shell.threads[0]?.modelSelection ?? null;
        if (modelSelection === null) {
          return yield* new WorkspaceConsultFailedError({
            operation: "choosing a model for the new conversation",
            detail: "the project has no default model",
          });
        }
        targetId = ThreadId.make(yield* randomId);
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
            // step (or `ask` would always time out), but a thread another chat
            // opened in someone's real project should not silently receive the
            // highest privilege tier.
            runtimeMode: "auto",
            branch: null,
            worktreePath: null,
            createdAt: askedAt,
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
              senderThreadId: invocation.threadId,
              senderThreadTitle,
              text: question,
              attachments: [],
            },
            modelSelection,
            titleSeed: input.title ?? titleFromQuestion(question),
            runtimeMode: "auto",
            interactionMode: "default",
            createdAt: askedAt,
          })
          .pipe(Effect.mapError(failed("asking the question")));
      }

      /**
       * One look at the asked thread: `some(text)` once its reply has settled,
       * `some(null)` when it settled with nothing to say, `none` while it is
       * still working. A reply counts once the turn carrying it settles and it
       * was written after the question, so a question steered into a running
       * turn is answered by that turn.
       */
      const checkReply = Effect.gen(function* () {
        const current = yield* projection
          .getThreadShellById(targetId)
          .pipe(Effect.mapError(failed("waiting for the reply")));
        if (Option.isNone(current)) return Option.some(null);
        const latest = current.value.latestTurn;
        if (latest === null || latest.state === "running") return Option.none();
        // The prior turn carries the answer only when it was running when we
        // asked and finished normally; an interrupted one handed our question
        // to a turn of its own.
        const priorTurn = latest.turnId === priorTurnId;
        if (priorTurn && (!priorTurnWasRunning || latest.state !== "completed")) {
          return Option.none();
        }
        const detail = yield* projection
          .getThreadDetailById(targetId, { messageLimit: REPLY_READ_LIMIT, activityLimit: 0 })
          .pipe(Effect.mapError(failed("reading the reply")));
        if (Option.isNone(detail)) return Option.none();
        const replies = detail.value.messages.filter(
          (message) =>
            message.role === "assistant" &&
            !message.streaming &&
            message.text.trim().length > 0 &&
            message.createdAt >= askedAt,
        );
        const reply =
          replies.findLast((message) => message.turnId === latest.turnId) ?? replies.at(-1);
        if (reply) return Option.some(truncate(reply.text));
        // Settled with nothing to say (interrupted, errored): stop waiting.
        if (!priorTurn && (latest.state === "error" || latest.state === "interrupted")) {
          return Option.some(null);
        }
        return Option.none();
      });

      // Wait for the reply, but never indefinitely: the caller gets the thread
      // id either way and can poll `read_thread`. Each event on the thread
      // wakes one re-check; nothing polls on a timer.
      const waitMs = Math.min(
        MAX_WAIT_MS,
        Math.max(0, Math.trunc(input.waitMs ?? DEFAULT_WAIT_MS)),
      );
      const awaitReply = Effect.gen(function* () {
        const wake = yield* Queue.sliding<void>(1);
        // Subscribe before the first check so a reply landing in between still wakes us.
        yield* engine.streamDomainEvents.pipe(
          Stream.filter((event) => wakesReplyWait(event, targetId)),
          Stream.runForEach(() => Queue.offer(wake, undefined)),
          Effect.forkScoped({ startImmediately: true }),
        );
        const first = yield* checkReply;
        if (Option.isSome(first)) return first.value;
        return yield* Effect.gen(function* () {
          while (true) {
            yield* Queue.take(wake);
            const next = yield* checkReply;
            if (Option.isSome(next)) return next.value;
          }
        }).pipe(Effect.timeoutOption(Duration.millis(waitMs)), Effect.map(Option.getOrNull));
      }).pipe(Effect.scoped);
      const answer = waitMs === 0 ? Option.getOrNull(yield* checkReply) : yield* awaitReply;

      const where = destination.kind === "project" ? "a new conversation" : "that conversation";
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

export const WorkspaceConsultToolkitHandlersLive = WorkspaceConsultToolkit.toLayer(
  Effect.sync(() => {
    const askLog: ConsultAskLog = new Map();
    return {
      workspace_consult: (input: WorkspaceConsultInput) => handleWorkspaceConsult(input, askLog),
    } satisfies Parameters<typeof WorkspaceConsultToolkit.toLayer>[0];
  }),
);
