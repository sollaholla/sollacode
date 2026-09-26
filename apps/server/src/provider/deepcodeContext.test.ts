import { describe, expect, it } from "vite-plus/test";
import {
  deepCodeContinuationPrompt,
  inspectDeepCodeContext,
  isDeepCodeContextOverflow,
} from "./deepcodeContext.ts";

describe("Deep Code context recovery", () => {
  it("detects a large tool result without depending on stale usage tokens", () => {
    const raw = JSON.stringify({ role: "tool", content: "字".repeat(300_000) });
    expect(inspectDeepCodeContext(raw).oversized).toBe(true);
    expect(
      inspectDeepCodeContext(JSON.stringify({ compacted: true, content: raw })).oversized,
    ).toBe(false);
  });
  it("bounds excerpts while retaining the original goal and recent decisions", () => {
    const raw = [
      { role: "user", content: "Keep the existing artwork" },
      ...Array.from({ length: 20 }, () => ({ role: "assistant", content: "x".repeat(100_000) })),
      { role: "assistant", content: "The build passed; the runtime check remains" },
    ]
      .map((message) => JSON.stringify(message))
      .join("\n");
    const history = inspectDeepCodeContext(raw);
    expect(history.excerpts.length).toBeLessThan(36_000);
    expect(history.excerpts).toContain("Keep the existing artwork");
    expect(history.excerpts).toContain("runtime check remains");
    const prompt = deepCodeContinuationPrompt({
      prompt: "Rotate the shirts 90 degrees",
      transcriptPath: "/evidence/original.jsonl",
      excerpts: history.excerpts,
    });
    expect(prompt).toContain("/evidence/original.jsonl");
    expect(prompt).toContain("Rotate the shirts 90 degrees");
    expect(prompt).toContain("Do not repeat completed commands");
  });
  it("only retries context rejection, not unrelated HTTP errors", () => {
    expect(
      isDeepCodeContextOverflow(
        "Execution failed: HTTP 400: This model's maximum context length is 1048576 tokens. However, you requested 1287359 tokens",
      ),
    ).toBe(true);
    expect(isDeepCodeContextOverflow("context_length_exceeded")).toBe(true);
    expect(isDeepCodeContextOverflow("HTTP 400 invalid tool call")).toBe(false);
    expect(isDeepCodeContextOverflow("HTTP 429 insufficient balance")).toBe(false);
  });
});
