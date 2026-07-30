import { describe, expect, it, vi } from "vite-plus/test";

import { findLowContextWarningMatches, runCompactAndContinue } from "./lowContextWarning";

describe("findLowContextWarningMatches", () => {
  it.each([
    ["I'm running out of context, so I should compact.", "I'm running out of context"],
    ["Context is low. I should compact before continuing.", "Context is low"],
    ["Warning: Running low on context.", "Running low on context"],
    ["We are approaching the context window limit.", "We are approaching the context window limit"],
    ["Almost out of context. Let me preserve the result.", "Almost out of context"],
  ])("detects a direct warning in %j", (text, phrase) => {
    expect(findLowContextWarningMatches(text).map((match) => match.phrase)).toEqual([phrase]);
  });

  it.each([
    'The docs say "context is low" is a warning.',
    "If context is low, compaction can help.",
    "We discussed context limits and compaction strategies.",
    "The phrase “I'm running out of context” appears in the test.",
    "A context window is a model constraint.",
  ])("rejects quoted, conditional, or generic discussion in %j", (text) => {
    expect(findLowContextWarningMatches(text)).toEqual([]);
  });
});

describe("runCompactAndContinue", () => {
  it("waits for confirmed compaction before sending the continuation", async () => {
    const order: string[] = [];
    let resolveCompaction!: () => void;
    const compactionComplete = new Promise<void>((resolve) => {
      resolveCompaction = resolve;
    });
    const sendContinuation = vi.fn(async () => {
      order.push("continue");
    });

    const workflow = runCompactAndContinue({
      onStageChange: (stage) => order.push(`stage:${stage}`),
      startCompaction: async () => {
        order.push("compact-started");
      },
      awaitCompactionComplete: async () => {
        order.push("waiting");
        await compactionComplete;
        order.push("compact-complete");
      },
      sendContinuation,
    });

    await Promise.resolve();
    expect(order).toEqual(["stage:compacting", "compact-started", "waiting"]);
    expect(sendContinuation).not.toHaveBeenCalled();

    resolveCompaction();
    await workflow;
    expect(order).toEqual([
      "stage:compacting",
      "compact-started",
      "waiting",
      "compact-complete",
      "stage:continuing",
      "continue",
    ]);
  });

  it("does not continue when provider compaction fails", async () => {
    const sendContinuation = vi.fn(async () => {});
    await expect(
      runCompactAndContinue({
        startCompaction: async () => {},
        awaitCompactionComplete: async () => {
          throw new Error("provider did not compact");
        },
        sendContinuation,
      }),
    ).rejects.toThrow("provider did not compact");
    expect(sendContinuation).not.toHaveBeenCalled();
  });
});
