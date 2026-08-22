import { describe, expect, it } from "vite-plus/test";

import {
  DUPLICATE_UTTERANCE_MS,
  GROK_UTTERANCE_SETTLE_MS,
  UTTERANCE_SETTLE_MS,
  isTranscriptRefinement,
  shouldCommitUtterance,
} from "./utteranceCoalesce";

describe("Grok utterance settle", () => {
  it("holds a Grok turn open longer than OpenAI after VAD stop", () => {
    expect(GROK_UTTERANCE_SETTLE_MS).toBeGreaterThan(UTTERANCE_SETTLE_MS);
    expect(GROK_UTTERANCE_SETTLE_MS).toBeGreaterThanOrEqual(1_000);
  });
});

describe("isTranscriptRefinement", () => {
  it("treats an identical line as the same utterance", () => {
    expect(isTranscriptRefinement("How's it going?", "How's it going?")).toBe(true);
    expect(isTranscriptRefinement("Hello?", "Hello?")).toBe(true);
  });

  it("treats a growing partial as the same utterance", () => {
    // Live Grok Voice: first commit was "How's." then the same turn finished.
    expect(isTranscriptRefinement("How's.", "How's it going?")).toBe(true);
  });

  it("does not merge two different things said close together", () => {
    expect(isTranscriptRefinement("How's it going?", "Hello?")).toBe(false);
    expect(isTranscriptRefinement("yes", "no")).toBe(false);
  });
});

describe("shouldCommitUtterance", () => {
  it("commits the first line of a session", () => {
    expect(
      shouldCommitUtterance({
        pending: { text: "Hello?" },
        lastCommitted: null,
        nowMs: 1_000,
      }),
    ).toBe(true);
  });

  it("drops a second completed event for the same item", () => {
    expect(
      shouldCommitUtterance({
        pending: { text: "How's it going?", itemId: "item-1" },
        lastCommitted: { text: "How's it going?", itemId: "item-1", atMs: 1_000 },
        nowMs: 1_100,
      }),
    ).toBe(false);
  });

  it("drops the same words arriving again a moment later", () => {
    expect(
      shouldCommitUtterance({
        pending: { text: "How's it going?" },
        lastCommitted: { text: "How's it going?", atMs: 1_000 },
        nowMs: 1_000 + 400,
      }),
    ).toBe(false);
  });

  it("drops the same line when Grok repeats it more than two seconds later", () => {
    expect(
      shouldCommitUtterance({
        pending: { text: "Hey, what's up?" },
        lastCommitted: { text: "Hey, what's up?", atMs: 20_10_37_240 },
        nowMs: 20_10_37_240 + 3_250,
      }),
    ).toBe(false);
  });

  it("allows the same word after a real pause", () => {
    // "yes" then "yes" again is a second answer, not a duplicate event.
    expect(
      shouldCommitUtterance({
        pending: { text: "yes" },
        lastCommitted: { text: "yes", atMs: 1_000 },
        nowMs: 1_000 + DUPLICATE_UTTERANCE_MS + 1,
      }),
    ).toBe(true);
  });
});
