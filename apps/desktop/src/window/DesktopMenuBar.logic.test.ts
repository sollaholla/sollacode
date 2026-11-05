import type { DesktopMenuBarChat } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_MENU_BAR_STATS,
  menuBarChatLines,
  menuBarResources,
  menuBarSummary,
  menuBarTitle,
  openThreadMenuAction,
} from "./DesktopMenuBar.logic.ts";

function chat(title: string, status: DesktopMenuBarChat["status"] = "working") {
  return { environmentId: "env", threadId: title, title, status } satisfies DesktopMenuBarChat;
}

describe("menu bar stats", () => {
  it("says what is going on, leaving out what isn't", () => {
    expect(menuBarSummary(EMPTY_MENU_BAR_STATS)).toBe("Nothing running");
    expect(menuBarSummary({ ...EMPTY_MENU_BAR_STATS, working: 3, paused: 1 })).toBe(
      "3 working · 1 paused",
    );
  });

  it("only counts work in motion beside the icon", () => {
    expect(menuBarTitle({ ...EMPTY_MENU_BAR_STATS, paused: 2 })).toBe("");
    expect(menuBarTitle({ ...EMPTY_MENU_BAR_STATS, working: 2 })).toBe("2");
  });

  it("names a bounded number of chats and shortens long titles", () => {
    const chats = Array.from({ length: 10 }, (_, index) => chat(`Chat ${index}`));
    const lines = menuBarChatLines({ ...EMPTY_MENU_BAR_STATS, chats });
    expect(lines).toHaveLength(9);
    expect(lines.at(-1)).toEqual({ label: "and 2 more" });

    const [long] = menuBarChatLines({
      ...EMPTY_MENU_BAR_STATS,
      chats: [chat("x".repeat(80), "paused")],
    });
    expect(long?.label.endsWith("…")).toBe(true);
    expect(long?.label.length).toBeLessThan(56);
  });

  it("reports the app's own footprint", () => {
    expect(
      menuBarResources({ memoryBytes: 1.5 * 1024 ** 3, cpuPercent: 12.4, uptimeSeconds: 3_900 }),
    ).toBe("1.5 GB memory · 12% CPU · up 1h 5m");
  });

  it("opens the chat a row names", () => {
    expect(openThreadMenuAction(chat("thread-1"))).toBe("open-thread:env/thread-1");
  });
});
