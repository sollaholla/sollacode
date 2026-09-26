import {
  CommandId,
  EnvironmentId,
  ThreadId,
  ProjectId,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { MobileDatabase } from "../persistence/mobile-database";
import { make } from "./deferred-thread-command-store";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function makeDatabase() {
  const values = new Map<string, string>();
  const key = (environmentId: string, kind: string, cacheKey: string) =>
    `${environmentId}:${kind}:${cacheKey}`;
  return MobileDatabase.of({
    loadCache: (environmentId, kind, cacheKey) =>
      Effect.succeed(Option.fromUndefinedOr(values.get(key(environmentId, kind, cacheKey)))),
    saveCache: (environmentId, kind, cacheKey, _schemaVersion, payload) =>
      Effect.sync(() => {
        values.set(key(environmentId, kind, cacheKey), payload);
      }),
    removeCache: (environmentId, kind, cacheKey) =>
      Effect.sync(() => {
        values.delete(key(environmentId, kind, cacheKey));
      }),
    clearCacheKind: () => Effect.void,
    clearEnvironmentCache: () => Effect.void,
    clearAllCaches: Effect.void,
    inspectCaches: Effect.succeed([]),
    loadPreferencesJson: Effect.succeed(Option.none()),
    savePreferencesJson: () => Effect.void,
  });
}

describe("mobile deferred thread command store", () => {
  it.effect("retains deletion across store recreation and isolates devices", () =>
    Effect.gen(function* () {
      const database = makeDatabase();
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, database));
      const entry = {
        command: {
          type: "thread.delete" as const,
          commandId: CommandId.make("delete"),
          threadId: ThreadId.make("thread-1"),
        },
        thread: {
          id: ThreadId.make("thread-1"),
          projectId: ProjectId.make("project-1"),
          title: "Offline row",
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access" as const,
          interactionMode: "default" as const,
          branch: null,
          worktreePath: null,
          latestTurn: null,
          createdAt: "2026-09-14T00:00:00.000Z",
          updatedAt: "2026-09-14T00:00:00.000Z",
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          latestUserMessageAt: null,
          hasPendingApprovals: false,
          hasPendingUserInput: false,
          hasActionableProposedPlan: false,
          session: null,
        },
        enqueuedAt: "2026-09-14T00:00:00.000Z",
      };
      yield* store.enqueue(ENVIRONMENT_ID, entry);
      const reloaded = yield* make().pipe(Effect.provideService(MobileDatabase, database));
      expect(yield* reloaded.list(ENVIRONMENT_ID)).toEqual([entry]);
      expect(yield* reloaded.list(EnvironmentId.make("other-device"))).toEqual([]);
    }),
  );

  it.effect("persists commands and compacts opposite actions on one axis", () =>
    Effect.gen(function* () {
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, makeDatabase()));
      yield* store.enqueue(ENVIRONMENT_ID, {
        command: {
          type: "thread.settle",
          commandId: CommandId.make("settle"),
          threadId: ThreadId.make("thread-1"),
        },
        enqueuedAt: "2026-06-06T00:00:00.000Z",
      });
      yield* store.enqueue(ENVIRONMENT_ID, {
        command: {
          type: "thread.unsettle",
          commandId: CommandId.make("unsettle"),
          threadId: ThreadId.make("thread-1"),
          reason: "user",
        },
        enqueuedAt: "2026-06-06T00:01:00.000Z",
      });
      yield* store.enqueue(ENVIRONMENT_ID, {
        command: {
          type: "thread.archive",
          commandId: CommandId.make("archive"),
          threadId: ThreadId.make("thread-1"),
        },
        enqueuedAt: "2026-06-06T00:02:00.000Z",
      });

      expect((yield* store.list(ENVIRONMENT_ID)).map((entry) => entry.command.type)).toEqual([
        "thread.unsettle",
        "thread.archive",
      ]);
    }),
  );

  it.effect("removes an acknowledged command without dropping another pending axis", () =>
    Effect.gen(function* () {
      const store = yield* make().pipe(Effect.provideService(MobileDatabase, makeDatabase()));
      yield* store.enqueue(ENVIRONMENT_ID, {
        command: {
          type: "thread.settle",
          commandId: CommandId.make("settle"),
          threadId: ThreadId.make("thread-1"),
        },
        enqueuedAt: "2026-06-06T00:00:00.000Z",
      });
      yield* store.enqueue(ENVIRONMENT_ID, {
        command: {
          type: "thread.archive",
          commandId: CommandId.make("archive"),
          threadId: ThreadId.make("thread-1"),
        },
        enqueuedAt: "2026-06-06T00:01:00.000Z",
      });

      yield* store.remove(ENVIRONMENT_ID, CommandId.make("settle"));

      expect((yield* store.list(ENVIRONMENT_ID)).map((entry) => entry.command.commandId)).toEqual([
        "archive",
      ]);
    }),
  );
});
