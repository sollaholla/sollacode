import { EnvironmentId } from "@t3tools/contracts";
import { useCanGoBack, useNavigate, useParams, useRouter, useSearch } from "@tanstack/react-router";
import { PhoneIcon, PhoneOffIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { useAgentRecord, useEnvironmentAgentCalls } from "../../agentCall/agentCallData";
import { endedAgentCallTitle, isAgentCallPhaseOpen } from "../../agentCall/agentCallLogic";
import { useAgentCallContext } from "../../agentCall/AgentCallProvider";
import { AgentGlyph } from "../agents/AgentGlyph";
import { Button } from "../ui/button";
import { AGENT_CALL_NEEDS_KEY_HINT, useAgentCallsAvailable } from "./AgentCallButton";
import { CallRoundButton } from "./AgentCallScreen";
import { IncomingCallSheet } from "./IncomingCallSheet";

/**
 * `/call/$environmentId/$callId`: where a call notification and the phone
 * app's call screen land.
 *
 * A ringing call shows the ringing sheet (the overlay draws it; Answer is the
 * tap that unlocks the microphone), a call live on this device shows the call
 * screen, a call held elsewhere can be ended from here, and a finished one
 * offers Call back. `?embedded=1` is the phone app hosting this page in its
 * own call screen: no app chrome, a call that app placed is joined straight
 * away, and this page answers only its own call (the overlay never rings in
 * the phone app) and never places another (no Call back).
 */
export function AgentCallRoute() {
  const params = useParams({ from: "/call/$environmentId/$callId" });
  const search = useSearch({ strict: false }) as { readonly embedded?: unknown };
  const embedded = search.embedded === true || search.embedded === "1" || search.embedded === 1;
  const environmentId = EnvironmentId.make(params.environmentId);
  const callId = params.callId;
  const api = useAgentCallContext();
  const calls = useEnvironmentAgentCalls(environmentId);
  const call = calls?.find((candidate) => candidate.callId === callId) ?? null;
  const agent = useAgentRecord(environmentId, call?.vmAgentId ?? null);
  const available = useAgentCallsAvailable(environmentId);
  const navigate = useNavigate();
  const router = useRouter();
  const canGoBack = useCanGoBack();

  const active = api?.activeCall ?? null;
  const isThisCall =
    active !== null && active.environmentId === environmentId && active.callId === callId;
  const onThisDevice = isThisCall && isAgentCallPhaseOpen(active.phase);
  const [declinedHere, setDeclinedHere] = useState(false);

  // Arriving here means "show me the call", not the pill.
  const setMinimised = api?.setMinimised;
  useEffect(() => {
    if (onThisDevice) setMinimised?.(false);
  }, [onThisDevice, setMinimised]);

  // The phone app placed this call and opened this page to carry its voice.
  const joinedRef = useRef(false);
  useEffect(() => {
    if (!embedded || joinedRef.current || api === null || agent === null) return;
    if (call === null || call.direction !== "outgoing" || call.status !== "ringing") return;
    if (onThisDevice) return;
    joinedRef.current = true;
    api.answer(environmentId, call, agent);
  }, [agent, api, call, embedded, environmentId, onThisDevice]);

  const close = () => {
    if (canGoBack) router.history.back();
    else void navigate({ to: "/", replace: true });
  };

  const name = agent?.name ?? "Your agent";
  let title: string;
  let detail: string | null = null;
  let showCallBack = false;
  let showEnd = false;
  if (calls === null) {
    title = "Connecting…";
  } else if (onThisDevice) {
    title = `On a call with ${name}`;
  } else if (call?.status === "ringing") {
    title = call.direction === "incoming" ? `${name} is calling` : `Calling ${name}…`;
  } else if (call?.status === "active") {
    title = `On a call with ${name}`;
    detail = call.answeredBy ? `Answered on ${call.answeredBy}.` : "Answered on another device.";
    // The way out of a call a closed tab or a lost phone left open.
    showEnd = true;
  } else {
    title = endedAgentCallTitle(call?.status ?? null);
    showCallBack = agent !== null && !embedded;
  }
  // The overlay's ringing sheet answers a ring. When the overlay isn't ringing
  // this call (always in the phone app, whose native screen buzzes, or after
  // an answer failed on this device), the page offers its own silent Answer.
  const overlayRingsIt =
    api?.ringing != null &&
    api.ringing.environmentId === environmentId &&
    api.ringing.call.callId === callId;
  const showIncoming =
    api !== null &&
    call !== null &&
    call.status === "ringing" &&
    call.direction === "incoming" &&
    !isThisCall &&
    !declinedHere &&
    !overlayRingsIt;

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-background text-foreground">
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 pt-[env(safe-area-inset-top)] text-center">
        {call !== null ? (
          <div className="mb-2 flex size-32 items-center justify-center rounded-full bg-muted/50">
            <AgentGlyph
              agentId={call.vmAgentId}
              avatarColor={agent?.avatarColor ?? null}
              online
              className="size-24"
            />
          </div>
        ) : null}
        <h1 className="max-w-full text-2xl font-semibold break-words">{title}</h1>
        {detail ? <p className="text-sm text-muted-foreground">{detail}</p> : null}
        {/* A call this device can join but did not place (opened from a link). */}
        {!embedded &&
        api !== null &&
        call?.status === "ringing" &&
        call.direction === "outgoing" &&
        !onThisDevice ? (
          <CallRoundButton
            label="Join"
            icon={<PhoneIcon />}
            tone="accept"
            onClick={() => api.answer(environmentId, call, agent)}
          />
        ) : null}
        {showEnd && api !== null && call !== null ? (
          <CallRoundButton
            label="End call"
            icon={<PhoneOffIcon />}
            tone="danger"
            onClick={() => api.end(environmentId, call.callId)}
          />
        ) : null}
        {showCallBack && api !== null && agent !== null ? (
          <div className="flex flex-col items-center gap-2">
            <CallRoundButton
              label="Call back"
              icon={<PhoneIcon />}
              tone="accept"
              disabled={!available}
              onClick={() => api.place(environmentId, agent)}
            />
            {!available ? (
              <p className="max-w-xs text-xs text-muted-foreground">{AGENT_CALL_NEEDS_KEY_HINT}</p>
            ) : null}
          </div>
        ) : null}
      </div>
      {!embedded ? (
        <div className="flex shrink-0 justify-center gap-2 px-6 pt-4 pb-[max(env(safe-area-inset-bottom),2rem)]">
          {call !== null ? (
            <Button
              type="button"
              variant="outline"
              onClick={() =>
                void navigate({
                  to: "/agents/$environmentId/$agentId",
                  params: { environmentId, agentId: call.vmAgentId },
                })
              }
            >
              Open chat
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={close}>
            Close
          </Button>
        </div>
      ) : null}
      {showIncoming ? (
        <IncomingCallSheet
          call={call}
          agent={{
            vmAgentId: call.vmAgentId,
            name,
            avatarColor: agent?.avatarColor ?? null,
          }}
          onAnswer={() => api.answer(environmentId, call, agent)}
          onDecline={() => {
            setDeclinedHere(true);
            api.decline(environmentId, call.callId);
          }}
        />
      ) : null}
    </div>
  );
}
