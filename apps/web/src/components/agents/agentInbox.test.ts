import { VmAgentId, VmAgentNotificationId, type VmAgentNotification } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  agentNotificationPreview,
  notificationsInFolder,
  unreadAgentNotificationCount,
} from "./agentInbox";

const notification = (
  id: string,
  input: Partial<Pick<VmAgentNotification, "readAt" | "archivedAt" | "body">> = {},
): VmAgentNotification => ({
  notificationId: VmAgentNotificationId.make(id),
  vmAgentId: VmAgentId.make("agent-1"),
  taskId: null,
  runId: null,
  kind: "agent-message",
  title: id,
  body: input.body ?? "Body",
  deepLink: "/agents/agent-1",
  readAt: input.readAt ?? null,
  archivedAt: input.archivedAt ?? null,
  createdAt: "2026-08-23T12:00:00.000Z",
});

describe("agent inbox folders", () => {
  it("keeps archived mail out of the inbox and unread badge", () => {
    const messages = [
      notification("unread"),
      notification("read", { readAt: "2026-08-23T12:01:00.000Z" }),
      notification("archived", { archivedAt: "2026-08-23T12:02:00.000Z" }),
    ];

    expect(notificationsInFolder(messages, "inbox").map((item) => item.notificationId)).toEqual([
      "unread",
      "read",
    ]);
    expect(notificationsInFolder(messages, "archive").map((item) => item.notificationId)).toEqual([
      "archived",
    ]);
    expect(unreadAgentNotificationCount(messages)).toBe(1);
  });

  it("collapses markdown whitespace for the list preview", () => {
    expect(agentNotificationPreview("First line\n\n- second   item")).toBe(
      "First line - second item",
    );
  });
});
