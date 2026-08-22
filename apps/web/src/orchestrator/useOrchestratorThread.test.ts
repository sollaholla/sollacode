import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { EnvironmentId, ORCHESTRATOR_THREAD_ID, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolvePrimaryOrchestratorThread } from "./useOrchestratorThread";

const shell = (environmentId: string, threadId: string = ORCHESTRATOR_THREAD_ID) =>
  ({
    environmentId: EnvironmentId.make(environmentId),
    id: ThreadId.make(threadId),
  }) as EnvironmentThreadShell;

describe("resolvePrimaryOrchestratorThread", () => {
  it("selects the primary copy even when a remote environment sorts first", () => {
    const primaryEnvironmentId = EnvironmentId.make("z-primary");
    const target = resolvePrimaryOrchestratorThread(
      [shell("a-remote"), shell(primaryEnvironmentId)],
      primaryEnvironmentId,
    );

    expect(target?.ref).toEqual({
      environmentId: primaryEnvironmentId,
      threadId: ORCHESTRATOR_THREAD_ID,
    });
    expect(target?.shell.environmentId).toBe(primaryEnvironmentId);
  });

  it("never falls back to a remote orchestrator", () => {
    expect(
      resolvePrimaryOrchestratorThread([shell("a-remote")], EnvironmentId.make("z-primary")),
    ).toBeNull();
    expect(resolvePrimaryOrchestratorThread([shell("a-remote")], null)).toBeNull();
  });

  it("ignores ordinary threads on the primary environment", () => {
    const primaryEnvironmentId = EnvironmentId.make("primary");
    expect(
      resolvePrimaryOrchestratorThread(
        [shell(primaryEnvironmentId, "ordinary-thread")],
        primaryEnvironmentId,
      ),
    ).toBeNull();
  });
});
