import { describe, expect, it } from "vite-plus/test";

import { agentDeletionMismatchHint, canConfirmAgentDeletion } from "./deleteAgentConfirmation";

describe("canConfirmAgentDeletion", () => {
  it("authorises an exact name", () => {
    expect(canConfirmAgentDeletion({ agentName: "Scout", typed: "Scout" })).toBe(true);
  });

  it("forgives surrounding whitespace, which is invisible and never meant", () => {
    expect(canConfirmAgentDeletion({ agentName: "Scout", typed: "  Scout " })).toBe(true);
    expect(canConfirmAgentDeletion({ agentName: " Scout ", typed: "Scout" })).toBe(true);
  });

  it("does not forgive case: two agents differing only in case are two agents", () => {
    expect(canConfirmAgentDeletion({ agentName: "Scout", typed: "scout" })).toBe(false);
    expect(canConfirmAgentDeletion({ agentName: "Scout", typed: "SCOUT" })).toBe(false);
  });

  it("refuses a prefix, a suffix, and inner whitespace changes", () => {
    expect(canConfirmAgentDeletion({ agentName: "Scout", typed: "Sco" })).toBe(false);
    expect(canConfirmAgentDeletion({ agentName: "Scout", typed: "Scout2" })).toBe(false);
    expect(canConfirmAgentDeletion({ agentName: "Night Scout", typed: "NightScout" })).toBe(false);
  });

  it("refuses everything when the agent has no usable name", () => {
    // Otherwise an empty field would authorise deleting it.
    expect(canConfirmAgentDeletion({ agentName: "   ", typed: "" })).toBe(false);
    expect(canConfirmAgentDeletion({ agentName: "", typed: "" })).toBe(false);
  });
});

describe("agentDeletionMismatchHint", () => {
  it("stays quiet until something is typed", () => {
    expect(agentDeletionMismatchHint({ agentName: "Scout", typed: "" })).toBeNull();
  });

  it("stays quiet once the name matches", () => {
    expect(agentDeletionMismatchHint({ agentName: "Scout", typed: "Scout" })).toBeNull();
  });

  it("names what is expected while it does not match", () => {
    expect(agentDeletionMismatchHint({ agentName: "Scout", typed: "sco" })).toBe(
      "Type Scout exactly to confirm.",
    );
  });
});
