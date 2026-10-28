import { assert, it } from "@effect/vitest";
import {
  AgentCallId,
  EnvironmentId,
  OrchestrationEvent,
  ThreadId,
  VmAgentBlockerId,
  VmAgentId,
  VmId,
  type AgentCall,
  type VmAgent,
  type VmAgentBlocker,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { WebPush, type PushAttention } from "../notifications/WebPush.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import {
  agentCallPushActions,
  agentCallTriggerForEvent,
  AgentCallReactorLive,
} from "./AgentCallReactor.ts";
import { AgentCalls, type AgentCallsShape, type AgentCallTransition } from "./AgentCalls.ts";
import { VmAgentWorkspace, type VmAgentBlockerEvent } from "./VmAgentWorkspace.ts";

const environmentId = EnvironmentId.make("host");
const vmAgentId = VmAgentId.make("agent-scout");
const agentThread = ThreadId.make("agent-thread");
const agent: VmAgent = {
  vmAgentId,
  name: "Scout",
  handle: "scout",
  purpose: "Watch the dashboards",
  vmId: VmId.make("vm-scout"),
  threadId: agentThread,
  status: "running",
  controlMode: "agent",
  icon: null,
  guestIp: null,
  lastError: null,
  createdAt: "2026-10-28T12:00:00.000Z",
  updatedAt: "2026-10-28T12:00:00.000Z",
};
const decodeEvent = Schema.decodeUnknownSync(OrchestrationEvent);
const activityEvent = (input: {
  readonly kind: string;
  readonly payload: unknown;
  readonly threadId?: string;
  readonly createdAt?: string;
  readonly summary?: string;
}) =>
  decodeEvent({
    sequence: 1,
    eventId: "event",
    type: "thread.activity-appended",
    aggregateKind: "thread",
    aggregateId: input.threadId ?? agentThread,
    occurredAt: input.createdAt ?? "2026-10-28T12:00:00.000Z",
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: {
      threadId: input.threadId ?? agentThread,
      activity: {
        id: "activity",
        tone: "approval",
        kind: input.kind,
        summary: input.summary ?? "Approval requested",
        payload: input.payload,
        turnId: null,
        createdAt: input.createdAt ?? "2026-10-28T12:00:00.000Z",
      },
    },
  });
const call = (overrides: Partial<AgentCall> = {}): AgentCall => ({
  callId: AgentCallId.make("call-1"),
  vmAgentId,
  direction: "incoming",
  reason: "blocker",
  topic: "Sign in to Google",
  status: "ringing",
  answeredBy: null,
  createdAt: "2026-10-28T12:00:00.000Z",
  answeredAt: null,
  endedAt: null,
  expiresAt: "2026-10-28T12:00:45.000Z",
  ...overrides,
});

it("rings for questions and approvals and cancels on their resolution", () => {
  const command = agentCallTriggerForEvent(
    activityEvent({
      kind: "approval.requested",
      payload: { requestId: "cmd", detail: "git push" },
      summary: "Command approval requested",
    }),
    environmentId,
  );
  assert.deepStrictEqual(command, {
    ring: {
      threadId: agentThread,
      key: "approval:agent-thread:cmd",
      reason: "approval",
      topic: "Command approval requested: git push",
      createdAt: "2026-10-28T12:00:00.000Z",
    },
  });
  const question = agentCallTriggerForEvent(
    activityEvent({
      kind: "user-input.requested",
      payload: {
        requestId: "ask",
        questions: [{ id: "q", header: "Account", question: "Which account?", options: [] }],
      },
    }),
    environmentId,
  );
  assert.deepStrictEqual(
    question !== null && "ring" in question ? [question.ring.reason, question.ring.topic] : null,
    ["question", "Which account?"],
  );
  const actionApproval = agentCallTriggerForEvent(
    activityEvent({
      kind: "user-input.requested",
      payload: {
        requestId: "send",
        questions: [{ id: "q", header: "Send", question: "Send it?", options: [] }],
        actionApproval: { actionKind: "send_email" },
      },
    }),
    environmentId,
  );
  assert.strictEqual(
    actionApproval !== null && "ring" in actionApproval ? actionApproval.ring.reason : null,
    "approval",
  );
  assert.deepStrictEqual(
    agentCallTriggerForEvent(
      activityEvent({ kind: "user-input.resolved", payload: { requestId: "ask" } }),
      environmentId,
    ),
    { cancel: "input:agent-thread:ask" },
  );
  assert.isNull(
    agentCallTriggerForEvent(activityEvent({ kind: "tool.started", payload: {} }), environmentId),
  );
});

it("pushes a ringing call and replaces it in place when it stops ringing", () => {
  const options = { environmentId, agentName: "Scout" };
  const rung = agentCallPushActions({ previous: null, call: call() }, options);
  assert.deepStrictEqual(rung, [
    {
      publish: {
        key: "call:call-1",
        kind: "call",
        tag: "call:call-1",
        title: "Scout is calling",
        body: "Sign in to Google",
        path: "/call/host/call-1",
        createdAt: "2026-10-28T12:00:00.000Z",
        expiresAt: "2026-10-28T12:00:45.000Z",
      },
    },
  ]);
  // Answered, declined or cancelled: a quiet same-tag replacement drops the
  // sticky ringing notification on every other device.
  const answered = call({
    status: "active",
    expiresAt: null,
    answeredBy: "Office Mac",
    answeredAt: "2026-10-28T12:00:10.000Z",
  });
  assert.deepStrictEqual(agentCallPushActions({ previous: call(), call: answered }, options), [
    { cancel: "call:call-1" },
    {
      publish: {
        key: "call:call-1:ended",
        kind: "call-ended",
        tag: "call:call-1",
        title: "Answered on Office Mac",
        body: "Call with Scout.",
        path: "/call/host/call-1",
        createdAt: "2026-10-28T12:00:10.000Z",
        expiresAt: "2026-10-28T12:10:10.000Z",
      },
    },
  ]);
  const ended = (status: AgentCall["status"]) =>
    agentCallPushActions(
      {
        previous: call(),
        call: call({ status, expiresAt: null, endedAt: "2026-10-28T12:00:20.000Z" }),
      },
      options,
    );
  assert.deepStrictEqual(ended("declined"), [
    { cancel: "call:call-1" },
    {
      publish: {
        key: "call:call-1:ended",
        kind: "call-ended",
        tag: "call:call-1",
        title: "Call ended",
        body: "You declined the call from Scout.",
        path: "/agents/host/agent-scout",
        createdAt: "2026-10-28T12:00:20.000Z",
        expiresAt: "2026-10-28T12:10:20.000Z",
      },
    },
  ]);
  const cancelled = ended("ended")[1];
  assert.deepStrictEqual(
    cancelled !== undefined && "publish" in cancelled
      ? [cancelled.publish.kind, cancelled.publish.title, cancelled.publish.body]
      : null,
    ["call-ended", "Call ended", "Scout stopped calling."],
  );
  const missed = call({
    status: "missed",
    topic: null,
    reason: "question",
    expiresAt: null,
    endedAt: "2026-10-28T12:00:45.000Z",
  });
  assert.deepStrictEqual(agentCallPushActions({ previous: call(), call: missed }, options), [
    { cancel: "call:call-1" },
    {
      publish: {
        key: "call:call-1:missed",
        kind: "missed-call",
        tag: "call:call-1",
        title: "Missed call from Scout",
        body: "Has a question for you.",
        path: "/agents/host/agent-scout",
        createdAt: "2026-10-28T12:00:45.000Z",
      },
    },
  ]);
  // Hanging up an answered call and outgoing calls push nothing.
  assert.deepStrictEqual(
    agentCallPushActions({ previous: answered, call: { ...answered, status: "ended" } }, options),
    [],
  );
  assert.deepStrictEqual(
    agentCallPushActions({ previous: null, call: call({ direction: "outgoing" }) }, options),
    [],
  );
});

const blocker = (id: string): VmAgentBlocker => ({
  blockerId: VmAgentBlockerId.make(id),
  vmAgentId,
  title: "Google sign-in needs you",
  detail: "Solve the reCAPTCHA.",
  url: null,
  createdAt: "2026-10-28T12:00:00.000Z",
  updatedAt: "2026-10-28T12:00:00.000Z",
  resolvedAt: null,
  resolvedBy: null,
});

it.effect("rings agents only for new blockers and live requests on threads they own", () =>
  Effect.gen(function* () {
    yield* TestClock.adjust("1 hour");
    const now = DateTime.formatIso(yield* DateTime.now);
    const seen = yield* Queue.unbounded<
      { readonly ring: Parameters<AgentCallsShape["ring"]>[0] } | { readonly cancel: string }
    >();
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const transitions = yield* PubSub.unbounded<AgentCallTransition>();
    let blockerListener: ((event: VmAgentBlockerEvent) => Effect.Effect<void>) | null = null;
    const published: PushAttention[] = [];
    const cancelled: string[] = [];
    const notified: string[] = [];
    const missedPushed = yield* Deferred.make<void>();

    yield* Layer.build(
      AgentCallReactorLive.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AgentCalls)({
              ring: (input) =>
                Queue.offer(seen, { ring: input }).pipe(Effect.as({ status: "disabled" as const })),
              cancelByKey: (key) => Queue.offer(seen, { cancel: key }).pipe(Effect.asVoid),
              transitions: Stream.fromPubSub(transitions),
            }),
            Layer.mock(WebPush)({
              publish: (attention) =>
                Effect.sync(() => published.push(attention)).pipe(
                  Effect.andThen(
                    attention.kind === "missed-call"
                      ? Deferred.succeed(missedPushed, undefined)
                      : Effect.void,
                  ),
                  Effect.asVoid,
                ),
              cancel: (key) => Effect.sync(() => void cancelled.push(key)),
            }),
            Layer.mock(VmAgentWorkspace)({
              subscribeBlockers: (listener) =>
                Effect.sync(() => {
                  blockerListener = listener;
                  return () => {
                    blockerListener = null;
                  };
                }),
              notify: (input) =>
                Effect.sync(() => notified.push(input.notificationId ?? input.title)).pipe(
                  Effect.as(true),
                ),
            }),
            Layer.mock(VmAgentStore)({
              getById: () => Effect.succeed(Option.some(agent)),
              getByThreadId: (threadId) =>
                Effect.succeed(threadId === agentThread ? Option.some(agent) : Option.none()),
            }),
            Layer.mock(ProjectionSnapshotQuery)({
              getThreadShellById: (threadId) =>
                Effect.succeed(
                  threadId === "side-chat"
                    ? Option.some({ sideChatParentThreadId: agentThread } as never)
                    : Option.none(),
                ),
            }),
            Layer.mock(OrchestrationEngineService)({
              streamDomainEvents: Stream.fromPubSub(events),
            }),
            Layer.mock(ServerEnvironment)({ getEnvironmentId: Effect.succeed(environmentId) }),
          ),
        ),
      ),
    );

    // Blockers: a same-title refresh does not ring; a new one does; resolving cancels.
    const listener = blockerListener as
      | ((event: VmAgentBlockerEvent) => Effect.Effect<void>)
      | null;
    if (listener === null) return assert.fail("the reactor did not subscribe to blockers");
    yield* listener({ type: "raised", blocker: blocker("old"), created: false });
    yield* listener({ type: "raised", blocker: blocker("new"), created: true });
    yield* listener({ type: "resolved", blocker: blocker("new") });
    assert.deepStrictEqual(yield* Queue.takeAll(seen), [
      {
        ring: {
          vmAgentId,
          reason: "blocker",
          topic: "Google sign-in needs you — Solve the reCAPTCHA.",
          key: "blocker:new",
        },
      },
      { cancel: "blocker:new" },
    ]);

    // Requests: stale and unowned ones are skipped; side chats ring their agent.
    const question = (threadId: string, createdAt: string, requestId: string) =>
      activityEvent({
        kind: "user-input.requested",
        threadId,
        createdAt,
        payload: {
          requestId,
          questions: [{ id: "q", header: "Q", question: "Which account?", options: [] }],
        },
      });
    yield* PubSub.publish(events, question(agentThread, "1970-01-01T00:00:00.000Z", "stale"));
    yield* PubSub.publish(events, question("someone-else", now, "unowned"));
    yield* PubSub.publish(events, question("side-chat", now, "side"));
    yield* PubSub.publish(
      events,
      activityEvent({
        kind: "user-input.resolved",
        payload: { requestId: "side" },
        threadId: "side-chat",
      }),
    );
    assert.deepStrictEqual(yield* Queue.take(seen), {
      ring: { vmAgentId, reason: "question", topic: "Which account?", key: "input:side-chat:side" },
    });
    assert.deepStrictEqual(yield* Queue.take(seen), { cancel: "input:side-chat:side" });

    // A missed call leaves an inbox notice (web push skips it) and replaces the
    // ringing push in place.
    const ringing = call();
    yield* PubSub.publish(transitions, {
      previous: ringing,
      call: { ...ringing, status: "missed", expiresAt: null, endedAt: "2026-10-28T12:00:45.000Z" },
    });
    yield* Deferred.await(missedPushed);
    assert.deepStrictEqual(notified, ["missed-call:call-1"]);
    assert.deepStrictEqual(cancelled, ["call:call-1"]);
    assert.strictEqual(published[0]?.tag, "call:call-1");
  }).pipe(Effect.scoped),
);
