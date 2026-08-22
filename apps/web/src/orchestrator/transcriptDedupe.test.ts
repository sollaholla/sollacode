import { describe, expect, it } from "vite-plus/test";

import { isRepeatedAssistantLine, isRepeatedUserLine, REPEAT_WINDOW_MS } from "./transcriptDedupe";

const assistant = (text: string, atMs: number) => ({ role: "assistant" as const, text, atMs });

describe("isRepeatedAssistantLine", () => {
  it("drops the same line said twice with nothing between", () => {
    expect(
      isRepeatedAssistantLine({
        role: "assistant",
        text: "Checking that.",
        previous: assistant("Checking that.", 1_000),
        nowMs: 1_400,
      }),
    ).toBe(true);
  });

  it("ignores trailing punctuation and spacing between the copies", () => {
    expect(
      isRepeatedAssistantLine({
        role: "assistant",
        text: "Checking  that",
        previous: assistant("Checking that.", 1_000),
        nowMs: 1_200,
      }),
    ).toBe(true);
  });

  it("keeps an identical line once the user has spoken in between", () => {
    // The orchestrator is told to acknowledge before *every* tool call, so the
    // same short phrase for a new question is the system working. Only two
    // assistant lines with nothing between them can be one line twice.
    expect(
      isRepeatedAssistantLine({
        role: "assistant",
        text: "Checking that.",
        previous: { role: "user", text: "and the other one?", atMs: 1_000 },
        nowMs: 1_400,
      }),
    ).toBe(false);
  });

  it("keeps an identical line said long enough afterwards", () => {
    expect(
      isRepeatedAssistantLine({
        role: "assistant",
        text: "Checking that.",
        previous: assistant("Checking that.", 0),
        nowMs: REPEAT_WINDOW_MS + 1,
      }),
    ).toBe(false);
  });

  it("does not treat a user line as an assistant repeat", () => {
    expect(
      isRepeatedAssistantLine({
        role: "user",
        text: "yes",
        previous: { role: "user", text: "yes", atMs: 1_000 },
        nowMs: 1_100,
      }),
    ).toBe(false);
  });
});

describe("isRepeatedUserLine", () => {
  it("drops the same spoken sentence arriving again a few seconds later", () => {
    // Live Grok Voice: one "Hey, what's up?" became three messages 3.2s apart.
    expect(
      isRepeatedUserLine({
        role: "user",
        text: "Hey, what's up?",
        previous: { role: "user", text: "Hey, what's up?", atMs: 1_000 },
        nowMs: 4_250,
      }),
    ).toBe(true);
  });

  it("keeps a second yes after the assistant has spoken", () => {
    expect(
      isRepeatedUserLine({
        role: "user",
        text: "yes",
        previous: { role: "assistant", text: "Should I send that?", atMs: 1_000 },
        nowMs: 1_400,
      }),
    ).toBe(false);
  });
});
