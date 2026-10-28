/**
 * Agent calls on the phone: which call to put on screen, when the call screen
 * closes itself, and where its page lives.
 *
 * The call itself is the web client's `/call/<environment>/<call>` page hosted
 * in a WebView, the same way the orchestrator is, so the microphone and audio
 * are on the phone while the agent works on its host. This file holds the
 * decisions around that page and nothing that touches React Native, so each
 * rule is testable on its own.
 */
import {
  AGENT_CALL_NATIVE_MESSAGE_TYPE,
  AGENT_CALL_RING_SECONDS,
  agentCallRoutePath,
  type AgentCall,
  type AgentCallNativeMessage,
  type AgentCallStatus,
} from "@t3tools/contracts";
import { agentCallTransferTarget } from "@t3tools/shared/agentCallBridge";

/** How long "Call ended" stays on screen after a call this phone held ends. */
export const AGENT_CALL_ENDED_LINGER_MS = 1_500;

/**
 * How long a ring that went live waits for the page to say this phone took
 * it before the screen decides another device answered. The page says so as
 * it answers, before its claim reaches the host, so this only covers the
 * bridge and a busy JS thread.
 */
export const AGENT_CALL_HOLD_GRACE_MS = 5_000;

/**
 * The web page that hosts one call, as `EnvironmentWebScreen` loads it.
 * `embedded=1` hides the web client's chrome; the native modal is the frame.
 */
export function agentCallPage(
  environmentId: string,
  callId: string,
): { readonly routePath: string; readonly query: string } {
  return { routePath: agentCallRoutePath(environmentId, callId), query: "embedded=1" };
}

/** Call ids are only unique per host, so device-side bookkeeping keys on both. */
export function agentCallKey(environmentId: string, callId: string): string {
  return JSON.stringify([environmentId, callId]);
}

/**
 * The incoming call the phone should present, if any.
 *
 * Only calls an agent placed to the person ring here: an outgoing call belongs
 * to the device that placed it. A call already presented once is not presented
 * again, so closing the screen on a ringing call stays closed while the other
 * devices keep ringing. A ring past its expiry is skipped even before the host
 * marks it missed, because a phone returning from the background can briefly
 * hold a stale snapshot.
 */
export function selectIncomingCallToPresent(input: {
  readonly environmentId: string;
  readonly calls: ReadonlyArray<AgentCall>;
  readonly alreadyPresented: (key: string) => boolean;
  readonly nowMs: number;
}): AgentCall | null {
  for (const call of input.calls) {
    if (call.direction !== "incoming" || call.status !== "ringing") continue;
    if (call.expiresAt !== null && Date.parse(call.expiresAt) <= input.nowMs) continue;
    if (input.alreadyPresented(agentCallKey(input.environmentId, call.callId))) continue;
    return call;
  }
  return null;
}

export type AgentCallScreenAction = "stay" | "dismiss" | "dismiss-soon" | "await-hold";

/**
 * What the call screen does when it sees the followed call's status change.
 *
 * Only an observed transition acts: a screen opened on a call that has
 * already ended stays and shows how it ended. `heldHere` is
 * `isCallHeldHere`; `failed` means the page reported a failure for it;
 * `transferring` that the page hung it up to move the person to another
 * agent (`AgentCallScreenHold.transfer`).
 *
 * - A failure stays, so the reason can be read; the person closes it.
 * - A ring this phone placed or took stays when it connects or is declined,
 *   so the page's outcome is on screen. Hung up before it connected, it
 *   lingers on "Call ended" like an ended call.
 * - A ring that went live without word from the page waits for it
 *   (`await-hold`): the host can be quicker than the page's own claim. No
 *   word means another device answered, and the screen closes.
 * - Any other ring that stops closes the screen: declined, missed, cancelled.
 * - A call this phone held that ends lingers briefly on "Call ended", like a
 *   phone's call screen. One the page hung up to transfer the person waits
 *   longer (`await-hold`): the page then holds the new call, and the screen
 *   follows it there instead of closing, or reports why it failed.
 */
export function resolveAgentCallScreenAction(input: {
  readonly previousStatus: AgentCallStatus | null;
  readonly status: AgentCallStatus;
  readonly heldHere: boolean;
  readonly failed: boolean;
  readonly transferring?: boolean;
}): AgentCallScreenAction {
  const { previousStatus, status } = input;
  if (input.failed) return "stay";
  if (previousStatus === null || previousStatus === status) return "stay";
  // A transfer: the call the page hung up ends, and the screen waits as long
  // as for any claim for the call it places (or why it couldn't).
  if (input.transferring && status !== "active" && status !== "ringing") return "await-hold";
  if (status === "failed" || status === "ringing") return "stay";
  if (previousStatus === "ringing") {
    if (input.heldHere) return status === "ended" ? "dismiss-soon" : "stay";
    return status === "active" ? "await-hold" : "dismiss";
  }
  if (previousStatus === "active") {
    return input.heldHere ? "dismiss-soon" : "dismiss";
  }
  return "stay";
}

/**
 * The followed call's status when the screen last looked at it, for
 * `resolveAgentCallScreenAction`. Null once the screen has moved on to
 * another call: a transfer's new call starts fresh, so its first status never
 * reads as a change, and the old call ending behind it is not the screen's
 * to act on.
 */
export function previousFollowedStatus(
  previous: { readonly callId: string; readonly status: AgentCallStatus } | null,
  callId: string,
): AgentCallStatus | null {
  return previous?.callId === callId ? previous.status : null;
}

/**
 * Who else is on the call, under the agent's name in the call screen's
 * header: "with Gregg, Nova". Null without participants, including from hosts
 * older than merged calls. Read-only: people are added and dropped on the
 * call page or by voice.
 */
export function agentCallParticipantsLine(
  call: Pick<AgentCall, "participants"> | null,
): string | null {
  const titles = (call?.participants ?? [])
    .map((participant) => participant.title.trim())
    .filter((title) => title.length > 0);
  return titles.length === 0 ? null : `with ${titles.join(", ")}`;
}

/**
 * Whether leaving the call screen must hang up.
 *
 * The voice session lives in the screen's WebView, so closing it silences the
 * call either way; ending it tells the host and the agent. A ringing incoming
 * call is left ringing on the person's other devices: closing the screen here
 * ignores it rather than declining it.
 */
export function shouldEndCallOnLeave(input: {
  readonly call: Pick<AgentCall, "direction" | "status"> | null;
  readonly heldHere: boolean;
}): boolean {
  const { call } = input;
  if (call === null || !input.heldHere) return false;
  if (call.status === "active") return true;
  return call.status === "ringing" && call.direction === "outgoing";
}

/** One hangup the call screen owes the host when it is left. */
export interface AgentCallLeaveEnd {
  readonly callId: string;
  /** Sent as `AgentCallEndInput.ifRinging`: the host ends the call only while it still rings. */
  readonly ifRinging: boolean;
}

/**
 * The hangups leaving the call screen owes.
 *
 * Only a call the page reported `connected` (the host accepted its claim) is
 * this phone's to hang up outright. A call the page holds but hasn't
 * connected, or one this phone placed that the page doesn't hold, is only
 * cancelled (`ifRinging`) while it can still be ringing: another device may
 * have answered it in the seconds before this phone's claim would land. A
 * ringing incoming call is left ringing for the person's other devices. A
 * claim of this phone's that landed just before its `connected` arrived is
 * left to the call's lease.
 */
export function callsToEndOnLeave(input: {
  readonly hold: AgentCallScreenHold;
  readonly findCall: (callId: string) => Pick<AgentCall, "direction" | "status"> | null;
  /** The call the host shows ringing out to this agent, if any. */
  readonly findOutgoingRing?: (vmAgentId: string) => string | null;
}): ReadonlyArray<AgentCallLeaveEnd> {
  const { hold } = input;
  const ends: AgentCallLeaveEnd[] = [];
  const cancelIfRinging = (callId: string) => {
    const call = input.findCall(callId);
    if (call === null || (call.direction === "outgoing" && call.status === "ringing")) {
      ends.push({ callId, ifRinging: true });
    }
  };
  for (const callId of hold.held) {
    if (!hold.connected.has(callId)) {
      cancelIfRinging(callId);
      continue;
    }
    const call = input.findCall(callId);
    if (call === null || shouldEndCallOnLeave({ call, heldHere: true })) {
      ends.push({ callId, ifRinging: false });
    }
  }
  if (hold.placedHere && !hold.held.has(hold.openedCallId)) cancelIfRinging(hold.openedCallId);
  // Mid-transfer the page is placing a call whose id it hasn't said yet: the
  // one ringing out to that agent is it (the host allows one open call per
  // agent). Before the host's snapshot shows it, its ring runs out on its own.
  const placing =
    hold.transfer === null ? null : (input.findOutgoingRing?.(hold.transfer.vmAgentId) ?? null);
  if (placing !== null && !ends.some((each) => each.callId === placing))
    ends.push({ callId: placing, ifRinging: true });
  return ends;
}

/**
 * How much longer the phone should buzz for this call, or null when it
 * shouldn't buzz: only an agent's ringing call, while the app is open and the
 * page hasn't answered it or failed to. `answeredHere` is the page's "held"
 * for the call, which comes as the person answers, seconds before the host's
 * snapshot stops saying "ringing". A ring stops at its expiry even when the
 * host's "missed" never arrives: a phone that lost its connection keeps the
 * last snapshot, which still says "ringing".
 */
export function ringRemainingMs(input: {
  readonly call: Pick<AgentCall, "direction" | "status" | "expiresAt"> | null;
  readonly appActive: boolean;
  readonly answeredHere: boolean;
  readonly failed: boolean;
  readonly nowMs: number;
}): number | null {
  const { call, nowMs } = input;
  if (!input.appActive || input.answeredHere || input.failed || call === null) return null;
  if (call.direction !== "incoming" || call.status !== "ringing") return null;
  const expiresAtMs =
    call.expiresAt === null ? nowMs + AGENT_CALL_RING_SECONDS * 1_000 : Date.parse(call.expiresAt);
  const remaining = expiresAtMs - nowMs;
  return Number.isFinite(remaining) && remaining > 0 ? remaining : null;
}

/**
 * The call to open instead of placing a new one when the agent is already on
 * a call (another device holds it) or is ringing the person. Placing would
 * only fail with "already on a call"; the call's own screen says who holds it
 * and can end it, or answers the ring. An outgoing call still ringing belongs
 * to the device that placed it, so it is left alone.
 */
export function openCallForAgent(
  calls: ReadonlyArray<AgentCall> | null,
  vmAgentId: string,
): AgentCall | null {
  return (
    calls?.find(
      (call) =>
        call.vmAgentId === vmAgentId &&
        (call.status === "active" || (call.status === "ringing" && call.direction === "incoming")),
    ) ?? null
  );
}

/**
 * Which calls the phone's call screen holds, learnt only from the page it
 * hosts (`AgentCallNativeMessage`): `held` when the page places or answers a
 * call, `connected` once the host accepted its claim, `released` when it hangs
 * up or the call ends, `failed` when voice couldn't start or dropped. Touches
 * prove nothing (VoiceOver and keyboards answer without one).
 *
 * The page can move on to a call the screen didn't open on, which the screen
 * then follows. A transfer is that: the page posts `released` for the old
 * call with the agent it is moving to (`agentCallTransferDetail`), then
 * `held` and `connected` for the call it placed to that agent, and leaving
 * the screen hangs up the new call, never the old one again.
 */
export interface AgentCallScreenHold {
  /** The call in the screen's route. */
  readonly openedCallId: string;
  /** Whether this phone placed the opened call, so leaving may cancel its ring. */
  readonly placedHere: boolean;
  /** The call the screen follows: the opened one, then whichever the page last reported. */
  readonly callId: string;
  /** Calls the page holds now; leaving the screen ends or cancels these (`callsToEndOnLeave`). */
  readonly held: ReadonlySet<string>;
  /** Calls the page has held at some point; their ending lingers on screen. */
  readonly heldEver: ReadonlySet<string>;
  /** Held calls the host gave this phone; only these are hung up outright on leaving. */
  readonly connected: ReadonlySet<string>;
  /** Why the followed call failed, as the page reported it; the screen stays open on it. */
  readonly failure: string | null;
  /**
   * A transfer in flight: the call the page hung up for it and the agent it
   * is calling instead, until the page holds that call or reports a failure.
   */
  readonly transfer: { readonly fromCallId: string; readonly vmAgentId: string } | null;
}

export function initialAgentCallScreenHold(input: {
  readonly callId: string;
  readonly placedHere: boolean;
}): AgentCallScreenHold {
  return {
    openedCallId: input.callId,
    placedHere: input.placedHere,
    callId: input.callId,
    held: new Set(),
    heldEver: new Set(),
    connected: new Set(),
    failure: null,
    transfer: null,
  };
}

/**
 * Whether the call is this phone's to see out: the page has held it, or this
 * phone placed it and it still rings. Placing a call only lets this phone
 * cancel its ring; once it is live without the page holding it, another
 * device answered it.
 */
export function isCallHeldHere(
  hold: AgentCallScreenHold,
  callId: string,
  status: AgentCallStatus | null,
): boolean {
  return (
    hold.heldEver.has(callId) ||
    (hold.placedHere && callId === hold.openedCallId && status === "ringing")
  );
}

/** What the call screen knows after one message from its page. */
export function applyAgentCallNativeMessage(
  hold: AgentCallScreenHold,
  message: AgentCallNativeMessage,
): AgentCallScreenHold {
  const { callId } = message;
  // The page holding a call other than the one it hung up has finished the transfer.
  const transfer = hold.transfer?.fromCallId === callId ? hold.transfer : null;
  switch (message.event) {
    case "held":
      return {
        ...hold,
        callId,
        held: new Set(hold.held).add(callId),
        heldEver: new Set(hold.heldEver).add(callId),
        failure: null,
        transfer,
      };
    case "connected":
      return {
        ...hold,
        callId,
        held: new Set(hold.held).add(callId),
        heldEver: new Set(hold.heldEver).add(callId),
        connected: new Set(hold.connected).add(callId),
        failure: null,
        transfer,
      };
    case "released": {
      if (!hold.held.has(callId) && !hold.connected.has(callId)) return hold;
      const held = new Set(hold.held);
      held.delete(callId);
      const connected = new Set(hold.connected);
      connected.delete(callId);
      const movingTo = agentCallTransferTarget(message.detail);
      return {
        ...hold,
        held,
        connected,
        transfer: movingTo === null ? transfer : { fromCallId: callId, vmAgentId: movingTo },
      };
    }
    case "failed": {
      // A failed call is no longer the page's: it either told the host, or
      // never took the call (another device answered first), and hanging that
      // one up on leaving would cut someone else's call.
      const held = new Set(hold.held);
      held.delete(callId);
      const connected = new Set(hold.connected);
      connected.delete(callId);
      return {
        ...hold,
        callId,
        held,
        connected,
        failure: message.detail ?? "The call failed.",
        transfer: null,
      };
    }
  }
}

const MAX_NATIVE_MESSAGE_LENGTH = 4_096;
const MAX_NATIVE_DETAIL_LENGTH = 500;
const MAX_CALL_ID_LENGTH = 128;

/**
 * Reads one WebView message as an agent call message, or null. The page can
 * post other things, and only a well-formed call message may change which
 * calls this phone holds.
 */
export function parseAgentCallNativeMessage(data: string): AgentCallNativeMessage | null {
  if (data.length > MAX_NATIVE_MESSAGE_LENGTH) return null;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  if (record.type !== AGENT_CALL_NATIVE_MESSAGE_TYPE) return null;
  const event = record.event;
  if (event !== "held" && event !== "connected" && event !== "released" && event !== "failed")
    return null;
  const callId = typeof record.callId === "string" ? record.callId.trim() : "";
  if (callId.length === 0 || callId.length > MAX_CALL_ID_LENGTH) return null;
  const detail =
    typeof record.detail === "string"
      ? record.detail.trim().slice(0, MAX_NATIVE_DETAIL_LENGTH)
      : "";
  return {
    type: AGENT_CALL_NATIVE_MESSAGE_TYPE,
    event,
    callId,
    ...(detail.length > 0 ? { detail } : {}),
  };
}

/**
 * A small remembered set of call keys for this app session.
 *
 * Bounded so a phone left open for weeks does not grow it without end; the
 * oldest keys go first, long after their calls stopped ringing.
 */
export function createAgentCallKeySet(limit = 64) {
  const keys = new Set<string>();
  return {
    has: (key: string) => keys.has(key),
    add: (key: string) => {
      keys.delete(key);
      keys.add(key);
      while (keys.size > limit) {
        const oldest = keys.values().next().value;
        if (oldest === undefined) break;
        keys.delete(oldest);
      }
    },
  };
}

/** Incoming calls already put on screen once on this phone. */
export const presentedIncomingCalls = createAgentCallKeySet();

/** Calls this phone placed, so its call screen knows the call is its own. */
export const callsPlacedHere = createAgentCallKeySet();

/** Offsets of the taps in one ring burst, then the gap until the next burst. */
export const RING_HAPTIC_BURST_MS = [0, 160, 320] as const;
export const RING_HAPTIC_PERIOD_MS = 2_000;

/**
 * Buzzes in a ring rhythm until stopped, or until `stopAfterMs` has passed:
 * three firm taps, then a pause. Taps are short because phone haptics are;
 * the rhythm is what reads as ringing.
 */
export function startRingingHaptics(
  tap: () => void,
  options: {
    readonly stopAfterMs?: number | null;
    readonly timers?: {
      readonly setTimeout: (callback: () => void, ms: number) => unknown;
      readonly clearTimeout: (handle: unknown) => void;
    };
  } = {},
): () => void {
  const timers = options.timers ?? {
    setTimeout: (callback: () => void, ms: number) => globalThis.setTimeout(callback, ms),
    clearTimeout: (handle: unknown) =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  };
  const pending = new Set<unknown>();
  let stopped = false;
  const schedule = (callback: () => void, ms: number) => {
    const handle = timers.setTimeout(() => {
      pending.delete(handle);
      if (!stopped) callback();
    }, ms);
    pending.add(handle);
  };
  const stop = () => {
    stopped = true;
    for (const handle of pending) timers.clearTimeout(handle);
    pending.clear();
  };
  const burst = () => {
    for (const offset of RING_HAPTIC_BURST_MS) schedule(tap, offset);
    schedule(burst, RING_HAPTIC_PERIOD_MS);
  };
  burst();
  const stopAfterMs = options.stopAfterMs;
  if (stopAfterMs !== undefined && stopAfterMs !== null) schedule(stop, stopAfterMs);
  return stop;
}

/**
 * Why the phone can't call agents on a host, or null when it can (or can't
 * tell yet; the host then answers for itself). Calls run on GPT-Live with the
 * OpenAI key saved on the host.
 */
export function agentCallBlockedReason(openAiApiKeyConfigured: boolean | undefined): string | null {
  return openAiApiKeyConfigured === false
    ? "Add an OpenAI key in Settings → Orchestrator on your computer to call agents."
    : null;
}
