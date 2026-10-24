import { describe, expect, it } from "vite-plus/test";

import { isThreadWorking, type ThreadWorkingInput } from "./threadWorking.ts";

const now = Date.parse("2026-10-12T16:20:18.000Z");
const at = (clock: string) => `2026-10-12T${clock}.000Z`;

const session = (status: string, activeTurnId: string | null = null) => ({
  status,
  activeTurnId,
});
const finishedTurn = { startedAt: at("15:55:18"), completedAt: at("15:56:18") };
const openTurn = { startedAt: at("16:17:18"), completedAt: null };

describe("isThreadWorking", () => {
  it("reads a session in flight as working", () => {
    expect(isThreadWorking({ session: session("running", "turn-1") }, now)).toBe(true);
    expect(isThreadWorking({ session: session("starting") }, now)).toBe(true);
  });

  it("does not count a blank side chat whose session is only being prepared", () => {
    expect(isThreadWorking({ isSideChat: true, session: session("starting") }, now)).toBe(false);
  });

  it("keeps a thread working while background tasks its finished turn started still report", () => {
    // The Undead Open World side chat (2026-10-12): turn completed, session
    // ready, two background builds still writing output.
    const thread: ThreadWorkingInput = {
      isSideChat: true,
      session: session("ready"),
      latestTurn: finishedTurn,
      backgroundTasks: { count: 2, startedAt: at("15:54:18"), lastActivityAt: at("16:20:18") },
    };
    expect(isThreadWorking(thread, now)).toBe(true);
    expect(
      isThreadWorking(
        {
          ...thread,
          backgroundTasks: { count: 2, startedAt: at("14:50:18"), lastActivityAt: at("15:49:18") },
        },
        now,
      ),
    ).toBe(false);
    expect(isThreadWorking({ ...thread, session: session("stopped") }, now)).toBe(false);
  });

  it("counts scheduled work, but not work held for a person", () => {
    const thread: ThreadWorkingInput = { session: session("ready"), latestTurn: finishedTurn };
    for (const state of ["pending", "claimed", "executing", "sleeping"]) {
      expect(isThreadWorking({ ...thread, pendingWork: { state } }, now)).toBe(true);
    }
    expect(
      isThreadWorking({ ...thread, pendingWork: { state: "blocked-authentication" } }, now),
    ).toBe(false);
  });

  it("reads a started turn as working while the session projection lags it", () => {
    expect(isThreadWorking({ session: session("ready"), latestTurn: openTurn }, now)).toBe(true);
    expect(isThreadWorking({ session: null, latestTurn: openTurn }, now)).toBe(true);
    for (const status of ["error", "stopped", "interrupted"]) {
      expect(isThreadWorking({ session: session(status), latestTurn: openTurn }, now)).toBe(false);
    }
  });

  it("reads a settled thread with nothing left running as idle", () => {
    expect(isThreadWorking({ session: session("ready"), latestTurn: finishedTurn }, now)).toBe(
      false,
    );
    expect(isThreadWorking({}, now)).toBe(false);
  });
});
