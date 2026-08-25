import { previewBridge } from "~/components/preview/previewBridge";

import { stopBrowserRecording } from "./browserRecording";

interface DesktopTabLease {
  references: number;
  closeTimer: number | null;
  ready: Promise<void>;
}

const leases = new Map<string, DesktopTabLease>();
const pendingTabOperations = new Map<string, Promise<void>>();

const reportDesktopTabCleanupFailure = (
  operation: "stop-recording" | "close-tab",
  tabId: string,
  cause: unknown,
): void => {
  console.error(`[desktop-tab-lifetime] ${operation} failed`, { tabId, cause });
};

const enqueueDesktopTabOperation = (
  tabId: string,
  operation: () => Promise<void> | void,
): Promise<void> => {
  const previous = pendingTabOperations.get(tabId);
  const pending = previous
    ? previous.catch(() => undefined).then(operation)
    : Promise.resolve(operation());
  pendingTabOperations.set(tabId, pending);
  void pending
    .finally(() => {
      if (pendingTabOperations.get(tabId) === pending) {
        pendingTabOperations.delete(tabId);
      }
    })
    .catch(() => undefined);
  return pending;
};

export interface AcquiredDesktopTab {
  readonly ready: Promise<void>;
  readonly release: () => void;
}

export function acquireDesktopTab(tabId: string): AcquiredDesktopTab {
  const current =
    leases.get(tabId) ??
    ({
      references: 0,
      closeTimer: null,
      ready: enqueueDesktopTabOperation(tabId, () => previewBridge?.createTab(tabId)),
    } satisfies DesktopTabLease);
  if (current.closeTimer !== null) window.clearTimeout(current.closeTimer);
  current.references += 1;
  current.closeTimer = null;
  leases.set(tabId, current);

  return {
    ready: current.ready,
    release: () => {
      const lease = leases.get(tabId);
      if (!lease) return;
      lease.references = Math.max(0, lease.references - 1);
      if (lease.references > 0) return;
      lease.closeTimer = window.setTimeout(() => {
        const latest = leases.get(tabId);
        if (!latest || latest.references > 0) return;
        leases.delete(tabId);
        void enqueueDesktopTabOperation(tabId, async () => {
          // Native teardown must not wait for MediaRecorder finalization. A
          // recorder can stall while saving its artifact, but Electron still
          // needs to release the tab, screencast and floating-window resources
          // immediately. Keep both promises in the per-tab queue so a same-id
          // reacquire cannot race late recording cleanup against a new tab.
          const recordingCleanup = Promise.resolve()
            .then(() => stopBrowserRecording(tabId))
            .catch((cause: unknown) => {
              reportDesktopTabCleanupFailure("stop-recording", tabId, cause);
            });
          const nativeCleanup = Promise.resolve()
            .then(() => previewBridge?.closeTab(tabId))
            .catch((cause: unknown) => {
              reportDesktopTabCleanupFailure("close-tab", tabId, cause);
            });
          await Promise.all([recordingCleanup, nativeCleanup]);
        }).catch(() => undefined);
      }, 0);
    },
  };
}
