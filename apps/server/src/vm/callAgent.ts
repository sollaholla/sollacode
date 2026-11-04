import type { ServerSettingsError, VmAgent, VmAgentId } from "@t3tools/contracts";
import { isOrchestratorCaller, orchestratorCallerAgent } from "@t3tools/shared/orchestratorCaller";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ProjectionRepositoryError } from "../persistence/Errors.ts";
import type { VmAgentStore } from "../persistence/Services/VmAgents.ts";
import type { ServerSettingsService } from "../serverSettings.ts";

/**
 * The agent on a call, by id: one of the host's agents, or the orchestrator,
 * which calls with the voice set for it in Settings → Orchestrator.
 */
export const makeCallAgentLookup =
  (agents: VmAgentStore["Service"], settings: ServerSettingsService["Service"]) =>
  (
    vmAgentId: VmAgentId,
  ): Effect.Effect<Option.Option<VmAgent>, ProjectionRepositoryError | ServerSettingsError> =>
    isOrchestratorCaller(vmAgentId)
      ? Effect.gen(function* () {
          const { orchestrator } = yield* settings.getSettings;
          const now = DateTime.formatIso(yield* DateTime.now);
          return Option.some(
            orchestratorCallerAgent({ voice: orchestrator.voice.trim() || null, now }),
          );
        })
      : agents.getById(vmAgentId);
