import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ORCHESTRATION_WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WS_METHODS,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import {
  ConnectionPersistenceError,
  DeferredThreadCommandStore,
  type DeferredThreadCommandEntry,
} from "../platform/persistence.ts";
import { EnvironmentRpcUnavailableError } from "../rpc/client.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import {
  compactDeferredThreadCommands,
  DeferredThreadCommandEntriesDocument,
  drainDeferredThreadCommands,
} from "./deferredThreadCommands.ts";
import {
  enqueueThreadTurn,
  updateOutboxMessage,
  type EnqueueThreadTurnInput,
} from "./messageOutbox.ts";

class RejectedSend extends Schema.TaggedErrorClass<RejectedSend>()("RejectedSend", {
  message: Schema.String,
}) {}

const environmentId = EnvironmentId.make("outbox-test");
const threadId = ThreadId.make("side-chat");
const input = (id = "message-1"): EnqueueThreadTurnInput => ({
  threadId,
  message: {
    messageId: MessageId.make(id),
    role: "user",
    text: "Keep this message",
    inputOrigin: "transcription",
    attachments: [
      {
        type: "image",
        name: "proof.png",
        mimeType: "image/png",
        sizeBytes: 3,
        dataUrl: "data:image/png;base64,YWJj",
      },
    ],
  },
  runtimeMode: "full-access",
  interactionMode: "agent",
  modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model: "free-test-model" },
  createdAt: "2026-09-22T12:00:00.000Z",
});
const document = Schema.fromJsonString(DeferredThreadCommandEntriesDocument);
const encode = Schema.encodeSync(document);
const decode = Schema.decodeUnknownSync(document);
const makeHarness = Effect.fn("OutboxTest.make")(function* () {
  const disk = new Map<EnvironmentId, string>();
  const store = DeferredThreadCommandStore.of({
    list: (id) =>
      Effect.sync(() => decode(disk.get(id) ?? "[]") as readonly DeferredThreadCommandEntry[]),
    enqueue: (id, entry) =>
      Effect.gen(function* () {
        const current = yield* store.list(id);
        disk.set(id, encode(compactDeferredThreadCommands(current, entry)));
      }),
    remove: (id, commandId) =>
      Effect.gen(function* () {
        disk.set(
          id,
          encode((yield* store.list(id)).filter((entry) => entry.command.commandId !== commandId)),
        );
      }),
    clear: (id) =>
      Effect.sync(() => {
        disk.delete(id);
      }),
  });
  const dispatched: ClientOrchestrationCommand[] = [];
  const session = yield* SubscriptionRef.make(Option.none<RpcSession>());
  const supervisor = EnvironmentSupervisor.of({
    target: new BearerConnectionTarget({ environmentId, label: "Remote", connectionId: "test" }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const provide = <A, E>(
    effect: Effect.Effect<A, E, EnvironmentSupervisor | DeferredThreadCommandStore>,
  ) =>
    effect.pipe(
      Effect.provideService(EnvironmentSupervisor, supervisor),
      Effect.provideService(DeferredThreadCommandStore, store),
    );
  const connect = (
    dispatch?: (
      command: ClientOrchestrationCommand,
    ) => Effect.Effect<{ sequence: number }, RejectedSend | EnvironmentRpcUnavailableError>,
    resolveWaitingCard: Effect.Effect<void, RejectedSend> = Effect.void,
  ) =>
    SubscriptionRef.set(
      session,
      Option.some({
        client: {
          [WS_METHODS.vmAgentBlockerResolve]: () => resolveWaitingCard,
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: ClientOrchestrationCommand) =>
            Effect.gen(function* () {
              dispatched.push(command);
              return dispatch ? yield* dispatch(command) : { sequence: dispatched.length };
            }),
        } as unknown as WsRpcProtocolClient,
        initialConfig: Effect.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      }),
    );
  return {
    disk,
    store,
    dispatched,
    provide,
    connect,
    drain: provide(drainDeferredThreadCommands(environmentId)),
    enqueue: (value = input()) => provide(enqueueThreadTurn(value)),
    update: (action: "retry" | "discard" | "acknowledge", id = "message-1") =>
      provide(updateOutboxMessage({ threadId, commandId: CommandId.make(`send:${id}`), action })),
  };
});

it.effect(
  "commits complete offline sends before any RPC and recovers bytes and settings from disk",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* h.enqueue();
      expect(h.dispatched).toEqual([]);
      const saved = yield* h.store.list(environmentId);
      expect(saved[0]?.command).toMatchObject({
        ...input(),
        commandId: "send:message-1",
        type: "thread.turn.start",
      });
      expect(saved[0]?.before?.map((command) => command.type)).toEqual([
        "thread.meta.update",
        "thread.runtime-mode.set",
        "thread.interaction-mode.set",
      ]);
      yield* Effect.result(h.drain);
      expect(yield* h.store.list(environmentId)).toEqual(saved);
      yield* h.connect();
      yield* h.drain;
      expect((yield* h.store.list(environmentId))[0]?.accepted).toBe(true);
    }),
);

it.effect("survives interruption while waiting for the receipt with the original IDs", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const started = yield* Deferred.make<void>();
    yield* h.enqueue();
    yield* h.connect((command) =>
      command.type === "thread.turn.start"
        ? Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never))
        : Effect.succeed({ sequence: 1 }),
    );
    const sending = yield* h.drain.pipe(Effect.forkChild);
    yield* Deferred.await(started);
    yield* Fiber.interrupt(sending);
    expect((yield* h.store.list(environmentId))[0]?.command.commandId).toBe("send:message-1");
    yield* h.connect();
    yield* h.drain;
    expect(
      h.dispatched
        .filter((command) => command.type === "thread.turn.start")
        .map((command) => command.commandId),
    ).toEqual(["send:message-1", "send:message-1"]);
  }),
);

it.effect("retries a lost acknowledgment idempotently and retains the echo until projection", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const receipts = new Map<string, { sequence: number }>();
    const accepted: string[] = [];
    let loseReceipt = true;
    yield* h.enqueue();
    yield* h.connect((command) =>
      Effect.gen(function* () {
        let receipt = receipts.get(command.commandId);
        if (!receipt) {
          receipt = { sequence: receipts.size + 1 };
          receipts.set(command.commandId, receipt);
          if (command.type === "thread.turn.start") accepted.push(command.message.messageId);
        }
        if (command.type === "thread.turn.start" && loseReceipt) {
          loseReceipt = false;
          return yield* new EnvironmentRpcUnavailableError({
            environmentId,
            message: "Socket closed after commit",
          });
        }
        return receipt;
      }),
    );
    yield* Effect.result(h.drain);
    yield* h.drain;
    expect(accepted).toEqual(["message-1"]);
    const calls = h.dispatched.length;
    yield* h.drain;
    expect(h.dispatched).toHaveLength(calls);
    expect((yield* h.store.list(environmentId))[0]?.accepted).toBe(true);
    yield* h.update("acknowledge");
    expect(yield* h.store.list(environmentId)).toEqual([]);
  }),
);

it.effect("keeps a rejected send, holds its successors, and delivers other threads", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.enqueue();
    yield* h.enqueue(input("message-2"));
    yield* h.enqueue({ ...input("other"), threadId: ThreadId.make("parent-chat") });
    yield* h.connect((command) =>
      "threadId" in command && command.threadId === threadId
        ? Effect.fail(new RejectedSend({ message: "Provider selection is invalid" }))
        : Effect.succeed({ sequence: 1 }),
    );
    yield* h.drain;
    const saved = yield* h.store.list(environmentId);
    expect(saved[0]?.error).toContain("Provider selection is invalid");
    expect(saved[1]?.accepted).toBeUndefined();
    expect(saved[2]?.accepted).toBe(true);
    yield* h.update("retry");
    yield* h.connect();
    yield* h.drain;
    expect((yield* h.store.list(environmentId)).every((entry) => entry.accepted)).toBe(true);
  }),
);

it.effect("a storage failure does not dispatch or claim the send was queued", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const broken = {
      ...h.store,
      enqueue: () =>
        Effect.fail(
          new ConnectionPersistenceError({
            operation: "save-deferred-thread-command",
            message: "Disk full",
          }),
        ),
    };
    const result = yield* h
      .provide(
        enqueueThreadTurn(input()).pipe(Effect.provideService(DeferredThreadCommandStore, broken)),
      )
      .pipe(Effect.result);
    expect(result._tag).toBe("Failure");
    expect(h.dispatched).toEqual([]);
    expect(yield* h.store.list(environmentId)).toEqual([]);
  }),
);

it.effect("stores repeated messages independently while deduplicating a repeated enqueue", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.enqueue();
    yield* h.enqueue();
    yield* h.enqueue(input("message-2"));
    yield* h.store.enqueue(environmentId, {
      command: { type: "thread.delete", threadId, commandId: CommandId.make("delete") },
      enqueuedAt: "2026-09-22T13:00:00.000Z",
    });
    expect((yield* h.store.list(environmentId)).map((entry) => entry.command.commandId)).toEqual([
      "send:message-1",
      "send:message-2",
      "delete",
    ]);
  }),
);

it.effect("keeps bootstrap creation and worktree preparation inside one saved send", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const value = input();
    yield* h.enqueue({
      ...value,
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project"),
          title: "Task",
          modelSelection: value.modelSelection!,
          runtimeMode: "full-access",
          interactionMode: "agent",
          branch: "main",
          worktreePath: null,
          createdAt: value.createdAt!,
        },
        prepareWorktree: { projectCwd: "/workspace", baseBranch: "main", branch: "task" },
        runSetupScript: true,
      },
    });
    expect((yield* h.store.list(environmentId))[0]?.before).toEqual([]);
    yield* h.connect();
    yield* h.drain;
    expect(h.dispatched).toHaveLength(1);
    expect(h.dispatched[0]).toHaveProperty("bootstrap.prepareWorktree.branch", "task");
  }),
);

it.effect("only explicitly rejected sends can be discarded", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    yield* h.enqueue();
    yield* h.update("discard");
    expect(yield* h.store.list(environmentId)).toHaveLength(1);
    yield* h.connect(() => Effect.fail(new RejectedSend({ message: "Rejected" })));
    yield* h.drain;
    yield* h.update("discard");
    expect(yield* h.store.list(environmentId)).toEqual([]);
  }),
);

it.effect("a hung connection times out without losing the saved send", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const sending = yield* Deferred.make<void>();
    yield* h.enqueue();
    yield* h.connect(() => Deferred.succeed(sending, undefined).pipe(Effect.andThen(Effect.never)));
    const drain = yield* Effect.result(h.drain).pipe(Effect.forkChild);
    yield* Deferred.await(sending);
    yield* TestClock.adjust("30 seconds");
    expect((yield* Fiber.join(drain))._tag).toBe("Failure");
    expect((yield* h.store.list(environmentId))[0]?.error).toBeUndefined();
    expect((yield* h.store.list(environmentId))[0]?.accepted).toBeUndefined();
    yield* h.connect();
    yield* h.drain;
    expect((yield* h.store.list(environmentId))[0]?.accepted).toBe(true);
  }),
);

it.effect(
  "resolves waiting cards only after delivery and never lets a hung card block other sends",
  () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const resolving = yield* Deferred.make<void>();
      yield* h.enqueue({
        ...input(),
        afterReply: { vmAgentId: "agent", blockerId: "blocker", answeredInChat: true },
      });
      yield* h.enqueue(input("message-2"));
      expect(h.dispatched).toEqual([]);
      yield* h.connect(
        undefined,
        Effect.gen(function* () {
          expect(h.dispatched.at(-1)?.type).toBe("thread.turn.start");
          yield* Deferred.succeed(resolving, undefined);
          return yield* Effect.never;
        }),
      );
      const drain = yield* h.drain.pipe(Effect.forkChild);
      yield* Deferred.await(resolving);
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(drain);
      expect((yield* h.store.list(environmentId)).every((entry) => entry.accepted)).toBe(true);
    }),
);

it.effect("finishes saving a message even if its caller disappears during the local write", () =>
  Effect.gen(function* () {
    const h = yield* makeHarness();
    const writing = yield* Deferred.make<void>();
    const commit = yield* Deferred.make<void>();
    const delayedStore = {
      ...h.store,
      enqueue: (id: EnvironmentId, entry: DeferredThreadCommandEntry) =>
        Effect.gen(function* () {
          yield* Deferred.succeed(writing, undefined);
          yield* Deferred.await(commit);
          yield* h.store.enqueue(id, entry);
        }),
    };
    const send = yield* h
      .provide(
        enqueueThreadTurn(input()).pipe(
          Effect.provideService(DeferredThreadCommandStore, delayedStore),
        ),
      )
      .pipe(Effect.forkChild);
    yield* Deferred.await(writing);
    const interrupt = yield* Fiber.interrupt(send).pipe(Effect.forkChild);
    yield* Deferred.succeed(commit, undefined);
    yield* Fiber.join(interrupt);
    expect((yield* h.store.list(environmentId))[0]?.command.commandId).toBe("send:message-1");
    yield* h.connect();
    yield* h.drain;
    expect((yield* h.store.list(environmentId))[0]?.accepted).toBe(true);
  }),
);
