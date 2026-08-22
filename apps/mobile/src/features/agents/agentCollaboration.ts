import type { VmAgentDelegation, VmAgentDelegationStatus } from "@t3tools/contracts";

export function isDelegationRelatedToAgent(
  delegation: Pick<VmAgentDelegation, "rootVmAgentId" | "sourceVmAgentId" | "targetVmAgentId">,
  vmAgentId: string,
): boolean {
  return (
    delegation.rootVmAgentId === vmAgentId ||
    delegation.sourceVmAgentId === vmAgentId ||
    delegation.targetVmAgentId === vmAgentId
  );
}

export function delegationFollowupKind(status: VmAgentDelegationStatus): "answer" | "note" {
  return status === "waiting-input" ? "answer" : "note";
}
