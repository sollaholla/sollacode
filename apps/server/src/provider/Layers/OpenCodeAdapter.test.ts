import * as NodeAssert from "node:assert/strict";
import { isTerminalProviderRefusal } from "@t3tools/shared/agentMode";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { beforeEach } from "vite-plus/test";

import {
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import {
  appendOpenCodeAssistantTextDelta,
  isOpenCodeNotFound,
  isSameOpenCodeDirectory,
  makeOpenCodeAdapter,
  mergeOpenCodeAssistantText,
  isOpenCodeRetryableUpstreamError,
  openCodeBillingRefusalMessage,
  openCodeGatewayUpstreamStatus,
  openCodeOverloadRetryReason,
  sessionErrorMessage,
  unwrapOpenCodeErrorBody,
} from "./OpenCodeAdapter.ts";

// Test-local service tag so the rest of the file can keep using `yield* OpenCodeAdapter`.
class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "t3/provider/Layers/OpenCodeAdapter.test/OpenCodeAdapter",
) {}

const asThreadId = (value: string): ThreadId => ThreadId.make(value);

type MessageEntry = {
  info: {
    id: string;
    role: "user" | "assistant";
  };
  parts: Array<unknown>;
};

const runtimeMock = {
  state: {
    startCalls: [] as string[],
    sessionCreateUrls: [] as string[],
    sessionCreateInputs: [] as Array<Record<string, unknown>>,
    authHeaders: [] as Array<string | null>,
    abortCalls: [] as string[],
    closeCalls: [] as string[],
    revertCalls: [] as Array<{ sessionID: string; messageID?: string }>,
    promptCalls: [] as Array<unknown>,
    promptAsyncError: null as Error | null,
    abortGate: undefined as Promise<void> | undefined,
    onAbort: undefined as (() => void) | undefined,
    closeError: null as Error | null,
    messages: [] as MessageEntry[],
    subscribedEvents: [] as unknown[],
    subscribedEventsGate: undefined as Promise<void> | undefined,
    sessionGetIds: [] as string[],
    missingSessionIds: new Set<string>(),
    transientErrorSessionIds: new Set<string>(),
    sessionDirectoryById: new Map<string, string>(),
    sessionUsageById: new Map<string, { cost: number; time: { updated: number } }>(),
    sessionUpdateCalls: [] as Array<{ sessionID: string; permission: unknown }>,
    forkCalls: [] as Array<{ sessionID: string; directory?: string }>,
    summarizeCalls: [] as Array<Record<string, unknown>>,
    summarizeResult: true as boolean,
    summarizeError: null as Error | null,
  },
  reset() {
    this.state.startCalls.length = 0;
    this.state.sessionCreateUrls.length = 0;
    this.state.sessionCreateInputs.length = 0;
    this.state.authHeaders.length = 0;
    this.state.abortCalls.length = 0;
    this.state.closeCalls.length = 0;
    this.state.revertCalls.length = 0;
    this.state.promptCalls.length = 0;
    this.state.promptAsyncError = null;
    this.state.abortGate = undefined;
    this.state.onAbort = undefined;
    this.state.closeError = null;
    this.state.messages = [];
    this.state.subscribedEvents = [];
    this.state.subscribedEventsGate = undefined;
    this.state.sessionGetIds.length = 0;
    this.state.missingSessionIds.clear();
    this.state.transientErrorSessionIds.clear();
    this.state.sessionDirectoryById.clear();
    this.state.sessionUsageById.clear();
    this.state.sessionUpdateCalls.length = 0;
    this.state.forkCalls.length = 0;
    this.state.summarizeCalls.length = 0;
    this.state.summarizeResult = true;
    this.state.summarizeError = null;
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: ({ binaryPath }) =>
    Effect.gen(function* () {
      runtimeMock.state.startCalls.push(binaryPath);
      const url = "http://127.0.0.1:4301";
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: Effect.never,
      };
    }),
  connectToOpenCodeServer: ({ serverUrl }) =>
    Effect.gen(function* () {
      const url = serverUrl ?? "http://127.0.0.1:4301";
      // Always register a finalizer so the closeCalls/closeError probes fire;
      // production attaches none for external servers.
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          runtimeMock.state.closeCalls.push(url);
          if (runtimeMock.state.closeError) {
            throw runtimeMock.state.closeError;
          }
        }),
      );
      return {
        url,
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () => Effect.succeed({ stdout: "", stderr: "", code: 0 }),
  createOpenCodeSdkClient: ({ baseUrl, serverPassword }) =>
    ({
      session: {
        create: async (input: Record<string, unknown>) => {
          runtimeMock.state.sessionCreateUrls.push(baseUrl);
          runtimeMock.state.sessionCreateInputs.push(input);
          runtimeMock.state.authHeaders.push(
            serverPassword ? `Basic ${btoa(`opencode:${serverPassword}`)}` : null,
          );
          return { data: { id: `${baseUrl}/session` } };
        },
        get: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.sessionGetIds.push(sessionID);
          // The real client is `throwOnError: true`: non-2xx rejects rather
          // than resolving, so missing → 404 throw, transient → 500 throw.
          if (runtimeMock.state.transientErrorSessionIds.has(sessionID)) {
            throw new Error("opencode server error", { cause: { status: 500 } });
          }
          if (runtimeMock.state.missingSessionIds.has(sessionID)) {
            throw new Error(`Session not found: ${sessionID}`, {
              cause: { status: 404, body: { name: "NotFoundError" } },
            });
          }
          const directory = runtimeMock.state.sessionDirectoryById.get(sessionID);
          return {
            data: {
              id: sessionID,
              ...(directory ? { directory } : {}),
              ...runtimeMock.state.sessionUsageById.get(sessionID),
            },
          };
        },
        update: async ({ sessionID, permission }: { sessionID: string; permission: unknown }) => {
          runtimeMock.state.sessionUpdateCalls.push({ sessionID, permission });
          return { data: { id: sessionID } };
        },
        fork: async ({ sessionID, directory }: { sessionID: string; directory?: string }) => {
          // Fork clones history into a new session bound to the directory.
          const forkedId = `${sessionID}_fork`;
          runtimeMock.state.forkCalls.push({ sessionID, ...(directory ? { directory } : {}) });
          if (directory) {
            runtimeMock.state.sessionDirectoryById.set(forkedId, directory);
          }
          return { data: { id: forkedId, ...(directory ? { directory } : {}) } };
        },
        summarize: async (input: Record<string, unknown>) => {
          runtimeMock.state.summarizeCalls.push(input);
          if (runtimeMock.state.summarizeError) {
            throw runtimeMock.state.summarizeError;
          }
          return { data: runtimeMock.state.summarizeResult };
        },
        abort: async ({ sessionID }: { sessionID: string }) => {
          runtimeMock.state.abortCalls.push(sessionID);
          runtimeMock.state.onAbort?.();
          await runtimeMock.state.abortGate;
        },
        promptAsync: async (input: unknown) => {
          runtimeMock.state.promptCalls.push(input);
          if (runtimeMock.state.promptAsyncError) {
            throw runtimeMock.state.promptAsyncError;
          }
        },
        messages: async () => ({ data: runtimeMock.state.messages }),
        revert: async ({ sessionID, messageID }: { sessionID: string; messageID?: string }) => {
          runtimeMock.state.revertCalls.push({
            sessionID,
            ...(messageID ? { messageID } : {}),
          });
          if (!messageID) {
            runtimeMock.state.messages = [];
            return;
          }

          const targetIndex = runtimeMock.state.messages.findIndex(
            (entry) => entry.info.id === messageID,
          );
          runtimeMock.state.messages =
            targetIndex >= 0
              ? runtimeMock.state.messages.slice(0, targetIndex + 1)
              : runtimeMock.state.messages;
        },
      },
      event: {
        subscribe: async () => ({
          stream: (async function* () {
            await runtimeMock.state.subscribedEventsGate;
            for (const event of runtimeMock.state.subscribedEvents) {
              yield event;
            }
          })(),
        }),
      },
    }) as unknown as ReturnType<OpenCodeRuntimeShape["createOpenCodeSdkClient"]>,
  loadOpenCodeInventory: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadOpenCodeInventory",
        detail: "OpenCodeRuntimeTestDouble.loadOpenCodeInventory not used in this test",
        cause: null,
      }),
    ),
  loadInventoryFromCli: () =>
    Effect.fail(
      new OpenCodeRuntimeError({
        operation: "loadInventoryFromCli",
        detail: "OpenCodeRuntimeTestDouble.loadInventoryFromCli not used in this test",
        cause: null,
      }),
    ),
};

const providerSessionDirectoryTestLayer = Layer.succeed(ProviderSessionDirectory, {
  upsert: () => Effect.void,
  upsertIfCurrent: () => Effect.succeed(false),
  getProvider: () =>
    Effect.die(new Error("ProviderSessionDirectory.getProvider is not used in test")),
  getBinding: () => Effect.succeed(Option.none()),
  listThreadIds: () => Effect.succeed([]),
  listBindings: () => Effect.succeed([]),
});

// The adapter now receives its settings as a plain argument (the old design
// read from `ServerSettingsService` internally). The test-only
// `ServerSettingsService` below is still kept because other dependencies in
// the layer graph reach for it — but the routing values the assertions
// probe (serverUrl, serverPassword) must be threaded directly through the
// decoded `OpenCodeSettings`.
const openCodeAdapterTestSettings = Schema.decodeSync(OpenCodeSettings)({
  binaryPath: "fake-opencode",
  serverUrl: "http://127.0.0.1:9999",
  serverPassword: "secret-password",
});

const OpenCodeAdapterTestLayer = Layer.effect(
  OpenCodeAdapter,
  makeOpenCodeAdapter(openCodeAdapterTestSettings),
).pipe(
  Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(
    ServerSettingsService.layerTest({
      providers: {
        opencode: {
          binaryPath: "fake-opencode",
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        },
      },
    }),
  ),
  Layer.provideMerge(providerSessionDirectoryTestLayer),
  Layer.provideMerge(NodeServices.layer),
);

beforeEach(() => {
  runtimeMock.reset();
});

const advanceTestClock = (ms: number) =>
  TestClock.adjust(`${ms} millis`).pipe(Effect.andThen(Effect.yieldNow));

/** Fork one reader of the adapter's single event queue and hand back its log. */
const collectThreadEvents = (adapter: OpenCodeAdapterShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const seen: Array<ProviderRuntimeEvent> = [];
    yield* adapter.streamEvents.pipe(
      Stream.filter((event) => event.threadId === threadId),
      Stream.runForEach((event) => Effect.sync(() => seen.push(event))),
      Effect.forkChild,
    );
    return seen;
  });

/** Poll `listSessions`, yielding to the event pump between reads, until `predicate` holds. */
const waitForSession = (
  adapter: OpenCodeAdapterShape,
  threadId: ThreadId,
  predicate: (session: ProviderSession) => boolean,
) =>
  Effect.gen(function* () {
    let session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
    for (
      let attempt = 0;
      attempt < 500 && (session === undefined || !predicate(session));
      attempt += 1
    ) {
      yield* advanceTestClock(1);
      session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
    }
    return session;
  });

it.layer(OpenCodeAdapterTestLayer)("OpenCodeAdapterLive", (it) => {
  const sessionID = "http://127.0.0.1:9999/session";
  const message = (role: "assistant" | "user" = "assistant", extra = {}) => ({
    type: "message.updated",
    properties: { info: { id: "msg-edge", sessionID, role, ...extra } },
  });
  const textPart = {
    id: "part-edge",
    messageID: "msg-edge",
    sessionID,
    type: "text",
    text: "Hello",
    time: { start: 1 },
  };
  const update = (part: unknown) => ({ type: "message.part.updated", properties: { part } });
  const delta = (extra = {}) => ({
    type: "message.part.delta",
    properties: {
      sessionID,
      messageID: "msg-edge",
      partID: "part-edge",
      field: "text",
      delta: " world",
      ...extra,
    },
  });
  let replayId = 0;
  const replay = (
    nativeEvents: unknown[],
    interrupt: boolean | "during-abort" = false,
    resumeSessionId?: string,
  ) =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId(`thread-event-edge-${++replayId}`);
      let release!: () => void;
      runtimeMock.state.subscribedEventsGate = new Promise<void>((resolve) => {
        release = resolve;
      });
      runtimeMock.state.subscribedEvents = [
        ...nativeEvents,
        {
          type: "session.updated",
          properties: { info: { id: sessionID, title: "replay-drained" } },
        },
      ];
      const fiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) =>
            event.type === "thread.metadata.updated" && event.payload.name === "replay-drained",
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        ...(resumeSessionId
          ? { resumeCursor: { schemaVersion: 1, sessionId: resumeSessionId } }
          : {}),
      });
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "fixture",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode/big-pickle",
        },
      });
      let releaseAbort: (() => void) | undefined;
      if (interrupt === "during-abort") {
        runtimeMock.state.abortGate = new Promise<void>((resolve) => {
          releaseAbort = resolve;
        });
        runtimeMock.state.onAbort = release;
      }
      const abortFiber =
        interrupt === "during-abort"
          ? yield* adapter.interruptTurn(threadId, turn.turnId).pipe(Effect.forkChild)
          : undefined;
      if (interrupt === true) yield* adapter.interruptTurn(threadId, turn.turnId);
      if (interrupt !== "during-abort") release();
      const events = Array.from(yield* Fiber.join(fiber));
      releaseAbort?.();
      if (abortFiber) yield* Fiber.join(abortFiber);
      yield* adapter.stopSession(threadId);
      return { events, turn };
    });

  it.effect("preserves deltas that arrive before the assistant message metadata", () =>
    Effect.gen(function* () {
      const { events, turn } = yield* replay([
        update(textPart),
        delta(),
        message(),
        update({ ...textPart, text: "Hello world", time: { start: 1, end: 2 } }),
      ]);
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => event.payload.delta),
        ["Hello world"],
      );
      NodeAssert.ok(deltas.every((event) => event.turnId === turn.turnId));
      NodeAssert.equal(events.filter((event) => event.type === "item.completed").length, 1);
    }),
  );

  it.effect("never publishes delayed user text as assistant output", () =>
    Effect.gen(function* () {
      const { events } = yield* replay([update(textPart), delta(), message("user")]);
      NodeAssert.equal(events.filter((event) => event.type === "content.delta").length, 0);
    }),
  );

  it.effect(
    "ignores foreign sessions, mismatched message IDs, non-text fields and deltas after completion",
    () =>
      Effect.gen(function* () {
        const { events } = yield* replay([
          message(),
          update(textPart),
          delta({ sessionID: "foreign" }),
          delta({ messageID: "wrong" }),
          delta({ field: "time" }),
          update({ ...textPart, time: { start: 1, end: 2 } }),
          delta(),
        ]);
        NodeAssert.deepEqual(
          events
            .filter((event) => event.type === "content.delta")
            .map((event) => event.payload.delta),
          ["Hello"],
        );
      }),
  );

  it.effect("keeps reasoning in its own stream and ignores tool-output deltas", () =>
    Effect.gen(function* () {
      const tool = {
        id: "tool-part",
        messageID: "msg-edge",
        sessionID,
        type: "tool",
        callID: "tool-call",
        tool: "bash",
        state: { status: "running", input: {}, title: "test", time: { start: 1 } },
      };
      const { events } = yield* replay([
        message(),
        update({ ...textPart, type: "reasoning" }),
        delta(),
        update(tool),
        delta({ partID: "tool-part", field: "output" }),
      ]);
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => event.payload.delta),
        ["Hello", " world"],
      );
      NodeAssert.ok(deltas.every((event) => event.payload.streamKind === "reasoning_text"));
    }),
  );

  it.effect("does not duplicate or reopen a terminal tool on replay", () =>
    Effect.gen(function* () {
      const tool = {
        id: "tool-part",
        messageID: "msg-edge",
        sessionID,
        type: "tool",
        callID: "tool-call",
        tool: "bash",
        state: {
          status: "completed",
          input: {},
          output: "passed",
          title: "test",
          metadata: {},
          time: { start: 1, end: 2 },
        },
      };
      const { events } = yield* replay([
        message(),
        update(tool),
        update(tool),
        update({ ...tool, state: { ...tool.state, status: "running" } }),
      ]);
      const lifecycle = events.filter((event) => event.itemId === "tool-call");
      NodeAssert.deepEqual(
        lifecycle.map((event) => event.type),
        ["item.completed"],
      );
    }),
  );

  it.effect("tracks completed usage once and ignores stale and foreign snapshots", () =>
    Effect.gen(function* () {
      const tokens = { input: 100, output: 30, reasoning: 10, cache: { read: 50, write: 20 } };
      const { events } = yield* replay([
        message("assistant", { tokens, time: { created: 1 } }),
        message("assistant", { tokens, time: { created: 1, completed: 20 } }),
        message("assistant", { tokens, time: { created: 1, completed: 20 } }),
        message("assistant", { id: "older", tokens, time: { created: 1, completed: 10 } }),
        message("assistant", { sessionID: "foreign", tokens, time: { created: 1, completed: 30 } }),
      ]);
      const usage = events.filter((event) => event.type === "thread.token-usage.updated");
      NodeAssert.equal(usage.length, 1);
      NodeAssert.equal(usage[0]?.payload.usage.usedTokens, 210);
    }),
  );

  it.effect(
    "uses native cumulative session cost without replay double counting or cross-session leakage",
    () =>
      Effect.gen(function* () {
        const snapshot = (cost: unknown, updated: number, id = sessionID) => ({
          type: "session.updated",
          properties: { info: { id, cost, time: { updated } } },
        });
        const { events } = yield* replay([
          snapshot(0, 10),
          snapshot(1.25, 20),
          snapshot(1.25, 20),
          snapshot(0.5, 15),
          snapshot(99, 30, "foreign"),
          snapshot(NaN, 30),
          snapshot(-1, 30),
          snapshot(undefined, 30),
          snapshot(1.5, 30),
        ]);
        const reports = events.filter((event) => event.type === "account.rate-limits.updated");
        NodeAssert.deepEqual(
          reports.map((event) => event.payload.rateLimits),
          [0, 1.25, 1.5].map((cost, i) => ({
            source: "opencode-session",
            sessionId: sessionID,
            sessionCost: cost,
            updatedAt: (i + 1) * 10,
          })),
        );
        const other = yield* replay([snapshot(0, 10)]);
        NodeAssert.equal(
          other.events.filter((event) => event.type === "account.rate-limits.updated").length,
          1,
        );
      }),
  );

  it.effect("restores the native session total on resume without loading message history", () =>
    Effect.gen(function* () {
      runtimeMock.state.sessionUsageById.set(sessionID, { cost: 2.5, time: { updated: 50 } });
      const { events } = yield* replay(
        [
          {
            type: "session.updated",
            properties: { info: { id: sessionID, cost: 1, time: { updated: 20 } } },
          },
          {
            type: "session.updated",
            properties: { info: { id: sessionID, cost: 3, time: { updated: 60 } } },
          },
        ],
        false,
        sessionID,
      );
      const reports = events.filter((event) => event.type === "account.rate-limits.updated");
      NodeAssert.deepEqual(
        reports.map((event) => event.payload.rateLimits),
        [
          { source: "opencode-session", sessionId: sessionID, sessionCost: 2.5, updatedAt: 50 },
          { source: "opencode-session", sessionId: sessionID, sessionCost: 3, updatedAt: 60 },
        ],
      );
    }),
  );

  it.effect("closes an interrupted turn as interrupted when idle precedes the abort error", () =>
    Effect.gen(function* () {
      const { events } = yield* replay(
        [
          { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
          {
            type: "session.error",
            properties: {
              sessionID,
              error: { name: "MessageAbortedError", data: { message: "Aborted" } },
            },
          },
          { type: "session.status", properties: { sessionID, status: { type: "idle" } } },
        ],
        true,
      );
      const completed = events.filter((event) => event.type === "turn.completed");
      NodeAssert.deepEqual(
        completed.map((event) => event.payload.state),
        ["interrupted"],
      );
      NodeAssert.equal(events.filter((event) => event.type === "turn.aborted").length, 1);
      NodeAssert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
    }),
  );

  it.effect("handles native idle arriving before the abort RPC resolves", () =>
    Effect.gen(function* () {
      const { events } = yield* replay(
        [{ type: "session.status", properties: { sessionID, status: { type: "idle" } } }],
        "during-abort",
      );
      NodeAssert.deepEqual(
        events
          .filter((event) => event.type === "turn.completed")
          .map((event) => event.payload.state),
        ["interrupted"],
      );
      NodeAssert.equal(events.filter((event) => event.type === "turn.aborted").length, 1);
    }),
  );

  it.effect("rejects Jev as a coding model before starting a turn or submitting a prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-jev-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      for (const model of [
        "opencode/jev-1.13-free",
        "opencode/jev-1.13",
        "openrouter/typesafe/jev-latest",
      ]) {
        const error = yield* adapter
          .sendTurn({
            threadId,
            input: "write code",
            modelSelection: { instanceId: ProviderInstanceId.make("opencode"), model },
          })
          .pipe(Effect.flip);
        NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      }
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 0);
      NodeAssert.equal((yield* adapter.listSessions())[0]?.status, "ready");
      yield* adapter.stopSession(threadId);
    }),
  );
  it.effect("reuses a configured OpenCode server URL instead of spawning a local server", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      NodeAssert.equal(session.provider, "opencode");
      NodeAssert.equal(session.threadId, "thread-opencode");
      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(runtimeMock.state.authHeaders, [
        `Basic ${btoa("opencode:secret-password")}`,
      ]);
    }),
  );

  it.effect("returns a durable resume cursor for a freshly created session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-cursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      // Without a persisted cursor, a session is created and its id is
      // surfaced as a resume cursor so the upper layer can persist it.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("resumes the persisted OpenCode session instead of creating a new one", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      // The adapter validates the persisted id with session.get and re-adopts
      // it — no new session is minted (issue #3604).
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_persisted"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });
      // Resume re-asserts the permission ruleset for the current runtimeMode.
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_persisted");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("sends follow-up turns to the resumed session id", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-resume-turn");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_persisted" },
      });

      const result = yield* adapter.sendTurn({
        threadId,
        input: "continue where we left off",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode"),
          "anthropic/sonnet",
        ),
      });

      // The prompt targets the resumed id, and the turn re-surfaces the cursor.
      NodeAssert.deepEqual(
        (runtimeMock.state.promptCalls[0] as { sessionID: string }).sessionID,
        "ses_persisted",
      );
      NodeAssert.deepEqual(result.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_persisted",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("falls back to a fresh session when the persisted session is gone", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stale");
      runtimeMock.state.missingSessionIds.add("ses_stale");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_stale" },
      });

      // get probed the stale id, found nothing, then created a new session and
      // emitted a fresh cursor rather than wedging the thread.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_stale"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores a malformed or wrong-version resume cursor", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-badcursor");

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 99, sessionId: "ses_persisted" },
      });

      // A foreign/stale-shaped cursor is treated as "no resume": never probed,
      // a fresh session is created.
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, []);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, ["http://127.0.0.1:9999"]);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "http://127.0.0.1:9999/session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("surfaces a non-not-found resume probe error instead of silently starting fresh", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-transient");
      // session.get returns a 500 (not a 404) for this id.
      runtimeMock.state.transientErrorSessionIds.add("ses_transient");

      const exit = yield* Effect.exit(
        adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_transient" },
        }),
      );

      // A transient/transport/auth failure must propagate — NOT be masked as a
      // brand-new empty session (the #3604 class of silent context loss).
      NodeAssert.equal(Exit.isFailure(exit), true);
      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_transient"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
    }),
  );

  it.effect("re-applies the current runtimeMode permissions when resuming", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-perms");

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        // A different runtimeMode than the original create — resume must not
        // leave the upstream session on stale permissions.
        runtimeMode: "approval-required",
        threadId,
        resumeCursor: { schemaVersion: 1, sessionId: "ses_perms" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_perms"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_perms");
      NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.permission != null, true);

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect(
    "forks the resumed session into the requested directory instead of losing context",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-cwd");
        // The persisted session still exists but was created in another working dir
        // (e.g. the thread moved from the project root into a git worktree).
        runtimeMock.state.sessionDirectoryById.set("ses_otherdir", "/some/other/worktree");

        const session = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
          resumeCursor: { schemaVersion: 1, sessionId: "ses_otherdir" },
        });

        // A cwd change must not mint an empty session: the adapter forks the
        // persisted session into the requested cwd, carrying history forward.
        NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_otherdir"]);
        NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
        NodeAssert.equal(runtimeMock.state.forkCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.forkCalls[0]?.sessionID, "ses_otherdir");
        NodeAssert.equal(typeof runtimeMock.state.forkCalls[0]?.directory, "string");
        // Permission ruleset re-asserted on the fork for the current runtimeMode.
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls.length, 1);
        NodeAssert.equal(runtimeMock.state.sessionUpdateCalls[0]?.sessionID, "ses_otherdir_fork");
        // Durable cursor now points at the history-complete fork in the new directory.
        NodeAssert.deepEqual(session.resumeCursor, {
          schemaVersion: 1,
          sessionId: "ses_otherdir_fork",
        });

        yield* adapter.stopSession(threadId);
      }),
  );

  it.effect("reuses the resumed session when the stored directory differs only lexically", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-samedir");
      // Same working tree, different spelling (trailing slash) — must reuse,
      // not fork.
      runtimeMock.state.sessionDirectoryById.set("ses_samedir", `${process.cwd()}/`);

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_samedir" },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_samedir"]);
      NodeAssert.deepEqual(runtimeMock.state.sessionCreateUrls, []);
      NodeAssert.deepEqual(runtimeMock.state.forkCalls, []);
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_samedir",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("forks a same-directory session when the cursor explicitly requests a fork", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-explicit-fork");
      runtimeMock.state.sessionDirectoryById.set("ses_source", process.cwd());

      const session = yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_source", fork: true },
      });

      NodeAssert.deepEqual(runtimeMock.state.sessionGetIds, ["ses_source"]);
      NodeAssert.equal(runtimeMock.state.forkCalls.length, 1);
      NodeAssert.equal(runtimeMock.state.forkCalls[0]?.sessionID, "ses_source");
      NodeAssert.deepEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "ses_source_fork",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("fails sendTurn for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-opencode-missing-send"),
          input: "hello",
          attachments: [],
        })
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-send");
    }),
  );

  it.effect("fails stopSession for missing sessions through the typed error channel", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const result = yield* adapter
        .stopSession(asThreadId("thread-opencode-missing-stop"))
        .pipe(Effect.result);

      NodeAssert.equal(result._tag, "Failure");
      NodeAssert.equal(result.failure._tag, "ProviderAdapterSessionNotFoundError");
      NodeAssert.equal(result.failure.provider, "opencode");
      NodeAssert.equal(result.failure.threadId, "thread-opencode-missing-stop");
    }),
  );

  it.effect("stops a configured-server session without trying to own server lifecycle", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-opencode"),
        runtimeMode: "full-access",
      });

      yield* adapter.stopSession(asThreadId("thread-opencode"));

      NodeAssert.deepEqual(runtimeMock.state.startCalls, []);
      NodeAssert.deepEqual(
        runtimeMock.state.abortCalls.includes("http://127.0.0.1:9999/session"),
        true,
      );
    }),
  );

  it.effect("emits one session.exited event when stopping a session", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-stop-event");
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.stopSession(threadId);

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.deepEqual(
        events.map((event) => event.type),
        ["session.started", "thread.started", "session.exited"],
      );
    }),
  );

  it.effect("clears session state even when cleanup finalizers throw", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-a"),
        runtimeMode: "full-access",
      });
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-stop-all-b"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.closeError = new Error("close failed");
      // `stopAll` relies on `stopOpenCodeContext`, which is typed as
      // never-failing. A throwing finalizer surfaces as a defect — `Effect.exit`
      // captures it so the assertions can still run. The key invariant we're
      // validating is "the sessions map and close-call probes reflect cleanup
      // attempts regardless of finalizer outcome".
      yield* Effect.exit(adapter.stopAll());
      const sessions = yield* adapter.listSessions();

      NodeAssert.deepEqual(runtimeMock.state.closeCalls, [
        "http://127.0.0.1:9999",
        "http://127.0.0.1:9999",
      ]);
      NodeAssert.deepEqual(sessions, []);
    }),
  );

  it.effect("completes streamEvents when the adapter scope closes", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make("sequential");
      let scopeClosed = false;

      try {
        const adapterLayer = Layer.effect(
          OpenCodeAdapter,
          makeOpenCodeAdapter(openCodeAdapterTestSettings),
        ).pipe(
          Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
          Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
          Layer.provideMerge(ServerSettingsService.layerTest()),
          Layer.provideMerge(providerSessionDirectoryTestLayer),
          Layer.provideMerge(NodeServices.layer),
        );
        const context = yield* Layer.buildWithScope(adapterLayer, scope);
        const adapter = yield* Effect.service(OpenCodeAdapter).pipe(Effect.provide(context));
        const eventsFiber = yield* adapter.streamEvents.pipe(Stream.runCollect, Effect.forkChild);

        yield* Scope.close(scope, Exit.void);
        scopeClosed = true;

        const exit = yield* Fiber.await(eventsFiber).pipe(Effect.timeout("1 second"));
        NodeAssert.equal(Exit.hasInterrupts(exit), true);
      } finally {
        if (!scopeClosed) {
          yield* Scope.close(scope, Exit.void).pipe(Effect.ignore);
        }
      }
    }),
  );

  it.effect("rolls back session state when sendTurn fails before OpenCode accepts the prompt", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-send-turn-failure"),
        runtimeMode: "full-access",
      });

      runtimeMock.state.promptAsyncError = new Error("prompt failed");
      const error = yield* adapter
        .sendTurn({
          threadId: asThreadId("thread-send-turn-failure"),
          input: "Fix it",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);
      const sessions = yield* adapter.listSessions();

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(error.detail, "prompt failed");
      NodeAssert.equal(
        error.message,
        "Provider adapter request failed (opencode) for session.promptAsync: prompt failed",
      );
      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.status, "ready");
      NodeAssert.equal(sessions[0]?.activeTurnId, undefined);
      NodeAssert.equal(sessions[0]?.lastError, "prompt failed");
    }),
  );

  it.effect("steers a running turn instead of opening a new one on mid-turn sendTurn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      // Steer: OpenCode queues the prompt into the busy session, so the
      // active turn id is reused instead of opening a new turn.
      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        input: "actually run 15",
        liveSteerTarget: {
          providerInstanceId: ProviderInstanceId.make("opencode"),
          activeTurnId: turn.turnId,
        },
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });
      NodeAssert.equal(String(steeredTurn.turnId), String(turn.turnId));

      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
      NodeAssert.equal(runtimeMock.state.promptCalls.length, 2);
    }),
  );

  it.effect("rejects a live steer targeted at a predecessor after a successor starts", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stale-live-steer");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "openai/gpt-5",
      };
      let releaseIdleEvent!: () => void;
      runtimeMock.state.subscribedEventsGate = new Promise<void>((resolve) => {
        releaseIdleEvent = resolve;
      });
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.status",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            status: { type: "idle" },
          },
        },
      ];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const predecessor = yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        modelSelection,
      });
      const predecessorCompleted = yield* adapter.streamEvents.pipe(
        Stream.filter(
          (event) => event.type === "turn.completed" && event.turnId === predecessor.turnId,
        ),
        Stream.runHead,
        Effect.forkChild,
      );
      releaseIdleEvent();
      yield* Fiber.join(predecessorCompleted);
      const successor = yield* adapter.sendTurn({
        threadId,
        input: "successor turn",
        modelSelection,
      });
      NodeAssert.notEqual(String(successor.turnId), String(predecessor.turnId));
      const promptCountBeforeStaleSteer = runtimeMock.state.promptCalls.length;

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "must not reach the successor",
          liveSteerTarget: {
            providerInstanceId: ProviderInstanceId.make("opencode"),
            activeTurnId: predecessor.turnId,
          },
          modelSelection,
        })
        .pipe(Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      NodeAssert.equal(runtimeMock.state.promptCalls.length, promptCountBeforeStaleSteer);
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((candidate) => candidate.threadId === threadId);
      NodeAssert.equal(String(session?.activeTurnId), String(successor.turnId));
    }),
  );

  it.effect("rejects a live steer while its OpenCode context is stopping", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-stopping-live-steer");
      const modelSelection = {
        instanceId: ProviderInstanceId.make("opencode"),
        model: "openai/gpt-5",
      };
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const runningTurn = yield* adapter.sendTurn({
        threadId,
        input: "long task",
        modelSelection,
      });
      let releaseAbort!: () => void;
      runtimeMock.state.abortGate = new Promise<void>((resolve) => {
        releaseAbort = resolve;
      });
      let markAbortStarted!: () => void;
      const abortStarted = new Promise<void>((resolve) => {
        markAbortStarted = resolve;
      });
      runtimeMock.state.onAbort = markAbortStarted;

      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => abortStarted);
      const promptCountBeforeStaleSteer = runtimeMock.state.promptCalls.length;
      const exit = yield* adapter
        .sendTurn({
          threadId,
          input: "must not enter a stopping SDK context",
          liveSteerTarget: {
            providerInstanceId: ProviderInstanceId.make("opencode"),
            activeTurnId: runningTurn.turnId,
          },
          modelSelection,
        })
        .pipe(Effect.exit);

      NodeAssert.equal(exit._tag, "Failure");
      NodeAssert.equal(runtimeMock.state.promptCalls.length, promptCountBeforeStaleSteer);
      releaseAbort();
      yield* Fiber.join(stopFiber);
    }),
  );

  it.effect("keeps the running turn when a steer prompt fails", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-steer-failure");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const turn = yield* adapter.sendTurn({
        threadId,
        input: "run 5 commands",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "openai/gpt-5",
        },
      });

      runtimeMock.state.promptAsyncError = new Error("steer failed");
      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "actually run 15",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        })
        .pipe(Effect.flip);

      // The original turn keeps running — only the steer prompt failed.
      NodeAssert.equal(error._tag, "ProviderAdapterRequestError");
      const sessions = yield* adapter.listSessions();
      const session = sessions.find((entry) => entry.threadId === threadId);
      NodeAssert.equal(session?.status, "running");
      NodeAssert.equal(String(session?.activeTurnId), String(turn.turnId));
    }),
  );

  it.effect("declares delivery receipts so ProviderService writes one per accepted send", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      // Without this flag no `message.delivered` receipt was ever recorded and
      // every OpenCode message sat at "Queued for OpenCode" indefinitely.
      NodeAssert.equal(adapter.capabilities.messageDeliveryReceipts, true);
    }),
  );

  it.effect(
    "treats OpenCode's MessageAbortedError after an interrupt as the interrupt, not a failure",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-aborted-after-interrupt");
        let releaseAbortError!: () => void;
        runtimeMock.state.subscribedEventsGate = new Promise<void>((resolve) => {
          releaseAbortError = resolve;
        });
        runtimeMock.state.subscribedEvents = [
          {
            type: "session.error",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              error: { name: "MessageAbortedError", data: { message: "Aborted" } },
            },
          },
        ];
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        // `streamEvents` is one queue, so a single reader must see everything.
        const seen = yield* collectThreadEvents(adapter, threadId);
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "long task",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });
        yield* adapter.interruptTurn(threadId, turn.turnId);
        releaseAbortError();
        const session = yield* waitForSession(
          adapter,
          threadId,
          (candidate) => candidate.status === "ready",
        );

        NodeAssert.equal(session?.status, "ready");
        NodeAssert.equal(session?.lastError, undefined);
        NodeAssert.equal(session?.activeTurnId, undefined);
        NodeAssert.deepEqual(
          seen.filter((event) => event.type === "runtime.error"),
          [],
          "an abort we requested must not surface as a runtime error",
        );
        // 2026-09-17: ingestion interrupts the provider when the assistant
        // streams AGENT_STOP, then waits for the turn to close. Orchestration
        // settles turns from `turn.completed` only, so an abort that emitted
        // nothing left the thread "Working" until the user pressed Stop.
        const completed = seen.filter((event) => event.type === "turn.completed");
        NodeAssert.equal(completed.length, 1, "the confirmed abort closes the turn exactly once");
        NodeAssert.equal(String(completed[0]?.turnId), String(turn.turnId));
        NodeAssert.equal(
          completed[0]?.type === "turn.completed" ? completed[0].payload.state : undefined,
          "interrupted",
          "an abort we requested closes the turn as interrupted, never as failed",
        );
        const aborted = seen.filter((event) => event.type === "turn.aborted");
        NodeAssert.equal(aborted.length, 1, "interruptTurn's turn.aborted must not be duplicated");
        NodeAssert.equal(String(aborted[0]?.turnId), String(turn.turnId));
      }),
  );

  it.effect(
    "closes the turn as interrupted when OpenCode aborts it without an interrupt call",
    () =>
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-aborted-by-opencode");
        let releaseAbortError!: () => void;
        runtimeMock.state.subscribedEventsGate = new Promise<void>((resolve) => {
          releaseAbortError = resolve;
        });
        runtimeMock.state.subscribedEvents = [
          {
            type: "session.error",
            properties: {
              sessionID: "http://127.0.0.1:9999/session",
              error: { name: "MessageAbortedError", data: { message: "Aborted" } },
            },
          },
        ];
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const seen = yield* collectThreadEvents(adapter, threadId);
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "long task",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "openai/gpt-5",
          },
        });
        releaseAbortError();
        const session = yield* waitForSession(
          adapter,
          threadId,
          (candidate) => candidate.status === "ready",
        );

        NodeAssert.equal(session?.status, "ready");
        NodeAssert.equal(session?.lastError, undefined);
        const aborted = seen.filter((event) => event.type === "turn.aborted");
        NodeAssert.equal(aborted.length, 1);
        NodeAssert.equal(String(aborted[0]?.turnId), String(turn.turnId));
        NodeAssert.equal(
          aborted[0]?.type === "turn.aborted" ? aborted[0].payload.reason : undefined,
          "Interrupted.",
        );
        NodeAssert.deepEqual(
          seen.filter((event) => event.type === "runtime.error"),
          [],
        );
        const completed = seen.filter((event) => event.type === "turn.completed");
        NodeAssert.equal(completed.length, 1, "an external abort still ends the turn");
        NodeAssert.equal(String(completed[0]?.turnId), String(turn.turnId));
        NodeAssert.equal(
          completed[0]?.type === "turn.completed" ? completed[0].payload.state : undefined,
          "interrupted",
        );
      }),
  );

  it.effect("compacts the OpenCode session in place through session.summarize", () =>
    Effect.gen(function* () {
      // Open World, 2026-09-17: a context overflow reset the session five times
      // in a row. Compaction keeps the session and its working memory; the
      // reset is the fallback when compaction cannot run.
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-compact");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "work",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode/union-alpha",
        },
      });
      NodeAssert.equal(yield* adapter.compactSessionHistory!(threadId), true);
      NodeAssert.deepEqual(runtimeMock.state.summarizeCalls, [
        {
          sessionID: "http://127.0.0.1:9999/session",
          providerID: "opencode",
          modelID: "union-alpha",
        },
      ]);
      // OpenCode declining is a false, so the caller falls back to a reset.
      runtimeMock.state.summarizeResult = false;
      NodeAssert.equal(yield* adapter.compactSessionHistory!(threadId), false);
      // A summarize that fails (the overflow rejects it too) is a typed error
      // the service catches and treats as "not compacted".
      runtimeMock.state.summarizeError = new Error("Prompt too long");
      const failed = yield* adapter.compactSessionHistory!(threadId).pipe(Effect.flip);
      NodeAssert.equal(failed instanceof Error, true);
    }),
  );

  it.effect("passes agent and variant options for the adapter's bound custom instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId: asThreadId("thread-custom-instance"),
        runtimeMode: "full-access",
      });

      yield* adapter.sendTurn({
        threadId: asThreadId("thread-custom-instance"),
        input: "Fix it",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
          [
            { id: "agent", value: "github-copilot" },
            { id: "variant", value: "high" },
          ],
        ),
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        agent: "github-copilot",
        variant: "high",
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("uses the bound custom instance id for fallback sendTurn model selection", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-fallback-model");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("opencode_zen"),
          "anthropic/claude-sonnet-4-5",
        ),
      });

      yield* adapter.sendTurn({
        threadId,
        input: "Fix it",
      });

      NodeAssert.deepEqual(runtimeMock.state.promptCalls.at(-1), {
        sessionID: "http://127.0.0.1:9999/session",
        model: {
          providerID: "anthropic",
          modelID: "claude-sonnet-4-5",
        },
        parts: [{ type: "text", text: "Fix it" }],
      });
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("rejects sendTurn model selections for another instance id", () => {
    const instanceId = ProviderInstanceId.make("opencode_zen");
    const adapterLayer = Layer.effect(
      OpenCodeAdapter,
      makeOpenCodeAdapter(openCodeAdapterTestSettings, { instanceId }),
    ).pipe(
      Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(providerSessionDirectoryTestLayer),
      Layer.provideMerge(NodeServices.layer),
    );

    return Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-custom-instance-wrong-selection");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "Fix it",
          modelSelection: createModelSelection(
            ProviderInstanceId.make("opencode"),
            "anthropic/claude-sonnet-4-5",
          ),
        })
        .pipe(Effect.flip);

      NodeAssert.equal(error._tag, "ProviderAdapterValidationError");
      if (error._tag !== "ProviderAdapterValidationError") {
        throw new Error("Unexpected error type");
      }
      NodeAssert.equal(
        error.issue,
        "OpenCode model selection is bound to instance 'opencode', expected 'opencode_zen'.",
      );
      NodeAssert.deepEqual(runtimeMock.state.promptCalls, []);
    }).pipe(Effect.provide(adapterLayer));
  });

  it.effect("reverts the full thread when rollback removes every assistant turn", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-rollback-all");
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      runtimeMock.state.messages = [
        {
          info: { id: "assistant-1", role: "assistant" },
          parts: [],
        },
        {
          info: { id: "assistant-2", role: "assistant" },
          parts: [],
        },
      ];

      const snapshot = yield* adapter.rollbackThread(threadId, 2);

      NodeAssert.deepEqual(runtimeMock.state.revertCalls, [
        { sessionID: "http://127.0.0.1:9999/session" },
      ]);
      NodeAssert.deepEqual(snapshot.turns, []);
    }),
  );

  it.effect("classifies a confirmed not-found across the shapes the SDK/runtime can produce", () =>
    Effect.sync(() => {
      // The real production shape: runOpenCodeSdk wraps the thrown Error
      // (cause = { body, status }) under OpenCodeRuntimeError.
      const wrappedError = new Error("Session not found: ses_x", {
        cause: { body: { name: "NotFoundError" }, status: 404 },
      });
      NodeAssert.equal(
        isOpenCodeNotFound({
          _tag: "OpenCodeRuntimeError",
          operation: "session.get",
          detail: "Session not found: ses_x",
          cause: wrappedError,
        }),
        true,
      );

      // 404 expressed only via response.status (the bot's flagged shape).
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 404 } } }), true);
      // 404 via a bare numeric status / statusCode.
      NodeAssert.equal(isOpenCodeNotFound(new Error("x", { cause: { status: 404 } })), true);
      NodeAssert.equal(isOpenCodeNotFound({ statusCode: 404 }), true);
      // OpenCode NotFoundError body name with no status.
      NodeAssert.equal(isOpenCodeNotFound({ body: { name: "NotFoundError" } }), true);

      // NOT a miss: only structured signals count, never free text. A non-404
      // error whose message/detail merely contains "not found" must propagate,
      // not be misread as a missing session and silently start fresh.
      NodeAssert.equal(
        isOpenCodeNotFound(new Error("upstream provider not found", { cause: { status: 500 } })),
        false,
      );
      NodeAssert.equal(isOpenCodeNotFound({ detail: "status=500 body={...not found...}" }), false);
      // An explicit non-404 status seals its subtree: a 500 whose serialized
      // body echoes a NotFoundError name — or that is itself named
      // *NotFound* — is a real failure, never a miss.
      NodeAssert.equal(isOpenCodeNotFound({ status: 500, body: { name: "NotFoundError" } }), false);
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError", status: 500 }), false);
      // A "NotFound"-flavored name that isn't OpenCode's exact `NotFoundError`
      // is not a confirmed miss even without a sealing status.
      NodeAssert.equal(isOpenCodeNotFound({ name: "UpstreamNotFoundError" }), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { name: "ProviderNotFoundError" } }), false);
      NodeAssert.equal(
        isOpenCodeNotFound(
          new Error("x", { cause: { status: 502, body: { name: "NotFoundError" } } }),
        ),
        false,
      );
      // Other transient/auth/network failures must propagate too.
      NodeAssert.equal(isOpenCodeNotFound(new Error("boom", { cause: { status: 500 } })), false);
      NodeAssert.equal(isOpenCodeNotFound({ cause: { response: { status: 401 } } }), false);
      NodeAssert.equal(isOpenCodeNotFound(new Error("network error (no response)")), false);
      NodeAssert.equal(isOpenCodeNotFound(undefined), false);
    }),
  );

  it.effect("treats lexically or physically identical directories as the same", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sameDirectory = (left: string, right: string) =>
        isSameOpenCodeDirectory(fileSystem, path, left, right);

      // Lexical-only differences (trailing slash, dot segments) short-circuit
      // without touching the filesystem — the paths need not exist.
      NodeAssert.equal(yield* sameDirectory("/repo/project/", "/repo/project"), true);
      NodeAssert.equal(yield* sameDirectory("/repo/nested/../project", "/repo/project"), true);
      // Nonexistent paths degrade to the lexical comparison instead of failing.
      NodeAssert.equal(yield* sameDirectory("/repo/project", "/repo/other"), false);

      // A symlinked cwd (the macOS `/tmp` → `/private/tmp` shape) resolves to
      // the directory it points at, so the two spellings compare equal.
      const base = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-opencode-dir-" });
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      yield* fileSystem.makeDirectory(real);
      yield* fileSystem.symlink(real, link);
      NodeAssert.equal(yield* sameDirectory(link, real), true);
      NodeAssert.equal(yield* sameDirectory(link, path.join(base, "other")), false);
    }).pipe(Effect.scoped),
  );

  it.effect("appends raw assistant text deltas and reconciles part update snapshots", () =>
    Effect.sync(() => {
      const firstUpdate = mergeOpenCodeAssistantText(undefined, "Hello");
      const overlapDelta = appendOpenCodeAssistantTextDelta(firstUpdate.latestText, "lo world");
      const secondUpdate = mergeOpenCodeAssistantText(overlapDelta.nextText, "Hellolo world");

      NodeAssert.deepEqual(
        [firstUpdate.deltaToEmit, overlapDelta.deltaToEmit, secondUpdate.deltaToEmit],
        ["Hello", "lo world", ""],
      );
      NodeAssert.equal(secondUpdate.latestText, "Hellolo world");
    }),
  );

  it.effect("does not strip coincidental prefix overlap from OpenCode part deltas", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-raw-delta");
      const part = {
        id: "part-raw-delta",
        sessionID: "http://127.0.0.1:9999/session",
        messageID: "msg-raw-delta",
        type: "text",
        text: "A B",
        time: { start: 1 },
      };
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-raw-delta",
              role: "assistant",
            },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part,
            time: 1,
          },
        },
        {
          type: "message.part.delta",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            messageID: "msg-raw-delta",
            partID: "part-raw-delta",
            field: "text",
            delta: "Bonus",
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            part: {
              ...part,
              text: "A BBonus",
              time: { start: 1, end: 2 },
            },
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(5),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const deltas = events.filter((event) => event.type === "content.delta");
      NodeAssert.deepEqual(
        deltas.map((event) => (event.type === "content.delta" ? event.payload.delta : "")),
        ["A B", "Bonus"],
      );
      NodeAssert.equal(events.at(-1)?.type, "item.completed");
      const completed = events.at(-1);
      if (completed?.type === "item.completed") {
        NodeAssert.equal(completed.payload.detail, "A BBonus");
      }
    }),
  );

  it.effect("lets OpenCode own session title generation and emits title metadata updates", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-title-sync");
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: {
              id: "http://127.0.0.1:9999/session",
              title: "Investigate OpenCode title sync",
            },
          },
        },
      ];

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(runtimeMock.state.sessionCreateInputs.length, 1);
      NodeAssert.equal("title" in (runtimeMock.state.sessionCreateInputs[0] ?? {}), false);

      const metadataUpdated = events.find((event) => event.type === "thread.metadata.updated");
      NodeAssert.ok(metadataUpdated);
      if (metadataUpdated.type === "thread.metadata.updated") {
        NodeAssert.equal(metadataUpdated.payload.name, "Investigate OpenCode title sync");
      }
    }),
  );

  it.effect("surfaces a subagent's child session as the parent turn's task lifecycle", () =>
    Effect.gen(function* () {
      // 2026-09-17: a `task` subagent retried an unavailable upstream for 13
      // minutes while every event from its child session was dropped as
      // "another session's", leaving a bare Working row with no progress.
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-subagent");
      const parent = "http://127.0.0.1:9999/session";
      const child = "ses-child-explore";
      const taskPart = (state: Record<string, unknown>) => ({
        id: "part-task",
        sessionID: parent,
        messageID: "msg-parent",
        type: "tool",
        callID: "call-task",
        tool: "task",
        state,
      });
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: { id: child, parentID: parent, title: "Trace retry (@explore subagent)" },
          },
        },
        {
          type: "message.updated",
          properties: { sessionID: parent, info: { id: "msg-parent", role: "assistant" } },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: parent,
            part: taskPart({
              status: "running",
              input: { description: "Trace retry", subagent_type: "explore" },
              title: "Trace retry",
              metadata: { sessionId: child, parentSessionId: parent },
              time: { start: 1 },
            }),
            time: 1,
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: child,
            part: {
              id: "part-child-grep",
              sessionID: child,
              messageID: "msg-child",
              type: "tool",
              callID: "call-grep",
              tool: "grep",
              state: {
                status: "running",
                input: { pattern: "retry" },
                title: "grep retry",
                time: { start: 2 },
              },
            },
            time: 2,
          },
        },
        {
          type: "session.status",
          properties: {
            sessionID: child,
            status: { type: "retry", attempt: 2, message: "Endpoint is unavailable.", next: 0 },
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: parent,
            part: taskPart({
              status: "completed",
              input: { description: "Trace retry", subagent_type: "explore" },
              output: "Findings: the label lives in ChatView.",
              title: "Trace retry",
              metadata: { sessionId: child, parentSessionId: parent },
              time: { start: 1, end: 3 },
            }),
            time: 3,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "task.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const started = events.filter((event) => event.type === "task.started");
      NodeAssert.equal(started.length, 1);
      NodeAssert.deepEqual(started[0]?.type === "task.started" ? started[0].payload : null, {
        taskId: child,
        taskType: "subagent",
        description: "Trace retry (@explore subagent)",
      });
      const progress = events.find((event) => event.type === "task.progress");
      NodeAssert.deepEqual(progress?.type === "task.progress" ? progress.payload : null, {
        taskId: child,
        title: "Trace retry",
        description: "Running grep",
        lastToolName: "grep",
        summary: "grep retry",
      });
      const retry = events.find((event) => event.type === "session.state.changed");
      NodeAssert.equal(
        retry?.type === "session.state.changed" &&
          retry.payload.reason?.startsWith("provider_overloaded:retrying;attempt=2"),
        true,
        "a subagent's upstream retry feeds the parent turn's retry heartbeat",
      );
      const completed = events.at(-1);
      NodeAssert.deepEqual(completed?.type === "task.completed" ? completed.payload : null, {
        taskId: child,
        status: "completed",
        title: "Trace retry",
        summary: "Findings: the label lives in ChatView.",
      });
    }),
  );

  it.effect(
    "classifies fifteen consecutive empty upstream responses for bounded silent recovery",
    () =>
      Effect.gen(function* () {
        // 2026-09-17 06:36-06:41: after a startup resume, union-alpha answered
        // every request with an empty stream. OpenCode logged a finished step
        // every ~33s (0 tokens, only a step-finish part) and looped forever;
        // Solla showed "Working" with nothing behind it.
        const adapter = yield* OpenCodeAdapter;
        const threadId = asThreadId("thread-opencode-empty-steps");
        const parent = "http://127.0.0.1:9999/session";
        let releaseEvents!: () => void;
        runtimeMock.state.subscribedEventsGate = new Promise<void>((resolve) => {
          releaseEvents = resolve;
        });
        const emptyStep = (index: number) => ({
          type: "message.updated",
          properties: {
            sessionID: parent,
            info: {
              id: `msg-empty-${index}`,
              sessionID: parent,
              role: "assistant",
              time: { created: index, completed: index + 30 },
              parentID: "msg-user",
              modelID: "union-alpha",
              providerID: "opencode",
              mode: "build",
              path: { cwd: "/repo", root: "/repo" },
              cost: 0,
              tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
              finish: "unknown",
            },
          },
        });
        runtimeMock.state.subscribedEvents = [
          // A real step with output resets the count.
          {
            type: "message.updated",
            properties: {
              sessionID: parent,
              info: {
                ...emptyStep(0).properties.info,
                id: "msg-real",
                tokens: { input: 900, output: 12, reasoning: 0, cache: { read: 0, write: 0 } },
              },
            },
          },
          emptyStep(1),
          emptyStep(2),
          emptyStep(3),
          emptyStep(4),
          emptyStep(5),
          emptyStep(6),
          emptyStep(7),
          emptyStep(8),
          emptyStep(9),
          emptyStep(10),
          emptyStep(11),
          emptyStep(12),
          emptyStep(13),
          emptyStep(14),
          emptyStep(15),
        ];
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId,
          runtimeMode: "full-access",
        });
        const seen = yield* collectThreadEvents(adapter, threadId);
        const turn = yield* adapter.sendTurn({
          threadId,
          input: "resume",
          modelSelection: {
            instanceId: ProviderInstanceId.make("opencode"),
            model: "opencode/union-alpha",
          },
        });
        releaseEvents();
        const session = yield* waitForSession(
          adapter,
          threadId,
          (candidate) => candidate.status === "error",
        );

        NodeAssert.equal(session?.status, "error");
        const failed = seen.filter((event) => event.type === "turn.completed");
        NodeAssert.equal(failed.length, 1);
        NodeAssert.equal(String(failed[0]?.turnId), String(turn.turnId));
        NodeAssert.equal(
          failed[0]?.type === "turn.completed" &&
            failed[0].payload.state === "failed" &&
            failed[0].payload.errorMessage?.includes("15 empty responses"),
          true,
        );
        NodeAssert.equal(failed[0]?.payload.failureKind, "retryable-upstream");
        const errors = seen.filter((event) => event.type === "runtime.error");
        NodeAssert.equal(errors.length, 1);
        NodeAssert.equal(errors[0]?.payload.failureKind, "retryable-upstream");
        NodeAssert.equal(errors[0]?.turnId, turn.turnId);
        NodeAssert.deepEqual(runtimeMock.state.abortCalls, [parent], "OpenCode's loop is stopped");
      }),
  );

  it.effect("stops only the subagent when its child session loops on empty responses", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-child-empty-steps");
      const parent = "http://127.0.0.1:9999/session";
      const child = "ses-child-stalled";
      const emptyChildStep = (index: number) => ({
        type: "message.updated",
        properties: {
          sessionID: child,
          info: {
            id: `msg-child-empty-${index}`,
            sessionID: child,
            role: "assistant",
            time: { created: index, completed: index + 30 },
            parentID: "msg-child-user",
            modelID: "union-alpha",
            providerID: "opencode",
            mode: "explore",
            path: { cwd: "/repo", root: "/repo" },
            cost: 0,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            finish: "unknown",
          },
        },
      });
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.updated",
          properties: {
            info: { id: child, parentID: parent, title: "Explore (@explore subagent)" },
          },
        },
        emptyChildStep(1),
        emptyChildStep(2),
        emptyChildStep(3),
        emptyChildStep(4),
        emptyChildStep(5),
        emptyChildStep(6),
        emptyChildStep(7),
        emptyChildStep(8),
        emptyChildStep(9),
        emptyChildStep(10),
        emptyChildStep(11),
        emptyChildStep(12),
        emptyChildStep(13),
        emptyChildStep(14),
        emptyChildStep(15),
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil(
          (event) =>
            event.type === "task.progress" &&
            event.payload.description.startsWith("Subagent stalled"),
        ),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      NodeAssert.equal(events.filter((event) => event.type === "turn.completed").length, 0);
      NodeAssert.equal(events.filter((event) => event.type === "runtime.error").length, 0);
      const stalled = events.at(-1);
      NodeAssert.equal(
        stalled?.type === "task.progress" &&
          stalled.payload.summary?.includes("15 empty responses"),
        true,
      );
      NodeAssert.deepEqual(runtimeMock.state.abortCalls, [child], "only the child is aborted");
    }),
  );

  it.effect("turns OpenCode's todowrite into one plan update for the Plan tab", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-todowrite");
      const parent = "http://127.0.0.1:9999/session";
      const input = {
        todos: [
          { content: "Find the fresh aborted payload", status: "in_progress", priority: "high" },
          { content: "Remove the provider slow label", status: "pending", priority: "medium" },
          { content: "Read the live DB", status: "completed", priority: "low" },
        ],
      };
      const todoPart = (state: Record<string, unknown>) => ({
        id: "part-todo",
        sessionID: parent,
        messageID: "msg-parent",
        type: "tool",
        callID: "call-todo",
        tool: "todowrite",
        state,
      });
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: { sessionID: parent, info: { id: "msg-parent", role: "assistant" } },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: parent,
            part: todoPart({ status: "running", input, title: "todowrite", time: { start: 1 } }),
            time: 1,
          },
        },
        {
          type: "message.part.updated",
          properties: {
            sessionID: parent,
            part: todoPart({
              status: "completed",
              input,
              output: "[]",
              title: "todowrite",
              time: { start: 1, end: 2 },
            }),
            time: 2,
          },
        },
      ];
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.filter((event) => event.threadId === threadId),
        Stream.takeUntil((event) => event.type === "item.completed"),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("1 second")));
      const plans = events.filter((event) => event.type === "turn.plan.updated");
      NodeAssert.equal(plans.length, 1, "running + completed carry the same input: one plan");
      NodeAssert.deepEqual(plans[0]?.type === "turn.plan.updated" ? plans[0].payload : null, {
        plan: [
          { step: "Find the fresh aborted payload", status: "inProgress" },
          { step: "Remove the provider slow label", status: "pending" },
          { step: "Read the live DB", status: "completed" },
        ],
      });
    }),
  );

  it.effect("normalizes OpenCode's native retryable upstream statuses", () =>
    Effect.sync(() => {
      NodeAssert.equal(
        openCodeOverloadRetryReason({
          attempt: 3,
          error: { statusCode: 529 },
        }),
        "provider_overloaded:retrying;attempt=3",
      );
      NodeAssert.equal(
        openCodeOverloadRetryReason({
          attempt: 3,
          error: { statusCode: 503 },
        }),
        "provider_overloaded:retrying;attempt=3",
      );
      NodeAssert.equal(
        openCodeOverloadRetryReason({
          attempt: 3,
          error: { statusCode: 500 },
        }),
        undefined,
      );
      // 2026-09-17 15:55: the gateway's api_error carries the status only in
      // its message. 503/429 ride the transient budget; 402 stays terminal.
      const gateway = (status: number) => ({
        name: "APIError",
        data: {
          type: "api_error",
          message: `Streaming response failed: [api_error] upstream provider error (HTTP ${status})`,
        },
      });
      NodeAssert.equal(openCodeGatewayUpstreamStatus(gateway(503)), 503);
      NodeAssert.equal(isOpenCodeRetryableUpstreamError(gateway(503)), true);
      // Same policy as a structured status: 502/503/504/529 retry; a 429 is
      // the usage-limit path's business and a 402 is billing, both terminal.
      NodeAssert.equal(isOpenCodeRetryableUpstreamError(gateway(429)), false);
      NodeAssert.equal(isOpenCodeRetryableUpstreamError(gateway(402)), false);
      NodeAssert.match(
        openCodeBillingRefusalMessage(gateway(402), "opencode/union-alpha") ?? "",
        /no credit left for the opencode\/union-alpha model \(HTTP 402 Payment Required\)/,
      );
      NodeAssert.equal(openCodeBillingRefusalMessage(gateway(503)), undefined);
      NodeAssert.equal(
        isOpenCodeRetryableUpstreamError({
          name: "APIError",
          data: { type: "invalid_request_error", message: "Prompt too long (HTTP 503)" },
        }),
        false,
        "only the gateway's own upstream wording counts",
      );
    }),
  );

  // 2026-09-17: OpenCode Zen's 402 reached the side chat as "[api_error]
  // upstream provider error (HTTP 402)" and then burned eight retries. The
  // transcript must say what it means (no credit) and what to do.
  it.effect("explains a gateway HTTP 402 session.error as a billing refusal", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-gateway-402");
      let releaseEvents!: () => void;
      runtimeMock.state.subscribedEventsGate = new Promise<void>((resolve) => {
        releaseEvents = resolve;
      });
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: {
              name: "APIError",
              data: {
                type: "api_error",
                message:
                  "Streaming response failed: [api_error] upstream provider error (HTTP 402)",
              },
            },
          },
        },
      ];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const seen = yield* collectThreadEvents(adapter, threadId);
      yield* adapter.sendTurn({
        threadId,
        input: "work",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode/union-alpha",
        },
      });
      releaseEvents();
      const session = yield* waitForSession(
        adapter,
        threadId,
        (candidate) => candidate.status === "error",
      );
      NodeAssert.match(
        session?.lastError ?? "",
        /OpenCode Zen declined this request because the account has no credit left/,
      );
      NodeAssert.match(session?.lastError ?? "", /https:\/\/opencode\.ai\/zen/);
      NodeAssert.equal(isTerminalProviderRefusal(session?.lastError ?? ""), true);
      const completed = seen.filter((event) => event.type === "turn.completed");
      NodeAssert.equal(completed.length, 1);
      NodeAssert.equal(
        completed[0]?.type === "turn.completed" ? completed[0].payload.failureKind : undefined,
        undefined,
        "a billing refusal is not a retryable upstream failure",
      );
      const errors = seen.filter((event) => event.type === "runtime.error");
      NodeAssert.equal(errors.length, 1);
      NodeAssert.match(
        errors[0]?.type === "runtime.error" ? errors[0].payload.message : "",
        /HTTP 402 Payment Required/,
      );
    }),
  );

  it.effect("classifies a gateway HTTP 503 session.error for bounded silent recovery", () =>
    Effect.gen(function* () {
      const adapter = yield* OpenCodeAdapter;
      const threadId = asThreadId("thread-opencode-gateway-503");
      let releaseEvents!: () => void;
      runtimeMock.state.subscribedEventsGate = new Promise<void>((resolve) => {
        releaseEvents = resolve;
      });
      runtimeMock.state.subscribedEvents = [
        {
          type: "session.error",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            error: {
              name: "APIError",
              data: {
                type: "api_error",
                message:
                  "Streaming response failed: [api_error] upstream provider error (HTTP 503)",
              },
            },
          },
        },
      ];
      yield* adapter.startSession({
        provider: ProviderDriverKind.make("opencode"),
        threadId,
        runtimeMode: "full-access",
      });
      const seen = yield* collectThreadEvents(adapter, threadId);
      const turn = yield* adapter.sendTurn({
        threadId,
        input: "work",
        modelSelection: {
          instanceId: ProviderInstanceId.make("opencode"),
          model: "opencode/union-alpha",
        },
      });
      releaseEvents();
      const session = yield* waitForSession(
        adapter,
        threadId,
        (candidate) => candidate.status === "error",
      );
      NodeAssert.equal(session?.status, "error");
      const completed = seen.filter((event) => event.type === "turn.completed");
      NodeAssert.equal(completed.length, 1);
      NodeAssert.equal(String(completed[0]?.turnId), String(turn.turnId));
      NodeAssert.equal(
        completed[0]?.type === "turn.completed" ? completed[0].payload.failureKind : undefined,
        "retryable-upstream",
      );
      const errors = seen.filter((event) => event.type === "runtime.error");
      NodeAssert.equal(errors.length, 1);
      NodeAssert.equal(errors[0]?.payload.failureKind, "retryable-upstream");
    }),
  );

  it.effect("unwraps the JSON body OpenCode forwards as an upstream error message", () =>
    Effect.sync(() => {
      // Open World side chat, 2026-09-17 14:41: the card read as raw JSON.
      const body =
        '{"type":"invalid_request_error","message":"Streaming response failed: [invalid_request_error] Prompt too long: the maximum context length is 262144 tokens including the completion"}';
      NodeAssert.equal(
        unwrapOpenCodeErrorBody(body),
        "Streaming response failed: [invalid_request_error] Prompt too long: the maximum context length is 262144 tokens including the completion",
      );
      NodeAssert.equal(
        sessionErrorMessage({ name: "APIError", data: { message: body } }),
        "Streaming response failed: [invalid_request_error] Prompt too long: the maximum context length is 262144 tokens including the completion",
      );
      // Plain text, non-object JSON, and bodies without a message pass through.
      NodeAssert.equal(
        unwrapOpenCodeErrorBody("Endpoint is unavailable"),
        "Endpoint is unavailable",
      );
      NodeAssert.equal(unwrapOpenCodeErrorBody("[1, 2]"), "[1, 2]");
      NodeAssert.equal(unwrapOpenCodeErrorBody('{"type":"x"}'), '{"type":"x"}');
      NodeAssert.equal(unwrapOpenCodeErrorBody("{not json}"), "{not json}");
      NodeAssert.equal(sessionErrorMessage(undefined), "OpenCode session failed.");
    }),
  );

  it.effect("writes provider-native observability records using the session thread id", () =>
    Effect.gen(function* () {
      const nativeEvents: Array<{
        readonly event?: {
          readonly provider?: string;
          readonly threadId?: string;
          readonly providerThreadId?: string;
          readonly type?: string;
        };
      }> = [];
      const nativeThreadIds: Array<string | null> = [];
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            info: {
              id: "msg-missing-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/other-session",
            info: {
              id: "msg-other-session",
              role: "assistant",
            },
          },
        },
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: (event: unknown, threadId: ThreadId | null) => {
          nativeEvents.push(event as (typeof nativeEvents)[number]);
          nativeThreadIds.push(threadId ?? null);
          return Effect.void;
        },
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      const session = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const started = yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return started;
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(session.threadId, "thread-native-log");
      NodeAssert.equal(nativeEvents.length, 1);
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.provider === "opencode"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some(
          (record) => record.event?.providerThreadId === "http://127.0.0.1:9999/session",
        ),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.threadId === "thread-native-log"),
        true,
      );
      NodeAssert.equal(
        nativeEvents.some((record) => record.event?.type === "message.updated"),
        true,
      );
      NodeAssert.equal(
        nativeThreadIds.every((threadId) => threadId === "thread-native-log"),
        true,
      );
    }),
  );

  it.effect("keeps the event pump alive when native event logging fails", () =>
    Effect.gen(function* () {
      runtimeMock.state.subscribedEvents = [
        {
          type: "message.updated",
          properties: {
            sessionID: "http://127.0.0.1:9999/session",
            info: {
              id: "msg-native-log-failure",
              role: "assistant",
            },
          },
        },
      ];

      const nativeEventLogger = {
        filePath: "memory://opencode-native-events",
        write: () => Effect.die(new Error("native log write failed")),
        close: () => Effect.void,
      };

      const adapterLayer = Layer.effect(
        OpenCodeAdapter,
        makeOpenCodeAdapter(openCodeAdapterTestSettings, {
          nativeEventLogger,
        }),
      ).pipe(
        Layer.provideMerge(Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble)),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
        Layer.provideMerge(
          ServerSettingsService.layerTest({
            providers: {
              opencode: {
                binaryPath: "fake-opencode",
                serverUrl: "http://127.0.0.1:9999",
                serverPassword: "secret-password",
              },
            },
          }),
        ),
        Layer.provideMerge(providerSessionDirectoryTestLayer),
        Layer.provideMerge(NodeServices.layer),
      );

      // Capture closeCalls *inside* the provided layer scope: the adapter's
      // layer finalizer now tears down any live sessions when the layer
      // closes (which is exactly what we want for leak prevention), so
      // inspecting closeCalls after `Effect.provide` completes would observe
      // the teardown — not the behavior under test. We care that the event
      // pump kept the session alive while logging was failing.
      const { sessions, closeCallsDuringRun } = yield* Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        yield* adapter.startSession({
          provider: ProviderDriverKind.make("opencode"),
          threadId: asThreadId("thread-native-log-failure"),
          runtimeMode: "full-access",
        });
        yield* advanceTestClock(10);
        return {
          sessions: yield* adapter.listSessions(),
          closeCallsDuringRun: [...runtimeMock.state.closeCalls],
        };
      }).pipe(Effect.provide(adapterLayer));

      NodeAssert.equal(sessions.length, 1);
      NodeAssert.equal(sessions[0]?.threadId, "thread-native-log-failure");
      NodeAssert.deepEqual(closeCallsDuringRun, []);
    }),
  );
});
