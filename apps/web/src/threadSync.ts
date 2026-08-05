import type { EnvironmentThreadStatus } from "@t3tools/client-runtime/state/threads";

export type ThreadSyncPhase = "loading" | "syncing";

export function resolveThreadSyncPhase(input: {
  readonly detailExists: boolean;
  readonly shellExists: boolean;
  readonly status: EnvironmentThreadStatus;
}): ThreadSyncPhase | null {
  if (!input.shellExists) {
    return null;
  }

  switch (input.status) {
    case "empty":
    case "cached":
    case "synchronizing":
      return input.detailExists ? "syncing" : "loading";
    case "deleted":
    case "live":
      return null;
  }
}

export function threadSyncLabel(phase: ThreadSyncPhase): string {
  return phase === "loading" ? "Loading messages..." : "Syncing messages...";
}

export function threadSyncOverlayCopy(phase: ThreadSyncPhase): {
  readonly title: string;
  readonly detail: string;
} {
  return phase === "loading"
    ? {
        title: "Loading conversation…",
        detail: "Restoring this thread’s messages and working context.",
      }
    : {
        title: "Catching up…",
        detail: "Fast-forwarding to the latest messages. Your conversation context is still here.",
      };
}
