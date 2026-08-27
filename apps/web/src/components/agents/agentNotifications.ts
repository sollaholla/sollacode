import type { VmAgentBlocker, VmAgentNotification } from "@t3tools/contracts";

export const MAX_INLINE_AGENT_ATTENTION_CARDS = 2;

export type InlineAgentAttentionItem =
  | {
      readonly kind: "blocker";
      readonly id: string;
      readonly occurredAt: string;
      readonly blocker: VmAgentBlocker;
    }
  | {
      readonly kind: "notification";
      readonly id: string;
      readonly occurredAt: string;
      readonly notification: VmAgentNotification;
    };

export interface InlineAgentAttention {
  readonly items: ReadonlyArray<InlineAgentAttentionItem>;
  readonly hiddenCount: number;
}

/** Old servers paired each blocker with a notification. Hide that derivative
 * row even before migration 64 removes it from the owning environment. */
export function isLegacyBlockerNotification(notification: VmAgentNotification): boolean {
  return notification.kind === "task-blocked" && notification.title.startsWith("Waiting on you:");
}

/**
 * Keep one alert stable while the agent is open. Reading it may reveal older
 * unread rows in the store, but those wait for the next visit; a genuinely new
 * alert (with a later creation time) replaces the visible card immediately.
 */
export function resolveInlineAgentNotification(
  notifications: ReadonlyArray<VmAgentNotification>,
  currentNotificationId: string | null,
): VmAgentNotification | null {
  const newestUnread = notifications
    .filter(
      (notification) =>
        notification.readAt === null &&
        notification.archivedAt === null &&
        !isLegacyBlockerNotification(notification),
    )
    .toSorted((left, right) => right.createdAt.localeCompare(left.createdAt))[0];
  if (currentNotificationId === null) return newestUnread ?? null;
  const current = notifications.find(
    (notification) => notification.notificationId === currentNotificationId,
  );
  if (!current) return newestUnread ?? null;
  // Dismiss archives the durable notification. Do not keep rendering the old
  // card merely because its id was stabilized for this visit.
  if (current.archivedAt !== null || isLegacyBlockerNotification(current)) {
    return newestUnread ?? null;
  }
  if (newestUnread && newestUnread.createdAt > current.createdAt) return newestUnread;
  return current;
}

/**
 * Merge the independent alert channel with durable waiting-on-you requests.
 * Actionable blockers always precede ordinary alerts; within each kind the
 * newest item stays first. One more card is tucked behind it and opens on
 * hover/focus. Resolving or dismissing a front item naturally reveals the next
 * one, so every request remains reachable without filling the chat.
 */
export function resolveInlineAgentAttention(
  blockers: ReadonlyArray<VmAgentBlocker>,
  notification: VmAgentNotification | null,
): InlineAgentAttention {
  const candidates: InlineAgentAttentionItem[] = blockers
    .filter((blocker) => blocker.resolvedAt === null)
    .map((blocker) => ({
      kind: "blocker",
      id: `blocker:${blocker.blockerId}`,
      occurredAt: blocker.updatedAt,
      blocker,
    }));
  if (notification !== null && !isLegacyBlockerNotification(notification)) {
    candidates.push({
      kind: "notification",
      id: `notification:${notification.notificationId}`,
      occurredAt: notification.createdAt,
      notification,
    });
  }
  candidates.sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "blocker" ? -1 : 1;
    return right.occurredAt.localeCompare(left.occurredAt);
  });
  return {
    items: candidates.slice(0, MAX_INLINE_AGENT_ATTENTION_CARDS),
    hiddenCount: Math.max(0, candidates.length - MAX_INLINE_AGENT_ATTENTION_CARDS),
  };
}

export function shouldSendAgentDesktopNotification(input: {
  readonly enabled: boolean;
  readonly permission: NotificationPermission | "unsupported";
  readonly previousUnreadCount: number;
  readonly unreadCount: number;
  readonly isAgentFocused: boolean;
}): boolean {
  return (
    input.enabled &&
    input.permission === "granted" &&
    !input.isAgentFocused &&
    input.unreadCount > input.previousUnreadCount
  );
}
