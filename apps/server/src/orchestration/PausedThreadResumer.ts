// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationResumePausedThreadsInput,
  type OrchestrationThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { RESUME_PROMPT } from "@t3tools/shared/resumePrompt";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * How long a resumed chat has to be refused before it counts as working. A
 * refusal comes back in seconds; a slow first reply must not stop the run.
 */
const OUTCOME_TIMEOUT = "45 seconds";
const TURN_START_FAILED_KIND = "provider.turn.start.failed";

/** What one resume proved about the account: it has room, or it refused again. */
export type ResumeOutcome = "working" | "refused";

/** A thread still paused: stopped by a provider, nothing running, no work queued. */
export const isPausedShell = (
  shell: Pick<OrchestrationThreadShell, "session" | "pendingWork" | "archivedAt">,
) =>
  shell.archivedAt === null &&
  shell.pendingWork == null &&
  shell.session?.status === "error" &&
  shell.session.activeTurnId === null &&
  Boolean(shell.session.lastError?.trim());

/** What an event says about a chat just resumed; null when it says nothing yet. */
export function resumeOutcomeOf(event: OrchestrationEvent): ResumeOutcome | null {
  if (event.type === "thread.message-sent")
    return event.payload.role === "assistant" ? "working" : null;
  if (event.type === "thread.activity-appended")
    return event.payload.activity.tone === "tool" ? "working" : null;
  if (event.type === "thread.session-set")
    return event.payload.session.status === "error" ? "refused" : null;
  return null;
}

/**
 * The newest user message when the provider never got it. A resume only tells
 * the provider to carry on with what it has, so that message must go itself.
 */
export function undeliveredMessageId(thread: {
  readonly messages: ReadonlyArray<{
    readonly id: MessageId;
    readonly role: string;
    readonly createdAt: string;
  }>;
  readonly activities: ReadonlyArray<{
    readonly kind: string;
    readonly createdAt: string;
    readonly payload: unknown;
  }>;
}): MessageId | null {
  const newest = thread.messages.findLast((message) => message.role === "user");
  if (newest === undefined) return null;
  if (thread.messages.some((m) => m.role === "assistant" && m.createdAt > newest.createdAt))
    return null;
  const failure = thread.activities.findLast((activity) => {
    if (activity.kind !== TURN_START_FAILED_KIND || activity.createdAt < newest.createdAt)
      return false;
    const payload = activity.payload as { readonly messageId?: unknown } | null;
    return payload?.messageId === newest.id;
  });
  const cancelled = (failure?.payload as { readonly deliveryCancelled?: unknown } | undefined)
    ?.deliveryCancelled;
  return cancelled === true ? newest.id : null;
}

export const makePausedThreadResumer = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const projection = yield* ProjectionSnapshotQuery;
  const scope = yield* Effect.scope;
  let run: Fiber.Fiber<void> | null = null;

  const commandId = () => CommandId.make(`resume-paused:${NodeCrypto.randomUUID()}`);

  /** Waits for the first sign of how `threadId` is going, then reads its state if none came. */
  const outcomeOf = (threadId: ThreadId) =>
    engine.streamDomainEvents.pipe(
      Stream.filter((event) => event.aggregateKind === "thread" && event.aggregateId === threadId),
      Stream.map(resumeOutcomeOf),
      Stream.filter((outcome) => outcome !== null),
      Stream.runHead,
      Effect.timeoutOption(OUTCOME_TIMEOUT),
      Effect.map(Option.flatten),
      Effect.flatMap(
        Option.match({
          onSome: (outcome) => Effect.succeed<ResumeOutcome>(outcome),
          onNone: () =>
            projection.getThreadShellById(threadId).pipe(
              Effect.map((shell) =>
                Option.isSome(shell) && isPausedShell(shell.value) ? "refused" : "working",
              ),
              Effect.orElseSucceed(() => "working" as const),
            ),
        }),
      ),
    );

  /** Starts one chat again; false when it no longer needs it. */
  const start = Effect.fn("PausedThreadResumer.start")(function* (
    threadId: ThreadId,
    modelSelection: ModelSelection | undefined,
  ) {
    const shell = yield* projection.getThreadShellById(threadId);
    if (Option.isNone(shell) || !isPausedShell(shell.value)) return false;
    const detail = yield* projection.getThreadDetailById(threadId, {
      messageLimit: 20,
      activityLimit: 40,
    });
    const unsent = Option.isSome(detail) ? undeliveredMessageId(detail.value) : null;
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    if (unsent !== null) {
      if (modelSelection !== undefined)
        yield* engine.dispatch({
          type: "thread.meta.update",
          commandId: commandId(),
          threadId,
          modelSelection,
        });
      yield* engine.dispatch({
        type: "thread.queued-message.send-now",
        commandId: commandId(),
        threadId,
        messageId: unsent,
        createdAt,
      });
      return true;
    }
    yield* engine.dispatch({
      type: "thread.turn.start",
      commandId: commandId(),
      threadId,
      message: {
        messageId: MessageId.make(NodeCrypto.randomUUID()),
        role: "user",
        text: RESUME_PROMPT,
        attachments: [],
      },
      ...(modelSelection === undefined ? {} : { modelSelection }),
      runtimeMode: shell.value.runtimeMode,
      interactionMode: shell.value.interactionMode,
      createdAt,
    });
    return true;
  });

  /** Resumes one chat and reports how it went; null when there was nothing to do. */
  const resumeOne = (threadId: ThreadId, modelSelection: ModelSelection | undefined) =>
    Effect.gen(function* () {
      // Listening before the start, so a refusal right after it is not missed.
      const outcome = yield* outcomeOf(threadId).pipe(Effect.forkChild({ startImmediately: true }));
      const started = yield* start(threadId, modelSelection);
      if (!started) {
        yield* Fiber.interrupt(outcome);
        return null;
      }
      return yield* Fiber.join(outcome);
    });

  const runThrough = Effect.fn("PausedThreadResumer.run")(function* (
    input: OrchestrationResumePausedThreadsInput,
  ) {
    if (
      input.afterThreadId !== undefined &&
      (yield* outcomeOf(input.afterThreadId)) === "refused"
    ) {
      yield* Effect.logInfo("paused chats stay paused: the first one was refused");
      return;
    }
    for (const threadId of input.threadIds) {
      const outcome = yield* resumeOne(threadId, input.modelSelection).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("could not resume a paused chat", { threadId, cause }).pipe(
            Effect.as(null),
          ),
        ),
      );
      if (outcome === "refused") {
        yield* Effect.logInfo("stopped resuming paused chats: the provider refused again");
        return;
      }
    }
  });

  /** Finishes when any chat in the run is stopped, which is how a phone ends one. */
  const stoppedByPerson = (input: OrchestrationResumePausedThreadsInput) => {
    const chats = new Set<string>([
      ...input.threadIds,
      ...(input.afterThreadId === undefined ? [] : [input.afterThreadId]),
    ]);
    return engine.streamDomainEvents.pipe(
      Stream.filter(
        (event) => event.type === "thread.turn-interrupt-requested" && chats.has(event.aggregateId),
      ),
      Stream.runHead,
    );
  };

  const stop = Effect.gen(function* () {
    const running = run;
    run = null;
    if (running === null) return false;
    yield* Fiber.interrupt(running);
    return true;
  });

  return {
    /** Starts a run in the background, replacing any run still going. */
    resume: Effect.fn("PausedThreadResumer.resume")(function* (
      input: OrchestrationResumePausedThreadsInput,
    ) {
      yield* stop;
      const fiber: Fiber.Fiber<void> = yield* runThrough(input).pipe(
        Effect.raceFirst(stoppedByPerson(input)),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            if (run === fiber) run = null;
          }),
        ),
        Effect.forkIn(scope),
      );
      run = fiber;
      return { queued: input.threadIds.length };
    }),
    /** Ends the run. Chats it had already started carry on; the rest stay paused. */
    stop: stop.pipe(Effect.map((stopped) => ({ stopped }))),
  };
});

export class PausedThreadResumer extends Context.Service<
  PausedThreadResumer,
  Effect.Success<typeof makePausedThreadResumer>
>()("t3/orchestration/PausedThreadResumer") {}
export const PausedThreadResumerLive = Layer.effect(PausedThreadResumer, makePausedThreadResumer);
