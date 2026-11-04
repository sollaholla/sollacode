import {
  ORCHESTRATOR_THREAD_ID,
  ORCHESTRATOR_THREAD_TITLE,
  agentCallRoutePath,
  type AgentCall,
  type EnvironmentId,
  type OrchestrationEvent,
  type ThreadId,
  VmAgentNotificationId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import { WebPush, type PushAttention } from "../notifications/WebPush.ts";
import { pushActionForEvent } from "../notifications/WebPushReactor.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import { isActionApprovalRequest, requestText } from "./AgentCallLive.ts";
import {
  AgentCalls,
  MISSED_CALL_NOTIFICATION_PREFIX,
  type AgentCallRingReason,
  type AgentCallTransition,
} from "./AgentCalls.ts";
import { resolveOwningVmAgent } from "./owningAgent.ts";
import { isOrchestratorCaller } from "@t3tools/shared/orchestratorCaller";
import { VmAgentWorkspace } from "./VmAgentWorkspace.ts";

/** A request older than this is a replay (a restart, a reconnect), not something to ring for. */
const LIVE_REQUEST_MAX_AGE_MS = 2 * 60_000;

const REASON_TEXT: Record<AgentCall["reason"], string> = {
  user: "Calling.",
  blocker: "Needs your help with something it's blocked on.",
  question: "Has a question for you.",
  approval: "Needs your approval.",
  request: "Wants to talk with you.",
};

export type AgentCallTrigger =
  | {
      readonly ring: {
        readonly threadId: ThreadId;
        readonly key: string;
        readonly reason: AgentCallRingReason;
        readonly topic: string;
        readonly createdAt: string;
      };
    }
  | { readonly cancel: string };

/**
 * A question or approval appearing in a thread rings its agent; its
 * resolution cancels the ring. Keys match the request's web push key.
 */
export function agentCallTriggerForEvent(
  event: OrchestrationEvent,
  environmentId: EnvironmentId,
): AgentCallTrigger | null {
  const action = pushActionForEvent(event, environmentId);
  if (action === null || event.type !== "thread.activity-appended") return null;
  if ("cancel" in action) return { cancel: action.cancel };
  const { activity, threadId } = event.payload;
  return {
    ring: {
      threadId,
      key: action.publish.key,
      reason:
        activity.kind === "approval.requested" || isActionApprovalRequest(activity)
          ? "approval"
          : "question",
      topic: requestText(activity).slice(0, 500),
      createdAt: activity.createdAt,
    },
  };
}

/** How long the quiet "call ended" replacement is worth delivering. */
const CALL_ENDED_PUSH_TTL_MS = 10 * 60_000;

/** The quiet replacement's text when a ring stops for any reason but a miss. */
function callEndedText(call: AgentCall, agentName: string): { title: string; body: string } {
  switch (call.status) {
    case "active":
      return {
        title: `Answered on ${call.answeredBy ?? "another device"}`,
        body: `Call with ${agentName}.`,
      };
    case "declined":
      return { title: "Call ended", body: `You declined the call from ${agentName}.` };
    case "failed":
      return { title: "Call ended", body: `The call from ${agentName} couldn't connect.` };
    default:
      return { title: "Call ended", body: `${agentName} stopped calling.` };
  }
}

/**
 * Web push for a call's state change: a ringing notification while it rings,
 * then replaced in place (same tag) once it stops ringing — by a missed-call
 * notice when nobody answered, otherwise by a quiet "call-ended" notice
 * ("Answered on <device>", "Call ended"), so the sticky ringing notification
 * leaves every device. Pending ring deliveries are withdrawn either way.
 */
export function agentCallPushActions(
  transition: AgentCallTransition,
  input: { readonly environmentId: EnvironmentId; readonly agentName: string },
): ReadonlyArray<{ readonly publish: PushAttention } | { readonly cancel: string }> {
  const { call, previous } = transition;
  if (call.direction !== "incoming") return [];
  const key = `call:${call.callId}`;
  const body = call.topic ?? REASON_TEXT[call.reason];
  if (previous === null && call.status === "ringing")
    return [
      {
        publish: {
          key,
          kind: "call",
          tag: key,
          title: `${input.agentName} is calling`,
          body,
          path: agentCallRoutePath(input.environmentId, call.callId),
          createdAt: call.createdAt,
          ...(call.expiresAt === null ? {} : { expiresAt: call.expiresAt }),
        },
      },
    ];
  if (previous?.status !== "ringing" || call.status === "ringing") return [];
  // The orchestrator's missed call opens its chat; an agent's opens the agent.
  const agentPath = isOrchestratorCaller(call.vmAgentId)
    ? `/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(ORCHESTRATOR_THREAD_ID)}`
    : `/agents/${encodeURIComponent(input.environmentId)}/${encodeURIComponent(call.vmAgentId)}`;
  if (call.status !== "missed") {
    const createdAt = call.endedAt ?? call.answeredAt ?? call.createdAt;
    return [
      { cancel: key },
      {
        publish: {
          key: `${key}:ended`,
          kind: "call-ended",
          tag: key,
          ...callEndedText(call, input.agentName),
          path:
            call.status === "active"
              ? agentCallRoutePath(input.environmentId, call.callId)
              : agentPath,
          createdAt,
          expiresAt: DateTime.formatIso(
            DateTime.add(DateTime.makeUnsafe(createdAt), { milliseconds: CALL_ENDED_PUSH_TTL_MS }),
          ),
        },
      },
    ];
  }
  return [
    { cancel: key },
    {
      publish: {
        key: `${key}:missed`,
        kind: "missed-call",
        tag: key,
        title: `Missed call from ${input.agentName}`,
        body,
        path: agentPath,
        createdAt: call.endedAt ?? call.createdAt,
      },
    },
  ];
}

/** Rings agents on new blockers, questions and approvals, and pushes call state to devices. */
export const AgentCallReactorLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const calls = yield* AgentCalls;
    const push = yield* WebPush;
    const workspace = yield* VmAgentWorkspace;
    const agents = yield* VmAgentStore;
    const projections = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const environmentId = yield* (yield* ServerEnvironment).getEnvironmentId;
    const agentName = (call: AgentCall) =>
      isOrchestratorCaller(call.vmAgentId)
        ? Effect.succeed(ORCHESTRATOR_THREAD_TITLE)
        : agents.getById(call.vmAgentId).pipe(
            Effect.map((agent) => (Option.isSome(agent) ? agent.value.name : "Your agent")),
            Effect.orElseSucceed(() => "Your agent"),
          );

    const onTransition = Effect.fn("AgentCalls.onTransition")(
      function* (transition: AgentCallTransition) {
        const name = yield* agentName(transition.call);
        const call = transition.call;
        // The orchestrator has no agent inbox; its missed call is in the push alone.
        if (
          call.direction === "incoming" &&
          call.status === "missed" &&
          !isOrchestratorCaller(call.vmAgentId)
        ) {
          // The inbox keeps the missed call after the in-memory record is
          // pruned. Web push leaves this entry alone (WebPushReactor skips
          // missed-call ids): the missed-call push below already replaces the
          // ringing notification in place.
          const notificationId = VmAgentNotificationId.make(
            `${MISSED_CALL_NOTIFICATION_PREFIX}${call.callId}`,
          );
          yield* workspace
            .notify({
              vmAgentId: call.vmAgentId,
              notificationId,
              kind: "agent-message",
              title: `Missed call from ${name}`,
              body: call.topic ?? REASON_TEXT[call.reason],
              dedupeKey: notificationId,
            })
            .pipe(Effect.ignoreCause({ log: true }));
        }
        for (const action of agentCallPushActions(transition, { environmentId, agentName: name }))
          yield* "publish" in action ? push.publish(action.publish) : push.cancel(action.cancel);
      },
      Effect.ignoreCause({ log: true }),
    );
    yield* calls.transitions.pipe(
      Stream.runForEach(onTransition),
      Effect.forkScoped({ startImmediately: true }),
    );

    yield* Effect.acquireRelease(
      workspace.subscribeBlockers((event) => {
        const key = `blocker:${event.blocker.blockerId}`;
        if (event.type === "resolved") return calls.cancelByKey(key);
        if (!event.created) return Effect.void;
        const detail = event.blocker.detail.trim();
        return calls
          .ring({
            vmAgentId: event.blocker.vmAgentId,
            reason: "blocker",
            topic: (detail ? `${event.blocker.title} — ${detail}` : event.blocker.title).slice(
              0,
              500,
            ),
            key,
          })
          .pipe(Effect.asVoid);
      }),
      (unsubscribe) => Effect.sync(unsubscribe),
    );

    yield* engine.streamDomainEvents.pipe(
      Stream.runForEach(
        Effect.fn("AgentCalls.onEvent")(
          function* (event) {
            const trigger = agentCallTriggerForEvent(event, environmentId);
            if (trigger === null) return;
            if ("cancel" in trigger) return yield* calls.cancelByKey(trigger.cancel);
            const now = DateTime.toEpochMillis(yield* DateTime.now);
            if (now - Date.parse(trigger.ring.createdAt) > LIVE_REQUEST_MAX_AGE_MS) return;
            const owner = yield* resolveOwningVmAgent({
              threadId: trigger.ring.threadId,
              getAgentByThreadId: (threadId) => agents.getByThreadId(threadId),
              getThreadShellById: (threadId) => projections.getThreadShellById(threadId),
            });
            if (Option.isNone(owner)) return;
            yield* calls.ring({
              vmAgentId: owner.value.vmAgentId,
              reason: trigger.ring.reason,
              topic: trigger.ring.topic,
              key: trigger.ring.key,
            });
          },
          Effect.ignoreCause({ log: true }),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
  }),
);
