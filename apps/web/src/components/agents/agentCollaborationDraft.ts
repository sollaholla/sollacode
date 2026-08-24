import type { EnvironmentId, VmAgent } from "@t3tools/contracts";

/** Keep in-progress handoff briefs isolated when route params reuse the workspace. */
export function agentCollaborationDraftKey(
  environmentId: EnvironmentId,
  vmAgentId: VmAgent["vmAgentId"],
): string {
  return `${environmentId}:${vmAgentId}`;
}
