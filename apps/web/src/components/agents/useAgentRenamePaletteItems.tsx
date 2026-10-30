import { useParams } from "@tanstack/react-router";
import { EnvironmentId } from "@t3tools/contracts";
import { PencilIcon } from "lucide-react";

import { useAgentRecord } from "../../agentCall/agentCallData";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../CommandPalette.logic";
import type { AgentRenameTarget } from "./RenameAgentDialog";

export function useAgentRenamePaletteItems(
  onRenameAgent: (target: AgentRenameTarget) => void,
): ReadonlyArray<CommandPaletteActionItem> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const agentId = useParams({
    strict: false,
    select: (params) => (params as { readonly agentId?: string }).agentId ?? null,
  });
  const routeEnvironmentId = useParams({
    strict: false,
    select: (params) => (params as { readonly environmentId?: string }).environmentId ?? null,
  });
  const environmentId =
    agentId === null
      ? null
      : routeEnvironmentId === null
        ? primaryEnvironmentId
        : EnvironmentId.make(routeEnvironmentId);
  const agent = useAgentRecord(environmentId, agentId);
  if (!agent || !environmentId) return [];
  return [
    {
      kind: "action",
      value: "action:agent-rename",
      title: `Rename ${agent.name}`,
      searchTerms: ["rename agent", "agent name", agent.name, agent.handle],
      icon: <PencilIcon className={ITEM_ICON_CLASS} />,
      run: async () => onRenameAgent({ environmentId, agent }),
    },
  ];
}
