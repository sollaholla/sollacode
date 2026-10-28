import {
  AGENT_CALL_DELEGATION_PATH,
  AGENT_CALL_HEARTBEAT_SECONDS,
  AGENT_CALL_SESSION_HEARTBEAT_PATH,
  AGENT_CALL_SESSION_PATH,
  AGENT_CALL_SESSION_RELEASE_PATH,
  type AgentCall,
  type AgentCallDirection,
  type AgentCallId,
  type EnvironmentId,
  type ThreadId,
  type VmAgent,
  type VmAgentId,
} from "@t3tools/contracts";
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
import { readPreferredMicrophone } from "../orchestrator/microphones";
import { useLiveUsageStore } from "../orchestrator/liveUsageStore";
import type { VoiceSession, VoiceSessionState } from "../orchestrator/realtimeSession";
import { createScreenWakeLock, findWakeLockRequester } from "../orchestrator/screenWakeLock";
import { fetchRecentThreadHistory } from "../orchestrator/useOrchestratorSession";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { readPreparedConnection } from "../state/session";
import { useAtomCommand } from "../state/use-atom-command";
import { vmAgentEnvironment } from "../state/vmAgents";
import {
  AGENT_CALL_DROPPED_MESSAGE,
  agentCallKey,
  hostSettledCallOutcome,
  incomingCallOpening,
  isAgentCallPhaseOpen,
  isTerminalAgentCallStatus,
  nextRingExpiry,
  ringingCallForDevice,
  trackRingingCalls,
  type AgentCallLocation,
  type AgentCallPhase,
  type EnvironmentAgentCalls,
} from "./agentCallLogic";
import { setAgentCallLive } from "./agentCallActivity";
import { useEnvironmentAgentCalls } from "./agentCallData";
import { isPhoneAppWebView, postAgentCallNativeMessage } from "./phoneAppBridge";

/** Who is on the other end, captured when the call starts. */
export interface AgentCallParty {
  readonly vmAgentId: VmAgentId;
  readonly name: string;
  readonly avatarColor: number | null;
  readonly threadId: ThreadId | null;
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
  /** Moves a running call to this microphone (null: the system default) without dropping it. */
  readonly chooseMicrophone: (deviceId: string | null) => void;
  readonly setMinimised: (minimised: boolean) => void;
  /** Clears a finished call's screen. */
  readonly dismiss: () => void;
}

/** The provider's record of the open call: which one it is, and how this device got it. */
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
});

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
  const commandsRef = useRef({ placeCall, declineCall, endCall });
  useEffect(() => {
    commandsRef.current = { placeCall, declineCall, endCall };
  }, [declineCall, endCall, placeCall]);

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
      if (current.callId !== null) {
        postAgentCallNativeMessage(
          outcome.phase === "failed" ? "failed" : "released",
          current.callId,
          outcome.error,
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
   * Starts a GPT-Live session for the call. Callbacks only act while their
   * session is the current one, so a session that was hung up cannot touch
   * the call afterwards.
   */
  const openSession = useCallback(
    (call: HeldCall, startBody: () => Promise<Readonly<Record<string, unknown>>>) => {
      const { generation } = call;
      const prepared = readPreparedConnection(call.environmentId);
      if (prepared === null) {
        finish(
          generation,
          { phase: "failed", error: "This host is not connected." },
          failureRelease(false, call.placedHere),
        );
        return;
      }
      let announced = false;
      const session: VoiceSession = createLiveVoiceSession(
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
          live: {
            sessionPath: AGENT_CALL_SESSION_PATH,
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
              // The agent rang, so the agent speaks first.
              if (!announced && call.direction === "incoming") {
                announced = true;
                session.announce(
                  incomingCallOpening({ agentName: call.agent.name, topic: call.topic }),
                );
              }
              return;
            }
            if (next !== "idle" && next !== "error") return;
            // The session ended itself: a failed start, the host or GPT-Live
            // closing it, a lost microphone. Settled after this tick, because
            // a failure's message is reported right after the state change.
            // One that ended before the host accepted the claim never
            // connected, so it fails with whatever reason it reported.
            queueMicrotask(() => {
              if (sessionRef.current !== session) return;
              const failed = session.state === "error" || !claimedRef.current;
              finish(
                generation,
                failed
                  ? { phase: "failed", error: activeRef.current?.error ?? null }
                  : { phase: "ended", error: null },
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
          },
          onLiveUsage: (usage) => {
            // Bills the same OpenAI key as the orchestrator, so it lands in the
            // same usage ledger. A report also means the host accepted the claim.
            useLiveUsageStore.getState().record(usage);
            if (sessionRef.current !== session || claimedRef.current) return;
            claimedRef.current = true;
            const callId = activeRef.current?.callId;
            if (callId) postAgentCallNativeMessage("connected", callId);
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
    [commitActive, finish, updateActive],
  );

  const readHistory = useCallback(
    async (environmentId: EnvironmentId, threadId: ThreadId | null) => {
      const prepared = readPreparedConnection(environmentId);
      if (threadId === null || prepared === null) return [];
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
      call: Omit<HeldCall, "phase" | "startedAt" | "error" | "generation">,
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
      mutedRef.current = false;
      setMuted(false);
      setWorking(false);
      setTranscript([]);
      setMinimised(false);
      setSessionState("connecting");
      setAgentCallLive(true);
      const next = {
        ...call,
        phase,
        startedAt: null,
        error: null,
        generation: generationRef.current,
      };
      commitActive(next);
      return next;
    },
    [commitActive, finish],
  );

  const place = useCallback(
    (environmentId: EnvironmentId, agent: VmAgent) => {
      const current = activeRef.current;
      if (current !== null && isAgentCallPhaseOpen(current.phase)) {
        // Already on a call: bring it back rather than start a second one.
        setMinimised(false);
        return;
      }
      const call = beginCall(
        {
          environmentId,
          agent: partyFor(agent, agent.vmAgentId),
          callId: null,
          direction: "outgoing",
          topic: null,
          placedHere: true,
        },
        "placing",
      );
      // Asked for as the session starts, so placing the call and reading the
      // chat's recent turns overlap the microphone opening.
      openSession(call, async () => {
        const history = readHistory(environmentId, agent.threadId);
        const result = await commandsRef.current.placeCall({
          environmentId,
          input: { vmAgentId: agent.vmAgentId },
        });
        if (result._tag !== "Success") {
          const error = commandFailureMessage(result.cause, "The call could not be placed.");
          updateActive(call.generation, { error });
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
      finish(active.generation, hostSettledCallOutcome(record.status, active.error), "none");
      return;
    }
    if (record.answeredAt !== null) {
      const startedAt = Date.parse(record.answeredAt);
      if (Number.isFinite(startedAt) && startedAt !== active.startedAt) {
        updateActive(active.generation, { startedAt });
      }
    }
  }, [active, callsByEnvironment, finish, updateActive]);

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
      chooseMicrophone,
      setMinimised,
      dismiss,
    }),
    [
      activeCall,
      answer,
      decline,
      dismiss,
      end,
      hangUp,
      minimised,
      place,
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
        {children}
      </AgentCallLiveContext.Provider>
    </AgentCallContext.Provider>
  );
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
