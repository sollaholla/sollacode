import { describe, expect, it } from "vite-plus/test";

import {
  appendInterruptedTasksNotice,
  buildInterruptedTasksNotice,
  describeInterruptedTasks,
  extractTrailingInterruptedTasksNotice,
} from "./interruptedTasksNotice";

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

  it("ignores a block that is not at the end", () => {
    // Only a trailing block is ours; anything else is the user's own text.
    const text = `${buildInterruptedTasksNotice(["Ran command"])}\n\nand then I typed more`;
    expect(extractTrailingInterruptedTasksNotice(text).titles).toEqual([]);
  });
});

describe("describeInterruptedTasks", () => {
  it("counts, and gets the singular right", () => {
    expect(describeInterruptedTasks(["a"])).toBe("1 background task interrupted");
    expect(describeInterruptedTasks(["a", "b"])).toBe("2 background tasks interrupted");
  });
});
