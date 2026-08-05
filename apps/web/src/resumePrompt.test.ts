import { describe, expect, it } from "vite-plus/test";

import { isResumePrompt, RESUME_PROMPT } from "./resumePrompt";

describe("resume prompts", () => {
  it("uses the contextual app-authored resume instruction", () => {
    expect(RESUME_PROMPT).toBe(
      "Please resume your current task using the context provided and pick up exactly where you left off.",
    );
  });

  it("recognizes current and already-persisted legacy resume turns only", () => {
    expect(isResumePrompt(RESUME_PROMPT)).toBe(true);
    expect(isResumePrompt("resume")).toBe(true);
    expect(isResumePrompt("Resume please")).toBe(false);
  });
});
