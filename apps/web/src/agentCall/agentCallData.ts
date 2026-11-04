import type { AgentCall, EnvironmentId, VmAgent } from "@t3tools/contracts";
import { isOrchestratorCaller, orchestratorCallerAgent } from "@t3tools/shared/orchestratorCaller";
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

/**
 * The orchestrator as the party on a call. Its voice lives in the host's
 * settings, so a call carries it as `callerVoice` and this record has none.
 */
const ORCHESTRATOR_RECORD = orchestratorCallerAgent({
  voice: null,
  now: new Date(0).toISOString(),
});

/**
 * The agent on a call, from its host's registry; null until it loads. A call
 * from the orchestrator gets the orchestrator, which is never in the registry.
 */
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
  if (isOrchestratorCaller(vmAgentId)) return ORCHESTRATOR_RECORD;
  if (latest?.type !== "snapshot") return null;
  return latest.agents.find((agent) => agent.vmAgentId === vmAgentId) ?? null;
}

/** A host's agents, from its registry; null until it loads. */
export function useEnvironmentAgents(
  environmentId: EnvironmentId | null,
): ReadonlyArray<VmAgent> | null {
  const atom = useMemo(
    () => (environmentId === null ? null : vmAgentEnvironment.agents({ environmentId, input: {} })),
    [environmentId],
  );
  const latest = useEnvironmentQuery(atom).data;
  return latest?.type === "snapshot" ? latest.agents : null;
}
