import {
  ORCHESTRATOR_THREAD_ID,
  ORCHESTRATOR_THREAD_TITLE,
  VmAgentId,
  VmId,
  type VmAgent,
} from "@t3tools/contracts";

/**
 * The orchestrator on a voice call. Calls are built around custom agents, so
 * the orchestrator takes part through a reserved caller id: a call with it
 * talks to the orchestrator's own chat, speaks with the orchestrator's voice
 * and is named "Orchestrator". It is never a real agent, never listed with
 * them, and can't be deleted or renamed.
 */
export const ORCHESTRATOR_CALLER_ID = VmAgentId.make("solla-orchestrator");

export const isOrchestratorCaller = (vmAgentId: string | null | undefined): boolean =>
  vmAgentId === ORCHESTRATOR_CALLER_ID;

/** The orchestrator, described the way a call describes the agent on it. */
export function orchestratorCallerAgent(input: {
  readonly voice: string | null;
  readonly now: string;
}): VmAgent {
  return {
    vmAgentId: ORCHESTRATOR_CALLER_ID,
    name: ORCHESTRATOR_THREAD_TITLE,
    handle: "orchestrator",
    purpose: "Runs the person's workspace: their chats, agents, terminals and connected computers.",
    icon: null,
    avatarColor: null,
    voice: input.voice,
    vmId: VmId.make("solla-orchestrator"),
    threadId: ORCHESTRATOR_THREAD_ID,
    status: "running",
    controlMode: "agent",
    guestIp: null,
    lastError: null,
    createdAt: input.now,
    updatedAt: input.now,
  };
}
