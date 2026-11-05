import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, ServerSettings, VmAgent } from "@t3tools/contracts";
import { agentCallEngineFor } from "@t3tools/shared/agentCallVoice";
import { Atom } from "effect/unstable/reactivity";
import { useNavigate } from "@tanstack/react-router";
import { PhoneIcon } from "lucide-react";

import { useEnvironmentAgentCalls } from "../../agentCall/agentCallData";
import {
  describeAgentCallElsewhere,
  isAgentCallPhaseOpen,
  openAgentCallElsewhere,
} from "../../agentCall/agentCallLogic";
import { useAgentCallContext } from "../../agentCall/AgentCallProvider";
import { serverEnvironment } from "../../state/server";
import { cn } from "../../lib/utils";
import { ToolbarControl } from "../ui/toolbar-control";

/** What to add before `agent` can be called: the key its voice's engine runs on. */
export function agentCallNeedsKeyHint(
  agent: Pick<VmAgent, "vmAgentId" | "avatarColor" | "voice"> | null,
): string {
  return agent !== null && agentCallEngineFor(agent) === "grok"
    ? "Add an xAI key in Settings → Orchestrator to call agents with a Grok voice"
    : "Add an OpenAI key in Settings → Orchestrator to call agents";
}

/**
 * Whether this host can call `agent`: on GPT-Live with the OpenAI key from
 * Settings → Orchestrator, or, for an agent given a Grok voice, on Grok Voice
 * with the xAI key.
 */
export function useAgentCallsAvailable(
  environmentId: EnvironmentId | null,
  agent: Pick<VmAgent, "vmAgentId" | "avatarColor" | "voice"> | null,
): boolean {
  const settings = useAtomValue(
    environmentId === null ? NO_SETTINGS_ATOM : serverEnvironment.settingsValueAtom(environmentId),
  );
  return agent !== null && agentCallEngineFor(agent) === "grok"
    ? settings?.orchestrator.xaiApiKeyConfigured === true
    : settings?.orchestrator.openAiApiKeyConfigured === true;
}

const NO_SETTINGS_ATOM = Atom.make<ServerSettings | null>(null);

/**
 * The agent header's Call button. While this agent is on a call here it
 * returns to the call; while it is on a call this device does not hold it
 * opens that call's page, where it can be ended; without an OpenAI key it
 * explains itself and opens the setting that fixes it.
 */
export function AgentCallButton(props: {
  readonly environmentId: EnvironmentId;
  readonly agent: VmAgent;
}) {
  const { agent, environmentId } = props;
  const calls = useAgentCallContext();
  const available = useAgentCallsAvailable(environmentId, agent);
  const hostCalls = useEnvironmentAgentCalls(environmentId);
  const navigate = useNavigate();
  if (calls === null) return null;
  const active = calls.activeCall;
  const onThisCall =
    active !== null &&
    isAgentCallPhaseOpen(active.phase) &&
    active.environmentId === environmentId &&
    active.agent.vmAgentId === agent.vmAgentId;
  const elsewhere = onThisCall ? null : openAgentCallElsewhere(hostCalls, agent.vmAgentId);
  const label = onThisCall
    ? `Return to the call with ${agent.name}`
    : elsewhere !== null
      ? `Open the call with ${agent.name}`
      : `Call ${agent.name}`;
  const title =
    elsewhere !== null
      ? describeAgentCallElsewhere(elsewhere, agent.name)
      : onThisCall || available
        ? label
        : agentCallNeedsKeyHint(agent);
  return (
    <ToolbarControl
      type="button"
      size="icon-xs"
      aria-label={label}
      aria-pressed={onThisCall}
      aria-disabled={!onThisCall && elsewhere === null && !available ? true : undefined}
      title={title}
      data-testid="agent-call-button"
      onClick={() => {
        if (onThisCall) {
          calls.setMinimised(false);
          return;
        }
        if (elsewhere !== null) {
          void navigate({
            to: "/call/$environmentId/$callId",
            params: { environmentId, callId: elsewhere.callId },
          });
          return;
        }
        if (!available) {
          void navigate({ to: "/settings/orchestrator" });
          return;
        }
        calls.place(environmentId, agent);
      }}
      className={cn(
        onThisCall
          ? "border-success text-success hover:border-success"
          : "border-transparent text-muted-foreground hover:text-foreground",
        !onThisCall && elsewhere === null && !available && "opacity-60",
      )}
    >
      <PhoneIcon className="size-3.5" aria-hidden />
    </ToolbarControl>
  );
}
