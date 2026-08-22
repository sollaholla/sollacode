import * as Arr from "effect/Array";
import type {
  OrchestrationShellSnapshot,
  OrchestrationShellStreamEvent,
  OrchestrationThreadPendingWorkStreamItem,
} from "@t3tools/contracts";

/**
 * Reduce a single shell stream event into an existing snapshot, returning a new
 * snapshot with the event's changes applied. This is a pure reducer that both
 * web and mobile can use to keep their local shell snapshot in sync.
 *
 * Returns the original snapshot reference unchanged if the event is not
 * recognized (forward-compatible).
 */
export function applyShellStreamEvent(
  snapshot: OrchestrationShellSnapshot,
  event: OrchestrationShellStreamEvent,
): OrchestrationShellSnapshot {
  if (event.sequence <= snapshot.snapshotSequence) return snapshot;

  switch (event.kind) {
    case "project-upserted": {
      const projects = snapshot.projects.some((p) => p.id === event.project.id)
        ? Arr.map(snapshot.projects, (p) => (p.id === event.project.id ? event.project : p))
        : Arr.append(snapshot.projects, event.project);
      return { ...snapshot, projects, snapshotSequence: event.sequence };
    }
    case "project-removed":
      return {
        ...snapshot,
        projects: Arr.filter(snapshot.projects, (p) => p.id !== event.projectId),
        snapshotSequence: event.sequence,
      };
    case "thread-upserted": {
      const threads = snapshot.threads.some((t) => t.id === event.thread.id)
        ? Arr.map(snapshot.threads, (t) => (t.id === event.thread.id ? event.thread : t))
        : Arr.append(snapshot.threads, event.thread);
      return { ...snapshot, threads, snapshotSequence: event.sequence };
    }
    case "thread-removed":
      return {
        ...snapshot,
        threads: Arr.filter(snapshot.threads, (t) => t.id !== event.threadId),
        snapshotSequence: event.sequence,
      };
    default:
      return snapshot;
  }
}

/**
 * Apply an out-of-band pending-work correction.
 *
 * Deliberately not part of `applyShellStreamEvent`: the item carries no
 * sequence, so it neither advances `snapshotSequence` nor may be gated on it.
 * The server sends one only for scheduler transitions that produced no event —
 * exactly the changes a sequence could not describe. A thread this client does
 * not hold, or a value it already has, returns the snapshot unchanged so no
 * subscriber re-renders for nothing.
 */
export function applyShellPendingWorkItem(
  snapshot: OrchestrationShellSnapshot,
  item: OrchestrationThreadPendingWorkStreamItem,
): OrchestrationShellSnapshot {
  const current = snapshot.threads.find((thread) => thread.id === item.threadId);
  if (current === undefined) return snapshot;
  const existing = current.pendingWork ?? null;
  if (
    existing === item.pendingWork ||
    (existing !== null &&
      item.pendingWork !== null &&
      existing.kind === item.pendingWork.kind &&
      existing.state === item.pendingWork.state &&
      existing.since === item.pendingWork.since)
  ) {
    return snapshot;
  }
  return {
    ...snapshot,
    threads: Arr.map(snapshot.threads, (thread) =>
      thread.id === item.threadId ? { ...thread, pendingWork: item.pendingWork } : thread,
    ),
  };
}
