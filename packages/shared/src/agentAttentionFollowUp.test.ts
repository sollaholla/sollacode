import { describe, expect, it } from "vite-plus/test";

import { mergeWaitingOnYouFollowUpDraft } from "./agentAttentionFollowUp.ts";

describe("mergeWaitingOnYouFollowUpDraft", () => {
  it("preserves an existing draft and adds a readable boundary", () => {
    expect(mergeWaitingOnYouFollowUpDraft("Use the work account", "Sign in to X")).toBe(
      "Use the work account\n\nFollow-up on “Sign in to X”: ",
    );
  });

  it("does not duplicate the same follow-up intent", () => {
    const draft = "Follow-up on “Sign in to X”: use the other account";
    expect(mergeWaitingOnYouFollowUpDraft(draft, "Sign in to X")).toBe(draft);
  });
});
