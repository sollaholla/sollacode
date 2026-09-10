import {
  EventId,
  TurnId,
  type ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderRuntimeEventBase,
  type ProviderSession,
  type ThreadId,
} from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as DateTime from "effect/DateTime";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText.ts";
import { ProviderAdapterRequestError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  buildDeepCodeExecArgs,
  buildDeepCodeTurnEnvironment,
  deepCodeHomeDir,
  deepCodeSessionsIndexPath,
  isDeepCodeEffort,
  parseDeepCodeSessionsIndex,
  pickDeepCodeSessionId,
  sessionIdFromCursor,
  type DeepCodeSessionIndexEntry,
} from "../deepcodeProtocol.ts";
import { DEEPCODE_DRIVER_KIND } from "../deepcodeRuntime.ts";

interface ActiveTurn {
  readonly id: TurnId;
  fiber?: Fiber.Fiber<void>;
  interrupted: boolean;
}

const isAdapterRequestError = Schema.is(ProviderAdapterRequestError);

interface SessionContext {
  session: ProviderSession;
  active?: ActiveTurn | undefined;
  effort?: string | undefined;
}

const MAX_STDOUT_BYTES = 2 * 1024 * 1024;

/** Each turn owns a scoped `--exec` process; later turns resume the native session. */
export const makeDeepCodeAdapter = Effect.fn("makeDeepCodeAdapter")(function* (config: {
  readonly instanceId: ProviderInstanceId;
  readonly binaryPath: string;
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
}) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fs = yield* FileSystem.FileSystem;
  const scope = yield* Effect.scope;
  const events = yield* Effect.acquireRelease(
    PubSub.unbounded<ProviderRuntimeEvent>(),
    PubSub.shutdown,
  );
  const sessions = new Map<ThreadId, SessionContext>();
  let sequence = 0;
  const now = () => DateTime.formatIso(DateTime.nowUnsafe());
  const base = (threadId: ThreadId, turnId?: TurnId): ProviderRuntimeEventBase => ({
    eventId: EventId.make(`deepcode:${config.instanceId}:${now()}:${++sequence}`),
    provider: DEEPCODE_DRIVER_KIND,
    providerInstanceId: config.instanceId,
    threadId,
    createdAt: now(),
    ...(turnId ? { turnId } : {}),
  });
  const emit = (event: ProviderRuntimeEvent) => PubSub.publishUnsafe(events, event);
  const error = (method: string, detail: string) =>
    new ProviderAdapterRequestError({
      provider: DEEPCODE_DRIVER_KIND,
      method,
      detail,
    });
  const unsupported = (method: string) =>
    Effect.fail(error(method, `Deep Code headless mode does not support ${method}.`));

  const readSessionIndex = (cwd: string) =>
    fs.readFileString(deepCodeSessionsIndexPath(deepCodeHomeDir(config.environment), cwd)).pipe(
      Effect.map(parseDeepCodeSessionsIndex),
      Effect.orElseSucceed((): ReadonlyArray<DeepCodeSessionIndexEntry> => []),
    );

  const startSession: ProviderAdapterShape<ProviderAdapterRequestError>["startSession"] = Effect.fn(
    "DeepCodeAdapter.startSession",
  )(function* (input) {
    const existing = sessions.get(input.threadId);
    if (existing) return existing.session;
    if (input.resumeCursor != null && !sessionIdFromCursor(input.resumeCursor)) {
      return yield* error("startSession", "The Deep Code session cursor is invalid.");
    }
    const timestamp = now();
    const session: ProviderSession = {
      provider: DEEPCODE_DRIVER_KIND,
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
    sessions.set(input.threadId, {
      session,
      effort: getModelSelectionStringOptionValue(input.modelSelection, "effort"),
    });
    return session;
  });

  const sendTurn: ProviderAdapterShape<ProviderAdapterRequestError>["sendTurn"] = Effect.fn(
    "DeepCodeAdapter.sendTurn",
  )(function* (input, options) {
    return yield* Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const context = sessions.get(input.threadId);
        if (!context) return yield* error("sendTurn", "Session not found.");
        if (context.active || input.liveSteerTarget)
          return yield* error(
            "sendTurn",
            "Deep Code cannot steer an active turn. Wait for it to finish or stop it.",
          );
        if (input.attachments?.length)
          return yield* error(
            "sendTurn",
            "Deep Code headless input accepts text only; attachments are not supported.",
          );
        if (!input.input?.trim()) return yield* error("sendTurn", "A text prompt is required.");
        const model = input.modelSelection?.model ?? context.session.model;
        const selectedEffort =
          getModelSelectionStringOptionValue(input.modelSelection, "effort") ??
          (input.modelSelection ? undefined : context.effort);
        if (selectedEffort !== undefined && !isDeepCodeEffort(selectedEffort)) {
          return yield* error("sendTurn", "Deep Code effort must be low, high, or max.");
        }
        const active: ActiveTurn = {
          id: TurnId.make(`deepcode-${config.instanceId}-${now()}-${++sequence}`),
          interrupted: false,
        };
        context.active = active;
        const ready = yield* Deferred.make<void, ProviderAdapterRequestError>();
        let terminal: ProviderRuntimeEvent | undefined;
        let stderr = "";
        const cwd = context.session.cwd ?? config.cwd;
        const resumeSessionId = sessionIdFromCursor(context.session.resumeCursor);
        const args = buildDeepCodeExecArgs({
          prompt: input.input,
          resumeSessionId,
        });
        const environment = buildDeepCodeTurnEnvironment(config.environment, {
          model,
          effort: selectedEffort,
        });
        const run = Effect.gen(function* () {
          const previousIndex = yield* readSessionIndex(cwd);
          const command = yield* resolveSpawnCommand(config.binaryPath, args, { env: environment });
          const handle = yield* spawner.spawn(
            ChildProcess.make(command.command, command.args, {
              shell: command.shell,
              cwd,
              env: environment,
              extendEnv: false,
              stdin: "ignore",
              stdout: "pipe",
              stderr: "pipe",
              forceKillAfter: "2 seconds",
            }),
          );
          if (active.interrupted) return;
          context.effort = selectedEffort;
          context.session = {
            ...context.session,
            status: "running",
            model,
            activeTurnId: active.id,
            updatedAt: now(),
          };
          emit({
            ...base(input.threadId, active.id),
            type: "turn.started",
            payload: model ? { model } : {},
          });
          yield* options?.onNativeDispatch ?? Effect.void;
          if (input.messageId)
            emit({
              ...base(input.threadId, active.id),
              type: "message.delivered",
              payload: { messageId: input.messageId },
            });
          const [stdout, stderrText, code] = yield* Effect.all(
            [
              collectUint8StreamText({ stream: handle.stdout, maxBytes: MAX_STDOUT_BYTES }),
              collectUint8StreamText({ stream: handle.stderr, maxBytes: 16_384 }),
              handle.exitCode,
            ],
            { concurrency: "unbounded" },
          );
          stderr = stderrText.text;
          if (active.interrupted) return;
          if (code !== 0) {
            return yield* error(
              "run",
              stderr.trim() || `Deep Code exited ${code} without a successful terminal result.`,
            );
          }
          const nextIndex = yield* readSessionIndex(cwd);
          const sessionId = pickDeepCodeSessionId({
            previous: previousIndex,
            next: nextIndex,
            resumeSessionId,
          });
          if (sessionId) {
            context.session = {
              ...context.session,
              resumeCursor: { sessionId },
            };
          }
          const reply = stdout.text.replace(/\s+$/u, "");
          if (reply.length > 0) {
            emit({
              ...base(input.threadId, active.id),
              type: "content.delta",
              payload: { streamKind: "assistant_text", delta: `${reply}\n` },
            });
          }
          terminal = {
            ...base(input.threadId, active.id),
            type: "turn.completed",
            payload: { state: "completed" },
          };
          Deferred.doneUnsafe(ready, Effect.void);
        }).pipe(
          Effect.scoped,
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              const underlying = Cause.squash(cause);
              const failure = isAdapterRequestError(underlying)
                ? underlying
                : error("run", stderr.trim() || String(cause));
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
                error("sendTurn", "Deep Code stopped before consuming the prompt."),
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
              else if (terminal) {
                if (terminal.type === "turn.completed" && terminal.payload.state === "failed")
                  emit({
                    ...base(input.threadId, active.id),
                    type: "runtime.error",
                    payload: {
                      message: terminal.payload.errorMessage ?? "Deep Code turn failed.",
                    },
                  });
                emit(terminal);
              }
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
    Effect.fn("DeepCodeAdapter.interruptTurn")(function* (threadId, turnId) {
      const active = sessions.get(threadId)?.active;
      if (!active || (turnId && turnId !== active.id)) return;
      active.interrupted = true;
      if (active.fiber) yield* Fiber.interrupt(active.fiber);
    });
  const stopSession = Effect.fn("DeepCodeAdapter.stopSession")(function* (threadId: ThreadId) {
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
    provider: DEEPCODE_DRIVER_KIND,
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
