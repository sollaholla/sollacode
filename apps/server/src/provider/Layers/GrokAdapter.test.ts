// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeFSP from "node:fs/promises";
import * as NodeURL from "node:url";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import {
  ApprovalRequestId,
  GrokSettings,
  MessageId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeTaskId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";

import { attachmentRelativePath } from "../../attachmentStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  grokPromptSettlementBelongsToContext,
  makeGrokAdapter,
  preserveAcceptedGrokTurn,
} from "./GrokAdapter.ts";
const decodeGrokSettings = Schema.decodeSync(GrokSettings);
const encodeUnknownJson = Schema.encodeUnknownSync(Schema.UnknownFromJsonString);

const __dirname = NodePath.dirname(NodeURL.fileURLToPath(import.meta.url));
const mockAgentPath = NodePath.join(__dirname, "../../../scripts/acp-mock-agent.ts");
const mockAgentCommand = process.execPath;

class SimulatedGrokFinalizationError extends Data.TaggedError("SimulatedGrokFinalizationError")<{
  readonly message: string;
}> {}

async function makeMockGrokWrapper(extraEnv?: Record<string, string>) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-grok.sh");
  const envExports = Object.entries(extraEnv ?? {})
    .map(([key, value]) => `export ${key}=${JSON.stringify(value)}`)
    .join("\n");
  const childCommand = `${JSON.stringify(mockAgentCommand)} ${JSON.stringify(mockAgentPath)} "$@"`;
  const captureWrapperPid = extraEnv?.T3_ACP_WRAPPER_PID_LOG_PATH
    ? `echo "$$" > ${JSON.stringify(extraEnv.T3_ACP_WRAPPER_PID_LOG_PATH)}`
    : "";
  const launch =
    extraEnv?.T3_ACP_WRAPPER_IGNORE_SIGTERM === "1"
      ? `trap '' TERM
${childCommand}
while :; do sleep 1; done`
      : `exec ${childCommand}`;
  const script = `#!/bin/sh
${envExports}
${captureWrapperPid}
${launch}
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

function waitForFileContent(
  filePath: string,
  attempts = 40,
  expectedContent?: string,
): Effect.Effect<string> {
  const readAttempt = (remainingAttempts: number): Effect.Effect<string> =>
    Effect.gen(function* () {
      if (remainingAttempts <= 0) {
        return yield* Effect.die(new Error(`Timed out waiting for file content at ${filePath}`));
      }
      const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(filePath, "utf8")).pipe(
        Effect.orElseSucceed(() => ""),
      );
      if (
        raw.trim().length > 0 &&
        (expectedContent === undefined || raw.includes(expectedContent))
      ) {
        return raw;
      }
      yield* Effect.sleep("25 millis");
      return yield* readAttempt(remainingAttempts - 1);
    });
  return readAttempt(attempts);
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
    throw error;
  }
}

async function readJsonLines(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

const grokAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-grok-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

const makeTestAdapter = (binaryPath: string, options?: Parameters<typeof makeGrokAdapter>[1]) =>
  makeGrokAdapter(decodeGrokSettings({ binaryPath }), options).pipe(Effect.orDie);

it("requires a settlement to match the live Grok turn", () => {
  const staleTurnId = TurnId.make("stale-turn");
  const replacementTurnId = TurnId.make("replacement-turn");

  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: replacementTurnId,
      liveSessionActiveTurnId: replacementTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isFalse(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "replacement-session",
      expectedAcpSessionId: "stale-session",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
  assert.isTrue(
    grokPromptSettlementBelongsToContext({
      liveAcpSessionId: "session-1",
      expectedAcpSessionId: "session-1",
      liveActiveTurnId: staleTurnId,
      liveSessionActiveTurnId: staleTurnId,
      turnId: staleTurnId,
    }),
  );
});

it.effect("preserves ACP acceptance when later local finalization fails", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("grok-post-acceptance-finalization-failure");
    const turnId = TurnId.make("turn-post-acceptance-finalization-failure");
    const accepted = { threadId, turnId };
    const result = yield* preserveAcceptedGrokTurn(
      Effect.fail(
        new SimulatedGrokFinalizationError({
          message: "simulated local finalization failure after session/prompt succeeded",
        }),
      ),
      accepted,
      { threadId, turnId },
    );

    assert.deepEqual(result, accepted);
  }),
);

it.layer(grokAdapterTestLayer)("GrokAdapterLive", (it) => {
  it.effect("starts a session and maps mock ACP prompt flow to runtime events", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const accountUsageUpdated = yield* Deferred.make<void>();
      const tokenUsageUpdated = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : event.type === "account.rate-limits.updated"
                ? Deferred.succeed(accountUsageUpdated, undefined)
                : event.type === "thread.token-usage.updated"
                  ? Deferred.succeed(tokenUsageUpdated, undefined)
                  : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-mock-alt" },
      });

      assert.equal(session.provider, "grok");
      assert.equal(session.model, "grok-mock-alt");
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      yield* Effect.all([Deferred.await(accountUsageUpdated), Deferred.await(tokenUsageUpdated)], {
        concurrency: 2,
      });

      yield* adapter.sendTurn({
        threadId,
        input: "hello grok",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(runtimeEventsFiber);
      const types = runtimeEvents.map((e) => e.type);

      assert.includeMembers(types, [
        "session.started",
        "session.state.changed",
        "thread.started",
        "account.rate-limits.updated",
        "thread.token-usage.updated",
        "turn.started",
        "item.started",
        "content.delta",
        "turn.completed",
      ] as const);

      const usage = runtimeEvents.find((event) => event.type === "account.rate-limits.updated");
      assert.isDefined(usage);
      if (usage?.type === "account.rate-limits.updated") {
        const rateLimits = usage.payload.rateLimits as {
          readonly config?: { readonly creditUsagePercent?: number };
        };
        assert.equal(rateLimits.config?.creditUsagePercent, 6);
      }

      const delta = runtimeEvents.find((e) => e.type === "content.delta");
      assert.isDefined(delta);
      if (delta?.type === "content.delta") {
        assert.equal(delta.payload.delta, "hello from mock");
      }

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("closes the ACP child process when a session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-session-close");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-adapter-exit-log-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");

      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.stopSession(threadId);

      const exitLog = yield* waitForFileContent(exitLogPath);
      assert.include(exitLog, "SIGTERM");
    }),
  );

  it.effect("reports a Grok session running only while the prompt is in flight", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-session-ready-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requestOpened =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "request.opened" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? Deferred.succeed(requestOpened, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "check lifecycle", attachments: [] })
        .pipe(Effect.forkChild);
      const requestOpenedEvent = yield* Deferred.await(requestOpened);

      const runningSessions = yield* adapter.listSessions();
      const runningSession = runningSessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.isDefined(runningSession?.activeTurnId);

      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make(String(requestOpenedEvent.requestId)),
        "accept",
      );
      yield* Fiber.join(sendTurnFiber);

      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("delivers an exact live steer while keeping the overlapping Grok turn running", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-exact-live-steer");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-exact-live-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const closeLogPath = NodePath.join(tempDir, "close.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_CLOSE_SESSION_LOG_PATH: closeLogPath,
          T3_ACP_CLOSE_SESSION_DELAY_MS: "1000",
        }),
      );
      const baseFileSystem = yield* FileSystem.FileSystem;
      const { attachmentsDir } = yield* ServerConfig;
      const attachmentReadStarted = yield* Deferred.make<void>();
      const releaseAttachmentRead = yield* Deferred.make<void>();
      const attachment = {
        type: "image" as const,
        id: "grok-exact-live-steer-12345678-1234-1234-1234-123456789abc",
        name: "steer.png",
        mimeType: "image/png",
        sizeBytes: 4,
      };
      const attachmentPath = NodePath.join(attachmentsDir, attachmentRelativePath(attachment));
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.dirname(attachmentPath), { recursive: true });
        await NodeFSP.writeFile(attachmentPath, Uint8Array.from([1, 2, 3, 4]));
      });
      const gatedFileSystem = FileSystem.FileSystem.of({
        ...baseFileSystem,
        readFile: (path) =>
          path === attachmentPath
            ? Deferred.succeed(attachmentReadStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseAttachmentRead)),
                Effect.andThen(baseFileSystem.readFile(path)),
              )
            : baseFileSystem.readFile(path),
      });
      const adapter = yield* makeTestAdapter(wrapperPath).pipe(
        Effect.provideService(FileSystem.FileSystem, gatedFileSystem),
      );
      const turnStarted = yield* Deferred.make<TurnId>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.started" && event.turnId !== undefined
          ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstMessageId = MessageId.make("grok-exact-live-running");
      const firstTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          messageId: firstMessageId,
          input: "keep the original Grok turn running",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      const activeTurnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, `"messageId":"${firstMessageId}"`);

      const steeredTurn = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("grok-exact-live-steer"),
        input: "apply this correction immediately",
        attachments: [],
        liveSteerTarget: {
          providerInstanceId: ProviderInstanceId.make("grok"),
          activeTurnId,
        },
      });

      assert.equal(steeredTurn.turnId, activeTurnId);
      const sessions = yield* adapter.listSessions();
      const runningSession = sessions.find((session) => session.threadId === threadId);
      assert.equal(runningSession?.status, "running");
      assert.equal(runningSession?.activeTurnId, activeTurnId);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(requests.filter((entry) => entry.method === "session/prompt").length, 2);

      // Pass the early target check and reserve a prompt slot, then stop the
      // session while attachment preparation is deliberately gated. Releasing
      // it crosses the final pre-prompt check in the stopping context.
      const racedMessageId = MessageId.make("grok-stop-race-live-steer");
      const racedSteerExitFiber = yield* adapter
        .sendTurn({
          threadId,
          messageId: racedMessageId,
          input: "must not enter the stopping Grok session",
          attachments: [attachment],
          liveSteerTarget: {
            providerInstanceId: ProviderInstanceId.make("grok"),
            activeTurnId,
          },
        })
        .pipe(Effect.exit, Effect.forkChild);
      yield* Deferred.await(attachmentReadStarted).pipe(Effect.timeout("2 seconds"));

      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* waitForFileContent(closeLogPath, 80, "session/close");
      assert.isFalse(yield* adapter.hasSession(threadId));
      const stoppingSessions = yield* adapter.listSessions();
      const stoppingSession = stoppingSessions.find((session) => session.threadId === threadId);
      assert.equal(stoppingSession?.status, "running");
      assert.equal(stoppingSession?.activeTurnId, activeTurnId);

      yield* Deferred.succeed(releaseAttachmentRead, undefined);
      const racedSteerExit = yield* Fiber.join(racedSteerExitFiber).pipe(
        Effect.timeout("2 seconds"),
      );
      assert.equal(racedSteerExit._tag, "Failure");
      const requestsAfterStopRace = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptMessageIds = requestsAfterStopRace
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => {
          const params = entry.params as { readonly messageId?: unknown } | undefined;
          return params?.messageId;
        });
      assert.deepEqual(promptMessageIds, [firstMessageId, "grok-exact-live-steer"]);
      assert.notInclude(promptMessageIds, racedMessageId);

      yield* Fiber.join(stopFiber).pipe(Effect.timeout("3 seconds"));
      yield* Fiber.interrupt(firstTurnFiber);
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("admits repeated live steers to Grok's native queue in FIFO order", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-repeated-live-steer-fifo");
      const hostMessageId = MessageId.make("grok-repeated-live-steer-host");
      const firstSteerMessageId = MessageId.make("grok-repeated-live-steer-first");
      const secondSteerMessageId = MessageId.make("grok-repeated-live-steer-second");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-repeated-live-steer-fifo-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_ANNOUNCE_HANGING_PROMPT: "1",
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const turnStarted = yield* Deferred.make<TurnId>();
      const allPromptsReachedGrok = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.started" && event.turnId !== undefined
          ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.ignore)
          : event.type === "content.delta" && event.payload.delta === "hanging-prompt-3"
            ? Deferred.succeed(allPromptsReachedGrok, undefined).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const hostDispatched = yield* Deferred.make<void>();
      const hostFiber = yield* adapter
        .sendTurn(
          {
            threadId,
            messageId: hostMessageId,
            input: "keep the host turn running",
            attachments: [],
          },
          { onNativeDispatch: Deferred.succeed(hostDispatched, undefined) },
        )
        .pipe(Effect.forkChild);
      const activeTurnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(hostDispatched).pipe(Effect.timeout("2 seconds"));

      const firstSteerDispatched = yield* Deferred.make<void>();
      const firstSteerFiber = yield* adapter
        .sendTurn(
          {
            threadId,
            messageId: firstSteerMessageId,
            input: "apply the first correction",
            attachments: [],
            liveSteerTarget: {
              providerInstanceId: ProviderInstanceId.make("grok"),
              activeTurnId,
            },
          },
          { onNativeDispatch: Deferred.succeed(firstSteerDispatched, undefined) },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstSteerDispatched).pipe(Effect.timeout("2 seconds"));

      const secondSteerDispatched = yield* Deferred.make<void>();
      const secondSteerFiber = yield* adapter
        .sendTurn(
          {
            threadId,
            messageId: secondSteerMessageId,
            input: "apply the second correction",
            attachments: [],
            liveSteerTarget: {
              providerInstanceId: ProviderInstanceId.make("grok"),
              activeTurnId,
            },
          },
          { onNativeDispatch: Deferred.succeed(secondSteerDispatched, undefined) },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(secondSteerDispatched).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(allPromptsReachedGrok).pipe(Effect.timeout("2 seconds"));

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptMessageIds = requests
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => {
          const params = entry.params as { readonly messageId?: unknown } | undefined;
          return params?.messageId;
        });
      assert.deepEqual(promptMessageIds, [
        hostMessageId,
        firstSteerMessageId,
        secondSteerMessageId,
      ]);
      assert.isUndefined(firstSteerFiber.pollUnsafe());
      assert.isUndefined(secondSteerFiber.pollUnsafe());

      yield* adapter.interruptTurn(threadId, activeTurnId).pipe(Effect.timeout("2 seconds"));
      yield* Effect.all(
        [Fiber.await(hostFiber), Fiber.await(firstSteerFiber), Fiber.await(secondSteerFiber)],
        { concurrency: 3 },
      ).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("fails an explicit live steer instead of prompting a successor Grok turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stale-live-steer-successor");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-stale-live-steer-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_PROMPT_DELAY_MS: "300",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const originalTurn = yield* adapter.sendTurn({
        threadId,
        messageId: MessageId.make("grok-original-turn"),
        input: "finish the original Grok turn",
        attachments: [],
      });
      const successorMessageId = MessageId.make("grok-successor-turn");
      const successorFiber = yield* adapter
        .sendTurn({
          threadId,
          messageId: successorMessageId,
          input: "run the successor Grok turn",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const successorTurnId = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = yield* adapter.listSessions();
          const session = sessions.find((entry) => entry.threadId === threadId);
          if (
            session?.status === "running" &&
            session.activeTurnId !== undefined &&
            session.activeTurnId !== originalTurn.turnId
          ) {
            return session.activeTurnId;
          }
          yield* Effect.sleep("10 millis");
        }
        return yield* Effect.die("Timed out waiting for the Grok successor turn.");
      });
      yield* waitForFileContent(requestLogPath, 80, `"messageId":"${successorMessageId}"`);

      const staleMessageId = MessageId.make("grok-stale-live-steer");
      const exit = yield* adapter
        .sendTurn({
          threadId,
          messageId: staleMessageId,
          input: "must not reach the Grok successor",
          attachments: [],
          liveSteerTarget: {
            providerInstanceId: ProviderInstanceId.make("grok"),
            activeTurnId: originalTurn.turnId,
          },
        })
        .pipe(Effect.exit);

      assert.equal(exit._tag, "Failure");
      const successorTurn = yield* Fiber.join(successorFiber);
      assert.equal(successorTurn.turnId, successorTurnId);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptMessageIds = requests
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => {
          const params = entry.params as { readonly messageId?: unknown } | undefined;
          return params?.messageId;
        });
      assert.deepEqual(promptMessageIds, ["grok-original-turn", "grok-successor-turn"]);
      assert.notInclude(promptMessageIds, staleMessageId);

      const settledSessions = yield* adapter.listSessions();
      const settledSession = settledSessions.find((session) => session.threadId === threadId);
      assert.equal(settledSession?.status, "ready");
      assert.isUndefined(settledSession?.activeTurnId);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("restores ready without completing an unstarted turn when preparation fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-preparation-failure-while-connecting");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "prepare invalid attachment",
          attachments: [
            {
              type: "image",
              id: "missing-image",
              name: "missing.png",
              mimeType: "image/png",
              sizeBytes: 1,
            },
          ],
        }),
      );
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.isUndefined(turnCompletedEvent);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("completes a Grok turn from xAI prompt completion when the prompt RPC hangs", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-fallback");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
          T3_ACP_EMIT_FOREIGN_SESSION_UPDATES: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnResult = yield* adapter.sendTurn({
        threadId,
        input: "exercise fallback",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );
      const eventTypes = runtimeEvents.map((event) => event.type);
      const content = runtimeEvents
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "content.delta" }> =>
            event.type === "content.delta" && String(event.threadId) === String(threadId),
        )
        .map((event) => event.payload.delta)
        .join("");
      const terminalIndex = runtimeEvents.findIndex(
        (event) => event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterTerminal = runtimeEvents
        .slice(terminalIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );
      const toolTitles = runtimeEvents.flatMap((event) =>
        event.type === "item.updated" && event.payload.title ? [event.payload.title] : [],
      );

      assert.equal(sendTurnResult.threadId, threadId);
      assert.include(eventTypes, "turn.completed");
      assert.equal(content, "hello from mock");
      assert.isAtLeast(terminalIndex, 0);
      assert.deepEqual(outputAfterTerminal, []);
      assert.notInclude(toolTitles, "Child-only tool");
      assert.equal(turnCompletedEvent?.payload.stopReason, "end_turn");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("retains turn transcript when sendTurn is interrupted after prompt success", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-send-turn-interrupt-after-prompt");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const contentDelta = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "interrupt after prompt",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      yield* Deferred.await(contentDelta);
      for (let yieldAttempt = 0; yieldAttempt < 6; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }
      yield* Fiber.interrupt(sendTurnFiber);
      for (let yieldAttempt = 0; yieldAttempt < 4; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const snapshot = yield* adapter.readThread(threadId);
      assert.equal(snapshot.turns.length, 1);
      assert.equal(snapshot.turns[0]?.items.length, 1);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("does not report a synthetic stop reason when xAI omits one", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-prompt-complete-missing-stop-reason");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
          T3_ACP_OMIT_XAI_PROMPT_COMPLETE_STOP_REASON: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "exercise missing stop reason",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      const turnCompletedEvent = runtimeEvents.find(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed",
      );

      assert.equal(turnCompletedEvent?.payload.state, "completed");
      assert.isNull(turnCompletedEvent?.payload.stopReason);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("lets Stop unblock a fully silent Grok prompt and accept a follow-up turn", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-after-full-silence");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* Effect.gen(function* () {
        yield* Effect.sleep("500 millis");
        yield* adapter.interruptTurn(threadId);
      }).pipe(Effect.forkChild({ startImmediately: true }));

      yield* adapter.sendTurn({
        threadId,
        input: "hang forever",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(cancelledEvents, 1);
      assert.equal(cancelledEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      const followUpEventsBefore = runtimeEvents.length;
      yield* adapter.sendTurn({
        threadId,
        input: "continue after stop",
        attachments: [],
      });
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const followUpCompletedEvents = runtimeEvents
        .slice(followUpEventsBefore)
        .filter(
          (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
            event.type === "turn.completed" && String(event.threadId) === String(threadId),
        );
      assert.lengthOf(followUpCompletedEvents, 1);
      assert.equal(followUpCompletedEvents[0]?.payload.state, "completed");

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not let a cancelled prompt settlement consume the follow-up prompt slot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-cancelled-settlement-before-follow-up");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-cancel-race-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const twoTurnsCompleted = yield* Deferred.make<void>();
      const completedCountRef = yield* Ref.make(0);
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started" && event.turnId !== undefined) {
            yield* Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore);
            return;
          }
          if (event.type !== "turn.completed") {
            return;
          }
          const completedCount = yield* Ref.updateAndGet(completedCountRef, (count) => count + 1);
          if (completedCount === 2) {
            yield* Deferred.succeed(twoTurnsCompleted, undefined);
          }
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      const followUp = yield* adapter
        .sendTurn({ threadId, input: "complete the follow-up", attachments: [] })
        .pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(firstSendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(twoTurnsCompleted).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.notEqual(String(followUp.turnId), String(firstTurnId));
      assert.deepEqual(
        turnCompletedEvents.map((event) => [String(event.turnId), event.payload.state]),
        [
          [String(firstTurnId), "cancelled"],
          [String(followUp.turnId), "completed"],
        ],
      );
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("spaces two session/cancel notifications so Stop matches the CLI double-enter", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-double-cancel");
      const cancelProtocolTimes: number[] = [];
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-double-cancel-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-double-cancel-native-events",
          write: (record: unknown) =>
            Effect.sync(() => {
              const protocolEvent = (
                record as {
                  event?: {
                    kind?: unknown;
                    payload?: {
                      direction?: unknown;
                      stage?: unknown;
                      payload?: unknown;
                    };
                  };
                }
              ).event;
              if (
                protocolEvent?.kind === "protocol" &&
                protocolEvent.payload?.direction === "outgoing" &&
                protocolEvent.payload.stage === "decoded" &&
                typeof protocolEvent.payload.payload === "object" &&
                protocolEvent.payload.payload !== null &&
                "method" in protocolEvent.payload.payload &&
                protocolEvent.payload.payload.method === "session/cancel"
              ) {
                cancelProtocolTimes.push(performance.now());
              }
            }),
          close: () => Effect.void,
        },
      });

      const firstTurnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        String(event.threadId) === String(threadId) &&
        event.type === "turn.started" &&
        event.turnId !== undefined
          ? Deferred.succeed(firstTurnStarted, event.turnId).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      yield* adapter
        .sendTurn({ threadId, input: "cancel this prompt", attachments: [] })
        .pipe(Effect.forkChild);
      const firstTurnId = yield* Deferred.await(firstTurnStarted).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');

      yield* adapter.interruptTurn(threadId, firstTurnId).pipe(Effect.timeout("2 seconds"));
      const cancelCount = yield* Effect.gen(function* () {
        for (let attempt = 0; attempt < 80; attempt += 1) {
          const raw = yield* Effect.tryPromise(() => NodeFSP.readFile(requestLogPath, "utf8")).pipe(
            Effect.orElseSucceed(() => ""),
          );
          const count = raw.split('"method":"session/cancel"').length - 1;
          if (count >= 2) {
            return count;
          }
          yield* Effect.sleep("25 millis");
        }
        return yield* Effect.die(
          new Error("Timed out waiting for two session/cancel notifications"),
        );
      });
      assert.isAtLeast(cancelCount, 2);
      assert.lengthOf(cancelProtocolTimes, 2);
      assert.isAtLeast(cancelProtocolTimes[1]! - cancelProtocolTimes[0]!, 30);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("finishes interrupted teardown before replacing the Grok session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-interrupted-during-teardown");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-stop-teardown-")),
      );
      const exitLogPath = NodePath.join(tempDir, "exit.log");
      const wrapperPidPath = NodePath.join(tempDir, "wrapper.pid");
      const agentPidPath = NodePath.join(tempDir, "agent.pid");
      const detachedChildPidPath = NodePath.join(tempDir, "detached-child.pid");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EXIT_LOG_PATH: exitLogPath,
          T3_ACP_WRAPPER_PID_LOG_PATH: wrapperPidPath,
          T3_ACP_PID_LOG_PATH: agentPidPath,
          T3_ACP_DETACHED_CHILD_PID_LOG_PATH: detachedChildPidPath,
          T3_ACP_DISABLE_CLOSE_CAPABILITY: "1",
          T3_ACP_WRAPPER_IGNORE_SIGTERM: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const wrapperPid = Number((yield* waitForFileContent(wrapperPidPath)).trim());
      const agentPid = Number((yield* waitForFileContent(agentPidPath)).trim());
      const detachedChildPid = Number((yield* waitForFileContent(detachedChildPidPath)).trim());
      assert.isTrue(processIsRunning(wrapperPid));
      assert.isTrue(processIsRunning(agentPid));
      assert.isTrue(processIsRunning(detachedChildPid));

      const stoppedSessionExited = yield* Deferred.make<void>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "session.exited" && String(event.threadId) === String(threadId)
          ? Deferred.succeed(stoppedSessionExited, undefined).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* waitForFileContent(exitLogPath, 80, "SIGTERM");
      yield* Fiber.interrupt(stopFiber);

      // Restart while the detached teardown is still waiting to escalate from
      // SIGTERM. It must join that teardown before installing its replacement;
      // otherwise the old cleanup can delete the new context by thread id.
      const restartFiber = yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(stoppedSessionExited).pipe(Effect.timeout("4 seconds"));
      yield* Fiber.join(restartFiber).pipe(Effect.timeout("4 seconds"));

      assert.isFalse(processIsRunning(wrapperPid));
      assert.isFalse(processIsRunning(agentPid));
      assert.isFalse(processIsRunning(detachedChildPid));
      assert.isTrue(yield* adapter.hasSession(threadId));
      assert.lengthOf(yield* adapter.listSessions(), 1);

      yield* adapter.stopSession(threadId).pipe(Effect.timeout("4 seconds"));
      yield* Fiber.interrupt(runtimeEventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("closes an advertised ACP session before shutting down its host", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-closes-acp-session");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-session-close-")),
      );
      const closeLogPath = NodePath.join(tempDir, "close.log");
      const detachedChildPidPath = NodePath.join(tempDir, "detached-child.pid");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_CLOSE_SESSION_LOG_PATH: closeLogPath,
          T3_ACP_DETACHED_CHILD_PID_LOG_PATH: detachedChildPidPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const detachedChildPid = Number((yield* waitForFileContent(detachedChildPidPath)).trim());
      assert.isTrue(processIsRunning(detachedChildPid));

      yield* adapter.stopSession(threadId).pipe(Effect.timeout("4 seconds"));

      assert.include(yield* waitForFileContent(closeLogPath), "session/close");
      assert.isFalse(processIsRunning(detachedChildPid));
      assert.isFalse(yield* adapter.hasSession(threadId));
    }).pipe(TestClock.withLive),
  );

  it.effect("drops late ACP notifications after a turn is cancelled", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-drop-late-cancelled-notifications");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_HANG_PROMPT_FOREVER: "1",
          T3_ACP_EMIT_LATE_UPDATE_AFTER_CANCEL: "1",
        }),
      );
      const lateNativeUpdate = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-cancelled-native-events",
          write: (record: unknown) =>
            JSON.stringify(record).includes("late after cancel")
              ? Deferred.succeed(lateNativeUpdate, undefined).pipe(Effect.asVoid)
              : Effect.void,
          close: () => Effect.void,
        },
      });

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnStarted = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" &&
              event.turnId !== undefined &&
              String(event.threadId) === String(threadId)
              ? Deferred.succeed(turnStarted, event.turnId).pipe(Effect.asVoid)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "cancel before the late update", attachments: [] })
        .pipe(Effect.forkChild);
      const turnId = yield* Deferred.await(turnStarted).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));
      yield* Deferred.await(lateNativeUpdate).pipe(Effect.timeout("2 seconds"));
      for (let yieldAttempt = 0; yieldAttempt < 8; yieldAttempt += 1) {
        yield* Effect.yieldNow;
      }

      const cancelledIndex = runtimeEvents.findIndex(
        (event) =>
          event.type === "turn.completed" &&
          String(event.threadId) === String(threadId) &&
          String(event.turnId) === String(turnId) &&
          event.payload.state === "cancelled",
      );
      const turnOutputTypes = new Set([
        "content.delta",
        "item.started",
        "item.updated",
        "item.completed",
        "turn.plan.updated",
      ]);
      const outputAfterCancellation = runtimeEvents
        .slice(cancelledIndex + 1)
        .filter(
          (event) => String(event.threadId) === String(threadId) && turnOutputTypes.has(event.type),
        );

      assert.isAtLeast(cancelledIndex, 0);
      assert.deepEqual(outputAfterCancellation, []);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("lets Stop cancel during the xAI completion drain window", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-during-completion-drain");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_PROMPT_COMPLETE_THEN_HANG: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const activeTurnIdRef = yield* Ref.make<TurnId | undefined>(undefined);
      const trailingChunkTurnId = yield* Deferred.make<TurnId>();
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.gen(function* () {
          runtimeEvents.push(event);
          if (String(event.threadId) !== String(threadId)) {
            return;
          }
          if (event.type === "turn.started") {
            yield* Ref.set(activeTurnIdRef, event.turnId);
          }
          if (event.type !== "content.delta" || event.payload.delta !== "mock") {
            return;
          }
          const turnId = event.turnId ?? (yield* Ref.get(activeTurnIdRef));
          if (turnId === undefined) {
            return;
          }
          yield* Deferred.succeed(trailingChunkTurnId, turnId).pipe(Effect.ignore);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({
          threadId,
          input: "cancel during completion drain",
          attachments: [],
        })
        .pipe(Effect.forkChild);

      const turnId = yield* Deferred.await(trailingChunkTurnId).pipe(Effect.timeout("2 seconds"));
      yield* adapter.interruptTurn(threadId, turnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(sendTurnFiber).pipe(Effect.timeout("2 seconds"));

      const turnCompletedEvents = runtimeEvents.filter(
        (event): event is Extract<ProviderRuntimeEvent, { type: "turn.completed" }> =>
          event.type === "turn.completed" && String(event.threadId) === String(threadId),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.lengthOf(turnCompletedEvents, 1);
      assert.equal(turnCompletedEvents[0]?.payload.state, "cancelled");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("settles the in-flight prompt before emitting completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-completion-before-next-turn");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const completedCountRef = yield* Ref.make(0);
      const secondTurnCompleted = yield* Deferred.make<void>();

      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (event.type !== "turn.completed" || String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }

        return Ref.modify(completedCountRef, (count) => {
          const nextCount = count + 1;
          return [nextCount, nextCount] as const;
        }).pipe(
          Effect.flatMap((count) => {
            if (count === 1) {
              return adapter
                .sendTurn({
                  threadId,
                  input: "second turn after completion",
                  attachments: [],
                })
                .pipe(Effect.forkChild, Effect.asVoid);
            }
            if (count === 2) {
              return Deferred.succeed(secondTurnCompleted, undefined).pipe(Effect.asVoid);
            }
            return Effect.void;
          }),
        );
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "first turn",
        attachments: [],
      });
      yield* Deferred.await(secondTurnCompleted);

      const completedCount = yield* Ref.get(completedCountRef);
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);

      assert.equal(completedCount, 2);
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("restores a Grok session to ready when the prompt RPC fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-prompt-failure-ready");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_FAIL_PROMPT: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          messageId: MessageId.make("message-grok-rejected"),
          input: "fail prompt",
          attachments: [],
        }),
      );
      const readySessions = yield* adapter.listSessions();
      const readySession = readySessions.find((session) => session.threadId === threadId);
      const failedTurnCompleted = runtimeEvents.find(
        (event) => event.type === "turn.completed" && event.threadId === threadId,
      );

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(readySession?.status, "ready");
      assert.isUndefined(readySession?.activeTurnId);
      assert.isUndefined(
        runtimeEvents.find(
          (event) =>
            event.type === "message.delivered" &&
            event.payload.messageId === "message-grok-rejected",
        ),
      );
      assert.equal(failedTurnCompleted?.type, "turn.completed");
      if (failedTurnCompleted?.type === "turn.completed") {
        assert.equal(failedTurnCompleted.payload.state, "failed");
        assert.isString(failedTurnCompleted.payload.errorMessage);
      }

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("ignores replayed session/load updates when resuming a Grok session", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-load-replay-filter");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_LOAD_REPLAY: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runtimeEventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        resumeCursor: { schemaVersion: 1, sessionId: "mock-session-1" },
      });

      yield* adapter.sendTurn({
        threadId,
        input: "after resume",
        attachments: [],
      });

      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-session-1",
      });
      assert.isFalse(
        runtimeEvents.some(
          (event) => event.type === "item.completed" && event.payload.title === "Replay tool",
        ),
      );
      assert.isFalse(
        runtimeEvents.some(
          (event) =>
            event.type === "content.delta" && event.payload.delta === "replayed assistant text",
        ),
      );

      yield* Fiber.interrupt(runtimeEventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects startSession when provider mismatches", () =>
    Effect.gen(function* () {
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);
      const threadId = ThreadId.make("grok-provider-mismatch");

      const error = yield* Effect.flip(
        adapter.startSession({
          threadId,
          provider: ProviderDriverKind.make("cursor"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
          modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");
    }),
  );

  it.effect("rejects sendTurn with empty input and no attachments", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-empty-turn");

      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("grok"), model: "grok-build" },
      });

      const error = yield* Effect.flip(
        adapter.sendTurn({
          threadId,
          input: "   ",
          attachments: [],
        }),
      );

      assert.equal(error._tag, "ProviderAdapterValidationError");

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("responds to ACP approvals using provider-supplied option ids", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-custom-approval-option-id");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
          T3_ACP_ALLOW_ONCE_OPTION_ID: "agent-defined-approval-id",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "request.opened"
          ? adapter.respondToRequest(
              threadId,
              ApprovalRequestId.make(String(event.requestId)),
              "accept",
            )
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "approval-required",
      });
      yield* adapter.sendTurn({ threadId, input: "approve this", attachments: [] });

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "agent-defined-approval-id",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("handles xAI ask_user_question extension requests", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-xai-ask-user-question");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({ T3_ACP_EMIT_XAI_ASK_USER_QUESTION: "1" }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const requested =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.requested" }>>();
      const resolved =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "user-input.resolved" }>>();

      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) => {
        if (String(event.threadId) !== String(threadId)) {
          return Effect.void;
        }
        if (event.type === "user-input.requested") {
          return Deferred.succeed(requested, event).pipe(Effect.ignore);
        }
        if (event.type === "user-input.resolved") {
          return Deferred.succeed(resolved, event).pipe(Effect.ignore);
        }
        return Effect.void;
      }).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const sendTurnFiber = yield* adapter
        .sendTurn({ threadId, input: "ask before continuing", attachments: [] })
        .pipe(Effect.forkChild);

      const requestedEvent = yield* Deferred.await(requested);
      assert.equal(requestedEvent.payload.questions.length, 1);
      assert.equal(requestedEvent.payload.questions[0]?.id, "Which scope should Grok use?");
      assert.equal(requestedEvent.payload.questions[0]?.question, "Which scope should Grok use?");
      assert.equal(requestedEvent.raw?.method, "x.ai/ask_user_question");

      yield* adapter.respondToUserInput(
        threadId,
        ApprovalRequestId.make(String(requestedEvent.requestId)),
        {
          "Which scope should Grok use?": "Workspace",
        },
      );

      const resolvedEvent = yield* Deferred.await(resolved);
      assert.deepEqual(resolvedEvent.payload.answers, {
        "Which scope should Grok use?": "Workspace",
      });
      assert.equal(String(resolvedEvent.turnId), String(requestedEvent.turnId));
      yield* Fiber.join(sendTurnFiber);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("continues streaming events when native notification logging fails", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-native-log-failure");
      const wrapperPath = yield* Effect.promise(() => makeMockGrokWrapper());
      const adapter = yield* makeTestAdapter(wrapperPath, {
        nativeEventLogger: {
          filePath: "memory://grok-native-events",
          write: (record: unknown) =>
            typeof record === "object" &&
            record !== null &&
            "event" in record &&
            typeof record.event === "object" &&
            record.event !== null &&
            "kind" in record.event &&
            record.event.kind === "notification"
              ? Effect.die(new Error("native log write failed"))
              : Effect.void,
          close: () => Effect.void,
        },
      });
      const contentDelta = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "content.delta" ? Deferred.succeed(contentDelta, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({ threadId, input: "keep streaming", attachments: [] });
      yield* Deferred.await(contentDelta);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps app plan mode onto the ACP plan session mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-plan-mode-probe");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const modeRequest = requests
        .toReversed()
        .find(
          (entry) =>
            entry.method === "session/set_mode" ||
            (entry.method === "session/set_config_option" &&
              (entry.params as Record<string, unknown> | undefined)?.configId === "mode"),
        );
      assert.isDefined(modeRequest);
      assert.include(
        ["architect", "plan"],
        String(
          (modeRequest?.params as Record<string, unknown> | undefined)?.modeId ??
            (modeRequest?.params as Record<string, unknown> | undefined)?.value,
        ),
      );
    }),
  );

  it.effect("sends Codex-style plan collaboration instructions on plan turns", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-plan-instructions");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan the refactor",
        attachments: [],
        interactionMode: "plan",
      });
      yield* waitForFileContent(requestLogPath, 80, '"method":"session/prompt"');
      yield* adapter.stopSession(threadId);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptRequest = requests.find((entry) => entry.method === "session/prompt");
      assert.isDefined(promptRequest);
      const promptText = encodeUnknownJson(promptRequest?.params);
      assert.include(promptText, "Plan Mode");
      assert.include(promptText, "<proposed_plan>");
      assert.include(promptText, "plan the refactor");
    }),
  );

  it.effect("captures a proposed plan from Grok assistant text", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-proposed-plan");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_PROMPT_RESPONSE_TEXT:
            "Here is the approach. <proposed_plan> # Auth rewrite Use the existing session store. </proposed_plan>",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const proposedPlan =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "turn.proposed.completed" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.proposed.completed"
          ? Deferred.succeed(proposedPlan, event).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan the auth rewrite",
        attachments: [],
        interactionMode: "plan",
      });

      const completed = yield* Deferred.await(proposedPlan);
      assert.equal(
        completed.payload.planMarkdown,
        "# Auth rewrite Use the existing session store.",
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("rejects mutating tool permissions while Grok is in plan mode", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-plan-denies-execute");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-acp-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_EMIT_TOOL_CALLS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "plan this change",
        attachments: [],
        interactionMode: "plan",
      });
      yield* Deferred.await(turnCompleted);
      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(eventsFiber);

      assert.isFalse(runtimeEvents.some((event) => event.type === "request.opened"));
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            !("method" in entry) &&
            typeof entry.result === "object" &&
            entry.result !== null &&
            "outcome" in entry.result &&
            typeof entry.result.outcome === "object" &&
            entry.result.outcome !== null &&
            "optionId" in entry.result.outcome &&
            entry.result.outcome.optionId === "reject-once",
        ),
      );
    }),
  );

  it.effect("emits a delivery receipt when Grok accepts the prompt", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-delivery-receipt");
      const messageId = MessageId.make("message-grok-accepted");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "200",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const deliveryReceipt = yield* Deferred.make<void>();
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "message.delivered"
              ? Deferred.succeed(deliveryReceipt, undefined)
              : event.type === "turn.completed"
                ? Deferred.succeed(turnCompleted, undefined)
                : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sendFiber = yield* adapter
        .sendTurn({
          threadId,
          messageId,
          input: "hello grok",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(deliveryReceipt).pipe(Effect.timeout("1 second"));
      assert.isUndefined(sendFiber.pollUnsafe());
      yield* Fiber.join(sendFiber);
      yield* Deferred.await(turnCompleted);

      const receipt = runtimeEvents.find((event) => event.type === "message.delivered");
      assert.isDefined(receipt);
      if (receipt?.type === "message.delivered") {
        assert.equal(receipt.payload.messageId, messageId);
      }
      const receiptIndex = runtimeEvents.findIndex((event) => event.type === "message.delivered");
      const completedIndex = runtimeEvents.findIndex((event) => event.type === "turn.completed");
      assert.isTrue(receiptIndex >= 0 && receiptIndex < completedIndex);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("keeps a queued steer retryable when Stop removes its session before consumption", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-stop-removes-unconsumed-steer");
      const hostMessageId = MessageId.make("grok-stop-removes-unconsumed-host");
      const steerMessageId = MessageId.make("grok-stop-removes-unconsumed-steer");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const hostDelivered = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "message.delivered" && event.payload.messageId === hostMessageId
              ? Deferred.succeed(hostDelivered, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const hostFiber = yield* adapter
        .sendTurn({
          threadId,
          messageId: hostMessageId,
          input: "keep running",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(hostDelivered).pipe(Effect.timeout("2 seconds"));
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      if (session?.activeTurnId === undefined) {
        return yield* Effect.die("Expected an active Grok host turn.");
      }

      const steerDispatched = yield* Deferred.make<void>();
      const steerFiber = yield* adapter
        .sendTurn(
          {
            threadId,
            messageId: steerMessageId,
            input: "queued correction",
            attachments: [],
            liveSteerTarget: {
              providerInstanceId: ProviderInstanceId.make("grok"),
              activeTurnId: session.activeTurnId,
            },
          },
          { onNativeDispatch: Deferred.succeed(steerDispatched, undefined) },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(steerDispatched).pipe(Effect.timeout("2 seconds"));
      yield* adapter.stopSession(threadId).pipe(Effect.timeout("3 seconds"));

      const error = yield* Effect.flip(Fiber.join(steerFiber)).pipe(Effect.timeout("2 seconds"));
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        return yield* Effect.die("Expected a retryable Grok delivery error.");
      }
      assert.equal(error.failureKind, "retryable-upstream");
      assert.notInclude(
        runtimeEvents
          .filter((event) => event.type === "message.delivered")
          .map((event) => event.payload.messageId),
        steerMessageId,
      );

      yield* Fiber.interrupt(hostFiber);
      yield* Fiber.interrupt(eventsFiber);
    }).pipe(TestClock.withLive),
  );

  it.effect("keeps a queued steer retryable when a replacement session wins completion", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-session-switch-unconsumed-steer");
      const hostMessageId = MessageId.make("grok-session-switch-host");
      const steerMessageId = MessageId.make("grok-session-switch-steer");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const hostDelivered = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "message.delivered" && event.payload.messageId === hostMessageId
              ? Deferred.succeed(hostDelivered, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const hostFiber = yield* adapter
        .sendTurn({
          threadId,
          messageId: hostMessageId,
          input: "keep running",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(hostDelivered).pipe(Effect.timeout("2 seconds"));
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      if (session?.activeTurnId === undefined) {
        return yield* Effect.die("Expected an active Grok host turn.");
      }

      const steerDispatched = yield* Deferred.make<void>();
      const steerFiber = yield* adapter
        .sendTurn(
          {
            threadId,
            messageId: steerMessageId,
            input: "queued correction before restart",
            attachments: [],
            liveSteerTarget: {
              providerInstanceId: ProviderInstanceId.make("grok"),
              activeTurnId: session.activeTurnId,
            },
          },
          { onNativeDispatch: Deferred.succeed(steerDispatched, undefined) },
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(steerDispatched).pipe(Effect.timeout("2 seconds"));
      yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(Effect.timeout("4 seconds"));

      const error = yield* Effect.flip(Fiber.join(steerFiber)).pipe(Effect.timeout("2 seconds"));
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag !== "ProviderAdapterRequestError") {
        return yield* Effect.die("Expected a retryable Grok delivery error.");
      }
      assert.equal(error.failureKind, "retryable-upstream");
      assert.notInclude(
        runtimeEvents
          .filter((event) => event.type === "message.delivered")
          .map((event) => event.payload.messageId),
        steerMessageId,
      );
      assert.isTrue(yield* adapter.hasSession(threadId));

      yield* Fiber.interrupt(hostFiber);
      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("keeps every interrupted native follow-up retryable in FIFO order", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-interrupted-native-follow-ups");
      const runningMessageId = MessageId.make("running-message");
      const olderMessageId = MessageId.make("older-queued-message");
      const newerMessageId = MessageId.make("newer-queued-message");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-interrupted-queue-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "500",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runningTurnStarted = yield* Deferred.make<TurnId>();
      const runningMessageDelivered = yield* Deferred.make<void>();
      const olderMessageDelivered = yield* Deferred.make<void>();
      const newerMessageDelivered = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.started" && event.turnId !== undefined
              ? Deferred.succeed(runningTurnStarted, event.turnId).pipe(Effect.asVoid)
              : event.type === "message.delivered" && event.payload.messageId === runningMessageId
                ? Deferred.succeed(runningMessageDelivered, undefined).pipe(Effect.asVoid)
                : event.type === "message.delivered" && event.payload.messageId === olderMessageId
                  ? Deferred.succeed(olderMessageDelivered, undefined).pipe(Effect.asVoid)
                  : event.type === "message.delivered" && event.payload.messageId === newerMessageId
                    ? Deferred.succeed(newerMessageDelivered, undefined).pipe(Effect.asVoid)
                    : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const runningSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: runningMessageId,
          input: "start the long task",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      const runningTurnId = yield* Deferred.await(runningTurnStarted).pipe(
        Effect.timeout("1 second"),
      );
      yield* Deferred.await(runningMessageDelivered).pipe(Effect.timeout("1 second"));

      const olderQueuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: olderMessageId,
          input: "first queued correction",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      const newerQueuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: newerMessageId,
          input: "second queued correction",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* waitForFileContent(requestLogPath, 80, `"messageId":"${newerMessageId}"`);

      yield* adapter.interruptTurn(threadId, runningTurnId).pipe(Effect.timeout("2 seconds"));
      yield* Fiber.join(runningSend).pipe(Effect.timeout("2 seconds"));
      const [olderError, newerError] = yield* Effect.all(
        [Effect.flip(Fiber.join(olderQueuedSend)), Effect.flip(Fiber.join(newerQueuedSend))],
        { concurrency: 2 },
      ).pipe(Effect.timeout("2 seconds"));

      assert.equal(olderError._tag, "ProviderAdapterRequestError");
      assert.equal(newerError._tag, "ProviderAdapterRequestError");
      assert.include(olderError.message, "before the model consumed it");
      assert.include(newerError.message, "before the model consumed it");
      if (
        olderError._tag !== "ProviderAdapterRequestError" ||
        newerError._tag !== "ProviderAdapterRequestError"
      ) {
        return yield* Effect.die("Expected interrupted Grok queue delivery errors.");
      }
      assert.equal(olderError.failureKind, "retryable-upstream");
      assert.equal(newerError.failureKind, "retryable-upstream");
      assert.isTrue(Option.isNone(yield* Deferred.poll(olderMessageDelivered)));
      assert.isTrue(Option.isNone(yield* Deferred.poll(newerMessageDelivered)));
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "message.delivered")
          .map((event) => event.payload.messageId),
        [runningMessageId],
      );

      // The reactor can now retry the two durable obligations oldest first.
      // Reusing their message ids proves that the cancelled attempts did not
      // cross the acceptance boundary or duplicate the already-running prompt.
      yield* adapter
        .sendTurn({
          threadId,
          messageId: olderMessageId,
          input: "first queued correction",
          attachments: [],
        })
        .pipe(Effect.timeout("2 seconds"));
      yield* adapter
        .sendTurn({
          threadId,
          messageId: newerMessageId,
          input: "second queued correction",
          attachments: [],
        })
        .pipe(Effect.timeout("2 seconds"));
      yield* Effect.all(
        [Deferred.await(olderMessageDelivered), Deferred.await(newerMessageDelivered)],
        { concurrency: 2 },
      ).pipe(Effect.timeout("1 second"));

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const promptMessageIds = requests
        .filter((entry) => entry.method === "session/prompt")
        .map((entry) => {
          const params = entry.params as { readonly messageId?: unknown } | undefined;
          return params?.messageId;
        });
      assert.deepEqual(promptMessageIds, [
        runningMessageId,
        olderMessageId,
        newerMessageId,
        olderMessageId,
        newerMessageId,
      ]);
      assert.deepEqual(
        runtimeEvents
          .filter((event) => event.type === "message.delivered")
          .map((event) => event.payload.messageId),
        [runningMessageId, olderMessageId, newerMessageId],
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("promotes every native queued prompt oldest first", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-entire-queue");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-queue-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "500",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const runningPromptDelivered = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "message.delivered" &&
              event.payload.messageId === MessageId.make("running-message")
              ? Deferred.succeed(runningPromptDelivered, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });

      const firstSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("running-message"),
          input: "start the long task",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* waitForFileContent(requestLogPath, 80, '"messageId":"running-message"');

      const olderQueuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("older-queued-message"),
          input: "first correction",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      const newerQueuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("newer-queued-message"),
          input: "second correction",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* waitForFileContent(requestLogPath, 80, '"messageId":"newer-queued-message"');

      assert.isDefined(adapter.promoteQueuedTurn);
      const targetMessageIds = [
        MessageId.make("older-queued-message"),
        MessageId.make("newer-queued-message"),
      ];
      const promoted = yield* adapter.promoteQueuedTurn!(threadId, targetMessageIds);
      assert.deepEqual(promoted, [
        MessageId.make("older-queued-message"),
        MessageId.make("newer-queued-message"),
      ]);
      const duplicate = yield* adapter.promoteQueuedTurn!(threadId, targetMessageIds);
      assert.deepEqual(duplicate, targetMessageIds);
      yield* Deferred.await(runningPromptDelivered).pipe(Effect.timeout("1 second"));

      const deliveredAfterNativeAdoption = runtimeEvents
        .filter((event) => event.type === "message.delivered")
        .map((event) => event.payload.messageId);
      assert.include(deliveredAfterNativeAdoption, MessageId.make("running-message"));
      assert.include(deliveredAfterNativeAdoption, MessageId.make("older-queued-message"));
      assert.include(deliveredAfterNativeAdoption, MessageId.make("newer-queued-message"));

      yield* Effect.all(
        [Fiber.join(firstSend), Fiber.join(olderQueuedSend), Fiber.join(newerQueuedSend)],
        { concurrency: 3 },
      ).pipe(Effect.timeout("2 seconds"));
      yield* waitForFileContent(requestLogPath, 80, '"method":"_x.ai/queue/interject"');
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      const interjections = requests.filter((entry) => entry.method === "_x.ai/queue/interject");
      assert.deepEqual(
        interjections.map((entry) => entry.params),
        [
          { sessionId: "mock-session-1", id: "older-queued-message", expectedVersion: 0 },
          { sessionId: "mock-session-1", id: "newer-queued-message", expectedVersion: 0 },
        ],
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("waits for every targeted queue row across staggered admission snapshots", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-admission-race");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-race-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "500",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const firstQueuedSnapshotObserved = yield* Deferred.make<void>();
      const adapter = yield* makeTestAdapter(wrapperPath, {
        beforeQueueSnapshotCommit: (notification) =>
          notification.entries.some((entry) => entry.id === "older-queued-message") &&
          !notification.entries.some((entry) => entry.id === "newer-queued-message")
            ? Deferred.succeed(firstQueuedSnapshotObserved, undefined).pipe(Effect.asVoid)
            : Effect.void,
      });
      const runningPromptDelivered = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "message.delivered" &&
        event.payload.messageId === MessageId.make("running-message")
          ? Deferred.succeed(runningPromptDelivered, undefined).pipe(Effect.asVoid)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const firstSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("running-message"),
          input: "start the long task",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(runningPromptDelivered).pipe(Effect.timeout("1 second"));

      assert.isDefined(adapter.promoteQueuedTurn);
      const promotion = yield* adapter.promoteQueuedTurn!(threadId, [
        MessageId.make("older-queued-message"),
        MessageId.make("newer-queued-message"),
      ]).pipe(Effect.forkChild);
      yield* Effect.yieldNow;

      const olderQueuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("older-queued-message"),
          input: "apply this first correction now",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(firstQueuedSnapshotObserved).pipe(Effect.timeout("1 second"));

      const newerQueuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("newer-queued-message"),
          input: "apply this second correction now",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      const promoted = yield* Fiber.join(promotion);
      assert.deepEqual(promoted, [
        MessageId.make("older-queued-message"),
        MessageId.make("newer-queued-message"),
      ]);
      yield* Effect.all(
        [Fiber.join(firstSend), Fiber.join(olderQueuedSend), Fiber.join(newerQueuedSend)],
        {
          concurrency: 2,
        },
      ).pipe(Effect.timeout("2 seconds"));

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.deepEqual(
        requests
          .filter((entry) => entry.method === "_x.ai/queue/interject")
          .map((entry) => entry.params),
        [
          { sessionId: "mock-session-1", id: "older-queued-message", expectedVersion: 0 },
          { sessionId: "mock-session-1", id: "newer-queued-message", expectedVersion: 0 },
        ],
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("fails targeted promotion when prompt admission fails before a queue row appears", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-target-admission-failure");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-admission-failure-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_FAIL_PROMPT_MESSAGE_ID: "failed-queued-message",
          T3_ACP_OMIT_XAI_QUEUE_CHANGED_PROMPT_MESSAGE_ID: "failed-queued-message",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const runningSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("running-message"),
          input: "keep the host turn running",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* waitForFileContent(requestLogPath, 80, '"messageId":"running-message"');

      assert.isDefined(adapter.promoteQueuedTurn);
      const promotion = yield* adapter.promoteQueuedTurn!(threadId, [
        MessageId.make("failed-queued-message"),
      ]).pipe(Effect.flip, Effect.forkChild);
      const promptError = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("failed-queued-message"),
          input: "this admission fails before Grok queues it",
          attachments: [],
        })
        .pipe(Effect.flip);
      const promotionError = yield* Fiber.join(promotion);

      assert.equal(promptError._tag, "ProviderAdapterRequestError");
      assert.equal(promotionError._tag, "ProviderAdapterRequestError");
      if (promotionError._tag === "ProviderAdapterRequestError") {
        assert.equal(promotionError.failureKind, "retryable-upstream");
        assert.include(promotionError.detail, "ended the queued prompt before the model consumed");
      }
      const session = (yield* adapter.listSessions()).find((entry) => entry.threadId === threadId);
      assert.equal(session?.status, "running");
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isFalse(requests.some((entry) => entry.method === "_x.ai/queue/interject"));

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(runningSend);
    }).pipe(TestClock.withLive),
  );

  it.effect("does not treat a failed transient queue row as promotion proof", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-transient-admission-failure");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-transient-failure-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_HANG_FIRST_PROMPT_FOREVER: "1",
          T3_ACP_FAIL_PROMPT_MESSAGE_ID: "failed-transient-message",
          T3_ACP_REMOVE_XAI_QUEUE_ROW_BEFORE_FAIL_MESSAGE_ID: "failed-transient-message",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const transientSnapshotBlocked = yield* Deferred.make<void>();
      const releaseTransientSnapshot = yield* Deferred.make<void>();
      const removalSnapshotBlocked = yield* Deferred.make<void>();
      const releaseRemovalSnapshot = yield* Deferred.make<void>();
      const sawTransientSnapshot = yield* Ref.make(false);
      const heldRemovalSnapshot = yield* Ref.make(false);
      const adapter = yield* makeTestAdapter(wrapperPath, {
        beforeQueueSnapshotCommit: (notification) =>
          Effect.gen(function* () {
            if (notification.entries.some((entry) => entry.id === "failed-transient-message")) {
              yield* Ref.set(sawTransientSnapshot, true);
              yield* Deferred.succeed(transientSnapshotBlocked, undefined);
              yield* Deferred.await(releaseTransientSnapshot);
              return;
            }
            if (!(yield* Ref.get(sawTransientSnapshot))) return;
            const firstRemoval = yield* Ref.modify(heldRemovalSnapshot, (held) => [!held, true]);
            if (!firstRemoval) return;
            yield* Deferred.succeed(removalSnapshotBlocked, undefined);
            yield* Deferred.await(releaseRemovalSnapshot);
          }),
      });

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const runningSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("running-message"),
          input: "keep the host turn running",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* waitForFileContent(requestLogPath, 80, '"messageId":"running-message"');

      const promptFailure = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("failed-transient-message"),
          input: "appear briefly, then fail admission",
          attachments: [],
        })
        .pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(transientSnapshotBlocked);

      assert.isDefined(adapter.promoteQueuedTurn);
      const promotionFailure = yield* adapter.promoteQueuedTurn!(threadId, [
        MessageId.make("failed-transient-message"),
      ]).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.succeed(releaseTransientSnapshot, undefined);
      yield* Deferred.await(removalSnapshotBlocked);
      yield* waitForFileContent(requestLogPath, 80, '"method":"_x.ai/queue/interject"');
      yield* Deferred.succeed(releaseRemovalSnapshot, undefined);

      const [promptError, promotionError] = yield* Effect.all(
        [Fiber.join(promptFailure), Fiber.join(promotionFailure)],
        { concurrency: 2 },
      );
      assert.equal(promptError._tag, "ProviderAdapterRequestError");
      assert.equal(promotionError._tag, "ProviderAdapterRequestError");
      if (promotionError._tag === "ProviderAdapterRequestError") {
        assert.equal(promotionError.failureKind, "retryable-upstream");
        assert.include(promotionError.detail, "ended the queued prompt before the model consumed");
      }
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.equal(requests.filter((entry) => entry.method === "_x.ai/queue/interject").length, 1);

      yield* adapter.stopSession(threadId);
      yield* Fiber.interrupt(runningSend);
    }).pipe(TestClock.withLive),
  );

  it.effect("waits beyond the old timeout for an authoritative promotion snapshot", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-delayed-confirmation");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-delayed-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "60000",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const queuedSnapshotObserved = yield* Deferred.make<void>();
      const confirmationBlocked = yield* Deferred.make<void>();
      const releaseConfirmation = yield* Deferred.make<void>();
      const holdSnapshots = yield* Ref.make(false);
      const adapter = yield* makeTestAdapter(wrapperPath, {
        beforeQueueSnapshotCommit: (notification) =>
          Effect.gen(function* () {
            if (notification.entries.some((entry) => entry.id === "queued-message")) {
              yield* Deferred.succeed(queuedSnapshotObserved, undefined);
            }
            if (yield* Ref.get(holdSnapshots)) {
              yield* Deferred.succeed(confirmationBlocked, undefined);
              yield* Deferred.await(releaseConfirmation);
            }
          }),
      });

      yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(TestClock.withLive);
      const runningSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("running-message"),
          input: "start the long task",
          attachments: [],
        })
        .pipe(TestClock.withLive, Effect.forkChild);
      const queuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("queued-message"),
          input: "apply this correction now",
          attachments: [],
        })
        .pipe(TestClock.withLive, Effect.forkChild);
      yield* Deferred.await(queuedSnapshotObserved);
      yield* Ref.set(holdSnapshots, true);

      assert.isDefined(adapter.promoteQueuedTurn);
      const promotion = yield* adapter.promoteQueuedTurn!(threadId, [
        MessageId.make("queued-message"),
      ]).pipe(Effect.forkChild);
      yield* Deferred.await(confirmationBlocked);
      yield* TestClock.adjust("1 minute");
      assert.isUndefined(promotion.pollUnsafe());

      yield* Deferred.succeed(releaseConfirmation, undefined);
      const promoted = yield* Fiber.join(promotion);
      assert.deepEqual(promoted, [MessageId.make("queued-message")]);

      yield* Fiber.interrupt(runningSend);
      yield* Fiber.interrupt(queuedSend);
      yield* adapter.stopSession(threadId).pipe(TestClock.withLive);
    }),
  );

  it.effect("wakes a pending promotion with a retryable error when the session stops", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-stop-wakeup");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-stop-wakeup-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "60000",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const queuedSnapshotObserved = yield* Deferred.make<void>();
      const confirmationBlocked = yield* Deferred.make<void>();
      const releaseConfirmation = yield* Deferred.make<void>();
      const holdSnapshots = yield* Ref.make(false);
      const adapter = yield* makeTestAdapter(wrapperPath, {
        beforeQueueSnapshotCommit: (notification) =>
          Effect.gen(function* () {
            if (notification.entries.some((entry) => entry.id === "queued-message")) {
              yield* Deferred.succeed(queuedSnapshotObserved, undefined);
            }
            if (yield* Ref.get(holdSnapshots)) {
              yield* Deferred.succeed(confirmationBlocked, undefined);
              yield* Deferred.await(releaseConfirmation);
            }
          }),
      });

      yield* adapter
        .startSession({
          threadId,
          provider: ProviderDriverKind.make("grok"),
          cwd: process.cwd(),
          runtimeMode: "full-access",
        })
        .pipe(TestClock.withLive);
      const runningSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("running-message"),
          input: "start the long task",
          attachments: [],
        })
        .pipe(TestClock.withLive, Effect.forkChild);
      const queuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("queued-message"),
          input: "apply this correction now",
          attachments: [],
        })
        .pipe(TestClock.withLive, Effect.forkChild);
      yield* Deferred.await(queuedSnapshotObserved);
      yield* Ref.set(holdSnapshots, true);

      assert.isDefined(adapter.promoteQueuedTurn);
      const promotion = yield* adapter.promoteQueuedTurn!(threadId, [
        MessageId.make("queued-message"),
      ]).pipe(Effect.flip, Effect.forkChild);
      yield* Deferred.await(confirmationBlocked);
      const stop = yield* adapter.stopSession(threadId).pipe(TestClock.withLive, Effect.forkChild);
      const error = yield* Fiber.join(promotion);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.equal(error.failureKind, "retryable-upstream");
        assert.include(error.detail, "session stopped before queued-message promotion");
      }
      yield* Deferred.succeed(releaseConfirmation, undefined);
      yield* Fiber.join(stop);

      yield* Fiber.interrupt(runningSend);
      yield* Fiber.interrupt(queuedSend);
    }),
  );

  it.effect("ignores unrelated snapshots, retries a stale row, and confirms the mixed batch", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-stale-mixed-batch");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-stale-mixed-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "500",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_XAI_QUEUE_INTERJECT_STALE_ONCE_ID: "newer-queued-message",
          T3_ACP_XAI_QUEUE_INTERJECT_UNRELATED_SNAPSHOT_FIRST: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sends = yield* Effect.forEach(
        [
          ["running-message", "start the long task"],
          ["older-queued-message", "first correction"],
          ["newer-queued-message", "second correction"],
        ] as const,
        ([messageId, input]) =>
          adapter
            .sendTurn({
              threadId,
              messageId: MessageId.make(messageId),
              input,
              attachments: [],
            })
            .pipe(Effect.forkChild),
      );
      yield* waitForFileContent(requestLogPath, 80, '"messageId":"newer-queued-message"');

      assert.isDefined(adapter.promoteQueuedTurn);
      const promoted = yield* adapter.promoteQueuedTurn!(threadId, [
        MessageId.make("older-queued-message"),
        MessageId.make("newer-queued-message"),
      ]);
      assert.deepEqual(promoted, [
        MessageId.make("older-queued-message"),
        MessageId.make("newer-queued-message"),
      ]);

      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.deepEqual(
        requests
          .filter((entry) => entry.method === "_x.ai/queue/interject")
          .map((entry) => entry.params),
        [
          { sessionId: "mock-session-1", id: "older-queued-message", expectedVersion: 0 },
          { sessionId: "mock-session-1", id: "newer-queued-message", expectedVersion: 0 },
          { sessionId: "mock-session-1", id: "newer-queued-message", expectedVersion: 1 },
        ],
      );

      yield* Effect.forEach(sends, Fiber.join, { concurrency: "unbounded", discard: true }).pipe(
        Effect.timeout("2 seconds"),
      );
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("retries only the unconfirmed row after a partial promotion failure", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-partial-retry");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-partial-retry-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "1000",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_XAI_QUEUE_INTERJECT_STALE_ONCE_ID: "newer-queued-message",
          T3_ACP_XAI_QUEUE_INTERJECT_STALE_COUNT: "2",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const targetMessageIds = [
        MessageId.make("older-queued-message"),
        MessageId.make("newer-queued-message"),
      ];

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const sends = yield* Effect.forEach(
        [
          ["running-message", "start the long task"],
          ["older-queued-message", "first correction"],
          ["newer-queued-message", "second correction"],
        ] as const,
        ([messageId, input]) =>
          adapter
            .sendTurn({
              threadId,
              messageId: MessageId.make(messageId),
              input,
              attachments: [],
            })
            .pipe(Effect.forkChild),
      );
      yield* waitForFileContent(requestLogPath, 80, '"messageId":"newer-queued-message"');

      assert.isDefined(adapter.promoteQueuedTurn);
      const firstError = yield* adapter.promoteQueuedTurn!(threadId, targetMessageIds).pipe(
        Effect.flip,
      );
      assert.equal(firstError._tag, "ProviderAdapterRequestError");
      if (firstError._tag === "ProviderAdapterRequestError") {
        assert.equal(firstError.failureKind, "retryable-upstream");
        assert.include(firstError.detail, "newer-queued-message");
      }

      const promoted = yield* adapter.promoteQueuedTurn!(threadId, targetMessageIds);
      assert.deepEqual(promoted, targetMessageIds);
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.deepEqual(
        requests
          .filter((entry) => entry.method === "_x.ai/queue/interject")
          .map((entry) => entry.params),
        [
          { sessionId: "mock-session-1", id: "older-queued-message", expectedVersion: 0 },
          { sessionId: "mock-session-1", id: "newer-queued-message", expectedVersion: 0 },
          { sessionId: "mock-session-1", id: "newer-queued-message", expectedVersion: 1 },
          { sessionId: "mock-session-1", id: "newer-queued-message", expectedVersion: 2 },
        ],
      );

      yield* Effect.forEach(sends, Fiber.join, { concurrency: "unbounded", discard: true }).pipe(
        Effect.timeout("3 seconds"),
      );
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("fails retryably when Grok keeps the row because no turn is running", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-promote-no-running-turn");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-promote-no-running-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_XAI_QUEUE_CHANGED: "1",
          T3_ACP_PROMPT_DELAY_MS: "500",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
          T3_ACP_XAI_QUEUE_INTERJECT_NO_RUNNING_TURN: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      const runningSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("running-message"),
          input: "start the long task",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      const queuedSend = yield* adapter
        .sendTurn({
          threadId,
          messageId: MessageId.make("queued-message"),
          input: "apply this correction now",
          attachments: [],
        })
        .pipe(Effect.forkChild);
      yield* waitForFileContent(requestLogPath, 80, '"messageId":"queued-message"');

      assert.isDefined(adapter.promoteQueuedTurn);
      const error = yield* adapter.promoteQueuedTurn!(threadId, [
        MessageId.make("queued-message"),
      ]).pipe(Effect.flip);
      assert.equal(error._tag, "ProviderAdapterRequestError");
      if (error._tag === "ProviderAdapterRequestError") {
        assert.equal(error.failureKind, "retryable-upstream");
        assert.include(error.detail, "running turn ended before queued message 'queued-message'");
      }
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.deepEqual(
        requests
          .filter((entry) => entry.method === "_x.ai/queue/interject")
          .map((entry) => entry.params),
        [{ sessionId: "mock-session-1", id: "queued-message", expectedVersion: 0 }],
      );

      yield* Fiber.interrupt(runningSend);
      yield* Fiber.interrupt(queuedSend);
      yield* adapter.stopSession(threadId);
    }).pipe(TestClock.withLive),
  );

  it.effect("maps Grok background-task notifications onto task.started and task.completed", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-background-task-lifecycle");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_GROK_BACKGROUND_TASKS: "1",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      assert.equal(adapter.capabilities.taskStop, true);

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const taskStarted = yield* Deferred.make<void>();
      const taskCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "task.started"
              ? Deferred.succeed(taskStarted, undefined)
              : event.type === "task.completed"
                ? Deferred.succeed(taskCompleted, undefined)
                : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "run a background command",
        attachments: [],
      });

      yield* Effect.all([Deferred.await(taskStarted), Deferred.await(taskCompleted)], {
        concurrency: 2,
      });

      const started = runtimeEvents.find((event) => event.type === "task.started");
      const completed = runtimeEvents.find((event) => event.type === "task.completed");
      assert.isDefined(started);
      assert.isDefined(completed);
      if (started?.type === "task.started") {
        assert.equal(started.payload.taskId, "call-mock-bg-1");
        assert.equal(started.payload.taskType, "local_bash");
        assert.equal(started.payload.description, "Run mock background command");
      }
      if (completed?.type === "task.completed") {
        assert.equal(completed.payload.taskId, "call-mock-bg-1");
        assert.equal(completed.payload.status, "completed");
        assert.equal(completed.payload.summary, "mock background command finished");
      }

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("maps dedicated _x.ai/task_* notifications the same way", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-background-task-dedicated");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_GROK_BACKGROUND_TASKS: "dedicated",
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const taskCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "task.completed"
          ? Deferred.succeed(taskCompleted, undefined).pipe(Effect.ignore)
          : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "run a dedicated background command",
        attachments: [],
      });
      yield* Deferred.await(taskCompleted);

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("stops a hanging Grok background task through _x.ai/task/kill", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("grok-background-task-stop");
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "grok-bg-task-kill-")),
      );
      const requestLogPath = NodePath.join(tempDir, "requests.ndjson");
      const wrapperPath = yield* Effect.promise(() =>
        makeMockGrokWrapper({
          T3_ACP_EMIT_GROK_BACKGROUND_TASKS: "hang",
          T3_ACP_REQUEST_LOG_PATH: requestLogPath,
        }),
      );
      const adapter = yield* makeTestAdapter(wrapperPath);
      const taskStarted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "task.started" }>>();
      const taskCompleted =
        yield* Deferred.make<Extract<ProviderRuntimeEvent, { type: "task.completed" }>>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "task.started"
          ? Deferred.succeed(taskStarted, event).pipe(Effect.ignore)
          : event.type === "task.completed"
            ? Deferred.succeed(taskCompleted, event).pipe(Effect.ignore)
            : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("grok"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
      });
      yield* adapter.sendTurn({
        threadId,
        input: "hang a background command",
        attachments: [],
      });
      const started = yield* Deferred.await(taskStarted);
      yield* adapter.stopTask!(threadId, RuntimeTaskId.make(started.payload.taskId));
      const completed = yield* Deferred.await(taskCompleted);
      assert.equal(completed.payload.status, "stopped");

      yield* waitForFileContent(requestLogPath, 80, '"method":"_x.ai/task/kill"');
      const requests = yield* Effect.promise(() => readJsonLines(requestLogPath));
      assert.isTrue(
        requests.some(
          (entry) =>
            entry.method === "_x.ai/task/kill" &&
            typeof entry.params === "object" &&
            entry.params !== null &&
            (entry.params as { taskId?: unknown }).taskId === "call-mock-bg-1",
        ),
      );

      yield* Fiber.interrupt(eventsFiber);
      yield* adapter.stopSession(threadId);
    }),
  );
});
