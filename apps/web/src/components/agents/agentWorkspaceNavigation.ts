import type { VmAgentWorkspaceSnapshot } from "@t3tools/contracts";

/** Schedule artifacts repeat Scheduled work, so only custom structured views get a menu entry. */
export function hasAgentDashboard(workspace: VmAgentWorkspaceSnapshot | null): boolean {
  const artifact = workspace?.artifact ?? null;
  return artifact !== null && artifact.definition.kind !== "schedule";
}
