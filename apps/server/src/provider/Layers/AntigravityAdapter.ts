import {
  EventId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  buildAntigravityStreamArgs,
  encodeAntigravityUserMessage,
  parseAntigravityEventLine,
} from "../antigravityProtocol.ts";
import {
  ANTIGRAVITY_DRIVER_KIND,
  EMPTY_ANTIGRAVITY_USAGE_TALLY,
  foldAntigravityUsage,
  mapAntigravityEvent,
  type AntigravityUsageTally,
} from "../antigravityRuntime.ts";

interface ActiveTurn {
  readonly id: TurnId;
  fiber?: Fiber.Fiber<void>;
  interrupted: boolean;
}
interface SessionContext {
  session: ProviderSession;
  active?: ActiveTurn | undefined;
  /** Token totals across the native conversation, so the meter can show what this thread has processed. */
  usage: AntigravityUsageTally;
}

function conversationId(cursor: unknown): string | undefined {
  return Predicate.isObject(cursor) &&
    typeof cursor.conversationId === "string" &&
    cursor.conversationId.trim()
    ? cursor.conversationId
    : undefined;
}

/** Each turn owns a scoped process; subsequent turns resume the native conversation. */
export const makeAntigravityAdapter = Effect.fn("makeAntigravityAdapter")(function* (config: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const scope = yield* Effect.scope;
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, SessionContext>();
  let sequence = 0;
  const now = () => DateTime.formatIso(DateTime.nowUnsafe());
  const base = (threadId: ThreadId, turnId?: TurnId): ProviderRuntimeEventBase => ({
    eventId: EventId.make(`antigravity:${config.instanceId}:${now()}:${++sequence}`),
    provider: ANTIGRAVITY_DRIVER_KIND,
    providerInstanceId: config.instanceId,
    threadId,
    createdAt: now(),
    ...(turnId ? { turnId } : {}),
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publishUnsafe(events, event);
  const error = (method: string, detail: string) =>
    new ProviderAdapterRequestError({
      provider: ANTIGRAVITY_DRIVER_KIND,
      method,
      detail,
    });
  const unsupported = (method: string) =>
    Effect.fail(error(method, `Antigravity headless mode does not support ${method}.`));

  const startSession: ProviderAdapterShape<ProviderAdapterRequestError>["startSession"] = Effect.fn(
    "AntigravityAdapter.startSession",
  )(function* (input) {
    const existing = sessions.get(input.threadId);
    if (existing) return existing.session;
    if (input.resumeCursor != null && !conversationId(input.resumeCursor)) {
      return yield* error("startSession", "The Antigravity conversation cursor is invalid.");
    }
    const timestamp = now();
    const session: ProviderSession = {
      provider: ANTIGRAVITY_DRIVER_KIND,
      providerInstanceId: config.instanceId,
      threadId: input.threadId,
      runtimeMode: input.runtimeMode,
      status: "ready",
      cwd: input.cwd ?? config.cwd,
      ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
      ...(input.resumeCursor ? { resumeCursor: input.resumeCursor } : {}),
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    sessions.set(input.threadId, { session, usage: EMPTY_ANTIGRAVITY_USAGE_TALLY });
    return session;
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterRequestError>["sendTurn"] = Effect.fn(
    "AntigravityAdapter.sendTurn",
  )(function* (input, options) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = sessions.get(input.threadId);
        if (!context) return yield* error("sendTurn", "Session not found.");
        if (context.active || input.liveSteerTarget)
          return yield* error(
            "sendTurn",
            "Antigravity cannot steer an active turn. Wait for it to finish or stop it.",
          );
        if (input.attachments?.length)
          return yield* error(
            "sendTurn",
            "Antigravity headless input accepts text only; attachments are not supported.",
          );
        if (!input.input?.trim()) return yield* error("sendTurn", "A text prompt is required.");
        const model = input.modelSelection?.model ?? context.session.model;
        const active: ActiveTurn = {
          id: TurnId.make(`agy-${config.instanceId}-${now()}-${++sequence}`),
          interrupted: false,
        };
        context.active = active;
        const ready = yield* Deferred.make<void, ProviderAdapterRequestError>();
        const args = [
          ...buildAntigravityStreamArgs({
            model,
            conversationId: conversationId(context.session.resumeCursor),
            skipPermissions: context.session.runtimeMode === "full-access",
          }),
          "--mode",
          input.interactionMode === "plan" ? "plan" : "accept-edits",
        ];
        let terminal: ProviderRuntimeEvent | undefined;
        let textReceived = false;
        let delivered = false;
        let stderr = "";
        const prompt = input.input;
        const run = Effect.gen(function* () {
          const command = yield* resolveSpawnCommand(config.binaryPath, args, {
            env: config.environment,
          });
          const handle = yield* spawner.spawn(
            ChildProcess.make(command.command, command.args, {
              shell: command.shell,
              cwd: context.session.cwd ?? config.cwd,
              env: config.environment,
              extendEnv: false,
              stdin: "pipe",
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "2 seconds",
            }),
          );
          if (active.interrupted) return;
          context.session = {
            ...context.session,
            status: "running",
            model,
            activeTurnId: active.id,
            updatedAt: now(),
          };
          const consume = handle.stdout.pipe(
            Stream.decodeText(),
            Stream.splitLines,
            Stream.runForEach((line) =>
              Effect.sync(() => {
                if (active.interrupted) return;
                const frame = parseAntigravityEventLine(line);
                if (!frame) return;
                if (frame.kind === "malformed")
                  throw new Error("Antigravity emitted malformed stream JSON.");
                if (
                  (frame.kind === "init" ||
                    frame.kind === "step_update" ||
                    frame.kind === "result") &&
                  frame.conversationId
                ) {
                  context.session = {
                    ...context.session,
                    resumeCursor: { conversationId: frame.conversationId },
                  };
                }
                if (
                  frame.kind === "step_update" &&
                  frame.stepType === "user_input" &&
                  !delivered &&
                  input.messageId
                ) {
                  delivered = true;
                  emit({
                    ...base(input.threadId, active.id),
                    type: "message.delivered",
                    payload: { messageId: input.messageId },
                  });
                }
                if (
                  frame.kind === "step_update" &&
                  frame.stepType === "agent_response" &&
                  frame.textDelta
                )
                  textReceived = true;
                if (frame.kind === "result" && !textReceived && frame.response) {
                  emit({
                    ...base(input.threadId, active.id),
                    type: "content.delta",
                    payload: { streamKind: "assistant_text", delta: frame.response },
                  });
                  textReceived = true;
                }
                if ((frame.kind === "step_update" || frame.kind === "result") && frame.usage) {
                  // Every usage-bearing frame updates the context meter; the
                  // other CLI drivers report usage the same way and the web
                  // client shows nothing for a provider that never does.
                  const folded = foldAntigravityUsage({
                    tally: context.usage,
                    kind: frame.kind,
                    usage: frame.usage,
                    model,
                  });
                  context.usage = folded.tally;
                  if (folded.snapshot)
                    emit({
                      ...base(input.threadId, active.id),
                      type: "thread.token-usage.updated",
                      payload: { usage: folded.snapshot },
                    });
                }
                for (const event of mapAntigravityEvent(frame, base(input.threadId, active.id))) {
                  if (event.type === "turn.completed") terminal = event;
                  else emit(event);
                }
              }),
            ),
          );
          context.usage = { ...context.usage, turnTokens: 0 };
          emit({
            ...base(input.threadId, active.id),
            type: "turn.started",
            payload: model ? { model } : {},
          });
          yield* options?.onNativeDispatch ?? Effect.void;
          const write = Stream.make(
            new TextEncoder().encode(`${encodeAntigravityUserMessage(prompt)}\n`),
          ).pipe(
            Stream.run(handle.stdin),
            Effect.tap(() => Deferred.succeed(ready, undefined)),
          );
          yield* Effect.all(
            [
              consume,
              handle.stderr.pipe(
                Stream.decodeText(),
                Stream.runForEach((chunk) =>
                  Effect.sync(() => {
                    stderr = (stderr + chunk).slice(-16_384);
                  }),
                ),
              ),
              write,
            ],
            { concurrency: "unbounded" },
          );
          const code = yield* handle.exitCode;
          if (code !== 0 || !terminal)
            return yield* error(
              "run",
              stderr.trim() || `Antigravity exited ${code} without a successful terminal result.`,
            );
        }).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const failure = error("run", stderr.trim() || String(cause));
              yield* Deferred.fail(ready, failure);
              terminal = {
                ...base(input.threadId, active.id),
                type: "turn.completed",
                payload: { state: "failed", errorMessage: failure.detail },
              };
            }),
          ),
          Effect.ensuring(
            Effect.gen(function* () {
              yield* Deferred.fail(
                ready,
                error("sendTurn", "Antigravity stopped before consuming the prompt."),
              );
              context.active = undefined;
              context.session = {
                ...context.session,
                status: "ready",
                activeTurnId: undefined,
                updatedAt: now(),
              };
              if (active.interrupted)
                emit({
                  ...base(input.threadId, active.id),
                  type: "turn.completed",
                  payload: { state: "interrupted" },
                });
              else if (terminal) emit(terminal);
            }),
          ),
        );
        active.fiber = yield* restore(run).pipe(Effect.forkIn(scope));
        yield* restore(Deferred.await(ready));
        return {
          threadId: input.threadId,
          turnId: active.id,
          resumeCursor: context.session.resumeCursor,
        };
      }),
    );
  });
  const interruptTurn: ProviderAdapterShape<ProviderAdapterRequestError>["interruptTurn"] =
    Effect.fn("AntigravityAdapter.interruptTurn")(function* (threadId, turnId) {
      const active = sessions.get(threadId)?.active;
      if (!active || (turnId && turnId !== active.id)) return;
      active.interrupted = true;
      if (active.fiber) yield* Fiber.interrupt(active.fiber);
    });
  const stopSession = Effect.fn("AntigravityAdapter.stopSession")(function* (threadId: ThreadId) {
    yield* interruptTurn(threadId);
    if (sessions.delete(threadId))
      emit({
        ...base(threadId),
        type: "session.exited",
        payload: { reason: "Session stopped.", recoverable: true, exitKind: "graceful" },
      });
  });
  const stopAll = () => Effect.forEach([...sessions.keys()], stopSession, { discard: true });
  yield* Effect.addFinalizer(() => stopAll().pipe(Effect.ignore));
  return {
    provider: ANTIGRAVITY_DRIVER_KIND,
    capabilities: {
      sessionModelSwitch: "in-session",
      taskStop: false,
      threadRollback: false,
      threadFork: false,
      textGeneration: false,
      messageDeliveryReceipts: true,
    },
    startSession,
    sendTurn,
    interruptTurn,
    stopSession,
    stopAll,
    listSessions: () => Effect.sync(() => [...sessions.values()].map((context) => context.session)),
    hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
    respondToRequest: () => unsupported("interactive approval"),
    respondToUserInput: () => unsupported("structured user input"),
    readThread: () => unsupported("native transcript read"),
    rollbackThread: () => unsupported("rollback"),
    streamEvents: Stream.fromPubSub(events),
  } satisfies ProviderAdapterShape<ProviderAdapterRequestError>;
});
