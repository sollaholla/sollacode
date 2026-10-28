import { EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PhoneIcon, PhoneOffIcon } from "lucide-react";

import { useAgentRecord, useEnvironmentAgentCalls } from "../../agentCall/agentCallData";
import {
  describeAgentCallElsewhere,
  isAgentCallPhaseOpen,
  openAgentCallElsewhere,
} from "../../agentCall/agentCallLogic";
import { useAgentCallContext } from "../../agentCall/AgentCallProvider";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import { AGENT_CALL_NEEDS_KEY_HINT, useAgentCallsAvailable } from "./AgentCallButton";

/**
 * Command palette actions for calls: "Call <agent>" on an agent's page, and
 * "End call" (plus "Return to call" when minimised) while a call is open.
 */
export function useAgentCallPaletteItems(): ReadonlyArray<CommandPaletteActionItem> {
  const calls = useAgentCallContext();
  const navigate = useNavigate();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const routeAgentId = useParams({
    strict: false,
    select: (params) => (params as { readonly agentId?: string }).agentId ?? null,
  });
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => (params as { readonly environmentId?: string }).environmentId ?? null,
  });
  // The legacy `/agents/$agentId` route means the primary host.
  const environmentId =
    routeAgentId === null
      ? null
      : routeEnvironmentId !== null
        ? EnvironmentId.make(routeEnvironmentId)
        : primaryEnvironmentId;
  const agent = useAgentRecord(environmentId, routeAgentId);
  const available = useAgentCallsAvailable(environmentId);
  const hostCalls = useEnvironmentAgentCalls(environmentId);
  if (calls === null) return [];

  const active = calls.activeCall;
  if (active !== null && isAgentCallPhaseOpen(active.phase)) {
    const items: Array<CommandPaletteActionItem> = [
      {
        kind: "action",
        value: "action:agent-call-end",
        searchTerms: ["end call", "hang up", "call", "phone", active.agent.name],
        title: `End call with ${active.agent.name}`,
        icon: <PhoneOffIcon className={ITEM_ICON_CLASS} />,
        run: async () => calls.hangUp(),
      },
    ];
    if (calls.minimised) {
      items.push({
        kind: "action",
        value: "action:agent-call-return",
        searchTerms: ["return to call", "call", "phone", active.agent.name],
        title: `Return to the call with ${active.agent.name}`,
        icon: <PhoneIcon className={ITEM_ICON_CLASS} />,
        run: async () => calls.setMinimised(false),
      });
    }
    return items;
  }

  if (environmentId === null || agent === null) return [];
  // The host refuses a second call to the agent: go to the one it is on.
  const elsewhere = openAgentCallElsewhere(hostCalls, agent.vmAgentId);
  if (elsewhere !== null) {
    return [
      {
        kind: "action",
        value: "action:agent-call-open",
        searchTerms: ["call", "voice call", "phone", "end call", agent.name],
        title: `Open the call with ${agent.name}`,
        description: describeAgentCallElsewhere(elsewhere, agent.name),
        icon: <PhoneIcon className={ITEM_ICON_CLASS} />,
        run: async () => {
          await navigate({
            to: "/call/$environmentId/$callId",
            params: { environmentId, callId: elsewhere.callId },
          });
        },
      },
    ];
  }
  return [
    {
      kind: "action",
      value: "action:agent-call-place",
      searchTerms: ["call", "voice call", "phone", "talk", "gpt-live", agent.name],
      title: `Call ${agent.name}`,
      description: available ? "Talk with this agent by voice" : AGENT_CALL_NEEDS_KEY_HINT,
      icon: <PhoneIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        if (available) calls.place(environmentId, agent);
        else await navigate({ to: "/settings/orchestrator" });
      },
    },
  ];
}
