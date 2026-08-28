import type { VmAgentWorkspaceSnapshot } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hasAgentDashboard } from "./agentWorkspaceNavigation";

const workspaceWithArtifact = (
  definition: NonNullable<VmAgentWorkspaceSnapshot["artifact"]>["definition"],
) =>
  ({
    artifact: {
      title: "Agent view",
      definition,
      revision: 1,
      updatedAt: "2026-08-25T00:00:00.000Z",
    },
  }) as VmAgentWorkspaceSnapshot;

describe("hasAgentDashboard", () => {
  it("hides absent and schedule artifacts that duplicate Scheduled work", () => {
    expect(hasAgentDashboard(null)).toBe(false);
    expect(hasAgentDashboard({ artifact: null } as VmAgentWorkspaceSnapshot)).toBe(false);
    expect(hasAgentDashboard(workspaceWithArtifact({ kind: "schedule" }))).toBe(false);
  });

  it("shows custom structured views", () => {
    expect(
      hasAgentDashboard(
        workspaceWithArtifact({
          kind: "metrics",
          metrics: [{ label: "Published", value: "12" }],
        }),
      ),
    ).toBe(true);
  });

  it("shows an HTML dashboard the same way as other custom views", () => {
    expect(
      hasAgentDashboard(
        workspaceWithArtifact({
          kind: "html",
          html: "<h1>Inbox</h1>",
        }),
      ),
    ).toBe(true);
  });
});
