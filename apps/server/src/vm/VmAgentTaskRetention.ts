import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

import { VmAgentWorkspaceStore } from "../persistence/Services/VmAgentWorkspaces.ts";
import { VmAgentWorkspace } from "./VmAgentWorkspace.ts";

export const COMPLETED_AGENT_TASK_RETENTION_HOURS = 1;
export const COMPLETED_AGENT_TASK_PURGE_INTERVAL = Duration.minutes(1);

export const purgeExpiredCompletedAgentTasks = Effect.fn(
  "VmAgentTaskRetention.purgeExpiredCompletedAgentTasks",
)(function* (now: DateTime.Utc) {
  const store = yield* VmAgentWorkspaceStore;
  const workspace = yield* VmAgentWorkspace;
  const cutoff = DateTime.formatIso(
    DateTime.subtract(now, { hours: COMPLETED_AGENT_TASK_RETENTION_HOURS }),
  );
  const affectedAgentIds = yield* store.purgeCompletedTasks({ cutoff });

  yield* Effect.forEach(
    affectedAgentIds,
    (vmAgentId) =>
      workspace.refresh(vmAgentId).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("completed agent task purge refresh failed", {
            vmAgentId,
            cause,
          }),
        ),
      ),
    { discard: true },
  );

  if (affectedAgentIds.length > 0) {
    yield* Effect.logInfo("completed agent tasks purged", {
      taskRetentionHours: COMPLETED_AGENT_TASK_RETENTION_HOURS,
      affectedAgentCount: affectedAgentIds.length,
    });
  }

  return affectedAgentIds;
});

const runPurgeSafely = Effect.gen(function* () {
  const now = yield* DateTime.now;
  yield* purgeExpiredCompletedAgentTasks(now);
}).pipe(
  Effect.catchCause((cause) =>
    Effect.logWarning("completed agent task purge failed", {
      taskRetentionHours: COMPLETED_AGENT_TASK_RETENTION_HOURS,
      cause,
    }),
  ),
);

export const startVmAgentTaskRetention = runPurgeSafely.pipe(
  Effect.repeat(Schedule.spaced(COMPLETED_AGENT_TASK_PURGE_INTERVAL)),
  Effect.asVoid,
);
