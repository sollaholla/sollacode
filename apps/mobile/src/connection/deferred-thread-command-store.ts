import {
  DeferredThreadCommandStore,
  type DeferredThreadCommandEntry,
  ConnectionPersistenceError,
} from "@t3tools/client-runtime/platform";
import {
  DeferredThreadCommandEntriesDocument,
  compactDeferredThreadCommands,
  isDeferredThreadCommand,
} from "@t3tools/client-runtime/operations";
import { type EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as MobileDatabase from "../persistence/mobile-database";

const CACHE_KEY = "commands";
const SCHEMA_VERSION = 1;
const StoredDeferredThreadCommands = Schema.Struct({
  schemaVersion: Schema.Literal(SCHEMA_VERSION),
  environmentId: Schema.String,
  entries: DeferredThreadCommandEntriesDocument,
});
const StoredDeferredThreadCommandsJson = Schema.fromJsonString(StoredDeferredThreadCommands);
const decodeStoredDeferredThreadCommands = Schema.decodeUnknownEffect(
  StoredDeferredThreadCommandsJson,
);
const encodeStoredDeferredThreadCommands = Schema.encodeEffect(StoredDeferredThreadCommandsJson);

type Operation = ConnectionPersistenceError["operation"];

function persistenceError(operation: Operation, cause: unknown) {
  return new ConnectionPersistenceError({
    operation,
    message: `Could not ${operation.replaceAll("-", " ")}: ${String(cause)}`,
  });
}

export const make = Effect.fn("MobileDeferredThreadCommandStore.make")(function* () {
  const database = yield* MobileDatabase.MobileDatabase;
  const lock = yield* Semaphore.make(1);

  const load = Effect.fn("MobileDeferredThreadCommandStore.load")(function* (
    environmentId: EnvironmentId,
  ) {
    const raw = yield* database
      .loadCache(environmentId, "deferred-thread-command", CACHE_KEY)
      .pipe(Effect.mapError((cause) => persistenceError("load-deferred-thread-commands", cause)));
    if (Option.isNone(raw)) {
      return [] as ReadonlyArray<DeferredThreadCommandEntry>;
    }
    const stored = yield* decodeStoredDeferredThreadCommands(raw.value).pipe(
      Effect.mapError((cause) => persistenceError("load-deferred-thread-commands", cause)),
    );
    if (stored.environmentId !== environmentId) {
      return [];
    }
    return stored.entries.flatMap((entry) =>
      isDeferredThreadCommand(entry.command)
        ? [{ command: entry.command, enqueuedAt: entry.enqueuedAt }]
        : [],
    );
  });

  const save = Effect.fn("MobileDeferredThreadCommandStore.save")(function* (
    environmentId: EnvironmentId,
    entries: ReadonlyArray<DeferredThreadCommandEntry>,
    operation: "save-deferred-thread-command" | "remove-deferred-thread-command",
  ) {
    const payload = yield* encodeStoredDeferredThreadCommands({
      schemaVersion: SCHEMA_VERSION,
      environmentId,
      entries,
    }).pipe(Effect.mapError((cause) => persistenceError(operation, cause)));
    yield* database
      .saveCache(environmentId, "deferred-thread-command", CACHE_KEY, SCHEMA_VERSION, payload)
      .pipe(Effect.mapError((cause) => persistenceError(operation, cause)));
  });

  return DeferredThreadCommandStore.of({
    list: (environmentId) => lock.withPermits(1)(load(environmentId)),
    enqueue: (environmentId, entry) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* load(environmentId);
          yield* save(
            environmentId,
            compactDeferredThreadCommands(current, entry),
            "save-deferred-thread-command",
          );
        }),
      ),
    remove: (environmentId, commandId) =>
      lock.withPermits(1)(
        Effect.gen(function* () {
          const current = yield* load(environmentId);
          yield* save(
            environmentId,
            current.filter((entry) => entry.command.commandId !== commandId),
            "remove-deferred-thread-command",
          );
        }),
      ),
    clear: (environmentId) =>
      database
        .removeCache(environmentId, "deferred-thread-command", CACHE_KEY)
        .pipe(
          Effect.mapError((cause) => persistenceError("clear-deferred-thread-commands", cause)),
        ),
  });
});

export const layer = Layer.effect(DeferredThreadCommandStore, make());
