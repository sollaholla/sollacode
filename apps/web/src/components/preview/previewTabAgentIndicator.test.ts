import { describe, expect, it } from "vite-plus/test";

import { resolvePreviewTabAgentIndicator } from "./previewTabAgentIndicator.ts";

describe("resolvePreviewTabAgentIndicator", () => {
  it("badges the tab an agent is driving", () => {
    expect(resolvePreviewTabAgentIndicator("agent")).toBe("agent");
  });

  it("keeps badging a tab where an agent is queued behind the user", () => {
    // Showing nothing here would read as "no agent in this tab" precisely when
    // the user is deciding whether to click into it.
    expect(resolvePreviewTabAgentIndicator("waiting-for-user")).toBe("waiting");
  });

  it("shows nothing for a tab the human is driving, or an idle one", () => {
    expect(resolvePreviewTabAgentIndicator("human")).toBeNull();
    expect(resolvePreviewTabAgentIndicator("none")).toBeNull();
    expect(resolvePreviewTabAgentIndicator(undefined)).toBeNull();
  });
});
