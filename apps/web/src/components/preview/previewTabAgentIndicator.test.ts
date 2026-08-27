import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewTabAgentIndicator } from "./previewTabAgentIndicator.ts";

describe("resolvePreviewTabAgentIndicator", () => {
  it("badges the tab an agent is mid-command in", () => {
    expect(resolvePreviewTabAgentIndicator({ controller: "agent", agentActive: true })).toBe(
      "agent",
    );
  });

  it("keeps the badge between an agent's actions, not just during one", () => {
    // The first version watched `controller` alone, which is only "agent"
    // while a CDP command is in flight — the badge showed for a fraction of a
    // second per tool call and was invisible in between. Reported as: "it does
    // but only for a second".
    expect(resolvePreviewTabAgentIndicator({ controller: "none", agentActive: true })).toBe(
      "agent",
    );
  });

  it("keeps badging a tab where an agent is queued behind the user", () => {
    expect(
      resolvePreviewTabAgentIndicator({ controller: "waiting-for-user", agentActive: false }),
    ).toBe("waiting");
  });

  it("drops the badge on a tab the human has taken over", () => {
    expect(resolvePreviewTabAgentIndicator({ controller: "human", agentActive: true })).toBeNull();
  });

  it("shows nothing for an idle tab no agent has touched", () => {
    expect(resolvePreviewTabAgentIndicator({ controller: "none", agentActive: false })).toBeNull();
    expect(resolvePreviewTabAgentIndicator(undefined)).toBeNull();
  });
});
