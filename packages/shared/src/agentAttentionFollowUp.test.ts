import { describe, expect, it } from "vite-plus/test";

import {
  mergeWaitingOnYouFollowUpDraft,
  prependWaitingOnYouReply,
} from "./agentAttentionFollowUp.ts";

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

describe("prependWaitingOnYouReply", () => {
  it("leads with the request so the reply explains itself", () => {
    expect(prependWaitingOnYouReply("Use the work account", "Sign in to X")).toBe(
      "> **Replying to your request:** Sign in to X\n" +
        "> This message is the answer to it, and the request is now resolved.\n\n" +
        "Use the work account",
    );
  });

  it("stays a prefix, so trailing context blocks still parse", () => {
    const withTrailingBlock = "Do it\n\n<terminal-context>...</terminal-context>";
    expect(prependWaitingOnYouReply(withTrailingBlock, "Sign in to X")).toMatch(
      /<terminal-context>\.\.\.<\/terminal-context>$/,
    );
  });

  it("adds nothing for a request with no title to quote", () => {
    expect(prependWaitingOnYouReply("Use the work account", "   ")).toBe("Use the work account");
  });
});
