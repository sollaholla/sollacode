import { AGENT_CALL_MAX_PARTICIPANTS, EnvironmentId } from "@t3tools/contracts";
import { useNavigate, useParams } from "@tanstack/react-router";
import { PhoneIcon, PhoneOffIcon, UserMinusIcon, UserPlusIcon } from "lucide-react";

import { useAgentRecord, useEnvironmentAgentCalls } from "../../agentCall/agentCallData";
import {
  addableCallRoster,
  describeAgentCallElsewhere,
  isAgentCallPhaseOpen,
  openAgentCallElsewhere,
} from "../../agentCall/agentCallLogic";
import { useAgentCallContext } from "../../agentCall/AgentCallProvider";
import { usePrimaryEnvironmentId } from "../../state/environments";
import {
  ADDON_ICON_CLASS,
  ITEM_ICON_CLASS,
  type CommandPaletteActionItem,
  type CommandPaletteSubmenuItem,
} from "../CommandPalette.logic";
import { agentCallNeedsKeyHint, useAgentCallsAvailable } from "./AgentCallButton";

/**
 * Command palette actions for calls: "Call <agent>" on an agent's page, and
 * "End call" (plus "Return to call" when minimised, and adding or removing
 * people while it is live) while a call is open.
 */
export function useAgentCallPaletteItems(): ReadonlyArray<
  CommandPaletteActionItem | CommandPaletteSubmenuItem
> {
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
  const available = useAgentCallsAvailable(environmentId, agent);
  const hostCalls = useEnvironmentAgentCalls(environmentId);
  if (calls === null) return [];

  const active = calls.activeCall;
  if (active !== null && isAgentCallPhaseOpen(active.phase)) {
    const items: Array<CommandPaletteActionItem | CommandPaletteSubmenuItem> = [
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
    const addable =
      active.phase === "live" &&
      active.transferringTo === null &&
      active.roster !== null &&
      active.participants.length < AGENT_CALL_MAX_PARTICIPANTS
        ? addableCallRoster({
            roster: active.roster,
            participants: active.participants,
            ownThreadId: active.agent.threadId,
          })
        : null;
    if (addable !== null && addable.agents.length + addable.chats.length > 0) {
      const choices = (entries: typeof addable.agents) =>
        entries.map((entry) => ({
          kind: "action" as const,
          value: `action:agent-call-add:${entry.threadId}`,
          searchTerms: [entry.name],
          title: entry.name,
          icon: <UserPlusIcon className={ITEM_ICON_CLASS} />,
          run: async () => calls.addParticipant(entry.threadId),
        }));
      items.push({
        kind: "submenu",
        value: "action:agent-call-add",
        searchTerms: ["add to call", "add someone", "invite", "call", "conference"],
        title: "Add someone to the call...",
        icon: <UserPlusIcon className={ITEM_ICON_CLASS} />,
        addonIcon: <UserPlusIcon className={ADDON_ICON_CLASS} />,
        groups: [
          { value: "agents", label: "Agents", items: choices(addable.agents) },
          { value: "chats", label: "Chats", items: choices(addable.chats) },
        ].filter((group) => group.items.length > 0),
      });
    }
    for (const participant of active.participants) {
      items.push({
        kind: "action",
        value: `action:agent-call-remove:${participant.threadId}`,
        searchTerms: ["remove from call", "call", participant.title],
        title: `Remove ${participant.title} from the call`,
        icon: <UserMinusIcon className={ITEM_ICON_CLASS} />,
        run: async () => calls.removeParticipant(participant.threadId),
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
      searchTerms: ["call", "voice call", "phone", "talk", "gpt-live", "grok", agent.name],
      title: `Call ${agent.name}`,
      description: available ? "Talk with this agent by voice" : agentCallNeedsKeyHint(agent),
      icon: <PhoneIcon className={ITEM_ICON_CLASS} />,
      run: async () => {
        if (available) calls.place(environmentId, agent);
        else await navigate({ to: "/settings/orchestrator" });
      },
    },
  ];
}
