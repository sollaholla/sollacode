import {
  ChevronDownIcon,
  MessageSquareIcon,
  MicIcon,
  MicOffIcon,
  PhoneOffIcon,
  XIcon,
} from "lucide-react";
import { agentAvatarTraits } from "@t3tools/client-runtime/state/agent-appearance";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import {
  agentCallMood,
  agentCallStatusText,
  callElapsedSeconds,
  formatCallDuration,
  isAgentCallPhaseOpen,
  latestCaption,
} from "../../agentCall/agentCallLogic";
import type {
  ActiveAgentCall,
  AgentCallApi,
  AgentCallLive,
} from "../../agentCall/AgentCallProvider";
import { cn } from "../../lib/utils";
import { AgentGlyph } from "../agents/AgentGlyph";
import { MicrophoneMenu } from "./MicrophoneMenu";

/**
 * Seconds since the call connected, ticking once a second while it runs.
 * Lives in the surfaces that show it, so the rest of the app does not
 * re-render every second.
 */
export function useCallElapsedSeconds(startedAt: number | null, running: boolean): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (startedAt === null || !running) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [running, startedAt]);
  return callElapsedSeconds(startedAt, now);
}

type CallButtonTone = "neutral" | "selected" | "accept" | "danger";

const TONE_CLASS: Record<CallButtonTone, string> = {
  neutral: "bg-muted text-foreground hover:bg-muted/80",
  selected: "bg-foreground text-background hover:bg-foreground/90",
  accept: "bg-success text-white hover:bg-success/90",
  danger: "bg-destructive text-white hover:bg-destructive/90",
};

/** A phone's round call button with its label underneath. */
export function CallRoundButton(props: {
  readonly label: string;
  readonly icon: ReactNode;
  readonly tone: CallButtonTone;
  readonly onClick: () => void;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  /** A small secondary control pinned to the button's corner (the microphone menu on Mute). */
  readonly accessory?: ReactNode;
}) {
  return (
    <div className="flex w-20 flex-col items-center gap-2">
      <div className="relative">
        <button
          type="button"
          aria-label={props.label}
          aria-pressed={props.pressed}
          disabled={props.disabled}
          onClick={props.onClick}
          className={cn(
            "flex size-16 cursor-pointer items-center justify-center rounded-full transition-colors duration-150 outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-default disabled:opacity-40 motion-reduce:transition-none [&_svg]:size-7",
            TONE_CLASS[props.tone],
          )}
        >
          {props.icon}
        </button>
        {props.accessory}
      </div>
      <span aria-hidden className="text-xs text-muted-foreground">
        {props.label}
      </span>
    </div>
  );
}

/**
 * The call's backdrop: a still wash of the agent's own color, the way a phone
 * tints a call with the contact's photo. Static on purpose — nothing repaints.
 */
export function CallBackdrop(props: { readonly agent: CallScreenAgent }) {
  const color = agentAvatarTraits(props.agent.vmAgentId, props.agent.avatarColor).color;
  const style = {
    backgroundImage: [
      `radial-gradient(120% 70% at 50% 28%, color-mix(in srgb, ${color} 34%, transparent), transparent 72%)`,
      `linear-gradient(to bottom, color-mix(in srgb, ${color} 14%, transparent), transparent 60%)`,
    ].join(", "),
  } satisfies CSSProperties;
  return <div aria-hidden className="pointer-events-none absolute inset-0" style={style} />;
}

/** What the call surfaces need from the agent, live record or captured. */
export interface CallScreenAgent {
  readonly vmAgentId: string;
  readonly name: string;
  readonly avatarColor: number | null;
}

/**
 * The call, full screen: the agent's face, name, a timer, one line of live
 * caption, and Mute / Chat / End. Looks and behaves like a phone call; the
 * agent's chat stays the full record of what was said and done.
 */
export function AgentCallScreen(props: {
  readonly api: AgentCallApi;
  readonly live: AgentCallLive;
  readonly call: ActiveAgentCall;
  readonly agent: CallScreenAgent;
  /** Hosted by the phone app: no minimise, no in-app chat. */
  readonly embedded: boolean;
  readonly onOpenChat: () => void;
}) {
  const { api, live, call, agent } = props;
  const open = isAgentCallPhaseOpen(call.phase);
  const elapsed = useCallElapsedSeconds(call.startedAt, call.phase === "live");
  const caption = open ? latestCaption(live.transcript) : null;
  const status = agentCallStatusText({
    phase: call.phase,
    direction: call.direction,
    elapsedSeconds: elapsed,
    error: call.error,
  });
  const mood = agentCallMood({
    phase: call.phase,
    sessionState: live.sessionState,
    working: live.working,
  });

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Call with ${agent.name}`}
      data-testid="agent-call-screen"
      className="fixed inset-0 z-50 flex flex-col bg-background text-foreground [-webkit-app-region:no-drag]"
    >
      <CallBackdrop agent={agent} />
      <div className="relative flex h-14 shrink-0 items-center justify-between px-4 pt-[env(safe-area-inset-top)]">
        {!props.embedded && open ? (
          <button
            type="button"
            aria-label="Minimise call"
            title="Minimise call"
            onClick={() => api.setMinimised(true)}
            className="flex size-9 cursor-pointer items-center justify-center rounded-full text-muted-foreground outline-hidden hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            <ChevronDownIcon className="size-5" />
          </button>
        ) : (
          <span />
        )}
        <span className="text-xs text-muted-foreground">Voice call</span>
        <span className="size-9" />
      </div>

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="relative mb-2 flex size-40 items-center justify-center rounded-full bg-background/40 shadow-sm ring-1 ring-foreground/5">
          {call.phase === "placing" || call.phase === "connecting" ? (
            // Duty-cycled, stepped, and still under reduced motion.
            <span
              aria-hidden
              className="absolute -inset-2 animate-status-pulse rounded-full border-2 border-foreground/15 motion-reduce:animate-none"
            />
          ) : null}
          <AgentGlyph
            agentId={agent.vmAgentId}
            avatarColor={agent.avatarColor}
            online
            mood={mood}
            className="size-32"
          />
        </div>
        <h1 className="max-w-full truncate text-3xl font-semibold">{agent.name}</h1>
        <p
          className={cn(
            "text-base tabular-nums",
            call.phase === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
          )}
          aria-live="polite"
        >
          {status}
        </p>
        {open && live.working ? (
          <p className="text-sm text-muted-foreground">Working on it in the chat. Keep talking.</p>
        ) : null}
        <p
          className={cn(
            "line-clamp-2 min-h-10 max-w-md text-sm",
            caption?.role === "user" ? "text-muted-foreground" : "text-foreground/80",
          )}
        >
          {caption ? caption.text : null}
        </p>
      </div>

      <div className="relative flex shrink-0 items-start justify-center gap-6 px-6 pt-4 pb-[max(env(safe-area-inset-bottom),2.5rem)]">
        {open ? (
          <>
            <CallRoundButton
              label={live.muted ? "Unmute" : "Mute"}
              icon={live.muted ? <MicOffIcon /> : <MicIcon />}
              tone={live.muted ? "selected" : "neutral"}
              pressed={live.muted}
              onClick={api.toggleMute}
              accessory={<MicrophoneMenu onChoose={api.chooseMicrophone} />}
            />
            {!props.embedded ? (
              <CallRoundButton
                label="Chat"
                icon={<MessageSquareIcon />}
                tone="neutral"
                onClick={props.onOpenChat}
              />
            ) : null}
            <CallRoundButton
              label="End"
              icon={<PhoneOffIcon />}
              tone="danger"
              onClick={api.hangUp}
            />
          </>
        ) : (
          <CallRoundButton label="Close" icon={<XIcon />} tone="neutral" onClick={api.dismiss} />
        )}
      </div>
    </div>
  );
}

/** The call folded away: a small pill to get back to it, and End. */
export function AgentCallPill(props: {
  readonly api: AgentCallApi;
  readonly call: ActiveAgentCall;
  readonly agent: CallScreenAgent;
}) {
  const { api, call, agent } = props;
  const open = isAgentCallPhaseOpen(call.phase);
  const elapsed = useCallElapsedSeconds(call.startedAt, call.phase === "live");
  const status =
    call.phase === "live" && elapsed !== null
      ? formatCallDuration(elapsed)
      : agentCallStatusText({
          phase: call.phase,
          direction: call.direction,
          elapsedSeconds: elapsed,
          error: call.phase === "failed" ? "Call failed" : call.error,
        });
  return (
    <div
      data-testid="agent-call-pill"
      className="fixed top-[calc(env(safe-area-inset-top)+0.5rem)] left-1/2 z-50 flex -translate-x-1/2 items-center gap-1 rounded-full bg-foreground py-1 pr-1 pl-1 text-background shadow-lg [-webkit-app-region:no-drag]"
    >
      <button
        type="button"
        onClick={() => api.setMinimised(false)}
        aria-label={`Return to the call with ${agent.name}`}
        className="flex min-w-0 cursor-pointer items-center gap-2 rounded-full py-1 pr-2 pl-2.5 text-sm outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
      >
        <span
          aria-hidden
          className={cn("size-2 shrink-0 rounded-full", open ? "bg-success" : "bg-destructive")}
        />
        <span className="tabular-nums">{status}</span>
        <span className="max-w-40 truncate font-medium">{agent.name}</span>
      </button>
      {open ? (
        <button
          type="button"
          aria-label="End call"
          title="End call"
          onClick={api.hangUp}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive text-white outline-hidden hover:bg-destructive/90 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <PhoneOffIcon className="size-3.5" />
        </button>
      ) : (
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={api.dismiss}
          className="flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full text-background/80 outline-hidden hover:bg-background/15 focus-visible:ring-2 focus-visible:ring-ring"
        >
          <XIcon className="size-3.5" />
        </button>
      )}
    </div>
  );
}
