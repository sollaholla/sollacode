import type { AgentCall, EnvironmentId, VmAgent } from "@t3tools/contracts";
import { useMemo } from "react";

import { useEnvironmentQuery } from "../state/query";
import { vmAgentEnvironment } from "../state/vmAgents";

/**
 * One host's open and recently ended calls, or null before the first snapshot.
 * A host too old to have calls fails the subscription, which reads as null.
 */
export function useEnvironmentAgentCalls(
  environmentId: EnvironmentId | null,
): ReadonlyArray<AgentCall> | null {
  const atom = useMemo(
    () => (environmentId === null ? null : vmAgentEnvironment.calls({ environmentId, input: {} })),
    [environmentId],
  );
  const latest = useEnvironmentQuery(atom).data;
  return latest?.type === "snapshot" ? latest.calls : null;
}

/** The agent on a call, from its host's registry; null until it loads. */
export function useAgentRecord(
  environmentId: EnvironmentId | null,
  vmAgentId: string | null,
): VmAgent | null {
  const atom = useMemo(
    () =>
      environmentId === null || vmAgentId === null
        ? null
        : vmAgentEnvironment.agents({ environmentId, input: {} }),
    [environmentId, vmAgentId],
  );
  const latest = useEnvironmentQuery(atom).data;
  if (latest?.type !== "snapshot") return null;
  return latest.agents.find((agent) => agent.vmAgentId === vmAgentId) ?? null;
}
