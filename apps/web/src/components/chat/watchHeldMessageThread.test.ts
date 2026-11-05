import { describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";

const fixture = vi.hoisted(() => ({
  shell: {
    pendingWork: { kind: "startup-resume", state: "sleeping", since: "2026-09-06T16:00:00.000Z" },
    session: { status: "ready", activeTurnId: null },
    latestTurn: null,
  } as { pendingWork: object | null; session: object; latestTurn: null },
  listeners: new Map<string, () => void>(),
}));
vi.mock("../../rpc/atomRegistry", () => ({
  appAtomRegistry: {
    get: (atom: string) =>
      atom === "state"
        ? { status: "live" }
        : atom === "shell"
          ? fixture.shell
          : {
              pendingWork: null,
              session: { status: "ready", activeTurnId: null },
              latestTurn: null,
              // The watcher falls back to the thread's own selection when the
              // session has no provider instance, so a detail without one is
              // not a shape this code ever sees.
              modelSelection: { model: "claude-opus-5", instanceId: "claude-primary" },
              activities: [],
            },
    subscribe: (atom: string, callback: () => void) => {
      fixture.listeners.set(atom, callback);
      return () => fixture.listeners.delete(atom);
    },
  },
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { stateAtom: () => "state", detailAtom: () => "detail" },
  environmentThreadShells: { threadShellAtom: () => "shell" },
}));
vi.mock("../../providerTasks", () => ({
  deriveProviderTasks: () => [],
  applyProviderTaskDismissals: (tasks: unknown) => tasks,
  isProviderTaskActive: () => false,
}));
vi.mock("../../providerTaskDismissalStore", () => ({
  useProviderTaskDismissalStore: {
    getState: () => ({ dismissals: {} }),
    subscribe: () => () => {},
  },
}));
import { watchHeldMessageThread } from "./watchHeldMessageThread";

describe("held message thread subscription", () => {
  it("reports an idle thread as ready and follows the shell", async () => {
    const notify = vi.fn();
    const unsubscribe = watchHeldMessageThread(
      scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread")),
      notify,
    );
    await Promise.resolve();
    expect(notify).toHaveBeenLastCalledWith(true, true);
    fixture.shell = { ...fixture.shell, pendingWork: null };
    fixture.listeners.get("shell")!();
    expect(notify).toHaveBeenCalledTimes(2);
    unsubscribe();
    expect(fixture.listeners.size).toBe(0);
  });
});
