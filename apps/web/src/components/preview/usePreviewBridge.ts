"use client";

import type {
  DesktopPreviewTabState,
  PreviewAgentControl,
  PreviewReportStatusInput,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { useEffect, useRef, useState } from "react";

import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { applyPreviewDesktopState, type DesktopPreviewOverlay } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import { usePreviewHumanVerification } from "./previewHumanVerification";
import { shouldClearBrowserPointer } from "./previewPointerLifecycle";
import {
  previewAgentControlFromIndicator,
  resolvePreviewTabAgentIndicator,
} from "./previewTabAgentIndicator";

/**
 * Mirrors low-latency desktop state into the store and reflects navigation
 * events back to the server. Webview lifetime is owned by ElectronBrowserHost.
 */
export function usePreviewBridge(input: {
  threadRef: ScopedThreadRef;
  tabId: string;
  runtimeTabId: string;
  syncGeneration: number;
}): string | null {
  const { threadRef, tabId, runtimeTabId, syncGeneration } = input;
  const environmentId = threadRef.environmentId;
  const threadId = threadRef.threadId;
  const clearBrowserPointer = useBrowserPointerStore((state) => state.clear);
  const reportStatus = useAtomCommand(previewEnvironment.reportStatus, "preview status report");
  const reportActivity = useAtomCommand(previewEnvironment.reportActivity, {
    reportFailure: false,
  });
  const humanVerification = usePreviewHumanVerification(runtimeTabId);
  const [downloadPending, setDownloadPending] = useState<boolean | null>(null);
  const bridge = previewBridge;
  const [snapshotStageId, setSnapshotStageId] = useState<string | null>(null);

  // One bridge subscription does both jobs (mirror state + forward to
  // server) so the desktop bridge keeps a single listener entry per tab.
  const lastInteractionAt = useRef<string | undefined>(undefined);
  const lastInteractionReportMs = useRef(0);
  useEffect(() => {
    if (downloadPending === null) return;
    void reportActivity({
      environmentId,
      input: {
        threadId,
        tabId,
        interacted: false,
        attentionRequired: downloadPending || humanVerification !== null,
      },
    });
  }, [downloadPending, humanVerification, reportActivity, environmentId, threadId, tabId]);
  const lastReportedUrl = useRef<string | null>(null);
  const lastReportedKind = useRef<DesktopPreviewTabState["navStatus"]["kind"] | null>(null);
  const lastReportedControl = useRef<PreviewAgentControl | null>(null);
  const lastDesktopNavStatus = useRef<DesktopPreviewTabState["navStatus"] | null>(null);
  useEffect(() => {
    if (!bridge || typeof window === "undefined") return;
    lastInteractionAt.current = undefined;
    lastInteractionReportMs.current = 0;
    setDownloadPending(null);
    lastReportedUrl.current = null;
    lastReportedKind.current = null;
    lastReportedControl.current = null;
    lastDesktopNavStatus.current = null;
    setSnapshotStageId(null);
    let activityTimer: ReturnType<typeof setTimeout> | undefined;
    const sendActivity = () => {
      activityTimer = undefined;
      lastInteractionReportMs.current = Date.now();
      void reportActivity({ environmentId, input: { threadId, tabId, interacted: true } });
    };
    const unsubscribe = bridge.onStateChange((changedTabId, state) => {
      if (changedTabId !== runtimeTabId) return;
      setSnapshotStageId(state.snapshotStageId);
      setDownloadPending(state.pendingDownloadApprovals.length > 0);
      if (state.lastInteractionAt !== lastInteractionAt.current) {
        lastInteractionAt.current = state.lastInteractionAt;
        const now = Date.now();
        if (state.lastInteractionAt && now - Date.parse(state.lastInteractionAt) < 30_000) {
          const remaining = 15_000 - (now - lastInteractionReportMs.current);
          if (remaining <= 0) sendActivity();
          else if (activityTimer === undefined) activityTimer = setTimeout(sendActivity, remaining);
        }
      }
      if (shouldClearBrowserPointer(lastDesktopNavStatus.current, state.navStatus)) {
        clearBrowserPointer(runtimeTabId);
      }
      lastDesktopNavStatus.current = state.navStatus;
      const overlay = projectDesktopState(state);
      applyPreviewDesktopState(scopeThreadRef(environmentId, threadId), tabId, overlay);
      // Remote viewers have no overlay of their own; tell the server who drives
      // the tab whenever that changes (and once after every reconnect).
      const agentControl = previewAgentControlFromIndicator(
        resolvePreviewTabAgentIndicator(overlay),
      );
      if (agentControl !== lastReportedControl.current) {
        lastReportedControl.current = agentControl;
        void reportActivity({
          environmentId,
          input: { threadId, tabId, interacted: false, agentControl },
        }).then((result) => {
          if (result._tag === "Failure" && lastReportedControl.current === agentControl) {
            lastReportedControl.current = null;
          }
        });
      }
      const reported = buildReportInput({
        threadId,
        tabId,
        state,
        lastReportedUrl: lastReportedUrl.current,
        lastReportedKind: lastReportedKind.current,
      });
      if (!reported) return;
      lastReportedUrl.current = reported.lastReportedUrl;
      lastReportedKind.current = reported.lastReportedKind;
      void reportStatus({
        environmentId,
        input: reported.input,
      }).then((result) => {
        if (
          result._tag === "Failure" &&
          lastReportedUrl.current === reported.lastReportedUrl &&
          lastReportedKind.current === reported.lastReportedKind
        ) {
          lastReportedUrl.current = null;
          lastReportedKind.current = null;
        }
      });
    });
    return () => {
      if (activityTimer !== undefined) {
        clearTimeout(activityTimer);
        sendActivity();
      }
      unsubscribe();
    };
  }, [
    bridge,
    clearBrowserPointer,
    environmentId,
    reportStatus,
    reportActivity,
    runtimeTabId,
    syncGeneration,
    tabId,
    threadId,
  ]);
  return snapshotStageId;
}

function projectDesktopState(state: DesktopPreviewTabState): DesktopPreviewOverlay {
  return {
    hasWebContents: state.webContentsId !== null,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
    loading: state.navStatus.kind === "Loading",
    zoomFactor: state.zoomFactor,
    pictureInPicture: state.pictureInPicture,
    colorScheme: state.colorScheme,
    controller: state.controller,
    agentActive: state.agentActive,
    downloads: state.downloads,
    pendingDownloadApprovals: state.pendingDownloadApprovals,
  };
}

/**
 * Decide whether a state change warrants an RPC to the server, and shape
 * the report payload.
 *
 * - Idle never reports — the tab is post-close or pre-load and the server
 *   already knows the canonical state from `open` / `closed`.
 * - We dedupe on (kind, url): consecutive Loading→Loading→Loading for the
 *   same URL collapses to a single RPC, ditto Success.
 * - LoadFailed always reports (the server uses it to emit `failed`).
 */
function buildReportInput(args: {
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly state: DesktopPreviewTabState;
  readonly lastReportedUrl: string | null;
  readonly lastReportedKind: DesktopPreviewTabState["navStatus"]["kind"] | null;
}): {
  readonly input: PreviewReportStatusInput;
  readonly lastReportedUrl: string;
  readonly lastReportedKind: DesktopPreviewTabState["navStatus"]["kind"];
} | null {
  const { threadId, tabId, state, lastReportedUrl, lastReportedKind } = args;
  const status = state.navStatus;
  if (status.kind === "Idle") return null;

  // Skip if we've already reported the same kind+url. LoadFailed always
  // reports (rapid duplicate failures are unusual and worth surfacing).
  const sameAsLast =
    status.kind !== "LoadFailed" &&
    status.kind === lastReportedKind &&
    status.url === lastReportedUrl;
  if (sameAsLast) return null;

  const base = {
    threadId,
    tabId,
    canGoBack: state.canGoBack,
    canGoForward: state.canGoForward,
  };
  if (status.kind === "LoadFailed") {
    return {
      input: {
        ...base,
        navStatus: {
          _tag: "LoadFailed",
          url: status.url,
          title: status.title,
          code: status.code,
          description: status.description,
        },
      },
      lastReportedUrl: status.url,
      lastReportedKind: "LoadFailed",
    };
  }
  return {
    input: {
      ...base,
      navStatus: { _tag: status.kind, url: status.url, title: status.title },
    },
    lastReportedUrl: status.url,
    lastReportedKind: status.kind,
  };
}
