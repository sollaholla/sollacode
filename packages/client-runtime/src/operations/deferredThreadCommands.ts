import {
  ClientOrchestrationCommand,
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
});

export const DeferredThreadCommandEntriesDocument = Schema.Array(
  DeferredThreadCommandEntryDocument,
);

export function isDeferredThreadCommand(
  command: ClientOrchestrationCommand,
): command is Persistence.DeferredThreadCommand {
  return (
    command.type === "thread.archive" ||
    command.type === "thread.unarchive" ||
    command.type === "thread.settle" ||
    command.type === "thread.unsettle"
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
  const incomingAxis = commandAxis(incoming.command);
  return [
    ...current.filter(
      (entry) =>
        entry.command.threadId !== incoming.command.threadId ||
        commandAxis(entry.command) !== incomingAxis,
    ),
    incoming,
  ].toSorted((left, right) => left.enqueuedAt.localeCompare(right.enqueuedAt));
}

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
    return yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, command).pipe(
      Effect.map(
        (result): DeferredThreadCommandDelivery => ({
          _tag: "Dispatched",
          result,
        }),
      ),
      Effect.catchIf(isTransportFailure, () =>
        DateTime.now.pipe(
          Effect.map(DateTime.formatIso),
          Effect.flatMap((enqueuedAt) =>
            store.enqueue(supervisor.target.environmentId, { command, enqueuedAt }),
          ),
          Effect.as<DeferredThreadCommandDelivery>({ _tag: "Deferred" }),
        ),
      ),
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
  yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const result = yield* request(ORCHESTRATION_WS_METHODS.dispatchCommand, entry.command).pipe(
          Effect.result,
        );
        if (Result.isSuccess(result)) {
          yield* store.remove(environmentId, entry.command.commandId);
          return;
        }
        if (isTransportFailure(result.failure)) {
          return yield* result.failure;
        }
        yield* Effect.logWarning("Dropping a rejected deferred thread command.", {
          environmentId,
          commandId: entry.command.commandId,
          commandType: entry.command.type,
          error: result.failure,
        });
        yield* store.remove(environmentId, entry.command.commandId);
      }),
    { discard: true },
  );
});
