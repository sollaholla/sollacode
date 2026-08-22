import { describe, expect, it } from "vite-plus/test";

import {
  CONVERSATION_GAP_MS,
  entriesSinceLastBoundary,
  findConversationBoundaries,
  isNewConversationBoundary,
} from "./conversationBoundary";

const at = (minutes: number) => new Date(Date.UTC(2026, 0, 1, 0, minutes)).toISOString();

describe("isNewConversationBoundary", () => {
  it("treats a long silence as a new conversation", () => {
    expect(isNewConversationBoundary({ previousCreatedAt: at(0), createdAt: at(45) })).toBe(true);
  });

  it("keeps an ordinary pause inside one conversation", () => {
    // A false boundary is worse than a missed one: it tells the model to forget
    // something the user still considers live.
    expect(isNewConversationBoundary({ previousCreatedAt: at(0), createdAt: at(5) })).toBe(false);
  });

  it("fires exactly at the threshold", () => {
    const previous = at(0);
    const createdAt = new Date(Date.parse(previous) + CONVERSATION_GAP_MS).toISOString();
    expect(isNewConversationBoundary({ previousCreatedAt: previous, createdAt })).toBe(true);
  });

  it("never marks the first entry", () => {
    // Nothing precedes it, and a separator above the very first line is noise.
    expect(isNewConversationBoundary({ previousCreatedAt: null, createdAt: at(0) })).toBe(false);
  });

  it("refuses to split a conversation on a bad or backwards clock", () => {
    expect(isNewConversationBoundary({ previousCreatedAt: "nonsense", createdAt: at(0) })).toBe(
      false,
    );
    expect(isNewConversationBoundary({ previousCreatedAt: at(90), createdAt: at(0) })).toBe(false);
  });
});

describe("findConversationBoundaries", () => {
  it("marks each entry that opens a new sitting", () => {
    const entries = [
      { createdAt: at(0) },
      { createdAt: at(2) },
      { createdAt: at(200) },
      { createdAt: at(201) },
      { createdAt: at(400) },
    ];
    expect([...findConversationBoundaries(entries)]).toEqual([2, 4]);
  });

  it("finds nothing in one continuous conversation", () => {
    const entries = [{ createdAt: at(0) }, { createdAt: at(3) }, { createdAt: at(6) }];
    expect(findConversationBoundaries(entries).size).toBe(0);
  });
});

describe("entriesSinceLastBoundary", () => {
  it("keeps only the conversation in progress", () => {
    // Older conversations are not wrong to remember, but they crowd out the
    // exchange the user is actually in, and the budget is small.
    const entries = [
      { createdAt: at(0), text: "old" },
      { createdAt: at(200), text: "new" },
      { createdAt: at(201), text: "newer" },
    ];
    expect(entriesSinceLastBoundary(entries).map((entry) => entry.text)).toEqual(["new", "newer"]);
  });

  it("keeps everything when there is only one conversation", () => {
    const entries = [{ createdAt: at(0) }, { createdAt: at(4) }];
    expect(entriesSinceLastBoundary(entries)).toHaveLength(2);
  });

  it("handles an empty history", () => {
    expect(entriesSinceLastBoundary([])).toEqual([]);
  });
});
