import { describe, expect, it } from "vite-plus/test";

import { isHistoryUnusableFailure } from "./historyUnusableFailure.ts";

describe("isHistoryUnusableFailure", () => {
  it("recognises the two failures seen live on 2026-09-12", () => {
    expect(
      isHistoryUnusableFailure(
        "Execution failed: HTTP 413: 413 Failed to buffer the request body: length limit exceeded [trace ID: faf29126db0aedc3c21c7ed5f006c91b]",
      ),
    ).toBe(true);
    expect(
      isHistoryUnusableFailure(
        "provider-private history is incompatible with the active route: reasoning replay `rs_6aa564d27de529e1bd894758:rs_01a09611d4b3`",
      ),
    ).toBe(true);
  });

  it("recognises the common context-window overflow wordings", () => {
    expect(isHistoryUnusableFailure("prompt is too long: 213000 tokens > 200000 maximum")).toBe(
      true,
    );
    expect(
      isHistoryUnusableFailure(
        "This model's maximum context length is 128000 tokens. However, your messages resulted in 131000 tokens.",
      ),
    ).toBe(true);
    expect(isHistoryUnusableFailure("Error: context_length_exceeded")).toBe(true);
  });

  it("recognises Claude Code giving up on its own compaction", () => {
    expect(
      isHistoryUnusableFailure(
        "Autocompact is thrashing: the context refilled to the limit within 3 turns of the previous compact, 3 times in a row. A file being read or a tool output is likely too large for the context window.",
      ),
    ).toBe(true);
  });

  it("leaves ordinary and transient failures alone", () => {
    expect(isHistoryUnusableFailure(null)).toBe(false);
    expect(isHistoryUnusableFailure("")).toBe(false);
    expect(isHistoryUnusableFailure("HTTP 429: rate limit reached")).toBe(false);
    expect(isHistoryUnusableFailure("HTTP 500: upstream overloaded")).toBe(false);
    expect(isHistoryUnusableFailure("The turn failed.")).toBe(false);
    expect(isHistoryUnusableFailure("Muse Code needs you to sign in.")).toBe(false);
  });
});
