import {
  VmAgentBlockerId,
  VmAgentId,
  VmAgentNotificationId,
  type VmAgentBlocker,
  type VmAgentNotification,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  MAX_INLINE_AGENT_ATTENTION_CARDS,
  resolveInlineAgentAttention,
  resolveInlineAgentNotification,
  shouldSendAgentDesktopNotification,
} from "./agentNotifications";

const notification = (
  id: string,
  createdAt: string,
  overrides: Partial<VmAgentNotification> = {},
): VmAgentNotification => ({
  notificationId: VmAgentNotificationId.make(id),
  vmAgentId: VmAgentId.make("scout"),
  taskId: null,
  runId: null,
  kind: "agent-message",
  title: `Alert ${id}`,
  body: "Details",
  deepLink: "/agents/local/scout",
  readAt: null,
  archivedAt: null,
  createdAt,
  ...overrides,
});

const blocker = (id: string, updatedAt: string): VmAgentBlocker => ({
  blockerId: VmAgentBlockerId.make(id),
  vmAgentId: VmAgentId.make("scout"),
  title: `Blocker ${id}`,
  detail: "Needs the user.",
  url: null,
  createdAt: updatedAt,
  updatedAt,
  resolvedAt: null,
  resolvedBy: null,
});

describe("resolveInlineAgentNotification", () => {
  it("shows the newest unread alert without cascading through older alerts after marking it read", () => {
    const older = notification("older", "2026-08-25T12:00:00.000Z");
    const newest = notification("newest", "2026-08-25T13:00:00.000Z");

    expect(resolveInlineAgentNotification([older, newest], null)?.notificationId).toBe(
      newest.notificationId,
    );
    expect(
      resolveInlineAgentNotification(
        [older, { ...newest, readAt: "2026-08-25T13:01:00.000Z" }],
        newest.notificationId,
      )?.notificationId,
    ).toBe(newest.notificationId);
  });

  it("replaces the visible card when a genuinely newer unread alert arrives", () => {
    const current = notification("current", "2026-08-25T13:00:00.000Z", {
      readAt: "2026-08-25T13:01:00.000Z",
    });
    const later = notification("later", "2026-08-25T14:00:00.000Z");
    expect(
      resolveInlineAgentNotification([current, later], current.notificationId)?.notificationId,
    ).toBe(later.notificationId);
  });

  it("removes a dismissed alert after its archive update arrives", () => {
    const current = notification("current", "2026-08-25T13:00:00.000Z", {
      readAt: "2026-08-25T13:01:00.000Z",
      archivedAt: "2026-08-25T13:02:00.000Z",
    });
    expect(resolveInlineAgentNotification([current], current.notificationId)).toBeNull();
  });

  it("ignores legacy notifications derived from waiting-on-you blockers", () => {
    const legacy = notification("legacy", "2026-08-25T13:00:00.000Z", {
      kind: "task-blocked",
      title: "Waiting on you: Sign in",
    });
    expect(resolveInlineAgentNotification([legacy], null)).toBeNull();
  });
});

describe("resolveInlineAgentAttention", () => {
  it("puts waiting-on-you first, then caps the stack at two cards", () => {
    const alert = notification("alert", "2026-08-25T14:00:00.000Z");
    const result = resolveInlineAgentAttention(
      [blocker("old", "2026-08-25T12:00:00.000Z"), blocker("new", "2026-08-25T15:00:00.000Z")],
      alert,
    );

    expect(result.items).toHaveLength(MAX_INLINE_AGENT_ATTENTION_CARDS);
    expect(result.items.map((item) => item.id)).toEqual(["blocker:new", "blocker:old"]);
    expect(result.hiddenCount).toBe(1);
  });

  it("keeps an older unresolved blocker ahead of a newer ordinary alert", () => {
    const alert = notification("new-alert", "2026-08-25T16:00:00.000Z");
    const result = resolveInlineAgentAttention(
      [blocker("older-blocker", "2026-08-25T12:00:00.000Z")],
      alert,
    );
    expect(result.items.map((item) => item.id)).toEqual([
      "blocker:older-blocker",
      "notification:new-alert",
    ]);
  });

  it("drops resolved blockers from the inline stack", () => {
    const resolved = {
      ...blocker("done", "2026-08-25T15:00:00.000Z"),
      resolvedAt: "2026-08-25T15:01:00.000Z",
      resolvedBy: "user" as const,
    };
    expect(resolveInlineAgentAttention([resolved], null)).toEqual({ items: [], hiddenCount: 0 });
  });
});

describe("shouldSendAgentDesktopNotification", () => {
  it("requires explicit app opt-in, granted host permission, an unfocused agent, and a new alert", () => {
    const base = {
      enabled: true,
      permission: "granted" as const,
      previousUnreadCount: 1,
      unreadCount: 2,
      isAgentFocused: false,
    };
    expect(shouldSendAgentDesktopNotification(base)).toBe(true);
    expect(shouldSendAgentDesktopNotification({ ...base, enabled: false })).toBe(false);
    expect(shouldSendAgentDesktopNotification({ ...base, permission: "default" })).toBe(false);
    expect(shouldSendAgentDesktopNotification({ ...base, permission: "denied" })).toBe(false);
    expect(shouldSendAgentDesktopNotification({ ...base, permission: "unsupported" })).toBe(false);
    expect(shouldSendAgentDesktopNotification({ ...base, isAgentFocused: true })).toBe(false);
    expect(shouldSendAgentDesktopNotification({ ...base, unreadCount: 1 })).toBe(false);
  });
});
