import type { AgentCall, AgentCallReason } from "@t3tools/contracts";
import { PhoneIcon, PhoneOffIcon } from "lucide-react";

import { AgentGlyph } from "../agents/AgentGlyph";
import { CallBackdrop, CallRoundButton, type CallScreenAgent } from "./AgentCallScreen";

const REASON_LABEL: Record<AgentCallReason, string> = {
  user: "Incoming call",
  blocker: "Needs your help",
  question: "Has a question",
  approval: "Needs your approval",
  request: "Wants to talk",
};

/**
 * An agent ringing: who, why, and Answer / Decline. Answer is the tap that
 * unlocks the microphone and audio, so it must start the call directly.
 */
export function IncomingCallSheet(props: {
  readonly call: AgentCall;
  readonly agent: CallScreenAgent;
  readonly onAnswer: () => void;
  readonly onDecline: () => void;
}) {
  const { agent, call } = props;
  return (
    <div
      role="alertdialog"
      aria-modal="true"
      aria-label={`${agent.name} is calling`}
      data-testid="agent-call-incoming"
      className="fixed inset-0 z-[60] flex flex-col bg-background text-foreground [-webkit-app-region:no-drag]"
    >
      <CallBackdrop agent={agent} />
      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 pt-[env(safe-area-inset-top)] text-center">
        <p className="text-sm text-muted-foreground">{REASON_LABEL[call.reason]}</p>
        <div className="relative mb-2 flex size-40 items-center justify-center rounded-full bg-background/40 shadow-sm ring-1 ring-foreground/5">
          {/* Duty-cycled, stepped, and still under reduced motion. */}
          <span
            aria-hidden
            className="absolute inset-0 animate-status-pulse rounded-full border-2 border-success/60 motion-reduce:animate-none"
          />
          <AgentGlyph
            agentId={agent.vmAgentId}
            avatarColor={agent.avatarColor}
            online
            mood="waiting"
            className="size-32"
          />
        </div>
        <h1 className="max-w-full text-3xl font-semibold break-words">{agent.name} is calling</h1>
        {call.topic ? (
          <p className="line-clamp-4 max-w-md text-base text-muted-foreground">{call.topic}</p>
        ) : null}
      </div>
      <div className="relative flex shrink-0 items-start justify-center gap-16 px-6 pt-4 pb-[max(env(safe-area-inset-bottom),3rem)]">
        <CallRoundButton
          label="Decline"
          icon={<PhoneOffIcon />}
          tone="danger"
          onClick={props.onDecline}
        />
        <CallRoundButton
          label="Answer"
          icon={<PhoneIcon />}
          tone="accept"
          onClick={props.onAnswer}
        />
      </div>
    </div>
  );
}
