import { ORCHESTRATOR_THREAD_ID, type AgentCall, type EnvironmentId } from "@t3tools/contracts";
import { isOrchestratorCaller } from "@t3tools/shared/orchestratorCaller";
import { useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";

import { useAgentRecord } from "../../agentCall/agentCallData";
import { ringAlerts, shouldNotifyIncomingCall } from "../../agentCall/agentCallLogic";
import { useAgentCallContext, useAgentCallLive } from "../../agentCall/AgentCallProvider";
import { startRingtone } from "../../agentCall/ringtone";
import { isBrowserPushEnabled } from "../../browser/webPush";
import { getClientSettings } from "../../hooks/useSettings";
import { resolveVoiceCuePolicy } from "../../orchestrator/voiceCues";
import { AgentCallPill, AgentCallScreen } from "./AgentCallScreen";
import { IncomingCallSheet } from "./IncomingCallSheet";

/** `/call/...?embedded=1`: the phone app's call screen, which brings its own chrome. */
function isEmbeddedCallLocation(location: {
  readonly pathname: string;
  readonly search: unknown;
}): boolean {
  if (!location.pathname.startsWith("/call/")) return false;
  const search = location.search as { readonly embedded?: unknown } | null;
  const embedded = search?.embedded;
  return embedded === true || embedded === 1 || embedded === "1";
}

/**
 * Every call surface over the app: the ringing sheet, the call screen, and
 * the pill a minimised call folds into. Mounted once beside the provider.
 */
export function AgentCallOverlay() {
  const api = useAgentCallContext();
  const live = useAgentCallLive();
  const navigate = useNavigate();
  const embedded = useLocation({ select: isEmbeddedCallLocation });
  const call = api?.activeCall ?? null;
  const record = useAgentRecord(call?.environmentId ?? null, call?.agent.vmAgentId ?? null);
  if (api === null) return null;

  const ringing = api.ringing;
  const onCall = call !== null && call.phase !== "ended" && call.phase !== "failed";
  const agent =
    call === null
      ? null
      : {
          vmAgentId: call.agent.vmAgentId,
          name: record?.name ?? call.agent.name,
          avatarColor: record?.avatarColor ?? call.agent.avatarColor,
        };

  return (
    <>
      {call !== null && agent !== null ? (
        api.minimised && !embedded ? (
          <AgentCallPill api={api} call={call} agent={agent} />
        ) : (
          <AgentCallScreen
            api={api}
            live={live}
            call={call}
            agent={agent}
            embedded={embedded}
            onOpenChat={() => {
              api.setMinimised(true);
              void (isOrchestratorCaller(call.agent.vmAgentId)
                ? navigate({
                    to: "/$environmentId/$threadId",
                    params: { environmentId: call.environmentId, threadId: ORCHESTRATOR_THREAD_ID },
                  })
                : navigate({
                    to: "/agents/$environmentId/$agentId",
                    params: { environmentId: call.environmentId, agentId: call.agent.vmAgentId },
                  }));
            }}
          />
        )
      ) : null}
      {ringing !== null ? (
        <IncomingCall
          key={`${ringing.environmentId}:${ringing.call.callId}`}
          environmentId={ringing.environmentId}
          call={ringing.call}
          onCall={onCall}
        />
      ) : null}
    </>
  );
}

function IncomingCall(props: {
  readonly environmentId: EnvironmentId;
  readonly call: AgentCall;
  readonly onCall: boolean;
}) {
  const api = useAgentCallContext();
  const record = useAgentRecord(props.environmentId, props.call.vmAgentId);
  const name = record?.name ?? "Your agent";
  useIncomingCallAlerts({ ...props, agentName: name });
  if (api === null) return null;
  return (
    <IncomingCallSheet
      call={props.call}
      agent={{
        vmAgentId: props.call.vmAgentId,
        name,
        avatarColor: record?.avatarColor ?? null,
      }}
      onAnswer={() => api.answer(props.environmentId, props.call, record)}
      onDecline={() => api.decline(props.environmentId, props.call.callId)}
    />
  );
}

/**
 * The ring itself: a synthesized ringtone and vibration while the sheet is up,
 * and a system notification when the person cannot see the sheet and push is
 * not already delivering this call. Everything stops when the call stops
 * ringing, because the sheet unmounts.
 */
function useIncomingCallAlerts(input: {
  readonly environmentId: EnvironmentId;
  readonly call: AgentCall;
  readonly onCall: boolean;
  readonly agentName: string;
}) {
  const { environmentId, call, onCall } = input;
  const agentNameRef = useRef(input.agentName);
  useEffect(() => {
    agentNameRef.current = input.agentName;
  }, [input.agentName]);

  useEffect(() => {
    const alerts = ringAlerts({
      ringing: true,
      onCall,
      policy: resolveVoiceCuePolicy(getClientSettings()),
    });
    if (!alerts.tone && !alerts.vibrate) return;
    const expiresAt = call.expiresAt === null ? null : Date.parse(call.expiresAt);
    const ringtone = startRingtone({
      tone: alerts.tone,
      vibrate: alerts.vibrate,
      volume: () => resolveVoiceCuePolicy(getClientSettings()).volume,
      expiresAt: Number.isFinite(expiresAt) ? expiresAt : null,
    });
    return () => ringtone.stop();
  }, [call.expiresAt, onCall]);

  useEffect(() => {
    if (typeof Notification === "undefined") return;
    let notification: Notification | null = null;
    const desktop = window.desktopBridge !== undefined;
    const check = () => {
      if (
        !shouldNotifyIncomingCall({
          hidden: document.visibilityState === "hidden",
          focused: document.hasFocus(),
          desktop,
          pushEnabled: isBrowserPushEnabled(environmentId),
          permission: Notification.permission,
          alreadyShown: notification !== null,
        })
      ) {
        return;
      }
      try {
        const shown = new Notification(`${agentNameRef.current} is calling`, {
          body: "Open Solla Code to answer.",
          tag: `call:${call.callId}`,
          requireInteraction: true,
        });
        shown.addEventListener("click", () => {
          window.focus();
          shown.close();
        });
        notification = shown;
      } catch {
        // Some mobile browsers only show notifications from a service worker.
      }
    };
    check();
    document.addEventListener("visibilitychange", check);
    window.addEventListener("blur", check);
    return () => {
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("blur", check);
      notification?.close();
    };
  }, [call.callId, environmentId]);
}
