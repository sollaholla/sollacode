import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type OrchestrationThreadActivity,
  type OrchestrationThreadDetailSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import { boundedThreadCacheSnapshot } from "./threadCache.ts";

const BASE_THREAD: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Cached thread",
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5.4",
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "main",
  worktreePath: null,
  latestTurn: null,
  createdAt: "2026-04-01T00:00:00.000Z",
  updatedAt: "2026-04-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
};
const createdAt = (index: number) =>
  `2026-04-01T00:${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.000Z`;
const message = (index: number, id = `message-${index}`) => ({
  id: MessageId.make(id),
  role: "user" as const,
  text: `Message ${index}`,
  turnId: null,
  streaming: false,
  createdAt: createdAt(index),
  updatedAt: createdAt(index),
});
const activity = (
  index: number,
  kind = "tool.completed",
  payload: unknown = {},
): OrchestrationThreadActivity => ({
  id: EventId.make(`activity-${index}`),
  kind,
  payload,
  tone: "info",
  summary: "Activity",
  turnId: null,
  sequence: index,
  createdAt: createdAt(index),
});
const snapshot = (thread: OrchestrationThread): OrchestrationThreadDetailSnapshot => ({
  snapshotSequence: 1000,
  thread,
});

describe("boundedThreadCacheSnapshot", () => {
  it("keeps small snapshots and their history by reference", () => {
    const value = snapshot(BASE_THREAD);
    expect(boundedThreadCacheSnapshot(value)).toBe(value);
  });

  it("persists a contiguous recent window without mutating the active transcript", () => {
    const value = snapshot({
      ...BASE_THREAD,
      messages: Array.from({ length: 250 }, (_, index) => message(index)),
      activities: Array.from({ length: 450 }, (_, index) => activity(index)),
    });
    const bounded = boundedThreadCacheSnapshot(value);
    expect(bounded.thread.messages).toEqual(value.thread.messages.slice(-100));
    expect(bounded.thread.activities).toEqual(value.thread.activities.slice(-200));
    expect(bounded.history).toEqual({
      totalMessages: 250,
      totalActivities: 450,
      messageCursor: { createdAt: createdAt(150), messageId: "message-150" },
      activityCursor: { createdAt: createdAt(250), activityId: "activity-250" },
    });
    expect(value.thread.messages).toHaveLength(250);
    expect(value.thread.activities).toHaveLength(450);
    expect(bounded.thread.proposedPlans).toBe(value.thread.proposedPlans);
    expect(bounded.thread.checkpoints).toBe(value.thread.checkpoints);
    expect(bounded.snapshotSequence).toBe(1000);
    // The server's exclusive cursor retrieves every omitted row, including
    // rows with an identical timestamp, rather than jumping over a gap.
    const sameTime = snapshot({
      ...BASE_THREAD,
      messages: Array.from({ length: 105 }, (_, index) => ({
        ...message(index, `message-${String(index).padStart(3, "0")}`),
        createdAt: createdAt(0),
      })),
    });
    expect(boundedThreadCacheSnapshot(sameTime).history?.messageCursor?.messageId).toBe(
      "message-005",
    );
  });

  it("uses the activity ID to page rows with the same timestamp", () => {
    const activities = Array.from({ length: 205 }, (_, index) => ({
      ...activity(index),
      id: EventId.make(`activity-${String(index).padStart(3, "0")}`),
      createdAt: createdAt(0),
    }));
    const bounded = boundedThreadCacheSnapshot(snapshot({ ...BASE_THREAD, activities }));
    expect(bounded.history?.activityCursor).toEqual({
      createdAt: createdAt(0),
      activityId: "activity-005",
    });
    expect(bounded.thread.activities).toEqual(activities.slice(5));
  });

  it("preserves task terminal states and plan lists without moving the cursor past gaps", () => {
    const pins = [
      activity(1, "task.started", { taskId: "task-1" }),
      activity(2, "task.progress", { taskId: "task-1" }),
      activity(3, "task.progress", { taskId: "task-1" }),
      activity(4, "task.completed", { taskId: "task-1" }),
      activity(5, "turn.plan.updated", { plan: [] }),
    ];
    const value = snapshot({
      ...BASE_THREAD,
      activities: [...pins, ...Array.from({ length: 250 }, (_, index) => activity(index + 10))],
    });
    const bounded = boundedThreadCacheSnapshot(value);
    expect(bounded.thread.activities.slice(0, 4)).toEqual([pins[0], pins[2], pins[3], pins[4]]);
    expect(bounded.history?.activityCursor).toEqual({
      createdAt: createdAt(60),
      activityId: "activity-60",
    });
    expect(boundedThreadCacheSnapshot(bounded)).toBe(bounded);
  });

  it("keeps receipts and pending held messages, but does not revive settled held messages", () => {
    const queued = message(1, "held-user-message:queued");
    const delivered = message(2, "held-user-message:delivered");
    const removed = message(3, "held-user-message:removed");
    const recentHeld = message(259, "held-user-message:recent");
    const receipt = activity(4, "provider.queue.promoted", {
      messageIds: [delivered.id, recentHeld.id],
    });
    const value = snapshot({
      ...BASE_THREAD,
      messages: [
        queued,
        delivered,
        removed,
        ...Array.from({ length: 150 }, (_, index) => message(index + 100)),
        recentHeld,
      ],
      activities: [
        receipt,
        activity(5, "queue.message-removed", { messageId: removed.id }),
        ...Array.from({ length: 220 }, (_, index) => activity(index + 10)),
      ],
    });
    const bounded = boundedThreadCacheSnapshot(value);
    expect(bounded.thread.messages[0]).toBe(queued);
    expect(bounded.thread.messages).not.toContain(delivered);
    expect(bounded.thread.messages).not.toContain(removed);
    expect(bounded.thread.activities).toContain(receipt);
    expect(bounded.history?.messageCursor?.messageId).toBe("message-151");
    expect(bounded.history?.activityCursor?.activityId).toBe("activity-30");
  });

  it("keeps existing cursors ahead of pinned metadata and retains known totals", () => {
    const pins = Array.from({ length: 200 }, (_, index) =>
      activity(index + 1, "task.started", { taskId: `task-${index}` }),
    );
    const value = {
      ...snapshot({ ...BASE_THREAD, activities: [activity(0), ...pins, activity(300)] }),
      history: {
        totalMessages: 1000,
        totalActivities: 2000,
        messageCursor: { createdAt: createdAt(400), messageId: MessageId.make("message-400") },
        activityCursor: { createdAt: createdAt(300), activityId: EventId.make("activity-300") },
      },
    };
    const bounded = boundedThreadCacheSnapshot(value);
    expect(bounded.thread.activities).not.toContain(value.thread.activities[0]);
    expect(bounded.history).toEqual(value.history);
  });

  it("bounds task lifecycle pins to the latest 200 tasks", () => {
    const value = snapshot({
      ...BASE_THREAD,
      activities: [
        ...Array.from({ length: 250 }, (_, index) =>
          activity(index, "task.started", { taskId: `task-${index}` }),
        ),
        ...Array.from({ length: 200 }, (_, index) => activity(index + 250)),
      ],
    });
    const bounded = boundedThreadCacheSnapshot(value);
    expect(bounded.thread.activities).toHaveLength(400);
    expect(bounded.thread.activities[0]?.id).toBe("activity-50");
    expect(bounded.history?.activityCursor?.activityId).toBe("activity-250");
  });
});
