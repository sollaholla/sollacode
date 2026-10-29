import type { AgentAvatarMood } from "@t3tools/client-runtime/state/agent-appearance";
import type {
  AgentCall,
  AgentCallDirection,
  AgentCallParticipant,
  AgentCallRosterEntry,
  AgentCallStatus,
  EnvironmentId,
} from "@t3tools/contracts";

import type { VoiceSessionState } from "../orchestrator/realtimeSession";
import type { VoiceCuePolicy } from "../orchestrator/voiceCues";

/**
 * Where this device's side of a call stands.
 *
 * `placing` waits for the host to create an outgoing call, `connecting`
 * opens GPT-Live for a call that exists, and `live` is the conversation.
 * `ended` and `failed` stay on screen long enough to say what happened.
 */
export type AgentCallPhase = "placing" | "connecting" | "live" | "ended" | "failed";

export function isAgentCallPhaseOpen(phase: AgentCallPhase): boolean {
  return phase !== "ended" && phase !== "failed";
}

const TERMINAL_STATUSES: ReadonlySet<AgentCallStatus> = new Set([
  "declined",
  "missed",
  "ended",
  "failed",
]);

export function isTerminalAgentCallStatus(status: AgentCallStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** One key per call across hosts; call ids are only unique on their host. */
export function agentCallKey(environmentId: string, callId: string): string {
  return `${environmentId}\u0000${callId}`;
}

/**
 * The face the agent wears on the call screen.
 *
 * Driven by call and session state only, never audio levels: every mood
 * change rebuilds the avatar image, so it may change a few times per turn,
 * not per frame. Speaking smiles, the agent's chat working looks down at its
 * work, connecting looks up expectantly, and trouble wears the blocked face.
 */
export function agentCallMood(input: {
  readonly phase: AgentCallPhase;
  readonly sessionState: VoiceSessionState;
  /** The agent's chat is handling something said on the call. */
  readonly working: boolean;
}): AgentAvatarMood {
  if (input.phase === "failed" || input.sessionState === "error") return "blocked";
  if (input.phase === "ended") return "idle";
  if (
    input.phase === "placing" ||
    input.phase === "connecting" ||
    input.sessionState === "connecting"
  ) {
    return "waiting";
  }
  if (input.sessionState === "speaking") return "happy";
  if (input.working) return "working";
  return "idle";
}

/** `00:42`, `02:13`, `1:02:03`: a phone's call timer. */
export function formatCallDuration(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(Number.isFinite(totalSeconds) ? totalSeconds : 0));
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const rest = seconds % 60;
  const pad = (value: number) => String(value).padStart(2, "0");
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

/** Whole seconds since the conversation started, or null before it has. */
export function callElapsedSeconds(startedAt: number | null, now: number): number | null {
  if (startedAt === null || !Number.isFinite(startedAt)) return null;
  return Math.max(0, Math.floor((now - startedAt) / 1_000));
}

/** The one line under the agent's name. */
export function agentCallStatusText(input: {
  readonly phase: AgentCallPhase;
  readonly direction: AgentCallDirection;
  readonly elapsedSeconds: number | null;
  readonly error: string | null;
  /** The agent a spoken transfer is moving the call to. */
  readonly transferringTo?: string | null;
}): string {
  if (input.transferringTo && isAgentCallPhaseOpen(input.phase)) {
    return `Transferring to ${input.transferringTo}…`;
  }
  switch (input.phase) {
    case "placing":
      return "Calling…";
    case "connecting":
      return input.direction === "outgoing" ? "Ringing…" : "Connecting…";
    case "live":
      return input.elapsedSeconds === null ? "Connected" : formatCallDuration(input.elapsedSeconds);
    case "ended":
      return "Call ended";
    case "failed":
      return input.error ?? "Call failed";
  }
}

/** What the call screen says about a call this device is not on. */
export function endedAgentCallTitle(status: AgentCallStatus | null): string {
  switch (status) {
    case "declined":
      return "Call declined";
    case "missed":
      return "Missed call";
    case "failed":
      return "Call failed";
    default:
      return "This call has ended";
  }
}

/** The newest line someone said, for the one-line caption. */
export function latestCaption(
  transcript: ReadonlyArray<{ readonly role: "user" | "assistant"; readonly text: string }>,
): { readonly role: "user" | "assistant"; readonly text: string } | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const entry = transcript[index];
    if (entry && entry.text.trim().length > 0) return entry;
  }
  return null;
}

export interface EnvironmentAgentCalls {
  readonly environmentId: EnvironmentId;
  readonly calls: ReadonlyArray<AgentCall>;
}

/**
 * The incoming call this device should ring for, newest first.
 *
 * Outgoing calls never ring here: only the device that placed one shows it,
 * and that device tracks it as its own call. A call this device is already on,
 * or one the person declined here (before the host has said so), is skipped,
 * and so is a ring past its expiry that the host has not marked missed yet.
 */
export function ringingCallForDevice(input: {
  readonly environments: ReadonlyArray<EnvironmentAgentCalls>;
  readonly activeCallKey: string | null;
  readonly dismissed: ReadonlySet<string>;
  readonly now: number;
}): { readonly environmentId: EnvironmentId; readonly call: AgentCall } | null {
  let best: { readonly environmentId: EnvironmentId; readonly call: AgentCall } | null = null;
  for (const { environmentId, calls } of input.environments) {
    for (const call of calls) {
      if (call.direction !== "incoming" || call.status !== "ringing") continue;
      if (call.expiresAt !== null && Date.parse(call.expiresAt) <= input.now) continue;
      const key = agentCallKey(environmentId, call.callId);
      if (key === input.activeCallKey || input.dismissed.has(key)) continue;
      if (best === null || Date.parse(call.createdAt) > Date.parse(best.call.createdAt)) {
        best = { environmentId, call };
      }
    }
  }
  return best;
}

/**
 * How this device's open call ends when its host settled it first. Hung up
 * elsewhere (or its lease ran out) reads "Call ended"; anything else is a
 * failure whose reason stays on screen until dismissed.
 */
export function hostSettledCallOutcome(
  status: AgentCallStatus,
  localError: string | null,
): { readonly phase: "ended" | "failed"; readonly error: string | null } {
  switch (status) {
    case "failed":
      return { phase: "failed", error: localError ?? "The call could not connect." };
    case "missed":
      return { phase: "failed", error: "The call stopped ringing before it connected." };
    case "declined":
      return { phase: "failed", error: "The call was declined on another device." };
    default:
      return { phase: "ended", error: null };
  }
}

/**
 * A call that went away under this device: the connection dropped, or the
 * host ended, refused or forgot (restarted) the session it was on.
 */
export const AGENT_CALL_DROPPED_MESSAGE = "The call dropped.";

export interface AgentCallLocation {
  readonly environmentId: EnvironmentId;
  readonly callId: string;
}

/**
 * Follows which calls ring across hosts, to clear their system notifications
 * once they stop. A host with no snapshot right now (disconnected) keeps its
 * calls as they were: going quiet says nothing about them.
 */
export function trackRingingCalls(
  previous: ReadonlyMap<string, AgentCallLocation>,
  environments: ReadonlyArray<EnvironmentAgentCalls>,
): {
  readonly ringing: ReadonlyMap<string, AgentCallLocation>;
  readonly stopped: ReadonlyArray<AgentCallLocation>;
} {
  const reported = new Set(environments.map(({ environmentId }) => environmentId));
  const ringing = new Map<string, AgentCallLocation>();
  for (const [key, location] of previous) {
    if (!reported.has(location.environmentId)) ringing.set(key, location);
  }
  for (const { environmentId, calls } of environments) {
    for (const call of calls) {
      if (call.status === "ringing") {
        ringing.set(agentCallKey(environmentId, call.callId), {
          environmentId,
          callId: call.callId,
        });
      }
    }
  }
  const stopped = [...previous].flatMap(([key, location]) => (ringing.has(key) ? [] : [location]));
  return { ringing, stopped };
}

/**
 * The agent's open call, for a device that is not on a call with it: another
 * device holds it, a closed tab left it open, or it is still ringing. The
 * host refuses a second call to the same agent, so Call opens that call's
 * page instead, where it can be joined, answered or ended.
 */
export function openAgentCallElsewhere(
  calls: ReadonlyArray<AgentCall> | null,
  vmAgentId: string,
): AgentCall | null {
  return (
    calls?.find(
      (call) => call.vmAgentId === vmAgentId && !isTerminalAgentCallStatus(call.status),
    ) ?? null
  );
}

/** One line about an open call this device is not on. */
export function describeAgentCallElsewhere(call: AgentCall, agentName: string): string {
  const device = call.answeredBy ?? "another device";
  if (call.status !== "ringing") return `On a call with ${agentName} on ${device}`;
  return call.direction === "incoming"
    ? `${agentName} is calling`
    : `Calling ${agentName} from ${device}`;
}

/** When the next ringing call stops ringing on its own, for a re-check then. */
export function nextRingExpiry(
  environments: ReadonlyArray<EnvironmentAgentCalls>,
  now: number,
): number | null {
  let next: number | null = null;
  for (const { calls } of environments) {
    for (const call of calls) {
      if (call.status !== "ringing" || call.expiresAt === null) continue;
      const at = Date.parse(call.expiresAt);
      if (Number.isFinite(at) && at > now && (next === null || at < next)) next = at;
    }
  }
  return next;
}

/**
 * Whether the ring makes noise and buzzes. Not while this device is already
 * on a call — the tone would go straight into the microphone — and the tone
 * follows the sound-cue switch and volume like every other sound the app makes.
 */
export function ringAlerts(input: {
  readonly ringing: boolean;
  readonly onCall: boolean;
  readonly policy: VoiceCuePolicy;
}): { readonly tone: boolean; readonly vibrate: boolean } {
  const alerting = input.ringing && !input.onCall;
  return {
    tone: alerting && input.policy.enabled && input.policy.volume > 0,
    vibrate: alerting,
  };
}

/** A ring is two seconds of tone, then four of silence. */
export const RING_BURST_MS = 2_000;
export const RING_PAUSE_MS = 4_000;
export const RING_VIBRATION_PATTERN: ReadonlyArray<number> = [500, 250, 500, 250, 500];

/**
 * Milliseconds until the next ring burst should start, or null when it would
 * start at or after the ring's expiry (the host will mark it missed).
 */
export function nextRingBurstDelay(input: {
  readonly startedAt: number;
  readonly now: number;
  readonly expiresAt: number | null;
}): number | null {
  const cycle = RING_BURST_MS + RING_PAUSE_MS;
  const intoCycle = Math.max(0, input.now - input.startedAt) % cycle;
  const delay = intoCycle === 0 ? 0 : cycle - intoCycle;
  if (input.expiresAt !== null && input.now + delay >= input.expiresAt) return null;
  return delay;
}

/**
 * Whether to raise a system notification for a ringing call.
 *
 * Only when the person cannot see the ringing sheet — the tab is hidden, or
 * the desktop window is behind others — and only when push is not already
 * delivering the same call to this browser, which would ring twice.
 */
export function shouldNotifyIncomingCall(input: {
  readonly hidden: boolean;
  readonly focused: boolean;
  readonly desktop: boolean;
  readonly pushEnabled: boolean;
  readonly permission: NotificationPermission | "unsupported";
  readonly alreadyShown: boolean;
}): boolean {
  if (input.alreadyShown || input.pushEnabled || input.permission !== "granted") return false;
  return input.hidden || (input.desktop && !input.focused);
}

/** What the agent says first when it is the one calling. */
export function incomingCallOpening(input: {
  readonly agentName: string;
  readonly topic: string | null;
}): string {
  const topic = input.topic?.trim() || "you need the person's input";
  return `Open the call: greet the person, say you're ${input.agentName}, and that you're calling because: ${topic}. Then ask how they'd like to proceed.`;
}

/**
 * Whether the person hears ringback: a call they placed, until the agent
 * picks up. A transfer's new call rings out the same way.
 */
export function isRingingOut(
  call: { readonly direction: AgentCallDirection; readonly phase: AgentCallPhase } | null,
): boolean {
  return (
    call !== null &&
    call.direction === "outgoing" &&
    (call.phase === "placing" || call.phase === "connecting")
  );
}

/**
 * What the voice is told once a call the person placed connects: pick up
 * with a short hello, the way anyone answers a phone, instead of waiting in
 * silence for the person to speak first.
 */
export function outgoingCallGreeting(input: { readonly agentName: string }): string {
  return `Pick up the call as ${input.agentName}: one short, casual hello such as "Hey, what's up?", then let the person talk.`;
}

/** Whether two snapshots list the same participants, so an unchanged one changes nothing. */
export function sameCallParticipants(
  a: ReadonlyArray<AgentCallParticipant>,
  b: ReadonlyArray<AgentCallParticipant>,
): boolean {
  return (
    a.length === b.length &&
    a.every((participant, index) => {
      const other = b[index];
      return (
        other !== undefined &&
        other.threadId === participant.threadId &&
        other.title === participant.title &&
        other.vmAgentId === participant.vmAgentId
      );
    })
  );
}

/**
 * Who the Add picker offers: the roster minus whoever is already on the call,
 * agents first, then chats, each in the roster's order.
 */
export function addableCallRoster(input: {
  readonly roster: ReadonlyArray<AgentCallRosterEntry>;
  readonly participants: ReadonlyArray<AgentCallParticipant>;
  /** The called agent's own chat. */
  readonly ownThreadId: string | null;
}): {
  readonly agents: ReadonlyArray<AgentCallRosterEntry>;
  readonly chats: ReadonlyArray<AgentCallRosterEntry>;
} {
  const onCall = new Set<string>(input.participants.map((participant) => participant.threadId));
  if (input.ownThreadId !== null) onCall.add(input.ownThreadId);
  const addable = input.roster.filter((entry) => !onCall.has(entry.threadId));
  return {
    agents: addable.filter((entry) => entry.vmAgentId !== null),
    chats: addable.filter((entry) => entry.vmAgentId === null),
  };
}
