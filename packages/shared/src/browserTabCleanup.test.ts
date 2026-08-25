import { describe, expect, it } from "vite-plus/test";

import {
  browserTabCleanupIds,
  browserTabCleanupPrompt,
  decideBrowserTabCleanup,
  isBrowserTabCleanupMessageId,
} from "./browserTabCleanup.ts";

describe("browser tab cleanup", () => {
  it("uses deterministic synthetic IDs and recognizes only cleanup messages", () => {
    const ids = browserTabCleanupIds({ threadId: "thread-1", completedTurnId: "turn-2" });
    expect(ids).toEqual({
      commandId: "browser-tab-cleanup-command:thread-1:turn-2",
      messageId: "browser-tab-cleanup-message:thread-1:turn-2",
    });
    expect(isBrowserTabCleanupMessageId(ids.messageId)).toBe(true);
    expect(isBrowserTabCleanupMessageId("agent-auto-resume-message:thread-1:turn-2")).toBe(false);
  });

  it("seeds an unknown baseline and compares normalized sets", () => {
    expect(
      decideBrowserTabCleanup({
        baseline: null,
        currentTabIds: ["tab-b", "tab-a"],
        sourceMessageId: null,
      }),
    ).toEqual({ _tag: "RecordCurrent" });
    expect(
      decideBrowserTabCleanup({
        baseline: { tabIds: ["tab-b", "tab-a"] },
        currentTabIds: ["tab-a", "tab-b", "tab-b"],
        sourceMessageId: null,
      }),
    ).toEqual({ _tag: "RecordCurrent" });
  });

  it("requests one cleanup pass for a changed set and suppresses cleanup recursion", () => {
    expect(
      decideBrowserTabCleanup({
        baseline: { tabIds: ["tab-a"] },
        currentTabIds: ["tab-a", "tab-b"],
        sourceMessageId: null,
      }),
    ).toEqual({ _tag: "SendReminder", tabCount: 2 });
    expect(
      decideBrowserTabCleanup({
        baseline: { tabIds: ["tab-a"] },
        currentTabIds: ["tab-a", "tab-b"],
        sourceMessageId: "browser-tab-cleanup-message:thread-1:turn-2",
      }),
    ).toEqual({ _tag: "RecordCurrent" });
  });

  it("reports only the count in the prompt, never raw tab IDs", () => {
    const prompt = browserTabCleanupPrompt(2);
    expect(prompt).toContain("2 tabs are open");
    expect(prompt).toContain("preview_close");
    expect(prompt).toContain("Never close a reused tab");
    expect(prompt).not.toContain("tab-a");
  });
});
