import { RegistryContext } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, VmAgentId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { useCallback, useContext, useState } from "react";

import { useServerConfigs } from "../../state/entities";
import { useAtomCommand } from "../../state/use-atom-command";
import { vmAgentEnvironment } from "../../state/vmAgents";
import {
  agentCallBlockedReason,
  agentCallKey,
  callsPlacedHere,
  openCallForAgent,
  presentedIncomingCalls,
} from "./agentCallModel";

/** Whether agents on a host can be called, from its settings. */
export function useAgentCallBlockedReason(environmentId: EnvironmentId): string | null {
  const configs = useServerConfigs();
  return agentCallBlockedReason(
    configs.get(environmentId)?.settings.orchestrator.openAiApiKeyConfigured,
  );
}

/**
 * Places a call to an agent and opens the call screen, where the web call page
 * connects the voice. When the agent is already on a call held elsewhere, or
 * is ringing, it opens that call's screen instead, which can end or answer
 * it. `placing` and `error` are keyed by agent so a list of agents can show
 * them on the right row.
 */
export function usePlaceAgentCall() {
  const navigation = useNavigation();
  const registry = useContext(RegistryContext);
  const placeCall = useAtomCommand(vmAgentEnvironment.placeCall, { reportFailure: false });
  const [placing, setPlacing] = useState<VmAgentId | null>(null);
  const [error, setError] = useState<{
    readonly vmAgentId: VmAgentId;
    readonly message: string;
  } | null>(null);

  const place = useCallback(
    async (environmentId: EnvironmentId, vmAgentId: VmAgentId) => {
      if (placing !== null) return;
      // The root observer keeps every host's call stream open, so this is current.
      const calls =
        Option.getOrNull(
          AsyncResult.value(registry.get(vmAgentEnvironment.calls({ environmentId, input: {} }))),
        )?.calls ?? null;
      const open = openCallForAgent(calls, vmAgentId);
      if (open !== null) {
        setError(null);
        // Opened by hand, so the observer doesn't present the same ring again.
        presentedIncomingCalls.add(agentCallKey(environmentId, open.callId));
        navigation.navigate("AgentCall", {
          environmentId: String(environmentId),
          callId: String(open.callId),
        });
        return;
      }
      setPlacing(vmAgentId);
      setError(null);
      const result = await placeCall({ environmentId, input: { vmAgentId } });
      setPlacing(null);
      if (result._tag === "Failure") {
        const failure = Cause.squash(result.cause);
        setError({
          vmAgentId,
          message:
            failure instanceof Error && failure.message.trim().length > 0
              ? failure.message
              : "The call could not be placed.",
        });
        return;
      }
      const call = result.value;
      callsPlacedHere.add(agentCallKey(environmentId, call.callId));
      navigation.navigate("AgentCall", {
        environmentId: String(environmentId),
        callId: String(call.callId),
      });
    },
    [navigation, placeCall, placing, registry],
  );

  return { place, placing, error };
}
