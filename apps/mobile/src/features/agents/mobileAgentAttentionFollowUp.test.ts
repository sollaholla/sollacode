import { describe, expect, it, vi } from "@effect/vitest";

import { openMobileWaitingOnYouFollowUp } from "./mobileAgentAttentionFollowUp";

describe("mobile Waiting on you follow-up", () => {
  it("preserves the draft, requests composer focus, and opens the agent thread", async () => {
    let draft = "Use the work account";
    const order: string[] = [];
    const requestFocus = vi.fn(() => order.push("focus"));
    const navigate = vi.fn(() => order.push("navigate"));

    await openMobileWaitingOnYouFollowUp({
      blockerTitle: "Sign in to X",
      draftKey: "environment-1:thread-1",
      environmentId: "environment-1",
      threadId: "thread-1",
      transformDraftText: async (draftKey, transform) => {
        expect(draftKey).toBe("environment-1:thread-1");
        draft = transform(draft);
        order.push("draft");
      },
      requestFocus,
      navigate,
    });

    expect(draft).toBe("Use the work account\n\nFollow-up on “Sign in to X”: ");
    expect(requestFocus).toHaveBeenCalledWith("environment-1:thread-1");
    expect(navigate).toHaveBeenCalledWith({
      environmentId: "environment-1",
      threadId: "thread-1",
    });
    expect(order).toEqual(["draft", "focus", "navigate"]);
  });
});
