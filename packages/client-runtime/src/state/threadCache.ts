import type {
  OrchestrationThreadActivity,
  OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { isHeldMessageId, removedHeldMessageIds } from "@t3tools/shared/heldMessages";

const MESSAGE_LIMIT = 100;
const ACTIVITY_LIMIT = 200;
const TASK_LIMIT = 200;

function compareHistoryRows(
  left: { readonly createdAt: string; readonly id: string },
  right: { readonly createdAt: string; readonly id: string },
): number {
  return left.createdAt < right.createdAt
    ? -1
    : left.createdAt > right.createdAt
      ? 1
      : left.id < right.id
        ? -1
        : left.id > right.id
          ? 1
          : 0;
}

function payloadRecord(activity: OrchestrationThreadActivity): Record<string, unknown> {
  return typeof activity.payload === "object" && activity.payload !== null
    ? (activity.payload as Record<string, unknown>)
    : {};
}

/** Saves a recent transcript without removing history from the active reader. */
export function boundedThreadCacheSnapshot(
  snapshot: OrchestrationThreadDetailSnapshot,
): OrchestrationThreadDetailSnapshot {
  const { thread, history } = snapshot;
  if (thread.messages.length <= MESSAGE_LIMIT && thread.activities.length <= ACTIVITY_LIMIT) {
    return snapshot;
  }

  const recentMessages = thread.messages.toSorted(compareHistoryRows).slice(-MESSAGE_LIMIT);
  const recentActivities = thread.activities.toSorted(compareHistoryRows).slice(-ACTIVITY_LIMIT);
  const messageIds = new Set<string>(recentMessages.map((message) => message.id));
  const activityIds = new Set(recentActivities.map((activity) => activity.id));
  const removedIds = removedHeldMessageIds(thread.activities);
  const deliveredIds = new Set<string>();
  for (const activity of thread.activities) {
    const payload = payloadRecord(activity);
    if (activity.kind === "message.delivered" && typeof payload.messageId === "string") {
      deliveredIds.add(payload.messageId);
    } else if (activity.kind === "provider.queue.promoted" && Array.isArray(payload.messageIds)) {
      for (const id of payload.messageIds) if (typeof id === "string") deliveredIds.add(id);
    }
  }
  // Pending work must remain actionable even when the surrounding transcript
  // is old. The storage byte guard still caps unusually large pending queues.
  for (const message of thread.messages) {
    if (
      message.streaming ||
      (isHeldMessageId(message.id) &&
        (message.queueState ?? "queued") === "queued" &&
        !removedIds.has(message.id) &&
        !deliveredIds.has(message.id))
    ) {
      messageIds.add(message.id);
    }
  }

  const tasks = new Map<string, Set<string>>();
  const receipts = new Set<string>();
  let hasTaskList = false;
  // The live reducer keeps activities in sequence order. Match the server's
  // pinned task roster, including terminal rows so old work cannot revive.
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity = thread.activities[index]!;
    const payload = payloadRecord(activity);
    if (activity.kind === "turn.plan.updated" && !hasTaskList) {
      activityIds.add(activity.id);
      hasTaskList = true;
    }
    if (
      (activity.kind === "task.started" ||
        activity.kind === "task.progress" ||
        activity.kind === "task.completed") &&
      typeof payload.taskId === "string"
    ) {
      let kinds = tasks.get(payload.taskId);
      if (kinds === undefined && tasks.size < TASK_LIMIT) {
        kinds = new Set();
        tasks.set(payload.taskId, kinds);
      }
      if (kinds !== undefined && !kinds.has(activity.kind)) {
        activityIds.add(activity.id);
        kinds.add(activity.kind);
      }
    }
    // Receipt activities drive both the held-message panel and delivery
    // checkmarks. Retain one per kind and retained message, not their history.
    const ids =
      activity.kind === "message.delivered" || activity.kind === "queue.message-removed"
        ? [payload.messageId]
        : activity.kind === "provider.queue.promoted" ||
            activity.kind === "queue.messages-cancelled"
          ? Array.isArray(payload.messageIds)
            ? payload.messageIds
            : []
          : [];
    for (const id of ids) {
      if (typeof id !== "string" || !messageIds.has(id)) continue;
      const key = `${activity.kind}:${id}`;
      if (!receipts.has(key)) {
        activityIds.add(activity.id);
        receipts.add(key);
      }
    }
  }

  const messages = thread.messages.filter((message) => messageIds.has(message.id));
  const activities = thread.activities.filter((activity) => activityIds.has(activity.id));
  const trimmedMessages = messages.length < thread.messages.length;
  const trimmedActivities = activities.length < thread.activities.length;
  if (!trimmedMessages && !trimmedActivities) return snapshot;

  const oldestMessage = recentMessages[0];
  const oldestActivity = recentActivities[0];
  const previousMessageCursor = history?.messageCursor;
  const previousActivityCursor = history?.activityCursor;
  return {
    ...snapshot,
    thread: { ...thread, messages, activities },
    history: {
      totalMessages: Math.max(history?.totalMessages ?? 0, thread.messages.length),
      totalActivities: Math.max(history?.totalActivities ?? 0, thread.activities.length),
      // Pinned rows can precede an existing gap. Never move a cursor backwards
      // past that gap or let an older pinned row hide omitted transcript rows.
      messageCursor:
        trimmedMessages &&
        oldestMessage !== undefined &&
        (previousMessageCursor == null ||
          compareHistoryRows(oldestMessage, {
            createdAt: previousMessageCursor.createdAt,
            id: previousMessageCursor.messageId,
          }) > 0)
          ? { createdAt: oldestMessage.createdAt, messageId: oldestMessage.id }
          : (previousMessageCursor ?? null),
      activityCursor:
        trimmedActivities &&
        oldestActivity !== undefined &&
        (previousActivityCursor == null ||
          compareHistoryRows(oldestActivity, {
            createdAt: previousActivityCursor.createdAt,
            id: previousActivityCursor.activityId,
          }) > 0)
          ? { createdAt: oldestActivity.createdAt, activityId: oldestActivity.id }
          : (previousActivityCursor ?? null),
    },
  };
}
