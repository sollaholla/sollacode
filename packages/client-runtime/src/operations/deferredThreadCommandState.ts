import type {
  EnvironmentId,
  OrchestrationShellSnapshot,
  OrchestrationThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import {
  DeferredThreadCommandStore,
  type DeferredThreadCommandEntry,
} from "../platform/persistence.ts";

const listeners = new Set<(environmentId: EnvironmentId) => void>();
const threads = new Map<EnvironmentId, Map<string, OrchestrationThreadShell>>();
export function rememberThreadShells(
  environmentId: EnvironmentId,
  rows: readonly OrchestrationThreadShell[],
) {
  let known = threads.get(environmentId);
  if (!known) threads.set(environmentId, (known = new Map()));
  for (const row of rows) known.set(row.id, row);
}
export function rememberedThreadShell(environmentId: EnvironmentId, threadId: string) {
  return threads.get(environmentId)?.get(threadId);
}
export function notifyDeferredThreadCommands(environmentId: EnvironmentId) {
  for (const listener of listeners) listener(environmentId);
}
export function deferredThreadCommandChanges(environmentId: EnvironmentId) {
  return Stream.callback<EnvironmentId>((queue) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const listener = (id: EnvironmentId) => {
          if (id === environmentId) Queue.offerUnsafe(queue, id);
        };
        listeners.add(listener);
        Queue.offerUnsafe(queue, environmentId);
        return listener;
      }),
      (listener) =>
        Effect.sync(() => {
          listeners.delete(listener);
        }),
    ).pipe(Effect.asVoid),
  ).pipe(
    Stream.mapEffect(() =>
      Effect.flatMap(DeferredThreadCommandStore, (store) => store.list(environmentId)),
    ),
  );
}

export function projectDeferredThreadSnapshot(
  snapshot: OrchestrationShellSnapshot,
  entries: readonly DeferredThreadCommandEntry[],
  archived: boolean,
): OrchestrationShellSnapshot {
  if (!entries.length) return snapshot;
  const rows = new Map(snapshot.threads.map((thread) => [thread.id, thread]));
  for (const entry of entries) {
    const { command } = entry;
    const thread = rows.get(command.threadId) ?? entry.thread;
    if (command.type === "thread.delete") {
      rows.delete(command.threadId);
      continue;
    }
    if (!thread) continue;
    switch (command.type) {
      case "thread.archive":
        rows.set(thread.id, { ...thread, archivedAt: entry.enqueuedAt });
        break;
      case "thread.unarchive":
        rows.set(thread.id, { ...thread, archivedAt: null });
        break;
      case "thread.settle":
        rows.set(thread.id, { ...thread, settledOverride: "settled", settledAt: entry.enqueuedAt });
        break;
      case "thread.unsettle":
        rows.set(thread.id, { ...thread, settledOverride: "active", settledAt: null });
        break;
    }
  }
  return {
    ...snapshot,
    threads: [...rows.values()].filter((row) => (row.archivedAt !== null) === archived),
  };
}
