import { describe, expect, it } from "vite-plus/test";

import {
  deriveWorkingSideChatsByParent,
  isSideChatActivelyWorking,
  sideChatDisplayTitle,
  sideChatParentActivityKey,
} from "./sideChat";

describe("sideChatDisplayTitle", () => {
  it("removes only the generated side-chat suffix", () => {
    expect(sideChatDisplayTitle("Investigate scroll jank (side chat)")).toBe(
      "Investigate scroll jank",
    );
    expect(sideChatDisplayTitle("Side chat notes")).toBe("Side chat notes");
  });
});

describe("side-chat activity", () => {
  const child = {
    id: "child-1",
    environmentId: "env-1",
    isSideChat: true,
    sideChatParentThreadId: "parent-1",
    archivedAt: null,
    updatedAt: "2026-08-03T12:00:00.000Z",
    latestTurn: {
      requestedAt: "2026-08-03T11:59:00.000Z",
      startedAt: "2026-08-03T11:59:05.000Z",
    },
    session: { status: "running", updatedAt: "2026-08-03T11:59:05.000Z" },
  };

  it("counts active children by durable parent and keeps the earliest start", () => {
    const activity = deriveWorkingSideChatsByParent([
      child,
      {
        ...child,
        id: "child-2",
        latestTurn: {
          requestedAt: "2026-08-03T11:58:00.000Z",
          startedAt: "2026-08-03T11:58:10.000Z",
        },
        session: { status: "starting", updatedAt: "2026-08-03T11:58:10.000Z" },
      },
    ]).get(sideChatParentActivityKey("env-1", "parent-1"));

    expect(activity).toEqual({
      count: 2,
      threadIds: ["child-1", "child-2"],
      startedAt: "2026-08-03T11:58:10.000Z",
    });
  });

  it("drops archived and promoted children instead of retaining a stale parent reference", () => {
    expect(
      deriveWorkingSideChatsByParent([
        { ...child, archivedAt: "2026-08-03T12:01:00.000Z" },
        { ...child, id: "promoted", isSideChat: false, sideChatParentThreadId: null },
      ]).size,
    ).toBe(0);
  });

  it("treats both provider startup and an active turn as work", () => {
    expect(isSideChatActivelyWorking(child)).toBe(true);
    expect(
      isSideChatActivelyWorking({
        ...child,
        session: { status: "ready", updatedAt: child.updatedAt },
      }),
    ).toBe(false);
  });

  it("keeps a startup auto-resume visible before the provider session starts", () => {
    const readyChild = {
      ...child,
      session: { status: "ready", updatedAt: child.updatedAt },
    };
    const activity = deriveWorkingSideChatsByParent([readyChild], {
      "env-1:child-1": "2026-08-03T11:57:00.000Z",
    }).get("env-1:parent-1");
    expect(activity).toMatchObject({
      count: 1,
      threadIds: ["child-1"],
      startedAt: "2026-08-03T11:57:00.000Z",
    });
  });
});
