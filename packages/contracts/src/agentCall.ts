import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { OrchestratorLiveHistoryEntry } from "./orchestratorLive.ts";
import { VmAgentId } from "./vm.ts";

/**
 * Agent calls: a GPT-Live voice call between a person and one custom agent.
 *
 * Either side can start one. The person places a call from the agent's
 * workspace (`outgoing`); an agent rings the person when it raises a blocker,
 * waits on a question or approval, or asks to talk (`incoming`). A call is an
 * ephemeral server record broadcast to every device of the host, so whichever
 * device answers first takes it and the others stop ringing. Voice runs on
 * OpenAI GPT-Live; the server creates each session with the OpenAI key from
 * Settings → Orchestrator, so browsers never hold a credential. What the person
 * says is forwarded into the agent's own chat as real messages, and the
 * agent's replies are spoken back.
 */

/** How long an unanswered ring lasts before it becomes `missed`. */
export const AGENT_CALL_RING_SECONDS = 45;
/** Answer or start: claims the call and returns the GPT-Live SDP answer. */
export const AGENT_CALL_SESSION_PATH = "/api/agents/call/session";
/** `${AGENT_CALL_SESSION_PATH}/release` frees the server session; body `{ sessionId }`. */
export const AGENT_CALL_SESSION_RELEASE_PATH = "/api/agents/call/session/release";
/**
 * GPT-Live client delegation: forwards what was said since the last delegation
 * into the agent's chat and streams NDJSON `OrchestratorLiveWorkEvent`s until
 * the agent's reply (or question, approval request, failure) arrives. The body
 * is an `OrchestratorLiveDelegationInput`.
 */
export const AGENT_CALL_DELEGATION_PATH = "/api/agents/call/delegation";
/**
 * Keeps an active call's lease: the device holding the call POSTs `{ sessionId }`
 * every `AGENT_CALL_HEARTBEAT_SECONDS`. The host ends an active call whose lease
 * lapses (`AGENT_CALL_LEASE_SECONDS`), so a crashed tab or killed app can't
 * leave a call open. Delegation requests renew the lease too.
 */
export const AGENT_CALL_SESSION_HEARTBEAT_PATH = "/api/agents/call/session/heartbeat";
export const AGENT_CALL_HEARTBEAT_SECONDS = 15;
export const AGENT_CALL_LEASE_SECONDS = 50;

/**
 * Messages the call page posts to the phone app that hosts it in a WebView
 * (`window.ReactNativeWebView.postMessage(JSON.stringify(message))`). The
 * native screen trusts these, not touches, to know which calls this phone
 * holds: `held` when the page places or answers a call, `connected` once the
 * host accepted this page's claim (the call is live on this phone), `released`
 * when it hangs up or the call ends, `failed` with the reason when voice
 * couldn't start or dropped.
 */
export const AGENT_CALL_NATIVE_MESSAGE_TYPE = "solla-agent-call";
export type AgentCallNativeMessage = {
  readonly type: typeof AGENT_CALL_NATIVE_MESSAGE_TYPE;
  readonly event: "held" | "connected" | "released" | "failed";
  readonly callId: string;
  readonly detail?: string;
};

/** Web route a notification or the phone app opens to answer or join a call. */
export const agentCallRoutePath = (environmentId: string, callId: string) =>
  `/call/${encodeURIComponent(environmentId)}/${encodeURIComponent(callId)}`;

export const AgentCallId = TrimmedNonEmptyString.check(Schema.isMaxLength(128)).pipe(
  Schema.brand("AgentCallId"),
);
export type AgentCallId = typeof AgentCallId.Type;

/** `outgoing`: the person called the agent. `incoming`: the agent called the person. */
export const AgentCallDirection = Schema.Literals(["outgoing", "incoming"]);
export type AgentCallDirection = typeof AgentCallDirection.Type;

/**
 * Why the call exists. `user` for calls the person placed; for incoming calls
 * the agent raised a `blocker`, its chat is waiting on a `question` or an
 * `approval`, or the agent asked to talk with agent_workspace `call_user`
 * (`request`).
 */
export const AgentCallReason = Schema.Literals([
  "user",
  "blocker",
  "question",
  "approval",
  "request",
]);
export type AgentCallReason = typeof AgentCallReason.Type;

/**
 * `ringing` until a device claims it (outgoing calls ring only on the device
 * that placed them), then `active`. Terminal: `declined`, `missed` (an incoming
 * ring nobody answered), `ended`, `failed` (voice could not start).
 */
export const AgentCallStatus = Schema.Literals([
  "ringing",
  "active",
  "declined",
  "missed",
  "ended",
  "failed",
]);
export type AgentCallStatus = typeof AgentCallStatus.Type;

export const AgentCall = Schema.Struct({
  callId: AgentCallId,
  vmAgentId: VmAgentId,
  direction: AgentCallDirection,
  reason: AgentCallReason,
  /** What the agent wants to talk about; it opens an incoming call with this. */
  topic: Schema.NullOr(Schema.String.check(Schema.isMaxLength(500))),
  status: AgentCallStatus,
  /** Label of the device that answered or placed the call. */
  answeredBy: Schema.NullOr(Schema.String.check(Schema.isMaxLength(200))),
  createdAt: IsoDateTime,
  answeredAt: Schema.NullOr(IsoDateTime),
  endedAt: Schema.NullOr(IsoDateTime),
  /** When a `ringing` call stops ringing; null once answered or ended. */
  expiresAt: Schema.NullOr(IsoDateTime),
});
export type AgentCall = typeof AgentCall.Type;

/** Every open call plus calls that ended in the last few minutes, newest first. */
export const AgentCallsSnapshot = Schema.Struct({
  type: Schema.Literal("snapshot"),
  calls: Schema.Array(AgentCall),
});
export type AgentCallsSnapshot = typeof AgentCallsSnapshot.Type;

export const AgentCallPlaceInput = Schema.Struct({ vmAgentId: VmAgentId });
export type AgentCallPlaceInput = typeof AgentCallPlaceInput.Type;

export const AgentCallRef = Schema.Struct({ callId: AgentCallId });
export type AgentCallRef = typeof AgentCallRef.Type;

/**
 * Ends a call. With `ifRinging`, the host ends it only while it still rings,
 * so a device that never connected can cancel its ring without hanging up a
 * call another device answered.
 */
export const AgentCallEndInput = Schema.Struct({
  callId: AgentCallId,
  ifRinging: Schema.optionalKey(Schema.Boolean),
});
export type AgentCallEndInput = typeof AgentCallEndInput.Type;

/** Body of `AGENT_CALL_SESSION_PATH`. The result is an `OrchestratorLiveStartResult`. */
export const AgentCallSessionStartInput = Schema.Struct({
  callId: AgentCallId,
  sdp: TrimmedNonEmptyString.check(Schema.isMaxLength(65_536)),
  history: Schema.Array(OrchestratorLiveHistoryEntry).check(Schema.isMaxLength(24)),
});
export type AgentCallSessionStartInput = typeof AgentCallSessionStartInput.Type;

export class AgentCallError extends Schema.TaggedErrorClass<AgentCallError>()("AgentCallError", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}
