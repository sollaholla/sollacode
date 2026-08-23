import type { VmAgentNotification } from "@t3tools/contracts";

export type AgentInboxFolder = "inbox" | "archive";

export function notificationsInFolder(
  notifications: ReadonlyArray<VmAgentNotification>,
  folder: AgentInboxFolder,
): ReadonlyArray<VmAgentNotification> {
  return notifications.filter((notification) =>
    folder === "archive" ? notification.archivedAt !== null : notification.archivedAt === null,
  );
}

export function unreadAgentNotificationCount(
  notifications: ReadonlyArray<VmAgentNotification>,
): number {
  return notifications.filter(
    (notification) => notification.archivedAt === null && notification.readAt === null,
  ).length;
}

export function agentNotificationPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim();
}
