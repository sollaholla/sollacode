import type { ScopedThreadRef } from "@t3tools/contracts";
import { findUsageGuardPauseNotice, isUsageGuardPauseActive } from "./usageGuardPause";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { environmentThreadDetails, environmentThreadShells } from "../../state/threads";
import { deriveProviderTasks, isProviderTaskActive } from "../../providerTasks";
import { applyProviderTaskDismissals } from "../../providerTasks";
import { useProviderTaskDismissalStore } from "../../providerTaskDismissalStore";

/** Keeps the originating thread live even when the user navigates to another chat. */
export function watchHeldMessageThread(
  ref: ScopedThreadRef,
  notify: (ready: boolean, idle: boolean) => void,
): () => void {
  const stateAtom = environmentThreadDetails.stateAtom(ref);
  const threadAtom = environmentThreadDetails.detailAtom(ref);
  const shellAtom = environmentThreadShells.threadShellAtom(ref);
  const check = () => {
    const state = appAtomRegistry.get(stateAtom);
    const thread = appAtomRegistry.get(threadAtom);
    const shell = appAtomRegistry.get(shellAtom);
    if (state.status !== "live" || !thread) return notify(false, false);
    const tasks = applyProviderTaskDismissals(
      deriveProviderTasks(thread.activities, {
        providerSessionEnded: thread.session?.status === "stopped",
      }),
      useProviderTaskDismissalStore.getState().dismissals,
    );
    const current = shell ?? thread;
    const idle =
      !current.session?.activeTurnId &&
      current.session?.status !== "running" &&
      current.session?.status !== "starting" &&
      current.latestTurn?.state !== "running";
    const usagePaused = isUsageGuardPauseActive({
      notice: findUsageGuardPauseNotice(
        thread.activities,
        thread.session?.providerInstanceId ?? thread.modelSelection.instanceId,
      ),
      pendingWork: current.pendingWork,
      isWorking: !idle,
    });
    notify(!usagePaused && !tasks.some(isProviderTaskActive), idle);
  };
  const unsubscribe = appAtomRegistry.subscribe(stateAtom, check);
  const unsubscribeShell = appAtomRegistry.subscribe(shellAtom, check);
  const unsubscribeDismissals = useProviderTaskDismissalStore.subscribe(check);
  queueMicrotask(check);
  return () => {
    unsubscribe();
    unsubscribeShell();
    unsubscribeDismissals();
  };
}
