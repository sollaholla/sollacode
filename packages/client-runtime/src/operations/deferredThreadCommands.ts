import * as PartitionedSemaphore from "effect/PartitionedSemaphore";
import {
  rememberedThreadShell,
  notifyDeferredThreadCommands,
} from "./deferredThreadCommandState.ts";
import {
  ClientOrchestrationCommand,
  VmAgentBlockerResolveInput,
  WS_METHODS,
  OrchestrationThreadShell,
  ORCHESTRATION_WS_METHODS,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/unstable/rpc";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  EnvironmentRpcUnavailableError,
  type EnvironmentRpcFailure,
  type EnvironmentRpcSuccess,
  request,
} from "../rpc/client.ts";

const DeferredThreadCommandEntryDocument = Schema.Struct({
  command: ClientOrchestrationCommand,
  enqueuedAt: Schema.String,
  thread: Schema.optional(OrchestrationThreadShell),
  before: Schema.optional(Schema.Array(ClientOrchestrationCommand)),
  error: Schema.optional(Schema.String),
  accepted: Schema.optional(Schema.Boolean),
  afterReply: Schema.optional(VmAgentBlockerResolveInput),
});

export const DeferredThreadCommandEntriesDocument = Schema.Array(
  DeferredThreadCommandEntryDocument,
);

export function isDeferredThreadCommand(
  command: ClientOrchestrationCommand,
): command is Persistence.DeferredThreadCommand {
  return (
    command.type === "thread.delete" ||
    command.type === "thread.archive" ||
    command.type === "thread.unarchive" ||
    command.type === "thread.settle" ||
    command.type === "thread.unsettle" ||
    command.type === "thread.turn.start"
  );
}

function commandAxis(command: Persistence.DeferredThreadCommand): "archive" | "settled" {
  return command.type === "thread.archive" || command.type === "thread.unarchive"
    ? "archive"
    : "settled";
}

export function compactDeferredThreadCommands(
  current: ReadonlyArray<Persistence.DeferredThreadCommandEntry>,
  incoming: Persistence.DeferredThreadCommandEntry,
): ReadonlyArray<Persistence.DeferredThreadCommandEntry> {
  // Messages are independent intents. Lifecycle toggles must never compact them.
  if (incoming.command.type === "thread.turn.start") {
    if (current.some((entry) => entry.command.commandId === incoming.command.commandId)) {
      return current.map((entry) =>
        entry.command.commandId === incoming.command.commandId ? incoming : entry,
      );
    }
    return [...current, incoming].toSorted((left, right) =>
      left.enqueuedAt.localeCompare(right.enqueuedAt),
    );
  }
  // A queued deletion supersedes pending lifecycle toggles for this thread.
  if (
    incoming.command.type !== "thread.delete" &&
    current.some(
      (entry) =>
        entry.command.threadId === incoming.command.threadId &&
        entry.command.type === "thread.delete",
    )
  )
    return current;
  const incomingAxis = commandAxis(incoming.command);
  return [
    ...current.filter(
      (entry) =>
        entry.command.type === "thread.turn.start" ||
        entry.command.threadId !== incoming.command.threadId ||
        (incoming.command.type !== "thread.delete" && commandAxis(entry.command) !== incomingAxis),
    ),
    incoming,
  ].toSorted((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt));
}

const deliveryLock = PartitionedSemaphore.makeUnsafe<EnvironmentId>({ permits: 1 });

type DispatchTag = typeof ORCHESTRATION_WS_METHODS.dispatchCommand;

export type DeferredThreadCommandDelivery =
  | {
      readonly _tag: "Dispatched";
      readonly result: EnvironmentRpcSuccess<DispatchTag>;
    }
  | { readonly _tag: "Deferred" };

const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isEnvironmentRpcUnavailableError = Schema.is(EnvironmentRpcUnavailableError);

type DeferredTransportFailure = EnvironmentRpcUnavailableError | RpcClientError.RpcClientError;

function isTransportFailure(error: unknown): error is DeferredTransportFailure {
  return isEnvironmentRpcUnavailableError(error) || isRpcClientError(error);
}

export const dispatchOrDeferThreadCommand = Effect.fn("DeferredThreadCommands.dispatchOrDefer")(
  function* (
    command: Persistence.DeferredThreadCommand,
  ): Effect.fn.Return<
    DeferredThreadCommandDelivery,
    EnvironmentRpcFailure<DispatchTag> | Persistence.ConnectionPersistenceError,
    EnvironmentSupervisor.EnvironmentSupervisor | Persistence.DeferredThreadCommandStore
  > {
    const store = yield* Persistence.DeferredThreadCommandStore;
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const environmentId = supervisor.target.environmentId;
    const enqueuedAt = DateTime.formatIso(yield* DateTime.now);
    const previous = yield* store.list(environmentId);
    const thread =
      rememberedThreadShell(environmentId, command.threadId) ??
      previous.find((entry) => entry.command.threadId === command.threadId)?.thread;
    yield* store.enqueue(environmentId, { command, enqueuedAt, ...(thread ? { thread } : {}) });
    notifyDeferredThreadCommands(environmentId);
    return yield* deliveryLock.withPermit(environmentId)(
      Effect.gen(function* () {
        const pending = yield* store.list(environmentId);
        if (!pending.some((entry) => entry.command.commandId === command.commandId))
          return { _tag: "Deferred" } as const;
        const result = yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, command).pipe(
          Effect.result,
        );
        if (Result.isFailure(result)) {
          const failure = result.failure;
          if (isTransportFailure(failure)) return { _tag: "Deferred" } as const;
          yield* store.remove(environmentId, command.commandId);
          notifyDeferredThreadCommands(environmentId);
          return yield* failure;
        }
        yield* store.remove(environmentId, command.commandId);
        notifyDeferredThreadCommands(environmentId);
        return { _tag: "Dispatched", result: result.success } as const;
      }),
    );
  },
);

export const drainDeferredThreadCommands = Effect.fn("DeferredThreadCommands.drain")(function* (
  environmentId: EnvironmentId,
): Effect.fn.Return<
  void,
  DeferredTransportFailure | Persistence.ConnectionPersistenceError,
  EnvironmentSupervisor.EnvironmentSupervisor | Persistence.DeferredThreadCommandStore
> {
  const store = yield* Persistence.DeferredThreadCommandStore;
  const entries = yield* store.list(environmentId);
  const blockedThreads = new Set<string>();
  yield* Effect.forEach(
    entries,
    (snapshotEntry) =>
      deliveryLock.withPermit(environmentId)(
        Effect.gen(function* () {
          const pending = yield* store.list(environmentId);
          const entry = pending.find(
            (current) => current.command.commandId === snapshotEntry.command.commandId,
          );
          if (!entry) return;
          if (entry.accepted) return;
          if (blockedThreads.has(entry.command.threadId)) return;
          if (entry.error) {
            blockedThreads.add(entry.command.threadId);
            return;
          }
          const result = yield* Effect.gen(function* () {
            for (const command of entry.before ?? [])
              yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, command);
            return yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, entry.command);
          }).pipe(
            Effect.timeoutOrElse({
              duration: "30 seconds",
              orElse: () =>
                Effect.fail(
                  new EnvironmentRpcUnavailableError({
                    environmentId,
                    message:
                      "Message delivery is waiting for the connection. The message remains saved.",
                  }),
                ),
            }),
            Effect.result,
          );
          if (Result.isSuccess(result)) {
            if (entry.command.type === "thread.turn.start") {
              if (entry.afterReply)
                yield* request(WS_METHODS.vmAgentBlockerResolve, entry.afterReply).pipe(
                  Effect.timeout("5 seconds"),
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      "Message delivered, but its waiting card could not be resolved.",
                      { cause },
                    ),
                  ),
                );
              // Keep the local echo through the receipt/projection handoff.
              yield* store.enqueue(environmentId, { ...entry, accepted: true });
            } else yield* store.remove(environmentId, entry.command.commandId);
            notifyDeferredThreadCommands(environmentId);
            return;
          }
          if (isTransportFailure(result.failure)) {
            return yield* result.failure;
          }
          if (entry.command.type === "thread.turn.start") {
            const failure = result.failure;
            const error =
              typeof failure === "object" && failure !== null && "message" in failure
                ? String(failure.message)
                : String(failure);
            yield* store.enqueue(environmentId, { ...entry, error });
            notifyDeferredThreadCommands(environmentId);
            blockedThreads.add(entry.command.threadId);
            return;
          }
          yield* Effect.logWarning("Dropping a rejected deferred thread command.", {
            environmentId,
            commandId: entry.command.commandId,
            commandType: entry.command.type,
            error: result.failure,
          });
          yield* store.remove(environmentId, entry.command.commandId);
          notifyDeferredThreadCommands(environmentId);
        }),
      ),
    { discard: true },
  );
});
