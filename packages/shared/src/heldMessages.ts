/** Server-owned user messages held until background work and usage cooldowns clear. */
export const HELD_MESSAGE_PREFIX = "held-user-message:";
export const isHeldMessageId = (id: string): boolean => id.startsWith(HELD_MESSAGE_PREFIX);
export const HELD_MESSAGE_REMOVED = "queue.message-removed";
export function removedHeldMessageIds(
  activities: readonly { kind: string; payload?: unknown }[],
): Set<string> {
  return new Set(
    activities.flatMap((activity) => {
      if (
        activity.kind === "queue.messages-cancelled" &&
        activity.payload &&
        typeof activity.payload === "object"
      ) {
        const ids = (activity.payload as { messageIds?: unknown }).messageIds;
        return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : [];
      }
      if (
        activity.kind !== HELD_MESSAGE_REMOVED ||
        !activity.payload ||
        typeof activity.payload !== "object"
      )
        return [];
      const id = (activity.payload as { messageId?: unknown }).messageId;
      return typeof id === "string" ? [id] : [];
    }),
  );
}
