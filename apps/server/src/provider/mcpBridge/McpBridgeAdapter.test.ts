import { assert, it } from "@effect/vitest";
import {
  ApprovalRequestId,
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import * as NodeTimersPromises from "node:timers/promises";

import type { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  MAX_TRANSPORT_FAILURES_BEFORE_TURN_LOSS,
  makeMcpBridgeAdapter,
  mapMcpBridgeEvent,
} from "./McpBridgeAdapter.ts";
import type { McpBridgeClient } from "./McpBridgeConnection.ts";
import {
  MCP_BRIDGE_PROTOCOL_VERSION,
  type McpBridgeDescriptor,
  type McpBridgeEvent,
  type McpBridgeToolName,
} from "./McpBridgeProtocol.ts";

const instanceId = ProviderInstanceId.make("external_test");
const serverConfig = {
  cwd: process.cwd(),
  attachmentsDir: process.cwd(),
} as ServerConfig["Service"];

const descriptor: McpBridgeDescriptor = {
  protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
  provider: { id: "fake", name: "Fake External", version: "1.0.0" },
  models: [
    { id: "fake-default", name: "Fake Default" },
    { id: "fake-other", name: "Fake Other" },
  ],
  defaultModel: "fake-default",
  capabilities: {
    taskStop: true,
    textGeneration: false,
    threadRollback: false,
    threadFork: false,
    modelSwitchRequiresNewThread: true,
    turnSteering: true,
  },
  limits: { eventsNextTimeoutMs: 25_000 },
  health: { status: "ready" },
};

class FakeBridgeClient implements McpBridgeClient {
  descriptor: McpBridgeDescriptor | null = descriptor;
  readonly pid = 1234;
  readonly stderr = "";
  readonly calls: Array<{
    readonly tool: McpBridgeToolName;
    readonly arguments: Readonly<Record<string, unknown>>;
  }> = [];
  readonly pages = new Map<string, Array<Record<string, unknown>>>();
  readonly threadMessages = new Map<string, ReadonlyArray<Record<string, unknown>>>();
  turnStarted = false;
  eventFailuresRemaining = 0;
  failEventsOnlyAfterTurn = false;
  eventFailureCause: unknown;
  eventFailureGate: Promise<void> | undefined;
  turnStartResponseGate: Promise<void> | undefined;
  sessionStopGate: Promise<void> | undefined;
  stopStarted = false;
  onSessionStopStart: (() => void) | undefined;
  failEventPollingAfterStop = false;
  sessionStartCount = 0;
  nextTurnId: string | undefined;
  onRecovery: (() => void) | undefined;

  async describe(): Promise<McpBridgeDescriptor> {
    if (!this.descriptor) throw new Error("descriptor unavailable");
    return this.descriptor;
  }

  async call(
    tool: McpBridgeToolName,
    argumentsValue: Readonly<Record<string, unknown>>,
  ): Promise<Record<string, unknown>> {
    this.calls.push({ tool, arguments: argumentsValue });
    const sessionId = String(argumentsValue.sessionId ?? "");
    switch (tool) {
      case "provider_bridge.session_start":
        this.sessionStartCount += 1;
        if (this.sessionStartCount >= 2) this.onRecovery?.();
        return {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId,
          resumeCursor: { schemaVersion: 1, bridgeSessionId: sessionId },
        };
      case "provider_bridge.turn_start":
        this.turnStarted = true;
        await this.turnStartResponseGate;
        return {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId,
          turnId: this.nextTurnId ?? `turn-${sessionId}`,
          resumeCursor: { schemaVersion: 1, bridgeSessionId: sessionId },
        };
      case "provider_bridge.turn_steer":
        return {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId,
          turnId: String(argumentsValue.expectedTurnId ?? ""),
          accepted: true,
          resumeCursor: { schemaVersion: 1, bridgeSessionId: sessionId },
        };
      case "provider_bridge.events_next": {
        if (this.stopStarted && this.failEventPollingAfterStop) {
          throw new Error("session was intentionally removed");
        }
        while (!this.turnStarted && (this.pages.get(sessionId)?.length ?? 0) > 0) {
          await NodeTimersPromises.setTimeout(1);
        }
        if (
          this.eventFailuresRemaining > 0 &&
          (!this.failEventsOnlyAfterTurn || this.turnStarted)
        ) {
          await this.eventFailureGate;
          this.eventFailuresRemaining -= 1;
          throw this.eventFailureCause ?? new Error("simulated provider bridge process crash");
        }
        const page = this.pages.get(sessionId)?.shift();
        if (page) return page;
        await NodeTimersPromises.setTimeout(10);
        return {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId,
          gap: false,
          nextSequence: Number(argumentsValue.afterSequence ?? 0),
          events: [],
        };
      }
      case "provider_bridge.thread_read":
        return {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId,
          messages: this.threadMessages.get(sessionId) ?? [],
        };
      case "provider_bridge.session_stop":
        this.stopStarted = true;
        this.onSessionStopStart?.();
        await this.sessionStopGate;
        return { protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION, sessionId };
      default:
        return { protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION, sessionId, ...argumentsValue };
    }
  }

  async shutdown(): Promise<void> {}
}

function event(input: {
  readonly eventId: string;
  readonly sequence: number;
  readonly sessionId: string;
  readonly type: string;
  readonly turnId?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
}) {
  return {
    eventId: input.eventId,
    sequence: input.sequence,
    timestamp: "2026-08-13T12:00:00.000Z",
    sessionId: input.sessionId,
    type: input.type,
    ...(input.turnId ? { turnId: input.turnId } : {}),
    payload: input.payload ?? {},
  };
}

it.effect("maps, stamps, orders, and deduplicates one bridge session event stream", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      fake.descriptor = {
        ...descriptor,
        limits: { eventsNextTimeoutMs: 1_234, maxEventsPerPoll: 7 },
      };
      const threadId = ThreadId.make("external-thread-a");
      fake.pages.set(String(threadId), [
        {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId: String(threadId),
          gap: false,
          nextSequence: 5,
          events: [
            event({
              eventId: "event-start",
              sequence: 1,
              sessionId: String(threadId),
              type: "turn.started",
              turnId: `turn-${threadId}`,
              payload: { model: "fake-default" },
            }),
            event({
              eventId: "event-delivered",
              sequence: 2,
              sessionId: String(threadId),
              type: "message.delivered",
              turnId: `turn-${threadId}`,
              payload: { messageId: "message-external-a" },
            }),
            event({
              eventId: "event-content",
              sequence: 3,
              sessionId: String(threadId),
              type: "content.delta",
              turnId: `turn-${threadId}`,
              payload: { kind: "assistant_text", text: "authoritative answer" },
            }),
            event({
              eventId: "event-content",
              sequence: 4,
              sessionId: String(threadId),
              type: "content.delta",
              turnId: `turn-${threadId}`,
              payload: { kind: "assistant_text", text: "duplicate" },
            }),
            event({
              eventId: "event-complete",
              sequence: 5,
              sessionId: String(threadId),
              type: "turn.completed",
              turnId: `turn-${threadId}`,
            }),
          ],
        },
      ]);
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const eventsFiber = yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)).pipe(
        Effect.forkChild,
      );
      const session = yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
        resumeCursor: { schemaVersion: 1, bridgeSessionId: String(threadId) },
      });
      assert.deepStrictEqual(session.resumeCursor, {
        schemaVersion: 1,
        bridgeSessionId: String(threadId),
      });
      const started = yield* adapter.sendTurn({
        threadId,
        input: "hello",
        messageId: MessageId.make("message-external-a"),
        attachments: [],
      });
      assert.equal(started.turnId, `turn-${threadId}`);

      const events = Array.from(
        yield* Fiber.join(eventsFiber).pipe(Effect.timeout("2 seconds")),
      ) as ProviderRuntimeEvent[];
      assert.deepStrictEqual(
        events.map((candidate) => candidate.type),
        ["turn.started", "message.delivered", "content.delta", "turn.completed"],
      );
      assert.equal(
        events.every((candidate) => candidate.providerInstanceId === instanceId),
        true,
      );
      assert.equal(
        events.every((candidate) => candidate.threadId === threadId),
        true,
      );
      const content = events.find((candidate) => candidate.type === "content.delta");
      assert.equal(
        content?.type === "content.delta" ? content.payload.delta : "",
        "authoritative answer",
      );
      const firstPoll = fake.calls.find((call) => call.tool === "provider_bridge.events_next");
      assert.equal(firstPoll?.arguments.timeoutMs, 1_234);
      assert.equal(firstPoll?.arguments.maxEvents, 7);
      const turnStart = fake.calls.find((call) => call.tool === "provider_bridge.turn_start");
      assert.equal(turnStart?.arguments.messageId, "message-external-a");
      const sessionStart = fake.calls.find((call) => call.tool === "provider_bridge.session_start");
      assert.deepStrictEqual(sessionStart?.arguments.resumeCursor, {
        schemaVersion: 1,
        bridgeSessionId: String(threadId),
      });
      yield* adapter.stopSession(threadId);
    }),
  ),
);

it.effect("forwards the thread-scoped MCP credential on session_start and recovery", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      const secrets: Array<string> = [];
      Object.assign(fake, { addSensitiveValue: (value: string) => secrets.push(value) });
      const threadId = ThreadId.make("external-thread-mcp-credential");
      McpProviderSession.setMcpProviderSession({
        environmentId: EnvironmentId.make("environment-mcp"),
        threadId,
        providerSessionId: "provider-session-mcp",
        providerInstanceId: instanceId,
        endpoint: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer secret-mcp-token",
      });
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
      );
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const sessionStart = fake.calls.find((call) => call.tool === "provider_bridge.session_start");
      assert.deepStrictEqual(sessionStart?.arguments.mcpServer, {
        url: "http://127.0.0.1:3773/mcp",
        authorizationHeader: "Bearer secret-mcp-token",
      });
      assert.deepStrictEqual(secrets, ["secret-mcp-token"]);
      yield* adapter.stopSession(threadId);
    }),
  ),
);

it.effect("keeps approval, cancellation, model-switch, and stop calls session-scoped", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const threadId = ThreadId.make("external-thread-actions");
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "auto-accept-edits",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const started = yield* adapter.sendTurn({ threadId, input: "work", attachments: [] });
      yield* adapter.respondToRequest(
        threadId,
        ApprovalRequestId.make("approval-1"),
        "acceptForSession",
      );
      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make("input-1"), {
        choice: "yes",
      });
      yield* adapter.interruptTurn(threadId, started.turnId);

      const rejected = yield* adapter
        .sendTurn({
          threadId,
          input: "switch",
          modelSelection: { instanceId, model: "fake-other" },
        })
        .pipe(Effect.result);
      assert.equal(rejected._tag, "Failure");
      assert.equal(adapter.capabilities.textGeneration, false);
      assert.equal(adapter.capabilities.taskStop, true);

      const scopedCalls = fake.calls.filter((call) =>
        [
          "provider_bridge.request_respond",
          "provider_bridge.user_input_respond",
          "provider_bridge.turn_interrupt",
        ].includes(call.tool),
      );
      assert.equal(
        scopedCalls.every((call) => call.arguments.sessionId === String(threadId)),
        true,
      );
      assert.equal(
        scopedCalls.find((call) => call.tool === "provider_bridge.turn_interrupt")?.arguments
          .turnId,
        String(started.turnId),
      );
      yield* adapter.stopAll();
      assert.equal(yield* adapter.hasSession(threadId), false);

      const switchingFake = new FakeBridgeClient();
      switchingFake.descriptor = {
        ...descriptor,
        capabilities: { ...descriptor.capabilities, modelSwitchRequiresNewThread: false },
      };
      const switchingAdapter = yield* makeMcpBridgeAdapter({
        connection: switchingFake,
        instanceId,
        serverConfig,
      });
      const switchingThread = ThreadId.make("external-thread-switching");
      yield* switchingAdapter.startSession({
        threadId: switchingThread,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      yield* switchingAdapter.sendTurn({
        threadId: switchingThread,
        input: "switch in session",
        modelSelection: { instanceId, model: "fake-other" },
      });
      assert.equal(switchingAdapter.capabilities.sessionModelSwitch, "in-session");
      assert.equal(
        switchingFake.calls.find((call) => call.tool === "provider_bridge.turn_start")?.arguments
          .model,
        "fake-other",
      );
      yield* switchingAdapter.stopAll();
    }),
  ),
);

it.effect("steers a follow-up into the active external browser turn", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const threadId = ThreadId.make("external-thread-steer");
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const started = yield* adapter.sendTurn({
        threadId,
        input: "initial request",
        messageId: MessageId.make("message-initial"),
        attachments: [],
      });
      const steered = yield* adapter.sendTurn({
        threadId,
        input: "follow up while running",
        messageId: MessageId.make("message-follow-up"),
        attachments: [],
        interactionMode: "default",
        liveSteerTarget: {
          providerInstanceId: instanceId,
          activeTurnId: started.turnId,
        },
      });

      assert.equal(steered.turnId, started.turnId);
      assert.equal(
        fake.calls.filter((call) => call.tool === "provider_bridge.turn_start").length,
        1,
      );
      const steer = fake.calls.find((call) => call.tool === "provider_bridge.turn_steer");
      assert.equal(steer?.arguments.expectedTurnId, String(started.turnId));
      assert.equal(steer?.arguments.messageId, "message-follow-up");
      assert.equal(steer?.arguments.message, "follow up while running");
      yield* adapter.stopAll();
    }),
  ),
);

it.effect("rejects a live steer targeted at a predecessor after a successor starts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const threadId = ThreadId.make("external-thread-stale-live-steer");
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const predecessor = yield* adapter.sendTurn({
        threadId,
        input: "predecessor",
        attachments: [],
      });

      yield* adapter.stopSession(threadId);
      fake.nextTurnId = "turn-successor";
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const successor = yield* adapter.sendTurn({
        threadId,
        input: "successor",
        attachments: [],
      });
      assert.equal(String(successor.turnId), "turn-successor");
      const steerCountBefore = fake.calls.filter(
        (call) => call.tool === "provider_bridge.turn_steer",
      ).length;

      const error = yield* adapter
        .sendTurn({
          threadId,
          input: "must not reach the successor",
          attachments: [],
          liveSteerTarget: {
            providerInstanceId: instanceId,
            activeTurnId: predecessor.turnId,
          },
        })
        .pipe(Effect.flip);

      assert.equal(error._tag, "ProviderAdapterRequestError");
      assert.equal(
        fake.calls.filter((call) => call.tool === "provider_bridge.turn_steer").length,
        steerCountBefore,
      );
      const sessions = yield* adapter.listSessions();
      assert.equal(String(sessions[0]?.activeTurnId), String(successor.turnId));
      yield* adapter.stopAll();
    }),
  ),
);

it.effect("rejects a live steer while its bridge context is stopping", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const threadId = ThreadId.make("external-thread-stopping-live-steer");
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const runningTurn = yield* adapter.sendTurn({
        threadId,
        input: "long task",
        attachments: [],
      });
      let releaseStop!: () => void;
      fake.sessionStopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      let markStopStarted!: () => void;
      const stopStarted = new Promise<void>((resolve) => {
        markStopStarted = resolve;
      });
      fake.onSessionStopStart = markStopStarted;

      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      yield* Effect.promise(() => stopStarted);
      const steerCountBefore = fake.calls.filter(
        (call) => call.tool === "provider_bridge.turn_steer",
      ).length;
      const exit = yield* adapter
        .sendTurn({
          threadId,
          input: "must not enter a stopping bridge context",
          attachments: [],
          liveSteerTarget: {
            providerInstanceId: instanceId,
            activeTurnId: runningTurn.turnId,
          },
        })
        .pipe(Effect.exit);

      assert.equal(exit._tag, "Failure");
      assert.equal(
        fake.calls.filter((call) => call.tool === "provider_bridge.turn_steer").length,
        steerCountBefore,
      );
      releaseStop();
      yield* Fiber.join(stopFiber);
    }),
  ),
);

it.effect("queues an image follow-up into the running turn instead of rejecting it", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const threadId = ThreadId.make("external-thread-steer-attachment");
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const started = yield* adapter.sendTurn({
        threadId,
        input: "initial request",
        attachments: [],
      });
      const steered = yield* adapter.sendTurn({
        threadId,
        input: "",
        messageId: MessageId.make("message-image-follow-up"),
        attachments: [
          {
            type: "image",
            id: "attachment-follow-up",
            name: "screenshot.png",
            mimeType: "image/png",
            sizeBytes: 1024,
          },
        ],
      });

      assert.equal(steered.turnId, started.turnId);
      const steer = fake.calls.find((call) => call.tool === "provider_bridge.turn_steer");
      assert.equal(steer?.arguments.expectedTurnId, String(started.turnId));
      assert.deepEqual(steer?.arguments.attachments, [
        `${serverConfig.attachmentsDir}/attachment-follow-up.png`,
      ]);
      assert.equal(steer?.arguments.message, "Please review the attached file(s).");
      yield* adapter.stopAll();
    }),
  ),
);

it.effect("keeps an active turn alive across a transport drop and delivers its real result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      fake.eventFailuresRemaining = 1;
      fake.failEventsOnlyAfterTurn = true;
      fake.eventFailureCause = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
      let releaseFailure!: () => void;
      fake.eventFailureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      const threadId = ThreadId.make("external-thread-transport-drop");
      fake.pages.set(String(threadId), [
        {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId: String(threadId),
          gap: false,
          nextSequence: 1,
          events: [
            event({
              eventId: "terminal-after-reconnect",
              sequence: 1,
              sessionId: String(threadId),
              type: "turn.completed",
              turnId: `turn-${threadId}`,
              payload: { state: "completed" },
            }),
          ],
        },
      ]);
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const observed: ProviderRuntimeEvent[] = [];
      const finished = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (candidate) =>
        Effect.sync(() => {
          observed.push(candidate);
        }).pipe(
          Effect.andThen(
            candidate.type === "turn.completed"
              ? Deferred.succeed(finished, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const started = yield* adapter.sendTurn({
        threadId,
        input: "answer while the pipe breaks",
        attachments: [],
      });
      releaseFailure();
      yield* Deferred.await(finished).pipe(Effect.timeout("3 seconds"));

      const terminals = observed.filter(
        (candidate) => candidate.type === "turn.completed" && candidate.turnId === started.turnId,
      );
      assert.equal(terminals.length, 1);
      assert.equal(
        terminals[0]?.type === "turn.completed" ? terminals[0].payload.state : "missing",
        "completed",
      );
      assert.equal(
        observed.some(
          (candidate) =>
            candidate.type === "runtime.error" ||
            (candidate.type === "runtime.warning" &&
              String(candidate.payload.message).startsWith(
                "External provider event stream interrupted",
              )),
        ),
        false,
      );
      // Reconnecting is internal: the turn is still running and the pipe is
      // expected back, so a recovered drop must leave no trace in the work log.
      // It used to publish "Reconnecting … the turn is still running", which
      // rendered with an error tone — a red failure describing a healthy turn.
      assert.equal(
        observed.some(
          (candidate) =>
            (candidate.type === "runtime.warning" || candidate.type === "runtime.error") &&
            String(candidate.payload.message).startsWith("Reconnecting to the external"),
        ),
        false,
      );
      assert.equal(
        observed.some(
          (candidate) => candidate.type === "runtime.warning" || candidate.type === "runtime.error",
        ),
        false,
        "a transport drop the adapter recovered from must be silent",
      );
      yield* adapter.stopSession(threadId);
    }),
  ),
);

it.effect("gives up on a turn once transport retries are exhausted", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      fake.eventFailuresRemaining = MAX_TRANSPORT_FAILURES_BEFORE_TURN_LOSS + 1;
      fake.failEventsOnlyAfterTurn = true;
      fake.eventFailureCause = new McpError(ErrorCode.ConnectionClosed, "Connection closed");
      const threadId = ThreadId.make("external-thread-transport-exhausted");
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const observed: ProviderRuntimeEvent[] = [];
      const failed = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (candidate) =>
        Effect.sync(() => {
          observed.push(candidate);
        }).pipe(
          Effect.andThen(
            candidate.type === "turn.completed" ? Deferred.succeed(failed, undefined) : Effect.void,
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const started = yield* adapter.sendTurn({
        threadId,
        input: "the bridge never comes back",
        attachments: [],
      });
      yield* Deferred.await(failed).pipe(Effect.timeout("30 seconds"));

      const terminals = observed.filter(
        (candidate) => candidate.type === "turn.completed" && candidate.turnId === started.turnId,
      );
      assert.equal(terminals.length, 1);
      assert.equal(
        terminals[0]?.type === "turn.completed" ? terminals[0].payload.state : "missing",
        "failed",
      );
      // Every retry along the way stays internal; the user hears about it once,
      // when the adapter has actually given up and the turn is really lost.
      const reconnects = observed.filter(
        (candidate) =>
          (candidate.type === "runtime.warning" || candidate.type === "runtime.error") &&
          String(candidate.payload.message).startsWith("Reconnecting to the external"),
      );
      assert.equal(reconnects.length, 0);
      yield* adapter.stopSession(threadId);
    }),
  ),
);

it.effect("resynchronizes a stale event cursor with thread_read", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      const threadId = ThreadId.make("external-thread-gap");
      fake.pages.set(String(threadId), [
        {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId: String(threadId),
          gap: true,
          oldestSequence: 50,
          nextSequence: 72,
          events: [],
        },
      ]);
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const warningFiber = yield* Stream.runHead(
        Stream.filter(adapter.streamEvents, (candidate) => candidate.type === "runtime.warning"),
      ).pipe(Effect.forkChild);
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "full-access",
        modelSelection: { instanceId, model: "fake-default" },
      });
      fake.turnStarted = true;
      const warning = yield* Fiber.join(warningFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(warning._tag, "Some");
      assert.equal(
        fake.calls.some(
          (call) =>
            call.tool === "provider_bridge.thread_read" &&
            call.arguments.sessionId === String(threadId),
        ),
        true,
      );
      yield* adapter.stopSession(threadId);
    }),
  ),
);

it.effect("restarts the bridge session after an event-process failure", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      fake.eventFailuresRemaining = 1;
      const recovered = yield* Effect.callback<void>((resume) => {
        fake.onRecovery = () => resume(Effect.void);
      }).pipe(Effect.forkScoped);
      const threadId = ThreadId.make("external-thread-recovery");
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      yield* Fiber.join(recovered).pipe(Effect.timeout("2 seconds"));
      assert.equal(fake.sessionStartCount, 2);
      yield* adapter.stopSession(threadId);
    }),
  ),
);

it.effect("fails an active turn exactly once when the bridge process fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      fake.eventFailuresRemaining = 1;
      fake.failEventsOnlyAfterTurn = true;
      let releaseFailure!: () => void;
      fake.eventFailureGate = new Promise<void>((resolve) => {
        releaseFailure = resolve;
      });
      const threadId = ThreadId.make("external-thread-active-crash");
      fake.pages.set(String(threadId), [
        {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId: String(threadId),
          gap: false,
          nextSequence: 2,
          events: [
            event({
              eventId: "late-terminal-after-crash",
              sequence: 1,
              sessionId: String(threadId),
              type: "turn.completed",
              turnId: `turn-${threadId}`,
            }),
            event({
              eventId: "marker-after-crash",
              sequence: 2,
              sessionId: String(threadId),
              type: "runtime.warning",
              payload: { message: "post-recovery marker" },
            }),
          ],
        },
      ]);
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const observed: ProviderRuntimeEvent[] = [];
      const marker = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (candidate) =>
        Effect.sync(() => {
          observed.push(candidate);
        }).pipe(
          Effect.andThen(
            candidate.type === "runtime.warning" &&
              candidate.payload.message === "post-recovery marker"
              ? Deferred.succeed(marker, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const started = yield* adapter.sendTurn({
        threadId,
        input: "crash during this turn",
        attachments: [],
      });
      releaseFailure();
      yield* Deferred.await(marker).pipe(Effect.timeout("3 seconds"));
      const terminalEvents = observed.filter(
        (candidate) => candidate.type === "turn.completed" && candidate.turnId === started.turnId,
      );
      assert.equal(terminalEvents.length, 1);
      assert.equal(
        terminalEvents[0]?.type === "turn.completed" ? terminalEvents[0].payload.state : "missing",
        "failed",
      );
      assert.equal(fake.sessionStartCount, 2);
      yield* adapter.stopSession(threadId);
    }),
  ),
);

it.effect("does not resurrect a turn that completes before turn_start returns", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      let releaseTurnStart!: () => void;
      fake.turnStartResponseGate = new Promise<void>((resolve) => {
        releaseTurnStart = resolve;
      });
      const threadId = ThreadId.make("external-thread-fast-terminal");
      fake.pages.set(String(threadId), [
        {
          protocolVersion: MCP_BRIDGE_PROTOCOL_VERSION,
          sessionId: String(threadId),
          gap: false,
          nextSequence: 1,
          events: [
            event({
              eventId: "fast-terminal",
              sequence: 1,
              sessionId: String(threadId),
              type: "turn.completed",
              turnId: `turn-${threadId}`,
            }),
          ],
        },
      ]);
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      const observedTerminal = yield* Deferred.make<void>();
      yield* Stream.runForEach(adapter.streamEvents, (candidate) =>
        candidate.type === "turn.completed" && candidate.turnId === TurnId.make(`turn-${threadId}`)
          ? Effect.sync(releaseTurnStart).pipe(
              Effect.andThen(Deferred.succeed(observedTerminal, undefined)),
            )
          : Effect.void,
      ).pipe(Effect.forkScoped);
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      yield* adapter.sendTurn({ threadId, input: "finish immediately", attachments: [] });
      yield* Deferred.await(observedTerminal).pipe(Effect.timeout("2 seconds"));
      const sessions = yield* adapter.listSessions();
      assert.equal(sessions[0]?.status, "ready");
      assert.isUndefined(sessions[0]?.activeTurnId);
      yield* adapter.stopSession(threadId);
    }),
  ),
);

it.effect("stops event polling before remote session teardown", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      fake.failEventPollingAfterStop = true;
      let releaseStop!: () => void;
      fake.sessionStopGate = new Promise<void>((resolve) => {
        releaseStop = resolve;
      });
      const threadId = ThreadId.make("external-thread-stop-race");
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const stopFiber = yield* adapter.stopSession(threadId).pipe(Effect.forkChild);
      while (!fake.stopStarted) {
        yield* Effect.promise(() => NodeTimersPromises.setTimeout(1));
      }
      yield* Effect.promise(() => NodeTimersPromises.setTimeout(700));
      assert.equal(fake.sessionStartCount, 1);
      releaseStop();
      yield* Fiber.join(stopFiber).pipe(Effect.timeout("2 seconds"));
      assert.equal(yield* adapter.hasSession(threadId), false);
    }),
  ),
);

it.effect("normalizes persisted transcript items by explicit turn id", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fake = new FakeBridgeClient();
      const threadId = ThreadId.make("external-thread-read");
      fake.threadMessages.set(String(threadId), [
        { role: "user", content: "hello", turnId: "turn-one" },
        { type: "tool_call", name: "read_file", turnId: "turn-one" },
        { role: "assistant", content: "done", turnId: "turn-two" },
      ]);
      const adapter = yield* makeMcpBridgeAdapter({
        connection: fake,
        instanceId,
        serverConfig,
      });
      yield* adapter.startSession({
        threadId,
        providerInstanceId: instanceId,
        runtimeMode: "approval-required",
        modelSelection: { instanceId, model: "fake-default" },
      });
      const snapshot = yield* adapter.readThread(threadId);
      assert.deepStrictEqual(
        snapshot.turns.map((turn) => [String(turn.id), turn.items.length]),
        [
          ["turn-one", 2],
          ["turn-two", 1],
        ],
      );
      yield* adapter.stopSession(threadId);
    }),
  ),
);

// --- tool item enrichment -------------------------------------------------

const toolItemThreadId = ThreadId.make("external-thread-items");

const toolItemEvent = (
  type: "item.started" | "item.completed",
  payload: Record<string, unknown>,
): McpBridgeEvent => ({
  eventId: `evt-${type}-${String(payload.name)}`,
  sequence: 1,
  timestamp: "2026-08-14T04:00:00.000Z",
  sessionId: "session-items",
  turnId: "turn-items",
  itemId: "call_compare_1",
  type,
  payload,
});

const statusEvent = (
  type: "reasoning.status" | "runtime.status",
  itemId: string,
  payload: Record<string, unknown>,
): McpBridgeEvent => ({
  eventId: `evt-${type}-${itemId}`,
  sequence: 1,
  timestamp: "2026-09-01T22:54:34.000Z",
  sessionId: "session-items",
  turnId: "turn-items",
  itemId,
  type,
  payload,
});

it("keeps a bridge thought under the default Thinking heading with its own item id", () => {
  // The bridge publishes each of the model's comments as a reasoning.status
  // with a distinct item id; the host keys one durable row per item, so the
  // id must survive and the row must read as the model thinking.
  const mapped = mapMcpBridgeEvent(
    statusEvent("reasoning.status", "turn-items:thought:3", {
      phase: "thinking",
      text: "Checking whether the live run cleared preflight.",
    }),
    instanceId,
    toolItemThreadId,
  );
  const payload = mapped.payload as Record<string, unknown>;
  assert.strictEqual(mapped.type, "item.updated");
  assert.strictEqual(String(mapped.itemId), "turn-items:thought:3");
  assert.strictEqual(payload.itemType, "reasoning");
  assert.strictEqual(payload.title, undefined);
  assert.strictEqual(payload.detail, "Checking whether the live run cleared preflight.");
});

it("titles a runtime status row by its phase so bridge narration is not a thought", () => {
  const mapped = mapMcpBridgeEvent(
    statusEvent("runtime.status", "turn-items:status", {
      phase: "working",
      text: "Delivering your message to the browser",
    }),
    instanceId,
    toolItemThreadId,
  );
  const payload = mapped.payload as Record<string, unknown>;
  assert.strictEqual(payload.itemType, "reasoning");
  assert.strictEqual(payload.title, "Working");
  assert.strictEqual(payload.detail, "Delivering your message to the browser");
});

it("maps an assistant-message item without forcing it to a tool type", () => {
  // The bridge closes each tool-loop round's prose with this item so the next
  // round's narration starts its own message. itemTypeForTool only returns tool
  // types, so mapping it through that path would leave the host reusing one
  // message for the whole turn and every round's prose would land as one wall.
  const mapped = mapMcpBridgeEvent(
    toolItemEvent("item.completed", {
      itemType: "assistant_message",
      text: "Checking the cap and bounding the outline first:",
    }),
    instanceId,
    toolItemThreadId,
  );
  const payload = mapped.payload as Record<string, unknown>;
  assert.strictEqual(mapped.type, "item.completed");
  assert.strictEqual(payload.itemType, "assistant_message");
  assert.strictEqual(payload.status, "completed");
  assert.strictEqual(payload.detail, "Checking the cap and bounding the outline first:");
  // The item id is what gives the next segment a distinct base key.
  assert.strictEqual(String(mapped.itemId), "call_compare_1");
});

it("still maps a tool item when no assistant itemType is present", () => {
  const mapped = mapMcpBridgeEvent(
    toolItemEvent("item.completed", {
      kind: "tool_result",
      name: "list_files",
      result: { ok: true },
    }),
    instanceId,
    toolItemThreadId,
  );
  const payload = mapped.payload as Record<string, unknown>;
  assert.strictEqual(payload.itemType, "dynamic_tool_call");
});

it("maps a completed exec_command to the native command-execution shape", () => {
  const mapped = mapMcpBridgeEvent(
    toolItemEvent("item.completed", {
      kind: "tool_result",
      name: "exec_command",
      result: {
        ok: true,
        value: {
          command: "ls -la",
          cwd: "/workspace",
          exit_code: 0,
          stdout: "file-a\nfile-b",
          stderr: "",
          timed_out: false,
          cancelled: false,
          truncated: false,
        },
      },
    }),
    instanceId,
    toolItemThreadId,
  );
  const payload = mapped.payload as Record<string, unknown>;
  const data = payload.data as Record<string, unknown>;
  assert.strictEqual(payload.itemType, "command_execution");
  assert.strictEqual(payload.status, "completed");
  assert.strictEqual(payload.title, "Ran command");
  assert.strictEqual(payload.detail, "file-a\nfile-b\n<exited with exit code 0>");
  assert.deepStrictEqual(data.item, { command: "ls -la" });
  assert.deepStrictEqual(data.rawOutput, { stdout: "file-a\nfile-b", exitCode: 0 });
  assert.strictEqual(String(data.toolCallId), "call_compare_1");
});

it("maps a started exec_command with the command as detail", () => {
  const mapped = mapMcpBridgeEvent(
    toolItemEvent("item.started", {
      kind: "tool_call",
      name: "exec_command",
      arguments: { command: "python3 build.py" },
    }),
    instanceId,
    toolItemThreadId,
  );
  const payload = mapped.payload as Record<string, unknown>;
  const data = payload.data as Record<string, unknown>;
  assert.strictEqual(payload.status, "inProgress");
  assert.strictEqual(payload.title, "Ran command");
  assert.strictEqual(payload.detail, "python3 build.py");
  assert.deepStrictEqual(data.item, { command: "python3 build.py" });
});

it("maps file and read tools with paths, summaries, and failures", () => {
  const written = mapMcpBridgeEvent(
    toolItemEvent("item.completed", {
      kind: "tool_result",
      name: "write_file",
      result: { ok: true, value: { path: "/workspace/a.ts", created: true, bytes: 12 } },
    }),
    instanceId,
    toolItemThreadId,
  );
  const writtenPayload = written.payload as Record<string, unknown>;
  assert.strictEqual(writtenPayload.itemType, "file_change");
  assert.strictEqual(writtenPayload.title, "File change");
  assert.strictEqual(writtenPayload.detail, "/workspace/a.ts · created");
  assert.deepStrictEqual((writtenPayload.data as Record<string, unknown>).item, {
    path: "/workspace/a.ts",
  });

  const denied = mapMcpBridgeEvent(
    toolItemEvent("item.completed", {
      kind: "tool_result",
      name: "exec_command",
      arguments: { command: "rm -rf /" },
      result: { ok: false, error: "Tool request was declined or expired." },
    }),
    instanceId,
    toolItemThreadId,
  );
  const deniedPayload = denied.payload as Record<string, unknown>;
  assert.strictEqual(deniedPayload.status, "failed");
  assert.strictEqual(deniedPayload.detail, "Tool request was declined or expired.");

  const listed = mapMcpBridgeEvent(
    toolItemEvent("item.completed", {
      kind: "tool_result",
      name: "list_files",
      arguments: { path: "src" },
      result: { ok: true, value: { entries: [{ path: "a" }, { path: "b" }], truncated: false } },
    }),
    instanceId,
    toolItemThreadId,
  );
  const listedPayload = listed.payload as Record<string, unknown>;
  assert.strictEqual(listedPayload.title, "Listed files");
  assert.strictEqual(listedPayload.detail, "src · 2 entries");
  assert.deepStrictEqual((listedPayload.data as Record<string, unknown>).rawOutput, {
    totalFiles: 2,
    truncated: false,
  });
});

const detailOf = (name: string, payload: Record<string, unknown>): unknown =>
  (
    mapMcpBridgeEvent(
      toolItemEvent("item.completed", { kind: "tool_result", name, ...payload }),
      instanceId,
      toolItemThreadId,
    ).payload as Record<string, unknown>
  ).detail;

it("summarizes a listing without inventing a path for the workspace root", () => {
  const entries = { entries: [{ path: "a" }, { path: "b" }], truncated: false };
  assert.strictEqual(
    detailOf("list_files", { arguments: { path: "." }, result: { ok: true, value: entries } }),
    "2 entries",
  );
  assert.strictEqual(
    detailOf("list_files", { arguments: { path: "./" }, result: { ok: true, value: entries } }),
    "2 entries",
  );
  assert.strictEqual(detailOf("list_files", { result: { ok: true, value: entries } }), "2 entries");
  assert.strictEqual(
    detailOf("list_files", {
      arguments: { path: "src/app" },
      result: { ok: true, value: entries },
    }),
    "src/app · 2 entries",
  );
  assert.strictEqual(
    detailOf("list_files", {
      result: { ok: true, value: { entries: [{ path: "a" }], truncated: true } },
    }),
    "1 entry+",
  );
});

it("keeps the workspace-root listing chip even when the detail omits the path", () => {
  const mapped = mapMcpBridgeEvent(
    toolItemEvent("item.completed", {
      kind: "tool_result",
      name: "list_files",
      arguments: { path: "." },
      result: { ok: true, value: { entries: [{ path: "a" }], truncated: false } },
    }),
    instanceId,
    toolItemThreadId,
  );
  const payload = mapped.payload as Record<string, unknown>;
  const data = payload.data as Record<string, unknown>;
  assert.strictEqual(payload.detail, "1 entry");
  assert.deepStrictEqual(data.item, { path: "." });
  assert.deepStrictEqual(data.rawOutput, { totalFiles: 1, truncated: false });
});

it("summarizes a search without inventing a pattern", () => {
  const matches = { matches: [{ line: 1 }, { line: 2 }], truncated: false };
  assert.strictEqual(
    detailOf("search_text", {
      arguments: { pattern: "TODO" },
      result: { ok: true, value: matches },
    }),
    "TODO · 2 matches",
  );
  assert.strictEqual(
    detailOf("search_text", {
      arguments: { query: "needle" },
      result: { ok: true, value: { matches: [{ line: 1 }], truncated: false } },
    }),
    "needle · 1 match",
  );
  assert.strictEqual(
    detailOf("search_text", { result: { ok: true, value: { matches: [], truncated: false } } }),
    "0 matches",
  );
  assert.strictEqual(
    detailOf("search_text", { result: { ok: true, value: matches } }),
    "2 matches",
  );
});

it("summarizes an edit without inventing a file name", () => {
  assert.strictEqual(
    detailOf("replace_text", {
      arguments: { path: "/workspace/a.ts" },
      result: { ok: true, value: { replacements: 2 } },
    }),
    "/workspace/a.ts · 2 replacements",
  );
  assert.strictEqual(
    detailOf("replace_text", { result: { ok: true, value: { replacements: 1 } } }),
    "1 replacement",
  );
  assert.strictEqual(
    detailOf("write_file", { result: { ok: true, value: { created: true } } }),
    "created",
  );
});

it("still renders the raw path while a file or listing tool is in flight", () => {
  const started = (name: string, args: Record<string, unknown>): unknown =>
    (
      mapMcpBridgeEvent(
        toolItemEvent("item.started", { kind: "tool_call", name, arguments: args }),
        instanceId,
        toolItemThreadId,
      ).payload as Record<string, unknown>
    ).detail;
  assert.strictEqual(started("list_files", { path: "." }), ".");
  assert.strictEqual(started("replace_text", { path: "/workspace/a.ts" }), "/workspace/a.ts");
  assert.strictEqual(started("search_text", { pattern: "TODO" }), "TODO");
  assert.isUndefined(started("replace_text", {}));
});
