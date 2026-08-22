import {
  ApprovalRequestId,
  CommandId,
  EnvironmentId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as RpcSession from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import * as Persistence from "../platform/persistence.ts";
import {
  archiveThread,
  createProject,
  respondToThreadApproval,
  respondToThreadUserInput,
  settleThread,
  stopThreadSession,
  unsettleThread,
} from "./commands.ts";
import {
  compactDeferredThreadCommands,
  drainDeferredThreadCommands,
} from "./deferredThreadCommands.ts";

const TEST_CRYPTO_LAYER = Layer.succeed(
  Crypto.Crypto,
  Crypto.make({
    randomBytes: (size) => new Uint8Array(size),
    digest: (_algorithm, data) => Effect.succeed(data),
  }),
);
const TEST_DEFERRED_COMMAND_LAYER = Layer.succeed(
  Persistence.DeferredThreadCommandStore,
  Persistence.DeferredThreadCommandStore.of({
    list: () => Effect.succeed([]),
    enqueue: () => Effect.void,
    remove: () => Effect.void,
    clear: () => Effect.void,
  }),
);
const TEST_COMMAND_LAYER = Layer.merge(TEST_CRYPTO_LAYER, TEST_DEFERRED_COMMAND_LAYER);

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("environment-1"),
  label: "Test environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});
const REMOTE_TARGET = new BearerConnectionTarget({
  environmentId: EnvironmentId.make("remote-environment"),
  label: "Remote environment",
  connectionId: "remote-connection",
});

const makeSupervisor = Effect.fn("TestEnvironmentCommands.makeSupervisor")(function* (
  dispatched: ClientOrchestrationCommand[],
) {
  const client = {
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: dispatched.length };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession.RpcSession = {
    client,
    initialConfig: Effect.never,
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

const makeOfflineRemoteSupervisor = Effect.fn(
  "TestEnvironmentCommands.makeOfflineRemoteSupervisor",
)(function* () {
  return EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: REMOTE_TARGET,
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.none<RpcSession.RpcSession>()),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  } satisfies EnvironmentSupervisor.EnvironmentSupervisor["Service"]);
});

describe("environment commands", () => {
  it.effect("queues a remote settle while its environment is offline", () =>
    Effect.gen(function* () {
      const entries = yield* Ref.make<ReadonlyArray<Persistence.DeferredThreadCommandEntry>>([]);
      const store = Persistence.DeferredThreadCommandStore.of({
        list: () => Ref.get(entries),
        enqueue: (_environmentId, entry) => Ref.update(entries, (current) => [...current, entry]),
        remove: (_environmentId, commandId) =>
          Ref.update(entries, (current) =>
            current.filter((entry) => entry.command.commandId !== commandId),
          ),
        clear: () => Ref.set(entries, []),
      });
      const supervisor = yield* makeOfflineRemoteSupervisor();

      const result = yield* settleThread({
        commandId: CommandId.make("offline-settle"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.DeferredThreadCommandStore, store),
      );

      expect(result).toEqual({ _tag: "Deferred" });
      expect((yield* Ref.get(entries)).map((entry) => entry.command)).toEqual([
        {
          type: "thread.settle",
          commandId: "offline-settle",
          threadId: "thread-1",
        },
      ]);
    }).pipe(Effect.provide(TEST_CRYPTO_LAYER)),
  );

  it.effect("drains a queued command with its original id after reconnect", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      const entries = yield* Ref.make<ReadonlyArray<Persistence.DeferredThreadCommandEntry>>([
        {
          command: {
            type: "thread.archive",
            commandId: CommandId.make("queued-archive"),
            threadId: ThreadId.make("thread-1"),
          },
          enqueuedAt: "2026-06-06T00:00:00.000Z",
        },
      ]);
      const store = Persistence.DeferredThreadCommandStore.of({
        list: () => Ref.get(entries),
        enqueue: () => Effect.void,
        remove: (_environmentId, commandId) =>
          Ref.update(entries, (current) =>
            current.filter((entry) => entry.command.commandId !== commandId),
          ),
        clear: () => Ref.set(entries, []),
      });

      yield* drainDeferredThreadCommands(TARGET.environmentId).pipe(
        Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
        Effect.provideService(Persistence.DeferredThreadCommandStore, store),
      );

      expect(dispatched).toEqual([
        {
          type: "thread.archive",
          commandId: "queued-archive",
          threadId: "thread-1",
        },
      ]);
      expect(yield* Ref.get(entries)).toEqual([]);
    }),
  );

  it("compacts opposite offline actions on the same thread axis", () => {
    const settled: Persistence.DeferredThreadCommandEntry = {
      command: {
        type: "thread.settle",
        commandId: CommandId.make("settle"),
        threadId: ThreadId.make("thread-1"),
      },
      enqueuedAt: "2026-06-06T00:00:00.000Z",
    };
    const unsettled: Persistence.DeferredThreadCommandEntry = {
      command: {
        type: "thread.unsettle",
        commandId: CommandId.make("unsettle"),
        threadId: ThreadId.make("thread-1"),
        reason: "user",
      },
      enqueuedAt: "2026-06-06T00:01:00.000Z",
    };
    expect(compactDeferredThreadCommands([settled], unsettled)).toEqual([unsettled]);
  });

  it.effect("adds generated command metadata", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      const result = yield* createProject({
        projectId: ProjectId.make("project-1"),
        title: "Project",
        workspaceRoot: "/workspace/project",
        createdAt: "2026-06-06T00:00:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(result).toEqual({ sequence: 1 });
      expect(dispatched).toEqual([
        {
          type: "project.create",
          commandId: "00000000-0000-4000-8000-000000000000",
          projectId: "project-1",
          title: "Project",
          workspaceRoot: "/workspace/project",
          createdAt: "2026-06-06T00:00:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_COMMAND_LAYER)),
  );

  it.effect("preserves caller metadata for idempotent queued commands", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* stopThreadSession({
        commandId: CommandId.make("queued-command"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-06-06T00:01:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.session.stop",
          commandId: "queued-command",
          threadId: "thread-1",
          createdAt: "2026-06-06T00:01:00.000Z",
        },
      ]);
    }).pipe(Effect.provide(TEST_COMMAND_LAYER)),
  );

  it.effect("derives approval response command ids from the request", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      const input = {
        threadId: ThreadId.make("thread-1"),
        requestId: ApprovalRequestId.make("approval-request-1"),
        decision: "accept" as const,
      };

      yield* respondToThreadApproval({
        ...input,
        createdAt: "2026-06-06T00:01:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* respondToThreadApproval({
        ...input,
        createdAt: "2026-06-06T00:01:01.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched.map((command) => command.commandId)).toEqual([
        'thread.approval.respond:["thread-1","approval-request-1"]',
        'thread.approval.respond:["thread-1","approval-request-1"]',
      ]);
    }).pipe(Effect.provide(TEST_COMMAND_LAYER)),
  );

  it.effect("derives user-input response command ids from the request", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);
      const input = {
        threadId: ThreadId.make("thread-1"),
        requestId: ApprovalRequestId.make("user-input-request-1"),
        answers: { sandbox_mode: "workspace-write" },
      };

      yield* respondToThreadUserInput({
        ...input,
        createdAt: "2026-06-06T00:02:00.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* respondToThreadUserInput({
        ...input,
        createdAt: "2026-06-06T00:02:01.000Z",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched.map((command) => command.commandId)).toEqual([
        'thread.user-input.respond:["thread-1","user-input-request-1"]',
        'thread.user-input.respond:["thread-1","user-input-request-1"]',
      ]);
    }).pipe(Effect.provide(TEST_COMMAND_LAYER)),
  );

  it.effect("does not add timestamps to commands without createdAt", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* archiveThread({
        commandId: CommandId.make("archive-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.archive",
          commandId: "archive-command",
          threadId: "thread-1",
        },
      ]);
    }).pipe(Effect.provide(TEST_COMMAND_LAYER)),
  );

  it.effect("dispatches settle and unsettle commands without timestamps", () =>
    Effect.gen(function* () {
      const dispatched: ClientOrchestrationCommand[] = [];
      const supervisor = yield* makeSupervisor(dispatched);

      yield* settleThread({
        commandId: CommandId.make("settle-command"),
        threadId: ThreadId.make("thread-1"),
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));
      yield* unsettleThread({
        commandId: CommandId.make("unsettle-command"),
        threadId: ThreadId.make("thread-1"),
        reason: "user",
      }).pipe(Effect.provideService(EnvironmentSupervisor.EnvironmentSupervisor, supervisor));

      expect(dispatched).toEqual([
        {
          type: "thread.settle",
          commandId: "settle-command",
          threadId: "thread-1",
        },
        {
          type: "thread.unsettle",
          commandId: "unsettle-command",
          threadId: "thread-1",
          reason: "user",
        },
      ]);
    }).pipe(Effect.provide(TEST_COMMAND_LAYER)),
  );
});
