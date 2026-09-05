import { describe, expect, it } from "vite-plus/test";
import { isSideChatSessionPreparing, isThreadSessionWorking } from "./threadActivity.ts";

describe("side chat session preparation", () => {
  const blank = {
    isSideChat: true,
    session: { status: "starting", activeTurnId: null },
    latestTurn: null,
    pendingWork: null,
  };

  it("keeps a blank fork sendable even when a failed initializer left starting behind", () => {
    expect(isSideChatSessionPreparing(blank)).toBe(true);
    expect(isThreadSessionWorking(blank)).toBe(false);
  });

  it("reports actual queued, starting and running work as busy", () => {
    for (const thread of [
      { ...blank, isSideChat: false },
      { ...blank, latestTurn: { state: "running" } },
      { ...blank, pendingWork: { state: "pending" } },
      { ...blank, session: { status: "starting", activeTurnId: "first-turn" } },
      { ...blank, session: { status: "running", activeTurnId: null } },
    ]) {
      expect(isSideChatSessionPreparing(thread)).toBe(false);
      expect(isThreadSessionWorking(thread)).toBe(true);
    }
  });

  it("leaves disconnected, ready and stopped conversations idle", () => {
    expect(isThreadSessionWorking(undefined)).toBe(false);
    for (const status of ["ready", "error", "stopped", "interrupted"]) {
      expect(isThreadSessionWorking({ ...blank, session: { status } })).toBe(false);
    }
  });
});
