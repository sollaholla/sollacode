import {
  AGENT_CALL_DELEGATION_PATH,
  AGENT_CALL_HEARTBEAT_SECONDS,
  AGENT_CALL_SESSION_HEARTBEAT_PATH,
  AGENT_CALL_GROK_SESSION_PATH,
  AGENT_CALL_SESSION_PATH,
  AGENT_CALL_SESSION_RELEASE_PATH,
  type AgentCall,
  type AgentCallDirection,
  type AgentCallId,
  type AgentCallParticipant,
  type AgentCallRosterEntry,
  type EnvironmentId,
  type ThreadId,
  type VmAgent,
  type VmAgentId,
} from "@t3tools/contracts";
import { agentCallTransferDetail } from "@t3tools/shared/agentCallBridge";
import { agentCallEngineFor, type AgentCallEngine } from "@t3tools/shared/agentCallVoice";
import * as Cause from "effect/Cause";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { closeCallNotifications } from "../browser/webPush";
import { useOrchestratorSessionContext } from "../orchestrator/OrchestratorSessionProvider";
import { createLiveVoiceSession } from "../orchestrator/liveSession";
import { getClientSettings } from "../hooks/useSettings";
import { readPreferredMicrophone } from "../orchestrator/microphones";
import { resolveVoiceCuePolicy } from "../orchestrator/voiceCues";
import { createGrokCallSession } from "./grokCallSession";
import { playHangUpTone, startRingback } from "./ringtone";
import { useLiveUsageStore } from "../orchestrator/liveUsageStore";
import { appendUsage } from "../orchestrator/usageStore";
import type { VoiceSession, VoiceSessionState } from "../orchestrator/realtimeSession";
import { createScreenWakeLock, findWakeLockRequester } from "../orchestrator/screenWakeLock";
import { fetchRecentThreadHistory } from "../orchestrator/useOrchestratorSession";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import type { PreparedConnection } from "@t3tools/client-runtime/connection/model";
import { awaitPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vmAgentEnvironment } from "../state/vmAgents";
import {
  AGENT_CALL_DROPPED_MESSAGE,
  agentCallSessionEnd,
  agentCallKey,
  hostSettledCallOutcome,
  incomingCallOpening,
  isAgentCallPhaseOpen,
  isRingingOut,
  isTerminalAgentCallStatus,
  nextRingExpiry,
  outgoingCallGreeting,
  ringingCallForDevice,
  sameCallParticipants,
  trackRingingCalls,
  type AgentCallLocation,
  type AgentCallPhase,
  type EnvironmentAgentCalls,
} from "./agentCallLogic";
import { setAgentCallLive } from "./agentCallActivity";
import { useEnvironmentAgentCalls, useEnvironmentAgents } from "./agentCallData";
import {
  callParticipantNotice,
  callRosterInstructions,
  readCallDirectives,
  resolveSpokenNames,
} from "./callDirectives";
import { isPhoneAppWebView, postAgentCallNativeMessage } from "./phoneAppBridge";

/** Who is on the other end, captured when the call starts. */
export interface AgentCallParty {
  readonly vmAgentId: VmAgentId;
  readonly name: string;
  readonly avatarColor: number | null;
  readonly threadId: ThreadId | null;
  /** What the call runs on, from the agent's voice: GPT-Live unless it was given a Grok voice. */
  readonly engine: AgentCallEngine;
}

/** The call this device is on, or just finished. */
export interface ActiveAgentCall {
  readonly environmentId: EnvironmentId;
  readonly agent: AgentCallParty;
  /** Null while an outgoing call is still being placed. */
  readonly callId: AgentCallId | null;
  readonly direction: AgentCallDirection;
  readonly topic: string | null;
  readonly phase: AgentCallPhase;
  /** Epoch ms the conversation started: the host's `answeredAt` once known. */
  readonly startedAt: number | null;
  readonly error: string | null;
  /** Chats on the call besides the agent, oldest first, as its host reports them. */
  readonly participants: ReadonlyArray<AgentCallParticipant>;
  /**
   * Who the call's voice can transfer to or add, fetched once the call is
   * live; null until then (or from a host too old to say).
   */
  readonly roster: ReadonlyArray<AgentCallRosterEntry> | null;
  /** The agent a spoken transfer is moving the call to, while the voice finishes. */
  readonly transferringTo: string | null;
  /**
   * The call a spoken transfer hung up to place this one, so a page showing
   * that call can follow the person here.
   */
  readonly transferredFrom: AgentCallId | null;
  /** Why adding or removing someone just failed; the next change that works clears it. */
  readonly participantError: string | null;
}

export interface AgentCallTranscriptLine {
  readonly role: "user" | "assistant";
  readonly text: string;
}

/**
 * What changes while a call runs — who is speaking, the captions — kept apart
 * from {@link AgentCallApi} so the surfaces that only need to know a call
 * exists (sidebar rows, header buttons, the palette) do not re-render with it.
 */
export interface AgentCallLive {
  readonly sessionState: VoiceSessionState;
  /** The agent's chat is handling something said on the call. */
  readonly working: boolean;
  readonly muted: boolean;
  /** The last few lines said on the call. */
  readonly transcript: ReadonlyArray<AgentCallTranscriptLine>;
}

export interface AgentCallApi {
  readonly activeCall: ActiveAgentCall | null;
  /**
   * The incoming call ringing on this device, if any. Never inside the phone
   * app's WebViews: the native app rings and presents calls there.
   */
  readonly ringing: { readonly environmentId: EnvironmentId; readonly call: AgentCall } | null;
  /** The call screen is folded into the floating pill. */
  readonly minimised: boolean;
  /** Calls the agent. Call from a tap: it opens the microphone and audio. */
  readonly place: (environmentId: EnvironmentId, agent: VmAgent) => void;
  /**
   * Connects this device to an existing call: answers an incoming ring, or
   * joins an outgoing call another surface of this device placed (the phone
   * app's call screen). Call from a tap.
   */
  readonly answer: (environmentId: EnvironmentId, call: AgentCall, agent: VmAgent | null) => void;
  readonly decline: (environmentId: EnvironmentId, callId: AgentCallId) => void;
  /**
   * Hangs up this device's call: ends it on the host once this device has
   * connected, and before that only cancels its ring, so a call another
   * device answered meanwhile carries on.
   */
  readonly hangUp: () => void;
  /**
   * Ends a call on its host wherever it is held: the way out of a call another
   * device holds, or one a closed tab left open. For this device's own open
   * call it is `hangUp`, which only cancels the ring until this device connects.
   */
  readonly end: (environmentId: EnvironmentId, callId: AgentCallId) => void;
  readonly toggleMute: () => void;
  /** Adds a chat from the call's roster to this device's live call. */
  readonly addParticipant: (threadId: ThreadId) => void;
  /** Takes a chat off this device's call. */
  readonly removeParticipant: (threadId: ThreadId) => void;
  /** Moves a running call to this microphone (null: the system default) without dropping it. */
  readonly chooseMicrophone: (deviceId: string | null) => void;
  readonly setMinimised: (minimised: boolean) => void;
  /** Clears a finished call's screen. */
  readonly dismiss: () => void;
}

/**
 * The provider's record of the open call: which one it is, and how this
 * device got it. Until the host gives a transferred call an id, the phone app
 * still follows the one it replaced (`transferredFrom`), so a failure is
 * reported against that.
 */
type HeldCall = ActiveAgentCall & {
  readonly generation: number;
  /** From this device's `place()`; false for a call it answered or joined. */
  readonly placedHere: boolean;
};

/**
 * What finishing a call tells its host: `end` hangs it up, `cancel` ends it
 * only while it still rings, `none` leaves it alone.
 */
type HostRelease = "end" | "cancel" | "none";

/** A hang-up ends a call this device holds; one it never connected only cancels its ring. */
const hangUpRelease = (claimed: boolean): HostRelease => (claimed ? "end" : "cancel");

/**
 * An ending the person did not ask for (a failure, the session closing
 * itself) ends a call this device holds and cancels the ring of one it
 * placed. A failed answer or join leaves the ring for the other devices.
 */
const failureRelease = (claimed: boolean, placedHere: boolean): HostRelease =>
  claimed ? "end" : placedHere ? "cancel" : "none";

const AgentCallContext = createContext<AgentCallApi | null>(null);
const IDLE_CALL: AgentCallLive = {
  sessionState: "idle",
  working: false,
  muted: false,
  transcript: [],
};
const AgentCallLiveContext = createContext<AgentCallLive>(IDLE_CALL);

/** Returns null outside the provider (isolated component tests). */
export function useAgentCallContext(): AgentCallApi | null {
  return useContext(AgentCallContext);
}

/** The running call's live state; idle when there is none. */
export function useAgentCallLive(): AgentCallLive {
  return useContext(AgentCallLiveContext);
}

const MAX_TRANSCRIPT_LINES = 6;
/** How long "Call ended" stays on screen before the call screen closes itself. */
const ENDED_LINGER_MS = 2_000;
/** Opening history is best-effort and must never hold the call up. */
const HISTORY_TIMEOUT_MS = 1_500;
/** How long answering waits for the host's connection, e.g. a phone app just woken by the ring. */
const HOST_CONNECTION_TIMEOUT_MS = 15_000;

const NO_PARTICIPANTS: ReadonlyArray<AgentCallParticipant> = [];

const commandFailureMessage = (cause: Cause.Cause<unknown>, fallback: string) => {
  const squashed = Cause.squash(cause);
  return squashed instanceof Error && squashed.message.trim().length > 0
    ? squashed.message
    : fallback;
};

const partyFor = (agent: VmAgent | null, vmAgentId: VmAgentId): AgentCallParty => ({
  vmAgentId,
  name: agent?.name ?? "Agent",
  avatarColor: agent?.avatarColor ?? null,
  threadId: agent?.threadId ?? null,
  engine: agent === null ? "gpt-live" : agentCallEngineFor(agent),
});

/** A spoken transfer waiting for the voice to finish saying so. */
interface PendingTransfer {
  readonly generation: number;
  /** From the roster; the host's agent record replaces it when loaded. */
  readonly party: AgentCallParty;
}

/**
 * Hosts agent calls for the whole app, beside the orchestrator's session, so a
 * call survives navigation.
 *
 * Watches every connected host's calls so an agent's ring reaches this device
 * wherever the person is in the app, and owns the one GPT-Live session a call
 * runs on. A call and the orchestrator never hold the microphone together:
 * starting a call stops the orchestrator, and the orchestrator refuses to
 * start during one.
 */
export function AgentCallProvider({ children }: { readonly children: ReactNode }) {
  // Held in a ref: the orchestrator's session object changes on every one of
  // its renders, and depending on it would re-render every call surface too.
  const orchestrator = useOrchestratorSessionContext();
  const orchestratorRef = useRef(orchestrator);
  useEffect(() => {
    orchestratorRef.current = orchestrator;
  }, [orchestrator]);
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  // Commands through a ref too, so the actions handed to every call surface
  // keep their identity across renders.
  const placeCall = useAtomCommand(vmAgentEnvironment.placeCall, { reportFailure: false });
  const declineCall = useAtomCommand(vmAgentEnvironment.declineCall, { reportFailure: false });
  const endCall = useAtomCommand(vmAgentEnvironment.endCall, { reportFailure: false });
  const callRoster = useAtomCommand(vmAgentEnvironment.callRoster, { reportFailure: false });
  const addCallParticipant = useAtomCommand(vmAgentEnvironment.addCallParticipant, {
    reportFailure: false,
  });
  const removeCallParticipant = useAtomCommand(vmAgentEnvironment.removeCallParticipant, {
    reportFailure: false,
  });
  const commandsRef = useRef({
    placeCall,
    declineCall,
    endCall,
    callRoster,
    addCallParticipant,
    removeCallParticipant,
  });
  useEffect(() => {
    commandsRef.current = {
      placeCall,
      declineCall,
      endCall,
      callRoster,
      addCallParticipant,
      removeCallParticipant,
    };
  }, [addCallParticipant, callRoster, declineCall, endCall, placeCall, removeCallParticipant]);

  const [callsByEnvironment, setCallsByEnvironment] = useState<
    ReadonlyMap<EnvironmentId, ReadonlyArray<AgentCall>>
  >(() => new Map());
  const [active, setActive] = useState<HeldCall | null>(null);
  const [sessionState, setSessionState] = useState<VoiceSessionState>("idle");
  const [working, setWorking] = useState(false);
  const [muted, setMuted] = useState(false);
  const [minimised, setMinimised] = useState(false);
  const [transcript, setTranscript] = useState<ReadonlyArray<AgentCallTranscriptLine>>([]);
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set());
  const [clock, setClock] = useState(() => Date.now());

  const sessionRef = useRef<VoiceSession | null>(null);
  /** Identifies the call `active` describes; bumps when a call starts or finishes. */
  const generationRef = useRef(0);
  const activeRef = useRef<HeldCall | null>(null);
  const mutedRef = useRef(false);
  /** Whether the host accepted this device's claim on the call (a session exists). */
  const claimedRef = useRef(false);
  /** The open call (agentCallKey) last seen in its host's snapshot. */
  const seenCallRef = useRef<string | null>(null);
  /** Calls seen ringing, to clear their notifications once they stop. */
  const ringingCallsRef = useRef<ReadonlyMap<string, AgentCallLocation>>(new Map());
  const transferRef = useRef<PendingTransfer | null>(null);
  /** Moves the call on once the voice finished announcing a transfer; false when none waits. */
  const completeTransferRef = useRef<(generation: number) => boolean>(() => false);
  /** The open call's host's agents, to call a transfer's agent as its own record. */
  const agentsRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly agents: ReadonlyArray<VmAgent>;
  } | null>(null);
  /** The participants the voice was last told about, and the call they were on. */
  const toldParticipantsRef = useRef<{
    readonly generation: number;
    readonly participants: ReadonlyArray<AgentCallParticipant>;
  } | null>(null);
  // The phone app's bridge is injected before the page loads; it never comes or goes.
  const [inPhoneApp] = useState(isPhoneAppWebView);

  const commitActive = useCallback(
    (next: HeldCall | null | ((current: HeldCall | null) => HeldCall | null)) => {
      const value = typeof next === "function" ? next(activeRef.current) : next;
      activeRef.current = value;
      setActive(value);
    },
    [],
  );

  const updateActive = useCallback(
    (generation: number, patch: Partial<ActiveAgentCall>) => {
      commitActive((current) =>
        current !== null && current.generation === generation ? { ...current, ...patch } : current,
      );
    },
    [commitActive],
  );

  const releaseCall = useCallback((call: ActiveAgentCall, release: "end" | "cancel") => {
    if (call.callId === null) return;
    void commandsRef.current.endCall({
      environmentId: call.environmentId,
      input:
        release === "cancel" ? { callId: call.callId, ifRinging: true } : { callId: call.callId },
    });
  }, []);

  /**
   * Ends this device's side of the call, then tells the host what `release`
   * says: see {@link hangUpRelease} and {@link failureRelease}. Endings the
   * host reported pass `none`.
   */
  const finish = useCallback(
    (
      generation: number,
      outcome: { readonly phase: "ended" | "failed"; readonly error: string | null },
      release: HostRelease,
      /** A transfer: the person is moving on to this agent, not hanging up. */
      options: { readonly transferTo?: VmAgentId } = {},
    ) => {
      const current = activeRef.current;
      if (current === null || current.generation !== generation) return;
      if (!isAgentCallPhaseOpen(current.phase)) return;
      // Anything the closing session still reports belongs to no call.
      generationRef.current += 1;
      const session = sessionRef.current;
      sessionRef.current = null;
      session?.stop();
      setAgentCallLive(false);
      setSessionState("idle");
      setWorking(false);
      setMuted(false);
      mutedRef.current = false;
      commitActive({ ...current, phase: outcome.phase, error: outcome.error });
      // A connected call ending, from either side, sounds like a phone hanging up.
      if (current.phase === "live" && options.transferTo === undefined) {
        const cues = resolveVoiceCuePolicy(getClientSettings());
        if (cues.enabled) playHangUpTone(cues.volume);
      }
      if (
        current.callId === null &&
        current.transferredFrom !== null &&
        outcome.phase === "failed"
      ) {
        // A transfer that failed before the host placed the new call: the
        // phone app's screen stays open on the old call to show why.
        postAgentCallNativeMessage("failed", current.transferredFrom, outcome.error);
      }
      if (current.callId !== null) {
        // A transfer's release says where the call is going, so the phone
        // app's screen waits for the new call instead of closing.
        postAgentCallNativeMessage(
          outcome.phase === "failed" ? "failed" : "released",
          current.callId,
          options.transferTo === undefined
            ? outcome.error
            : agentCallTransferDetail(options.transferTo),
        );
        // A call this device finished never rings here again: a failed or
        // unclaimed answer leaves it ringing on the host for the other
        // devices, and a cancelled ring takes a moment to leave the snapshot.
        const key = agentCallKey(current.environmentId, current.callId);
        setDismissed((dismissed) => new Set(dismissed).add(key));
      }
      if (release !== "none") releaseCall(current, release);
    },
    [commitActive, releaseCall],
  );

  /**
   * Shows why adding or removing someone failed, and tells the voice
   * silently: so it can answer truthfully if asked, or, with `correct`, so
   * it tells the person now (it said it added someone nobody could find).
   */
  const reportParticipantError = useCallback(
    (generation: number, error: string, options: { readonly correct?: boolean } = {}) => {
      updateActive(generation, { participantError: error });
      if (activeRef.current?.generation === generation) {
        sessionRef.current?.instruct?.(
          options.correct
            ? `${error} Tell the person now, and ask who they meant.`
            : `${error} Tell the person if they ask.`,
        );
      }
    },
    [updateActive],
  );

  /** Adds a chat to the call or takes one off, on the call's host. */
  const changeParticipants = useCallback(
    async (
      call: HeldCall,
      change: "add" | "remove",
      target: { readonly threadId: ThreadId; readonly name: string },
    ) => {
      if (call.callId === null) return;
      const request = {
        environmentId: call.environmentId,
        input: { callId: call.callId, threadId: target.threadId },
      };
      const result =
        change === "add"
          ? await commandsRef.current.addCallParticipant(request)
          : await commandsRef.current.removeCallParticipant(request);
      // The participants themselves arrive with the host's snapshot.
      if (result._tag === "Success") {
        updateActive(call.generation, { participantError: null });
        return;
      }
      reportParticipantError(
        call.generation,
        commandFailureMessage(
          result.cause,
          change === "add"
            ? `${target.name} couldn't be added to the call.`
            : `${target.name} couldn't be taken off the call.`,
        ),
      );
    },
    [reportParticipantError, updateActive],
  );

  /**
   * Acts on what the voice just said it is doing: transferring the person
   * to another agent, or adding or removing people (each phrase, and each
   * name in "Adding Gregg and Nova to the call."). Names resolve against the
   * roster the voice was given, so a name it was never offered (or a reply
   * that only sounds like the phrase) transfers nobody; an add or remove
   * whose name fits nobody is reported, so the voice can put it right.
   */
  const actOnDirective = useCallback(
    (generation: number, session: VoiceSession, text: string) => {
      const directives = readCallDirectives(text);
      const call = activeRef.current;
      if (directives.length === 0 || call === null || call.generation !== generation) return;
      if (call.phase !== "live" || call.transferringTo !== null) return;
      const roster = call.roster ?? [];
      const [first] = directives;
      if (first?.kind === "transfer") {
        const { found } = resolveSpokenNames(first.name, roster, { agentsOnly: true });
        const [target] = found;
        if (found.length !== 1 || target === undefined || target.vmAgentId === null) return;
        if (target.vmAgentId === call.agent.vmAgentId) return;
        transferRef.current = {
          generation,
          party: {
            vmAgentId: target.vmAgentId,
            name: target.name,
            avatarColor: null,
            threadId: target.threadId,
            // The host's record, read when the transfer goes through, says if it is Grok.
            engine: "gpt-live",
          },
        };
        updateActive(generation, { transferringTo: target.name });
        // The call moves on once these last words are spoken (completeTransfer).
        session.endAfterReply();
        return;
      }
      const onCall = call.participants.map((participant) => ({
        name: participant.title,
        threadId: participant.threadId,
        vmAgentId: participant.vmAgentId,
      }));
      const missing: string[] = [];
      const changes: Array<Promise<void>> = [];
      for (const directive of directives) {
        if (directive.kind === "add") {
          const resolved = resolveSpokenNames(directive.name, roster);
          missing.push(
            ...resolved.missing.map((name) => `No one called ${name} is on the call list.`),
          );
          for (const target of resolved.found) {
            const present =
              target.threadId === call.agent.threadId ||
              onCall.some((participant) => participant.threadId === target.threadId);
            if (!present) changes.push(changeParticipants(call, "add", target));
          }
        } else if (directive.kind === "remove") {
          const resolved = resolveSpokenNames(directive.name, onCall);
          missing.push(...resolved.missing.map((name) => `${name} isn't on this call.`));
          for (const target of resolved.found)
            changes.push(changeParticipants(call, "remove", target));
        }
      }
      // Said once the others went through, so a success can't clear it from the screen.
      if (missing.length > 0)
        void Promise.all(changes).then(() =>
          reportParticipantError(generation, missing.join(" "), { correct: true }),
        );
    },
    [changeParticipants, reportParticipantError, updateActive],
  );

  /**
   * Starts a GPT-Live session for the call. Callbacks only act while their
   * session is the current one, so a session that was hung up cannot touch
   * the call afterwards.
   */
  const startSession = useCallback(
    (
      call: HeldCall,
      prepared: PreparedConnection,
      startBody: () => Promise<Readonly<Record<string, unknown>>>,
    ) => {
      const { generation } = call;
      let announced = false;
      /** The model the Grok session opened with, to price its usage. */
      let grokModel: string | null = null;
      const grok = call.agent.engine === "grok";
      const markClaimed = () => {
        if (sessionRef.current !== session || claimedRef.current) return;
        claimedRef.current = true;
        const callId = activeRef.current?.callId;
        if (callId) postAgentCallNativeMessage("connected", callId);
      };
      const session: VoiceSession = (grok ? createGrokCallSession : createLiveVoiceSession)(
        {
          httpBaseUrl: prepared.httpBaseUrl,
          // Sent exactly as the orchestrator's GPT-Live requests are: bearer
          // for remote hosts, the session cookie otherwise.
          bearerToken: prepared.httpAuthorization?.token ?? null,
          // Read by the Realtime transport only; a call's persona and
          // language are set on the host.
          authority: "read-only",
          confirmDestructiveActions: true,
          language: "en",
          microphoneId: readPreferredMicrophone(),
          // Read as the call starts: a change lands on the next call.
          phoneLine: getClientSettings().callPhoneLine,
          cuePolicy: () => resolveVoiceCuePolicy(getClientSettings()),
          live: {
            sessionPath: grok ? AGENT_CALL_GROK_SESSION_PATH : AGENT_CALL_SESSION_PATH,
            releasePath: AGENT_CALL_SESSION_RELEASE_PATH,
            delegationPath: AGENT_CALL_DELEGATION_PATH,
            startBody,
            // The host ends a call whose device stops renewing it.
            heartbeat: {
              path: AGENT_CALL_SESSION_HEARTBEAT_PATH,
              everySeconds: AGENT_CALL_HEARTBEAT_SECONDS,
            },
          },
        },
        {
          onToolCall: async () => undefined,
          onStateChange: (next) => {
            if (sessionRef.current !== session) return;
            setSessionState(next);
            if (next === "listening" || next === "speaking") {
              commitActive((current) =>
                current === null || current.generation !== generation || current.phase === "live"
                  ? current
                  : { ...current, phase: "live", startedAt: current.startedAt ?? Date.now() },
              );
              // Whoever placed the call, the agent speaks first: why it rang,
              // or a hello when the person called it.
              if (!announced) {
                announced = true;
                session.announce(
                  call.direction === "incoming"
                    ? incomingCallOpening({ agentName: call.agent.name, topic: call.topic })
                    : outgoingCallGreeting({ agentName: call.agent.name }),
                );
              }
              return;
            }
            if (next !== "idle" && next !== "error") return;
            // The session ended itself: a failed start, the host or GPT-Live
            // closing it, a lost microphone. Settled after this tick, because
            // a failure's message is reported right after the state change.
            // One that ended before it was live never connected, so it fails
            // with whatever reason it reported.
            queueMicrotask(() => {
              if (sessionRef.current !== session) return;
              // The voice finished "Transferring you to …": the call moves on.
              if (completeTransferRef.current(generation)) return;
              finish(
                generation,
                agentCallSessionEnd({
                  sessionFailed: session.state === "error",
                  claimed: claimedRef.current,
                  connected: activeRef.current?.phase === "live",
                  error: activeRef.current?.error ?? null,
                }),
                failureRelease(claimedRef.current, call.placedHere),
              );
            });
          },
          onError: (message) => {
            if (sessionRef.current === session) updateActive(generation, { error: message });
          },
          onWorkingChange: (next) => {
            if (sessionRef.current === session) setWorking(next);
          },
          onTranscript: (entry) => {
            if (sessionRef.current !== session) return;
            setTranscript((current) => [...current, entry].slice(-MAX_TRANSCRIPT_LINES));
            if (entry.role === "assistant") actOnDirective(generation, session, entry.text);
          },
          onLiveUsage: (usage) => {
            // Bills the same OpenAI key as the orchestrator, so it lands in the
            // same usage ledger. A report also means the host accepted the claim.
            useLiveUsageStore.getState().record(usage);
            markClaimed();
          },
          // Grok: the session opens only once the host accepted the claim.
          onSessionReady: (ready) => {
            grokModel = ready.model;
            markClaimed();
          },
          // Grok bills the xAI key the orchestrator's Grok voice uses: same ledger.
          onUsage: (usage) => {
            if (grokModel !== null) appendUsage({ model: grokModel, usage, now: new Date() });
          },
          // No reconnect: the dropped session's release has already hung
          // the call up on the host, which never re-admits an answered call.
          onConnectionLost: () => {
            if (sessionRef.current !== session) return;
            finish(
              generation,
              { phase: "failed", error: AGENT_CALL_DROPPED_MESSAGE },
              failureRelease(claimedRef.current, call.placedHere),
            );
          },
          // The host refused a heartbeat or delegation: it already ended the
          // call (another device hung up, the lease ran out) or restarted.
          onSessionGone: () => {
            if (sessionRef.current !== session) return;
            finish(generation, { phase: "failed", error: AGENT_CALL_DROPPED_MESSAGE }, "none");
          },
          // The host refused the claim ("Answered on <device>") or had already
          // settled the call: it is not this device's to end.
          onStartRefused: (detail) => {
            if (sessionRef.current !== session) return;
            finish(generation, { phase: "failed", error: detail }, "none");
          },
        },
      );
      sessionRef.current = session;
      if (mutedRef.current) session.setMuted?.(true);
      void session.start();
    },
    [actOnDirective, commitActive, finish, updateActive],
  );

  /** Starts the call's voice once its host's connection is ready. */
  const openSession = useCallback(
    (call: HeldCall, startBody: () => Promise<Readonly<Record<string, unknown>>>) => {
      const { generation } = call;
      void awaitPreparedConnection(call.environmentId, HOST_CONNECTION_TIMEOUT_MS).then(
        (prepared) => {
          const current = activeRef.current;
          // Hung up, or replaced by another call, while the host connected.
          if (current?.generation !== generation || !isAgentCallPhaseOpen(current.phase)) return;
          if (prepared === null) {
            finish(
              generation,
              { phase: "failed", error: "This host is not connected." },
              failureRelease(false, call.placedHere),
            );
            return;
          }
          startSession(call, prepared, startBody);
        },
      );
    },
    [finish, startSession],
  );

  const readHistory = useCallback(
    async (environmentId: EnvironmentId, threadId: ThreadId | null) => {
      if (threadId === null) return [];
      const prepared = await awaitPreparedConnection(environmentId, HISTORY_TIMEOUT_MS);
      if (prepared === null) return [];
      return fetchRecentThreadHistory(
        {
          httpBaseUrl: prepared.httpBaseUrl,
          bearerToken: prepared.httpAuthorization?.token ?? null,
        },
        threadId,
        HISTORY_TIMEOUT_MS,
      );
    },
    [],
  );

  /** Clears the way for a new call: the orchestrator's mic, any earlier call. */
  const beginCall = useCallback(
    (
      call: Pick<
        HeldCall,
        | "environmentId"
        | "agent"
        | "callId"
        | "direction"
        | "topic"
        | "placedHere"
        | "transferredFrom"
      >,
      phase: AgentCallPhase,
    ) => {
      const voice = orchestratorRef.current;
      if (voice !== null && voice.state !== "idle") voice.stop();
      const previous = activeRef.current;
      if (previous !== null && isAgentCallPhaseOpen(previous.phase)) {
        finish(
          previous.generation,
          { phase: "ended", error: null },
          hangUpRelease(claimedRef.current),
        );
      }
      generationRef.current += 1;
      claimedRef.current = false;
      transferRef.current = null;
      mutedRef.current = false;
      setMuted(false);
      setWorking(false);
      setTranscript([]);
      setMinimised(false);
      setSessionState("connecting");
      setAgentCallLive(true);
      const next: HeldCall = {
        ...call,
        phase,
        startedAt: null,
        error: null,
        participants: NO_PARTICIPANTS,
        roster: null,
        transferringTo: null,
        participantError: null,
        generation: generationRef.current,
      };
      commitActive(next);
      return next;
    },
    [commitActive, finish],
  );

  const placeParty = useCallback(
    (
      environmentId: EnvironmentId,
      party: AgentCallParty,
      transferredFrom: AgentCallId | null = null,
    ) => {
      const current = activeRef.current;
      if (current !== null && isAgentCallPhaseOpen(current.phase)) {
        // Already on a call: bring it back rather than start a second one.
        setMinimised(false);
        return;
      }
      const call = beginCall(
        {
          environmentId,
          agent: party,
          callId: null,
          direction: "outgoing",
          topic: null,
          placedHere: true,
          transferredFrom,
        },
        "placing",
      );
      // Asked for as the session starts, so placing the call and reading the
      // chat's recent turns overlap the microphone opening.
      openSession(call, async () => {
        const history = readHistory(environmentId, party.threadId);
        const result = await commandsRef.current.placeCall({
          environmentId,
          input: { vmAgentId: party.vmAgentId },
        });
        if (result._tag !== "Success") {
          const error = commandFailureMessage(result.cause, "The call could not be placed.");
          updateActive(call.generation, { error });
          // The phone app's screen is still on the call this replaced, and
          // closes on its own soon after that call ended: say why now, not
          // once the microphone and network have finished opening.
          if (transferredFrom !== null && call.generation === generationRef.current)
            postAgentCallNativeMessage("failed", transferredFrom, error);
          throw new Error(error);
        }
        const callId = result.value.callId;
        if (call.generation !== generationRef.current) {
          // Hung up while the host was still placing it: cancel the ring.
          void commandsRef.current.endCall({ environmentId, input: { callId, ifRinging: true } });
          throw new Error("The call was cancelled.");
        }
        updateActive(call.generation, { callId, phase: "connecting" });
        postAgentCallNativeMessage("held", callId);
        return { callId, history: await history };
      });
    },
    [beginCall, openSession, readHistory, updateActive],
  );

  const place = useCallback(
    (environmentId: EnvironmentId, agent: VmAgent) =>
      placeParty(environmentId, partyFor(agent, agent.vmAgentId)),
    [placeParty],
  );

  /**
   * Moves a call whose voice just said "Transferring you to <Name>." to that
   * agent: hangs this one up quietly (no tone, no "Call ended" in between)
   * and calls the agent from this device, as if the person had tapped Call.
   */
  const completeTransfer = useCallback(
    (generation: number): boolean => {
      const pending = transferRef.current;
      if (pending === null || pending.generation !== generation) return false;
      transferRef.current = null;
      const current = activeRef.current;
      if (current === null || current.generation !== generation) return false;
      if (!isAgentCallPhaseOpen(current.phase)) return false;
      const wasMuted = mutedRef.current;
      finish(generation, { phase: "ended", error: null }, hangUpRelease(claimedRef.current), {
        transferTo: pending.party.vmAgentId,
      });
      const registry = agentsRef.current;
      const agent =
        registry?.environmentId === current.environmentId
          ? registry.agents.find((candidate) => candidate.vmAgentId === pending.party.vmAgentId)
          : undefined;
      placeParty(
        current.environmentId,
        agent === undefined ? pending.party : partyFor(agent, agent.vmAgentId),
        current.callId,
      );
      // The new voice opens asynchronously and reads this before starting its microphone.
      mutedRef.current = wasMuted;
      setMuted(wasMuted);
      return true;
    },
    [finish, placeParty],
  );
  useEffect(() => {
    completeTransferRef.current = completeTransfer;
  }, [completeTransfer]);

  // A call the person placed rings out until the agent picks up.
  const ringingOut = isRingingOut(active);
  useEffect(() => {
    if (!ringingOut || !resolveVoiceCuePolicy(getClientSettings()).enabled) return;
    const ringback = startRingback({
      volume: () => resolveVoiceCuePolicy(getClientSettings()).volume,
    });
    return () => ringback.stop();
  }, [ringingOut]);

  const answer = useCallback(
    (environmentId: EnvironmentId, call: AgentCall, agent: VmAgent | null) => {
      const current = activeRef.current;
      if (
        current !== null &&
        isAgentCallPhaseOpen(current.phase) &&
        current.environmentId === environmentId &&
        current.callId === call.callId
      ) {
        setMinimised(false);
        return;
      }
      const next = beginCall(
        {
          environmentId,
          agent: partyFor(agent, call.vmAgentId),
          callId: call.callId,
          direction: call.direction,
          topic: call.topic,
          placedHere: false,
          transferredFrom: null,
        },
        "connecting",
      );
      // Said before the host confirms, so the phone app never mistakes this
      // answer for one taken on another device; a refused claim says "failed".
      postAgentCallNativeMessage("held", call.callId);
      openSession(next, async () => ({
        callId: call.callId,
        history: await readHistory(environmentId, agent?.threadId ?? null),
      }));
    },
    [beginCall, openSession, readHistory],
  );

  const decline = useCallback((environmentId: EnvironmentId, callId: AgentCallId) => {
    const key = agentCallKey(environmentId, callId);
    // Closed here at once; the host's snapshot follows.
    setDismissed((current) => new Set(current).add(key));
    void commandsRef.current.declineCall({ environmentId, input: { callId } });
  }, []);

  const hangUp = useCallback(() => {
    const current = activeRef.current;
    if (current === null) return;
    finish(current.generation, { phase: "ended", error: null }, hangUpRelease(claimedRef.current));
  }, [finish]);

  const end = useCallback(
    (environmentId: EnvironmentId, callId: AgentCallId) => {
      const current = activeRef.current;
      if (
        current !== null &&
        isAgentCallPhaseOpen(current.phase) &&
        current.environmentId === environmentId &&
        current.callId === callId
      ) {
        finish(
          current.generation,
          { phase: "ended", error: null },
          hangUpRelease(claimedRef.current),
        );
        return;
      }
      void commandsRef.current.endCall({ environmentId, input: { callId } });
    },
    [finish],
  );

  const toggleMute = useCallback(() => {
    const next = !mutedRef.current;
    mutedRef.current = next;
    setMuted(next);
    sessionRef.current?.setMuted?.(next);
  }, []);

  const addParticipant = useCallback(
    (threadId: ThreadId) => {
      const call = activeRef.current;
      if (call === null || call.phase !== "live" || call.transferringTo !== null) return;
      const name = call.roster?.find((entry) => entry.threadId === threadId)?.name ?? "That chat";
      void changeParticipants(call, "add", { threadId, name });
    },
    [changeParticipants],
  );

  const removeParticipant = useCallback(
    (threadId: ThreadId) => {
      const call = activeRef.current;
      if (call === null || !isAgentCallPhaseOpen(call.phase)) return;
      const name =
        call.participants.find((participant) => participant.threadId === threadId)?.title ??
        "That chat";
      void changeParticipants(call, "remove", { threadId, name });
    },
    [changeParticipants],
  );

  const chooseMicrophone = useCallback((deviceId: string | null) => {
    sessionRef.current?.setMicrophone?.(deviceId);
  }, []);

  const dismiss = useCallback(() => {
    const current = activeRef.current;
    if (current !== null && !isAgentCallPhaseOpen(current.phase)) commitActive(null);
  }, [commitActive]);

  const reportCalls = useCallback(
    (environmentId: EnvironmentId, calls: ReadonlyArray<AgentCall> | null) => {
      setCallsByEnvironment((current) => {
        if ((current.get(environmentId) ?? null) === calls) return current;
        const next = new Map(current);
        if (calls === null) next.delete(environmentId);
        else next.set(environmentId, calls);
        return next;
      });
      setClock(Date.now());
    },
    [],
  );

  // The host is the authority on the call: its answer time starts the timer,
  // and a call it has settled (another device hung up, the lease ran out, it
  // failed) or forgotten (the host restarted) ends here too.
  useEffect(() => {
    if (active === null || active.callId === null || !isAgentCallPhaseOpen(active.phase)) return;
    // No snapshot from this host right now (disconnected): nothing to judge.
    const calls = callsByEnvironment.get(active.environmentId);
    if (calls === undefined) return;
    const key = agentCallKey(active.environmentId, active.callId);
    const record = calls.find((candidate) => candidate.callId === active.callId);
    if (!record) {
      // An open call never leaves its host's snapshot, so one that vanished
      // after it was seen was forgotten by a restart. One not seen yet is a
      // snapshot that has not caught up with placeCall.
      if (seenCallRef.current === key) {
        finish(active.generation, { phase: "failed", error: AGENT_CALL_DROPPED_MESSAGE }, "none");
      }
      return;
    }
    seenCallRef.current = key;
    if (isTerminalAgentCallStatus(record.status)) {
      // Ended on the host (another device's End, the agent deleted, the time
      // cap): the person is not moving on, so a transfer still being
      // announced is dropped. This device's own transfer ends its call only
      // once its voice has gone quiet (completeTransfer), never through here.
      if (transferRef.current?.generation === active.generation) transferRef.current = null;
      finish(active.generation, hostSettledCallOutcome(record.status, active.error), "none");
      return;
    }
    const patch: { startedAt?: number; participants?: ReadonlyArray<AgentCallParticipant> } = {};
    if (record.answeredAt !== null) {
      const startedAt = Date.parse(record.answeredAt);
      if (Number.isFinite(startedAt) && startedAt !== active.startedAt) patch.startedAt = startedAt;
    }
    const participants = record.participants ?? NO_PARTICIPANTS;
    if (!sameCallParticipants(participants, active.participants)) patch.participants = participants;
    if (Object.keys(patch).length > 0) updateActive(active.generation, patch);
  }, [active, callsByEnvironment, finish, updateActive]);

  // Once the call is live, ask its host once who the voice can transfer to
  // or add, and teach the voice the phrases this device acts on. A host too
  // old to say leaves the roster empty and the voice untaught.
  const rosterAskedRef = useRef<number | null>(null);
  useEffect(() => {
    if (active === null || active.phase !== "live" || active.callId === null) return;
    if (rosterAskedRef.current === active.generation) return;
    rosterAskedRef.current = active.generation;
    const { generation, environmentId, callId } = active;
    void commandsRef.current.callRoster({ environmentId, input: { callId } }).then((result) => {
      const roster = result._tag === "Success" ? result.value.entries : [];
      updateActive(generation, { roster });
      const lines = callRosterInstructions(roster);
      const current = activeRef.current;
      if (lines.length === 0 || current?.generation !== generation || current.phase !== "live")
        return;
      // One append each: a long roster stays within an append's bound.
      for (const line of lines) sessionRef.current?.instruct?.(line);
    });
  }, [active, updateActive]);

  // The voice hears who joined or left the call, once each: diffed by chat
  // against what it was last told, so a repeated snapshot says nothing.
  useEffect(() => {
    if (active === null || active.phase !== "live") return;
    const told = toldParticipantsRef.current;
    const known = told?.generation === active.generation ? told.participants : NO_PARTICIPANTS;
    if (known === active.participants) return;
    toldParticipantsRef.current = {
      generation: active.generation,
      participants: active.participants,
    };
    const notice = callParticipantNotice(known, active.participants);
    if (notice !== null) sessionRef.current?.instruct?.(notice);
  }, [active]);

  // "Call ended" says what happened, then gets out of the way. Failures stay
  // until dismissed: their reason has to be readable.
  useEffect(() => {
    if (active?.phase !== "ended") return;
    const generation = active.generation;
    const timer = setTimeout(() => {
      commitActive((current) =>
        current !== null && current.generation === generation && current.phase === "ended"
          ? null
          : current,
      );
    }, ENDED_LINGER_MS);
    return () => clearTimeout(timer);
  }, [active, commitActive]);

  // A phone that locks mid-call suspends the page and drops the call; holding
  // the screen awake is the only web remedy while a call is open.
  const callOpen = active !== null && isAgentCallPhaseOpen(active.phase);
  useEffect(() => {
    if (!callOpen) return;
    const lock = createScreenWakeLock(findWakeLockRequester());
    void lock.acquire();
    const onVisibility = () => {
      if (!document.hidden) void lock.acquire();
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      lock.release();
    };
  }, [callOpen]);

  // The microphone never outlives the app shell.
  useEffect(
    () => () => {
      generationRef.current += 1;
      sessionRef.current?.stop();
      sessionRef.current = null;
      setAgentCallLive(false);
    },
    [],
  );

  const environmentCalls = useMemo<ReadonlyArray<EnvironmentAgentCalls>>(
    () =>
      [...callsByEnvironment.entries()].map(([environmentId, calls]) => ({ environmentId, calls })),
    [callsByEnvironment],
  );
  const activeCallKey =
    active !== null && active.callId !== null && isAgentCallPhaseOpen(active.phase)
      ? agentCallKey(active.environmentId, active.callId)
      : null;
  const ringing = useMemo(
    () =>
      inPhoneApp
        ? null
        : ringingCallForDevice({
            environments: environmentCalls,
            activeCallKey,
            dismissed,
            now: clock,
          }),
    [activeCallKey, clock, dismissed, environmentCalls, inPhoneApp],
  );

  // A call that stops ringing (answered anywhere, declined, missed) takes its
  // "is calling" notification with it, without waiting for the host's push.
  useEffect(() => {
    const { ringing: next, stopped } = trackRingingCalls(ringingCallsRef.current, environmentCalls);
    ringingCallsRef.current = next;
    for (const call of stopped) closeCallNotifications(call.callId);
  }, [environmentCalls]);

  // Re-checked when a ring runs out, in case the host's "missed" is late.
  useEffect(() => {
    const expiry = nextRingExpiry(environmentCalls, clock);
    if (expiry === null) return;
    const timer = setTimeout(() => setClock(Date.now()), Math.max(0, expiry - clock) + 50);
    return () => clearTimeout(timer);
  }, [clock, environmentCalls]);

  const observedEnvironmentIds = useMemo(() => {
    const ids = environments.map((environment) => environment.environmentId);
    if (primaryEnvironmentId !== null && !ids.includes(primaryEnvironmentId)) {
      ids.push(primaryEnvironmentId);
    }
    return ids;
  }, [environments, primaryEnvironmentId]);

  const reportAgents = useCallback(
    (environmentId: EnvironmentId, agents: ReadonlyArray<VmAgent> | null) => {
      agentsRef.current = agents === null ? null : { environmentId, agents };
    },
    [],
  );

  const activeCall = useMemo<ActiveAgentCall | null>(() => {
    if (active === null) return null;
    const { generation: _generation, placedHere: _placedHere, ...call } = active;
    return call;
  }, [active]);

  const value = useMemo<AgentCallApi>(
    () => ({
      activeCall,
      ringing,
      minimised,
      place,
      answer,
      decline,
      hangUp,
      end,
      toggleMute,
      addParticipant,
      removeParticipant,
      chooseMicrophone,
      setMinimised,
      dismiss,
    }),
    [
      activeCall,
      addParticipant,
      answer,
      decline,
      dismiss,
      end,
      hangUp,
      minimised,
      place,
      removeParticipant,
      ringing,
      toggleMute,
      chooseMicrophone,
    ],
  );
  const live = useMemo<AgentCallLive>(
    () => ({ sessionState, working, muted, transcript }),
    [muted, sessionState, transcript, working],
  );

  return (
    <AgentCallContext.Provider value={value}>
      <AgentCallLiveContext.Provider value={live}>
        {observedEnvironmentIds.map((environmentId) => (
          <AgentCallsObserver
            key={environmentId}
            environmentId={environmentId}
            onCalls={reportCalls}
          />
        ))}
        {callOpen ? (
          <AgentsObserver
            key={active.environmentId}
            environmentId={active.environmentId}
            onAgents={reportAgents}
          />
        ) : null}
        {children}
      </AgentCallLiveContext.Provider>
    </AgentCallContext.Provider>
  );
}

/** Keeps the open call's host's agents at hand, for a transfer, without re-rendering the provider. */
function AgentsObserver(props: {
  readonly environmentId: EnvironmentId;
  readonly onAgents: (environmentId: EnvironmentId, agents: ReadonlyArray<VmAgent> | null) => void;
}) {
  const { environmentId, onAgents } = props;
  const agents = useEnvironmentAgents(environmentId);
  useEffect(() => {
    onAgents(environmentId, agents);
  }, [agents, environmentId, onAgents]);
  return null;
}

/** Keeps one host's call snapshot flowing into the provider. */
function AgentCallsObserver(props: {
  readonly environmentId: EnvironmentId;
  readonly onCalls: (environmentId: EnvironmentId, calls: ReadonlyArray<AgentCall> | null) => void;
}) {
  const { environmentId, onCalls } = props;
  const calls = useEnvironmentAgentCalls(environmentId);
  useEffect(() => {
    onCalls(environmentId, calls);
  }, [calls, environmentId, onCalls]);
  useEffect(() => () => onCalls(environmentId, null), [environmentId, onCalls]);
  return null;
}
