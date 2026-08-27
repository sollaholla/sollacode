"use client";

import { RegistryContext, useAtomSet, useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  PREVIEW_AUTOMATION_OPERATIONS,
  type EnvironmentId,
  type PreviewAutomationCloseResult,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationOpenResult,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResizeResult,
  type PreviewAutomationSetColorSchemeInput,
  type PreviewAutomationSetColorSchemeResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationHost as PreviewAutomationHostState,
  type PreviewAutomationRequest,
  type PreviewAutomationStatus,
  type PreviewRenderedViewportSize,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import { useCallback, useContext, useEffect, useMemo, useState } from "react";
import { Atom } from "effect/unstable/reactivity";

import {
  applyPreviewServerSnapshot,
  readActivePreviewSessions,
  readThreadPreviewState,
  reconcilePreviewServerSessions,
  updatePreviewServerSnapshot,
} from "~/previewStateStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { resolveBrowserNavigationTarget } from "~/browser/browserTargetResolver";
import {
  readActiveBrowserRecordingTargets,
  startBrowserRecording,
  stopBrowserRecording,
} from "~/browser/browserRecording";
import { resolveBrowserRecordingStopTarget } from "~/browser/browserRecordingScope";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { runBrowserViewportMutation } from "~/browser/browserViewportActions";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { isElectron } from "~/env";
import { useEnvironments } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { vmAgentEnvironment } from "~/state/vmAgents";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";
import { closePreviewSession, reconcileLegacyPreviewClose } from "./closePreviewSession";
import {
  PreviewAutomationOperationError,
  PreviewAutomationHumanVerificationHostError,
  PreviewAutomationOverlayTimeoutError,
  PreviewAutomationRecordingNotActiveError,
  PreviewAutomationTargetUnavailableError,
  PreviewAutomationViewportTimeoutError,
} from "./previewAutomationErrors";
import {
  getPreviewHumanVerification,
  inspectPreviewHumanVerification,
} from "./previewHumanVerification";
import {
  previewAutomationDefaultViewport,
  previewAutomationOpenNeedsOverlay,
  shouldOpenPreviewMiniPlayer,
} from "./previewAutomationOpenReadiness";
import {
  assertPreviewRuntimeCurrent,
  waitForNavigationReadiness,
} from "./previewNavigationReadiness";
import { createPreviewAutomationRequestConsumerAtom } from "./previewAutomationRequestConsumer";
import { createPreviewAutomationClientId } from "./previewAutomationClientId";
import {
  findPreviewAutomationDomainTabs,
  needsPreviewAutomationSessionSync,
  previewAutomationDomainKey,
  resolvePreviewAutomationClosePlan,
  resolvePreviewAutomationOpenTab,
  resolvePreviewAutomationTarget,
} from "./previewAutomationTarget";
import {
  runPreviewAutomationLifecycleMutation,
  runPreviewAutomationPostCloseRefresh,
} from "./previewAutomationLifecycleQueue";
import { isPreviewViewportReady } from "./previewViewportReadiness";
import { shouldRollbackPreviewViewport } from "./previewViewportRollback";
import { resolvePreviewAutomationThreadTarget } from "./previewAutomationThreadTarget";

const renewPreviewAutomationForeground = (): Promise<void> => {
  const automation = previewBridge?.automation;
  if (!automation) {
    return Promise.reject(new Error("Desktop preview automation bridge is unavailable."));
  }
  return automation.renewForeground();
};

const PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS = 500;

const waitForPreviewPresentation = async (runtimeTabId: string): Promise<void> => {
  const deadline = Date.now() + PREVIEW_PRESENTATION_SETTLE_TIMEOUT_MS;
  while (Date.now() <= deadline) {
    if (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible) return;
    await new Promise<void>((resolve) => window.setTimeout(resolve, 16));
  }
};

const waitForDesktopOverlay = async (
  threadRef: ScopedThreadRef,
  requestId: string,
  tabId: string,
  runtimeTabId: string,
  operation: PreviewAutomationRequest["operation"],
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const state = assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, {
      operation,
      requestId,
    });
    if (state.desktopByTabId[tabId] && previewBridge) {
      const status = await previewBridge.automation.status(runtimeTabId);
      if (status.available) return;
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationOverlayTimeoutError({
    requestId,
    environmentId: threadRef.environmentId,
    threadId: threadRef.threadId,
    timeoutMs,
  });
};

interface ExecutablePreviewWebview extends Element {
  readonly executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

const findPreviewWebview = (tabId: string): ExecutablePreviewWebview | null =>
  Array.from(document.querySelectorAll<ExecutablePreviewWebview>("webview[data-preview-tab]")).find(
    (candidate) => candidate.getAttribute("data-preview-tab") === tabId,
  ) ?? null;

const readWebviewViewport = async (
  webview: ExecutablePreviewWebview,
): Promise<PreviewRenderedViewportSize | null> => {
  const value = await webview.executeJavaScript(
    "({ width: window.innerWidth, height: window.innerHeight })",
  );
  if (typeof value !== "object" || value === null) return null;
  const { width, height } = value as { readonly width?: unknown; readonly height?: unknown };
  return typeof width === "number" &&
    Number.isInteger(width) &&
    width > 0 &&
    typeof height === "number" &&
    Number.isInteger(height) &&
    height > 0
    ? { width, height }
    : null;
};

const readRenderedViewport = async (
  runtimeTabId: string,
): Promise<PreviewRenderedViewportSize | null> => {
  const webview = findPreviewWebview(runtimeTabId);
  if (!webview) return null;
  return await readWebviewViewport(webview);
};

const readDeclaredViewport = (
  webview: ExecutablePreviewWebview | null,
): PreviewRenderedViewportSize | null => {
  const width = Number(webview?.getAttribute("data-preview-css-width"));
  const height = Number(webview?.getAttribute("data-preview-css-height"));
  return Number.isInteger(width) && width > 0 && Number.isInteger(height) && height > 0
    ? { width, height }
    : null;
};

const waitForRenderedViewport = async (
  threadRef: ScopedThreadRef,
  tabId: string,
  runtimeTabId: string,
  setting: PreviewViewportSetting,
  timeoutMs: number,
  context: {
    readonly requestId: PreviewAutomationRequest["requestId"];
    readonly operation: PreviewAutomationRequest["operation"];
    readonly environmentId: EnvironmentId;
    readonly threadId: PreviewAutomationRequest["threadId"];
  },
): Promise<PreviewRenderedViewportSize> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    assertPreviewRuntimeCurrent(threadRef, tabId, runtimeTabId, context);
    try {
      const webview = findPreviewWebview(runtimeTabId);
      const appliedSettingKey = webview?.getAttribute("data-preview-viewport-key") ?? null;
      const declaredViewport = readDeclaredViewport(webview);
      const renderedViewport = webview ? await readWebviewViewport(webview) : null;
      if (
        renderedViewport &&
        isPreviewViewportReady({
          setting,
          appliedSettingKey,
          declaredViewport,
          renderedViewport,
        })
      ) {
        return renderedViewport;
      }
    } catch {
      // Registration and navigation can transiently replace the guest while
      // React applies the server snapshot. Retry until the operation deadline.
    }
    await new Promise<void>((resolve) => window.setTimeout(resolve, 50));
  }
  throw new PreviewAutomationViewportTimeoutError({
    ...context,
    tabId,
    timeoutMs,
  });
};

const currentStatus = async (
  threadRef: ScopedThreadRef,
  requestedTabId: string | null,
): Promise<PreviewAutomationStatus> => {
  const state = readThreadPreviewState(threadRef);
  const { snapshot, tabId } = resolvePreviewAutomationTarget(state, requestedTabId);
  const runtimeTabId = tabId ? previewRuntimeTabId(threadRef, state.serverEpoch, tabId) : null;
  const visible = runtimeTabId
    ? (useBrowserSurfaceStore.getState().byTabId[runtimeTabId]?.visible ?? false)
    : false;
  const viewportSetting = snapshot ? (snapshot.viewport ?? FILL_PREVIEW_VIEWPORT) : undefined;
  const viewport = runtimeTabId ? await readRenderedViewport(runtimeTabId).catch(() => null) : null;
  const viewportStatus = {
    ...(viewportSetting === undefined ? {} : { viewportSetting }),
    ...(viewport === null ? {} : { viewport }),
  };
  if (runtimeTabId && tabId && previewBridge && state.desktopByTabId[tabId]) {
    const status = await previewBridge.automation.status(runtimeTabId);
    return {
      ...status,
      tabId,
      visible,
      ...viewportStatus,
      humanVerification: getPreviewHumanVerification(runtimeTabId),
    };
  }
  const navStatus = snapshot?.navStatus;
  return {
    available: Boolean(previewBridge?.automation),
    visible,
    tabId,
    url: navStatus && navStatus._tag !== "Idle" ? navStatus.url : null,
    title: navStatus && navStatus._tag !== "Idle" ? navStatus.title : null,
    loading: navStatus?._tag === "Loading",
    humanVerification: runtimeTabId ? getPreviewHumanVerification(runtimeTabId) : null,
    ...viewportStatus,
  };
};

const raiseAtomCommandFailure = (result: Parameters<typeof squashAtomCommandFailure>[0]): never => {
  throw squashAtomCommandFailure(result);
};

const raisePreviewAutomationHostError = (
  error: PreviewAutomationRecordingNotActiveError,
): never => {
  throw error;
};

export function PreviewAutomationHosts() {
  const { environments } = useEnvironments();
  if (!isElectron || !previewBridge?.automation) return null;
  return (
    <>
      {/*
       * Host lifetime follows the desktop runtime's environment connections,
       * not the routed thread. This keeps background threads automatable and
       * lets the subscription runtime own reconnects for every saved target.
       */}
      {environments.map((environment) => (
        <PreviewAutomationHost
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ))}
    </>
  );
}

function PreviewAutomationHost(props: { readonly environmentId: EnvironmentId }) {
  const { environmentId } = props;
  const registry = useContext(RegistryContext);
  const [automationClientId] = useState(createPreviewAutomationClientId);
  const initialAutomationHost = useMemo<PreviewAutomationHostState>(
    () => ({
      clientId: automationClientId,
      environmentId,
      supportedOperations: [...PREVIEW_AUTOMATION_OPERATIONS],
    }),
    [automationClientId, environmentId],
  );
  const automationRequestsAtom = previewEnvironment.automationRequests({
    environmentId,
    input: initialAutomationHost,
  });
  const listPreviews = useAtomQueryRunner(previewEnvironment.list, {
    reportFailure: false,
  });
  const listAgents = useAtomQueryRunner(vmAgentEnvironment.agents, {
    reportFailure: false,
  });
  const open = useAtomCommand(previewEnvironment.open, {
    reportFailure: false,
  });
  const closePreview = useAtomCommand(previewEnvironment.close, {
    reportFailure: false,
  });
  const resize = useAtomCommand(previewEnvironment.resize, {
    reportFailure: false,
  });
  const respondToAutomation = useAtomCommand(
    previewEnvironment.respondToAutomation,
    "preview automation response",
  );
  const focusAutomationHost = useAtomCommand(
    previewEnvironment.focusAutomationHost,
    "preview automation host focus",
  );
  const [automationConnectionAtom] = useState(() => Atom.make<string | null>(null));
  const automationConnectionId = useAtomValue(automationConnectionAtom);

  const handleRequest = useCallback(
    async (request: PreviewAutomationRequest): Promise<unknown> => {
      const requestThreadRef: ScopedThreadRef = {
        environmentId,
        threadId: request.threadId,
      };
      const threadRef = resolvePreviewAutomationThreadTarget({
        environmentId,
        requestThreadRef,
        requestedTabId: request.tabId,
        previewByThreadKey: readActivePreviewSessions(),
        presentationsByRuntimeTabId: useBrowserSurfaceStore.getState().byTabId,
      });
      let tabId = request.tabId ?? null;
      try {
        let state = readThreadPreviewState(threadRef);
        const needsSessionSync = needsPreviewAutomationSessionSync(state, request.tabId);
        if (needsSessionSync) {
          const listTarget = {
            environmentId,
            input: { threadId: threadRef.threadId },
          } as const;
          registry.refresh(previewEnvironment.list(listTarget));
          const result = await listPreviews(listTarget);
          if (result._tag === "Failure") {
            return raiseAtomCommandFailure(result);
          }
          reconcilePreviewServerSessions(threadRef, result.value);
          state = readThreadPreviewState(threadRef);
        }
        tabId = request.tabId ?? state.snapshot?.tabId ?? null;
        const unavailableTarget = {
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: threadRef.threadId,
          tabId,
          bridgeAvailable: Boolean(previewBridge),
        };
        const requireReadyTab = async () => {
          const bridge = previewBridge;
          const readyTabId = tabId;
          if (!bridge || !readyTabId) {
            throw new PreviewAutomationTargetUnavailableError(unavailableTarget);
          }
          const readyState = readThreadPreviewState(threadRef);
          const runtimeTabId = previewRuntimeTabId(threadRef, readyState.serverEpoch, readyTabId);
          await waitForDesktopOverlay(
            threadRef,
            request.requestId,
            readyTabId,
            runtimeTabId,
            request.operation,
            request.timeoutMs,
          );
          return {
            bridge,
            tabId: readyTabId,
            runtimeTabId,
          };
        };
        type ReadyTab = Awaited<ReturnType<typeof requireReadyTab>>;
        const inspectReadyTab = async (
          ready: ReadyTab,
          options: {
            readonly snapshot?: PreviewAutomationSnapshot | null;
            readonly force?: boolean;
          } = {},
        ) =>
          await inspectPreviewHumanVerification({
            runtimeTabId: ready.runtimeTabId,
            evaluate: (expression) =>
              ready.bridge.automation.evaluate(ready.runtimeTabId, {
                expression,
                awaitPromise: true,
                returnByValue: true,
              }),
            ...options,
          });
        const requireAutomatableTab = async () => {
          const ready = await requireReadyTab();
          const verification = getPreviewHumanVerification(ready.runtimeTabId);
          if (verification) {
            throw new PreviewAutomationHumanVerificationHostError({
              requestId: request.requestId,
              operation: request.operation,
              environmentId,
              threadId: threadRef.threadId,
              tabId: ready.tabId,
              verification,
            });
          }
          return ready;
        };
        const inspectAfterAction = async (ready: ReadyTab) => {
          try {
            await inspectReadyTab(ready);
          } catch {
            // Challenge inspection is diagnostic. The page action already
            // completed, so a transient guest replacement cannot rewrite its
            // result; the next status/snapshot will inspect again.
          }
        };
        switch (request.operation) {
          case "status": {
            const status = await currentStatus(threadRef, tabId);
            try {
              const ready = await requireReadyTab();
              const humanVerification = await inspectReadyTab(ready);
              return { ...status, humanVerification } satisfies PreviewAutomationStatus;
            } catch {
              return status;
            }
          }
          case "open": {
            return await runPreviewAutomationLifecycleMutation(threadRef, async () => {
              const input = request.input as PreviewAutomationOpenInput;
              const resolvedInputUrl = input.url
                ? resolveBrowserNavigationTarget(environmentId, {
                    kind: "url",
                    url: input.url,
                  }).resolvedUrl
                : undefined;
              if (resolvedInputUrl && !request.tabIdExplicit && (input.reuseExistingTab ?? true)) {
                const listTarget = {
                  environmentId,
                  input: { threadId: threadRef.threadId },
                } as const;
                registry.refresh(previewEnvironment.list(listTarget));
                const listed = await listPreviews(listTarget);
                if (listed._tag === "Failure") return raiseAtomCommandFailure(listed);
                reconcilePreviewServerSessions(threadRef, listed.value);
                state = readThreadPreviewState(threadRef);
                const matchingTabs = findPreviewAutomationDomainTabs(state, resolvedInputUrl);
                const domain = previewAutomationDomainKey(resolvedInputUrl);
                if (matchingTabs.length > 0 && domain) {
                  const shouldOpen = input.open ?? input.show ?? true;
                  return {
                    outcome: "selection-required",
                    requestedUrl: resolvedInputUrl,
                    domain,
                    matchingTabs: matchingTabs.map((match) => ({
                      ...match,
                      activeForUser: state.activeTabId === match.tabId,
                      currentForAgent: request.tabId === match.tabId,
                      reuseCall: {
                        tool: "preview_open",
                        arguments: {
                          tabId: match.tabId,
                          url: resolvedInputUrl,
                          open: shouldOpen,
                        },
                      },
                    })),
                    newTabCall: {
                      tool: "preview_open",
                      arguments: {
                        url: resolvedInputUrl,
                        reuseExistingTab: false,
                        open: shouldOpen,
                      },
                    },
                    message: `A tab for ${domain} is already open. Choose a tabId to reuse, or explicitly create a new tab only when separate state is necessary.`,
                  } satisfies PreviewAutomationOpenResult;
                }
              } else {
                state = readThreadPreviewState(threadRef);
              }

              if (
                request.tabIdExplicit &&
                request.tabId !== undefined &&
                !state.sessions[request.tabId]
              ) {
                tabId = request.tabId;
                throw new PreviewAutomationTargetUnavailableError({
                  ...unavailableTarget,
                  tabId,
                });
              }

              let activeTabId = resolvePreviewAutomationOpenTab(
                state,
                request.tabId,
                input.reuseExistingTab ?? true,
              );
              let activeSnapshot = activeTabId
                ? (state.sessions[activeTabId] ?? state.snapshot ?? undefined)
                : undefined;
              const reusedExistingTab = activeTabId !== null;
              tabId = activeTabId;
              if (!activeTabId) {
                const result = await open({
                  environmentId,
                  input: {
                    threadId: threadRef.threadId,
                    ...(resolvedInputUrl ? { url: resolvedInputUrl } : {}),
                  },
                });
                if (result._tag === "Failure") return raiseAtomCommandFailure(result);
                const snapshot = result.value;
                applyPreviewServerSnapshot(threadRef, snapshot);
                activeTabId = snapshot.tabId;
                activeSnapshot = snapshot;
                tabId = activeTabId;
              }
              const activeRuntimeTabId = previewRuntimeTabId(
                threadRef,
                readThreadPreviewState(threadRef).serverEpoch,
                activeTabId,
              );
              if (activeSnapshot) {
                const defaultViewport = previewAutomationDefaultViewport(
                  reusedExistingTab,
                  activeSnapshot,
                );
                if (defaultViewport) {
                  const resizeResult = await runBrowserViewportMutation(
                    activeRuntimeTabId,
                    async () => {
                      assertPreviewRuntimeCurrent(
                        threadRef,
                        activeTabId,
                        activeRuntimeTabId,
                        request,
                      );
                      return await resize({
                        environmentId,
                        input: {
                          threadId: threadRef.threadId,
                          tabId: activeTabId,
                          viewport: defaultViewport,
                        },
                      });
                    },
                  );
                  if (resizeResult._tag === "Failure") {
                    return raiseAtomCommandFailure(resizeResult);
                  }
                  activeSnapshot = resizeResult.value;
                  updatePreviewServerSnapshot(threadRef, resizeResult.value);
                }
              }
              const shouldPresentPreview = shouldOpenPreviewMiniPlayer(input);
              if (shouldPresentPreview) {
                usePreviewMiniPlayerStore.getState().open(threadRef, activeTabId);
              }
              if (activeSnapshot && previewAutomationOpenNeedsOverlay(input, activeSnapshot)) {
                await waitForDesktopOverlay(
                  threadRef,
                  request.requestId,
                  activeTabId,
                  activeRuntimeTabId,
                  request.operation,
                  request.timeoutMs,
                );
              }
              if (shouldPresentPreview) {
                // React commits the thread-bound surface asynchronously. Settle
                // briefly so active-thread opens report visible=true, without
                // turning a background thread's offscreen mini player into an
                // operation failure.
                await waitForPreviewPresentation(activeRuntimeTabId);
              }
              if (reusedExistingTab && resolvedInputUrl && previewBridge) {
                const verification = getPreviewHumanVerification(activeRuntimeTabId);
                if (verification) {
                  throw new PreviewAutomationHumanVerificationHostError({
                    requestId: request.requestId,
                    operation: request.operation,
                    environmentId,
                    threadId: threadRef.threadId,
                    tabId: activeTabId,
                    verification,
                  });
                }
                assertPreviewRuntimeCurrent(threadRef, activeTabId, activeRuntimeTabId, request);
                await previewBridge.navigate(activeRuntimeTabId, resolvedInputUrl);
                await waitForNavigationReadiness(
                  threadRef,
                  request.requestId,
                  activeTabId,
                  activeRuntimeTabId,
                  request.operation,
                  "load",
                  request.timeoutMs,
                );
              }
              const ready = await requireReadyTab();
              const humanVerification = await inspectReadyTab(ready).catch(() => null);
              const status = {
                ...(await currentStatus(threadRef, activeTabId)),
                humanVerification,
              } satisfies PreviewAutomationStatus;
              return reusedExistingTab
                ? ({
                    outcome: "reused",
                    tabId: activeTabId,
                    status,
                    message: `Reused tab ${activeTabId}. This tab was not created by this call, so do not close it merely as cleanup.`,
                  } satisfies PreviewAutomationOpenResult)
                : ({
                    outcome: "created",
                    tabId: activeTabId,
                    status,
                    message: `Created tab ${activeTabId}. Reuse it for this browsing concern and close it with preview_close when it is no longer needed.`,
                    cleanup: {
                      tool: "preview_close",
                      arguments: { tabId: activeTabId },
                    },
                  } satisfies PreviewAutomationOpenResult);
            });
          }
          case "close": {
            return await runPreviewAutomationLifecycleMutation(threadRef, async () => {
              const closeTabId = request.tabId;
              if (!request.tabIdExplicit || !closeTabId) {
                tabId = closeTabId ?? null;
                throw new PreviewAutomationTargetUnavailableError({
                  ...unavailableTarget,
                  tabId,
                });
              }

              const listTarget = {
                environmentId,
                input: { threadId: threadRef.threadId },
              } as const;
              // The local index for a background agent thread can lag behind
              // another client. Re-read the server under the lifecycle lock
              // before deciding what exists or whether a blank replacement is
              // newly created by this close.
              registry.refresh(previewEnvironment.list(listTarget));
              const listed = await listPreviews(listTarget);
              if (listed._tag === "Failure") return raiseAtomCommandFailure(listed);
              reconcilePreviewServerSessions(threadRef, listed.value);
              state = readThreadPreviewState(threadRef);
              tabId = closeTabId;
              const closePlan = resolvePreviewAutomationClosePlan(state, closeTabId);
              if (closePlan.outcome === "already-closed") {
                const activeTabId = closePlan.activeTabId;
                tabId = activeTabId;
                return {
                  closedTabId: closeTabId,
                  tabId: activeTabId,
                  replacementCreated: false,
                  message: activeTabId
                    ? `${closeTabId} was already closed. Active tab is ${activeTabId}.`
                    : `${closeTabId} was already closed.`,
                } satisfies PreviewAutomationCloseResult;
              }
              const closeRuntimeTabId = previewRuntimeTabId(
                threadRef,
                state.serverEpoch,
                closeTabId,
              );
              const verification = getPreviewHumanVerification(closeRuntimeTabId);
              if (verification) {
                throw new PreviewAutomationHumanVerificationHostError({
                  requestId: request.requestId,
                  operation: request.operation,
                  environmentId,
                  threadId: threadRef.threadId,
                  tabId: closeTabId,
                  verification,
                });
              }
              const closingSnapshot = closePlan.snapshot;
              const previousSessionCount = closePlan.previousSessionCount;
              const miniPlayer = selectThreadPreviewMiniPlayer(
                usePreviewMiniPlayerStore.getState().byThreadKey,
                threadRef,
              );
              if (miniPlayer?.tabId === closeTabId) {
                usePreviewMiniPlayerStore.getState().close(threadRef);
              }
              const closed = await closePreviewSession({
                closePreview,
                snapshot: closingSnapshot,
                tabId: closeTabId,
                threadRef,
              });
              if (closed._tag === "Failure") return raiseAtomCommandFailure(closed);

              if (closed.value === undefined) {
                // An older server has committed the void-returning close. A
                // best-effort list supplies its survivor set, and an empty set
                // is repaired through the normal server open path. Refresh/open
                // failure cannot turn the committed close into a destructive
                // close retry.
                await runPreviewAutomationPostCloseRefresh(async () => {
                  const agents = await listAgents({ environmentId, input: {} });
                  const retainBlankTab =
                    agents._tag === "Success" &&
                    agents.value.type === "snapshot" &&
                    agents.value.agents.some((agent) => agent.threadId === threadRef.threadId);
                  await reconcileLegacyPreviewClose({
                    closeResult: closed.value,
                    retainBlankTab,
                    threadRef,
                    listPreviews: async () => {
                      registry.refresh(previewEnvironment.list(listTarget));
                      return await listPreviews(listTarget);
                    },
                    openBlankPreview: async () =>
                      await open({
                        environmentId,
                        input: { threadId: threadRef.threadId },
                      }),
                  });
                });
              }
              const nextState = readThreadPreviewState(threadRef);
              const nextTabId = nextState.snapshot?.tabId ?? null;
              const replacementCreated =
                previousSessionCount === 1 &&
                nextTabId !== null &&
                nextTabId !== closeTabId &&
                nextState.sessions[nextTabId]?.navStatus._tag === "Idle";
              tabId = nextTabId;
              return {
                closedTabId: closeTabId,
                tabId: nextTabId,
                replacementCreated,
                message: replacementCreated
                  ? `Closed ${closeTabId}. A blank ${nextTabId} remains because the browser always keeps one tab.`
                  : nextTabId
                    ? `Closed ${closeTabId}. Active tab is ${nextTabId}.`
                    : `Closed ${closeTabId}.`,
              } satisfies PreviewAutomationCloseResult;
            });
          }
          case "navigate": {
            const ready = await requireAutomatableTab();
            const input = request.input as PreviewAutomationNavigateInput;
            const resolution = resolveBrowserNavigationTarget(
              environmentId,
              input.target ?? {
                kind: "url",
                url: input.url!,
              },
            );
            await ready.bridge.navigate(ready.runtimeTabId, resolution.resolvedUrl);
            await waitForNavigationReadiness(
              threadRef,
              request.requestId,
              ready.tabId,
              ready.runtimeTabId,
              request.operation,
              input.readiness ?? "load",
              input.timeoutMs ?? request.timeoutMs,
            );
            const humanVerification = await inspectReadyTab(ready).catch(() => null);
            return {
              ...(await currentStatus(threadRef, ready.tabId)),
              humanVerification,
            } satisfies PreviewAutomationStatus;
          }
          case "resize": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationResizeInput;
            const setting = resolvePreviewViewport(input);
            const applied = await runBrowserViewportMutation(ready.runtimeTabId, async () => {
              const operationState = assertPreviewRuntimeCurrent(
                threadRef,
                ready.tabId,
                ready.runtimeTabId,
                request,
              );
              const previousSetting =
                operationState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
              const result = await resize({
                environmentId,
                input: {
                  threadId: threadRef.threadId,
                  tabId: ready.tabId,
                  viewport: setting,
                },
              });
              if (result._tag === "Failure") {
                return raiseAtomCommandFailure(result);
              }
              updatePreviewServerSnapshot(threadRef, result.value);
              return {
                previousSetting,
                serverEpoch: operationState.serverEpoch,
              };
            });
            let viewport: PreviewRenderedViewportSize;
            try {
              viewport = await waitForRenderedViewport(
                threadRef,
                ready.tabId,
                ready.runtimeTabId,
                setting,
                input.timeoutMs ?? request.timeoutMs,
                {
                  requestId: request.requestId,
                  operation: request.operation,
                  environmentId,
                  threadId: threadRef.threadId,
                },
              );
            } catch (cause) {
              await runBrowserViewportMutation(ready.runtimeTabId, async () => {
                const latestState = readThreadPreviewState(threadRef);
                const latestSetting =
                  latestState.sessions[ready.tabId]?.viewport ?? FILL_PREVIEW_VIEWPORT;
                if (
                  shouldRollbackPreviewViewport(
                    applied.previousSetting,
                    setting,
                    latestSetting,
                    applied.serverEpoch,
                    latestState.serverEpoch,
                  )
                ) {
                  const rollback = await resize({
                    environmentId,
                    input: {
                      threadId: threadRef.threadId,
                      tabId: ready.tabId,
                      viewport: applied.previousSetting,
                    },
                  });
                  if (rollback._tag !== "Failure") {
                    updatePreviewServerSnapshot(threadRef, rollback.value);
                  }
                }
              });
              throw cause;
            }
            return {
              tabId: ready.tabId,
              setting,
              viewport,
            } satisfies PreviewAutomationResizeResult;
          }
          case "setColorScheme": {
            const ready = await requireReadyTab();
            const input = request.input as PreviewAutomationSetColorSchemeInput;
            await ready.bridge.setColorScheme(ready.runtimeTabId, input.colorScheme);
            return {
              tabId: ready.tabId,
              colorScheme: input.colorScheme,
            } satisfies PreviewAutomationSetColorSchemeResult;
          }
          case "snapshot": {
            const ready = await requireReadyTab();
            const snapshot = await ready.bridge.automation.snapshot(ready.runtimeTabId);
            const humanVerification = await inspectReadyTab(ready, { snapshot }).catch(() =>
              getPreviewHumanVerification(ready.runtimeTabId),
            );
            return { ...snapshot, humanVerification } satisfies PreviewAutomationSnapshot;
          }
          case "click": {
            const ready = await requireAutomatableTab();
            const result = await ready.bridge.automation.click(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.click>[1],
              request.expiresAt,
            );
            await inspectAfterAction(ready);
            return result;
          }
          case "type": {
            const ready = await requireAutomatableTab();
            const result = await ready.bridge.automation.type(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.type>[1],
              request.expiresAt,
            );
            await inspectAfterAction(ready);
            return result;
          }
          case "upload": {
            const ready = await requireAutomatableTab();
            const result = await ready.bridge.automation.upload(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.upload>[1],
            );
            await inspectAfterAction(ready);
            return result;
          }
          case "press": {
            const ready = await requireAutomatableTab();
            const result = await ready.bridge.automation.press(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.press>[1],
              request.expiresAt,
            );
            await inspectAfterAction(ready);
            return result;
          }
          case "scroll": {
            const ready = await requireAutomatableTab();
            const result = await ready.bridge.automation.scroll(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.scroll>[1],
            );
            await inspectAfterAction(ready);
            return result;
          }
          case "evaluate": {
            const ready = await requireAutomatableTab();
            const result = await ready.bridge.automation.evaluate(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.evaluate>[1],
            );
            await inspectAfterAction(ready);
            return result;
          }
          case "waitFor": {
            const ready = await requireAutomatableTab();
            const result = await ready.bridge.automation.waitFor(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.waitFor>[1],
            );
            await inspectAfterAction(ready);
            return result;
          }
          case "waitForDownload": {
            const ready = await requireAutomatableTab();
            // No inspectAfterAction: this wait can sit for minutes on a person
            // answering the download card, and re-inspecting the page after it
            // tells the caller nothing it asked for.
            return await ready.bridge.automation.waitForDownload(
              ready.runtimeTabId,
              request.input as Parameters<typeof ready.bridge.automation.waitForDownload>[1],
            );
          }
          case "recordingStart": {
            const ready = await requireReadyTab();
            const startedAt = await startBrowserRecording(
              ready.runtimeTabId,
              threadRef,
              ready.tabId,
            );
            return {
              tabId: ready.tabId,
              recording: true,
              startedAt,
            };
          }
          case "recordingStop": {
            const activeRecordings = readActiveBrowserRecordingTargets(threadRef);
            const activeTabIds = new Set(
              activeRecordings.map((recording) => recording.serverTabId),
            );
            const stopTabId = resolveBrowserRecordingStopTarget(
              activeTabIds,
              tabId,
              request.tabIdExplicit ? request.tabId : undefined,
            );
            tabId = stopTabId ?? tabId;
            const stopRuntimeTabId =
              activeRecordings.find((recording) => recording.serverTabId === stopTabId)
                ?.runtimeTabId ?? null;
            const artifact = stopRuntimeTabId ? await stopBrowserRecording(stopRuntimeTabId) : null;
            if (!artifact || !stopTabId) {
              return raisePreviewAutomationHostError(
                new PreviewAutomationRecordingNotActiveError({
                  requestId: request.requestId,
                  environmentId,
                  threadId: threadRef.threadId,
                  tabId,
                }),
              );
            }
            return { ...artifact, tabId: stopTabId };
          }
        }
      } catch (cause) {
        throw PreviewAutomationOperationError.fromCause({
          requestId: request.requestId,
          operation: request.operation,
          environmentId,
          threadId: threadRef.threadId,
          tabId,
          cause,
        });
      }
    },
    [closePreview, environmentId, listAgents, listPreviews, open, registry, resize],
  );
  const [requestHandlerAtom] = useState(() => Atom.make({ handle: handleRequest }));
  const setRequestHandler = useAtomSet(requestHandlerAtom);
  useEffect(() => {
    setRequestHandler({ handle: handleRequest });
  }, [handleRequest, setRequestHandler]);

  const automationRequestConsumerAtom = useMemo(
    () =>
      createPreviewAutomationRequestConsumerAtom({
        requestsAtom: automationRequestsAtom,
        clientId: automationClientId,
        connectionAtom: automationConnectionAtom,
        environmentId,
        requestHandlerAtom,
        renewAutomationForeground: renewPreviewAutomationForeground,
        respond: (response) =>
          respondToAutomation({
            environmentId,
            input: response,
          }),
        label: `preview:automation-host:${environmentId}:${automationClientId}`,
      }),
    [
      automationClientId,
      automationConnectionAtom,
      automationRequestsAtom,
      requestHandlerAtom,
      respondToAutomation,
      environmentId,
    ],
  );
  useAtomValue(automationRequestConsumerAtom);

  useEffect(() => {
    const report = () => {
      if (!automationConnectionId) return;
      void focusAutomationHost({
        environmentId,
        input: {
          clientId: automationClientId,
          environmentId,
          connectionId: automationConnectionId,
          focused: document.hasFocus(),
        },
      });
    };
    report();
    window.addEventListener("focus", report);
    window.addEventListener("blur", report);
    return () => {
      window.removeEventListener("focus", report);
      window.removeEventListener("blur", report);
    };
  }, [automationClientId, automationConnectionId, environmentId, focusAutomationHost]);

  return null;
}
