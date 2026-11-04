import { useAtomValue } from "@effect/atom-react";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  type AgentCall,
  AgentCallId,
  type AgentCallStatus,
  EnvironmentId,
  ORCHESTRATOR_THREAD_TITLE,
} from "@t3tools/contracts";
import { isOrchestratorCaller } from "@t3tools/shared/orchestratorCaller";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Haptics from "expo-haptics";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";
import { EnvironmentWebScreen } from "../orchestrator/OrchestratorRouteScreen";
import {
  AGENT_CALL_ENDED_LINGER_MS,
  AGENT_CALL_HOLD_GRACE_MS,
  agentCallKey,
  agentCallPage,
  agentCallParticipantsLine,
  applyAgentCallNativeMessage,
  callsPlacedHere,
  callsToEndOnLeave,
  initialAgentCallScreenHold,
  isCallHeldHere,
  parseAgentCallNativeMessage,
  previousFollowedStatus,
  resolveAgentCallScreenAction,
  ringRemainingMs,
  startRingingHaptics,
} from "./agentCallModel";
import { useAppActive } from "./useAppActive";
import { usePlaceAgentCall } from "./usePlaceAgentCall";

type AgentCallRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly callId: string;
}>;

/** The host's open and recently ended calls, from its call stream. */
function useAgentCalls(environmentId: EnvironmentId): ReadonlyArray<AgentCall> | null {
  const callsAtom = useMemo(
    () => vmAgentEnvironment.calls({ environmentId, input: {} }),
    [environmentId],
  );
  return Option.getOrNull(AsyncResult.value(useAtomValue(callsAtom)))?.calls ?? null;
}

function useAgentName(environmentId: EnvironmentId, vmAgentId: string | null): string | null {
  const agentsAtom = useMemo(
    () => vmAgentEnvironment.agents({ environmentId, input: {} }),
    [environmentId],
  );
  const latest = Option.getOrNull(AsyncResult.value(useAtomValue(agentsAtom)));
  // The orchestrator calls as itself and is never in the agent registry.
  if (isOrchestratorCaller(vmAgentId)) return ORCHESTRATOR_THREAD_TITLE;
  if (vmAgentId === null || latest?.type !== "snapshot") return null;
  return latest.agents.find((agent) => agent.vmAgentId === vmAgentId)?.name ?? null;
}

/** Closing the screen hangs up a call this phone holds (see the leave effect). */
function CloseCallHeaderButton() {
  const navigation = useNavigation();
  const iconColor = useThemeColor("--color-icon");
  return (
    <Pressable
      accessibilityLabel="Close call screen"
      accessibilityHint="Hangs up if the call is on this phone"
      accessibilityRole="button"
      hitSlop={12}
      onPress={() => navigation.goBack()}
      className="p-2 active:opacity-60"
    >
      <SymbolView
        name="xmark"
        size={18}
        tintColor={iconColor}
        type="monochrome"
        weight="semibold"
      />
    </Pressable>
  );
}

/**
 * A voice call with one agent, full screen.
 *
 * The call is the web client's call page in a WebView, like the orchestrator:
 * answering, the conversation and hanging up all happen there. This screen
 * adds what a phone app owes a call: it buzzes while an agent's call rings, it
 * closes itself when a ring stops without this phone taking it, and leaving it
 * hangs up the calls this phone holds, since the audio lives in the WebView.
 * Which calls those are, the page says (`AgentCallNativeMessage`); the screen
 * follows the page to another call if it moves on to one, as it does when the
 * voice transfers the person to another agent, and its header then names that
 * call's agent and who else is on it.
 */
export function AgentCallRouteScreen({ route }: AgentCallRouteProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const openedCallId = route.params.callId;
  const calls = useAgentCalls(environmentId);
  const appActive = useAppActive();
  const endCall = useAtomCommand(vmAgentEnvironment.endCall, { reportFailure: false });
  const { place: callBack, placing: placingAgent } = usePlaceAgentCall();
  const placing = placingAgent !== null;

  const [hold, setHold] = useState(() =>
    initialAgentCallScreenHold({
      callId: openedCallId,
      placedHere: callsPlacedHere.has(agentCallKey(environmentId, openedCallId)),
    }),
  );
  const onPageMessage = useCallback((data: string) => {
    const message = parseAgentCallNativeMessage(data);
    if (message !== null) setHold((current) => applyAgentCallNativeMessage(current, message));
  }, []);

  const call = calls?.find((candidate) => candidate.callId === hold.callId) ?? null;
  const agentName = useAgentName(environmentId, call?.vmAgentId ?? null);
  const status = call?.status ?? null;
  const heldHere = isCallHeldHere(hold, hold.callId, status);
  const answeredHere = hold.heldEver.has(hold.callId);
  const failed = hold.failure !== null;
  const transferring = hold.transfer?.fromCallId === hold.callId;

  const leavingRef = useRef(false);
  const close = useCallback(() => {
    if (leavingRef.current) return;
    leavingRef.current = true;
    navigation.goBack();
  }, [navigation]);

  const previousRef = useRef<{ readonly callId: string; readonly status: AgentCallStatus } | null>(
    null,
  );
  useEffect(() => {
    if (status === null) return;
    const previous = previousRef.current;
    previousRef.current = { callId: hold.callId, status };
    const action = resolveAgentCallScreenAction({
      previousStatus: previousFollowedStatus(previous, hold.callId),
      status,
      heldHere,
      failed,
      transferring,
    });
    if (action === "dismiss") {
      close();
      return;
    }
    // Pending closes are re-decided whenever what they hinge on changes: the
    // page claiming the call, or reporting a failure, cancels them.
    if (action === "dismiss-soon" || action === "await-hold") {
      const timer = setTimeout(
        close,
        action === "dismiss-soon" ? AGENT_CALL_ENDED_LINGER_MS : AGENT_CALL_HOLD_GRACE_MS,
      );
      return () => clearTimeout(timer);
    }
    return;
  }, [close, failed, heldHere, hold.callId, status, transferring]);

  const ringDirection = call?.direction ?? null;
  const ringExpiresAt = call?.expiresAt ?? null;
  useEffect(() => {
    const stopAfterMs = ringRemainingMs({
      call:
        ringDirection === null || status === null
          ? null
          : { direction: ringDirection, status, expiresAt: ringExpiresAt },
      appActive,
      answeredHere,
      failed,
      nowMs: Date.now(),
    });
    if (stopAfterMs === null) return;
    return startRingingHaptics(
      () => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy).catch(() => undefined);
      },
      { stopAfterMs },
    );
  }, [answeredHere, appActive, failed, ringDirection, ringExpiresAt, status]);

  // However the screen goes (the close button, Android back, or closing
  // itself), a call this phone holds must not stay "active" on the host with
  // nobody on it, and a ring it placed but never connected is cancelled.
  const latestRef = useRef({ hold, calls });
  useEffect(() => {
    latestRef.current = { hold, calls };
  }, [calls, hold]);
  const endOnLeaveRef = useRef<() => void>(() => undefined);
  useEffect(() => {
    endOnLeaveRef.current = () => {
      const latest = latestRef.current;
      const ends = callsToEndOnLeave({
        hold: latest.hold,
        findCall: (callId) =>
          latest.calls?.find((candidate) => candidate.callId === callId) ?? null,
        findOutgoingRing: (vmAgentId) =>
          latest.calls?.find(
            (candidate) =>
              candidate.vmAgentId === vmAgentId &&
              candidate.direction === "outgoing" &&
              candidate.status === "ringing",
          )?.callId ?? null,
      });
      for (const { callId, ifRinging } of ends) {
        void endCall({ environmentId, input: { callId: AgentCallId.make(callId), ifRinging } });
      }
    };
  }, [endCall, environmentId]);
  useEffect(() => () => endOnLeaveRef.current(), []);

  // iOS shows the subtitle (iOS 26 and later); the page lists the same people.
  const participantsLine = agentCallParticipantsLine(call);
  useLayoutEffect(() => {
    navigation.setOptions({
      title: agentName ?? "Call",
      unstable_headerSubtitle: participantsLine ?? undefined,
      headerBackVisible: false,
      headerLeft: CloseCallHeaderButton,
    });
  }, [agentName, navigation, participantsLine]);

  // The page that opened stays loaded when the page moves on to another call:
  // reloading it would drop that call's voice.
  const page = agentCallPage(environmentId, openedCallId);
  return (
    <View className="flex-1 bg-screen">
      {hold.failure !== null ? (
        <View className="border-b border-danger-border bg-danger px-4 py-3">
          <Text
            accessibilityLiveRegion="polite"
            accessibilityRole="alert"
            className="text-sm text-danger-foreground"
          >
            {hold.failure}
          </Text>
          {call !== null ? (
            <Pressable
              accessibilityRole="button"
              disabled={placing}
              className="mt-2 min-h-[42px] self-start justify-center rounded-[10px] bg-blue-500 px-4 active:opacity-70"
              onPress={() => void callBack(environmentId, call.vmAgentId)}
            >
              <Text className="text-sm font-t3-bold text-white">
                {placing ? "Calling…" : "Call back"}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
      <EnvironmentWebScreen
        environmentId={environmentId}
        routePath={page.routePath}
        query={page.query}
        notConnected="Connect to this agent's host to take the call on this phone."
        onMessage={onPageMessage}
      />
    </View>
  );
}
