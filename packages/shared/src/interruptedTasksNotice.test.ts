import { describe, expect, it } from "vite-plus/test";

import {
  appendInterruptedTasksNotice,
  buildInterruptedTasksNotice,
  describeInterruptedTasks,
  extractTrailingInterruptedTasksNotice,
} from "./interruptedTasksNotice.ts";

describe("interrupted tasks notice", () => {
  it("round-trips the prompt and the task titles", () => {
    const prompt = appendInterruptedTasksNotice("check the build", [
      "Ran command: npm test",
      "Searched text",
    ]);
    const extracted = extractTrailingInterruptedTasksNotice(prompt);
    expect(extracted.promptText).toBe("check the build");
    expect(extracted.titles).toEqual(["Ran command: npm test", "Searched text"]);
  });

  it("tells the agent what to do about it", () => {
    // The whole reason this rides in the prompt rather than sitting in the UI:
    // the agent's next turn otherwise has no idea its work was killed.
    const block = buildInterruptedTasksNotice(["Ran command"]);
    expect(block).toContain("Restart any that are still needed");
  });

  it("keeps the instruction out of the badge", () => {
    const prompt = appendInterruptedTasksNotice("hi", ["Ran command"]);
    expect(extractTrailingInterruptedTasksNotice(prompt).titles).toEqual(["Ran command"]);
  });

  it("changes nothing when no task was interrupted", () => {
    expect(appendInterruptedTasksNotice("hi", [])).toBe("hi");
    expect(buildInterruptedTasksNotice([])).toBe("");
    expect(extractTrailingInterruptedTasksNotice("hi")).toEqual({ promptText: "hi", titles: [] });
  });

  it("survives a task title containing newlines", () => {
    // Titles come from provider progress text, which is not guaranteed to be
    // one line — and one stray newline would otherwise eat the rest of the list.
    const prompt = appendInterruptedTasksNotice("go", ["Ran\ncommand   with  gaps", "Second"]);
    expect(extractTrailingInterruptedTasksNotice(prompt).titles).toEqual([
      "Ran command with gaps",
      "Second",
    ]);
  });

  it("works on a message that was only an interruption", () => {
    const prompt = appendInterruptedTasksNotice("", ["Ran command"]);
    const extracted = extractTrailingInterruptedTasksNotice(prompt);
    expect(extracted.promptText).toBe("");
    expect(extracted.titles).toEqual(["Ran command"]);
  });

  it("still strips a block that is no longer trailing so the XML never reaches the bubble", () => {
    const text = `${buildInterruptedTasksNotice(["Ran command"])}\n\nand then I typed more`;
    const extracted = extractTrailingInterruptedTasksNotice(text);
    expect(extracted.titles).toEqual(["Ran command"]);
    expect(extracted.promptText).toBe("and then I typed more");
    expect(extracted.promptText).not.toContain("interrupted_background_tasks");
  });

  it("strips the Preview-only cancellation that leaked as the whole bubble", () => {
    const text = [
      "<interrupted_background_tasks>",
      "The user sent this message, which deliberately cancelled the background tasks listed below. They were killed on purpose and did not fail: ignore any non-zero exit code, kill signal, or truncated output they reported, and do not investigate those as errors or draw conclusions about the machine from them. Restart any that are still needed.",
      "- Preview",
      "</interrupted_background_tasks>",
    ].join("\n");
    const extracted = extractTrailingInterruptedTasksNotice(text);
    expect(extracted.promptText).toBe("");
    expect(extracted.titles).toEqual(["Preview"]);
  });

  it("strips a CRLF copy of the block", () => {
    const text = appendInterruptedTasksNotice("check the build", ["Preview"]).replaceAll(
      "\n",
      "\r\n",
    );
    const extracted = extractTrailingInterruptedTasksNotice(text);
    expect(extracted.promptText).toBe("check the build");
    expect(extracted.titles).toEqual(["Preview"]);
    expect(extracted.promptText).not.toContain("interrupted_background_tasks");
  });
});

describe("describeInterruptedTasks", () => {
  it("counts, and gets the singular right", () => {
    expect(describeInterruptedTasks(["a"])).toBe("1 background task interrupted");
    expect(describeInterruptedTasks(["a", "b"])).toBe("2 background tasks interrupted");
  });
});
