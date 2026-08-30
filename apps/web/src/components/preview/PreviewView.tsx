"use client";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  PreviewTabId,
  type PreviewRemoteInputAction,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, LoaderCircleIcon, ShieldAlertIcon } from "lucide-react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { previewAnnotationScreenshotFile } from "~/lib/previewAnnotation";
import { ensureLocalApi } from "~/localApi";
import { readPreparedConnection } from "~/state/session";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import {
  useEnvironment,
  useEnvironmentHttpBaseUrl,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { useThreadShell } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { openPreviewSession } from "./openPreviewSession";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { formatPreviewUrl } from "./previewUrlPresentation";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu } from "./PreviewMoreMenu";
import {
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "~/browser/browserViewportActions";
import { resolveResponsiveBrowserViewportSize } from "~/browser/browserViewportLayout";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { PreviewUnreachable } from "./PreviewUnreachable";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { PreviewRemoteDevTools } from "./PreviewRemoteDevTools";
import { devToolsFrontendUrl } from "./devToolsFrontendUrl";
import { PreviewRemoteSurface } from "./PreviewRemoteSurface";
import { isElectron } from "~/env";
import { resolvePreviewSurfaceMode } from "./previewSurfaceMode";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { useLoadingProgress } from "./useLoadingProgress";
import { usePreviewSession } from "./usePreviewSession";
import { ZoomIndicator } from "./ZoomIndicator";
import { AgentBrowserCursor } from "./AgentBrowserCursor";
import { PreviewDownloadApprovalPrompt } from "./PreviewDownloadApprovalPrompt";
import { PreviewDownloadNotice } from "./PreviewDownloadNotice";
import { cn } from "~/lib/utils";
import {
  findActiveBrowserRecordingRuntimeTabId,
  startBrowserRecording,
  stopBrowserRecording,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";
import { Button } from "~/components/ui/button";
import {
  inspectPreviewHumanVerification,
  usePreviewHumanVerification,
} from "./previewHumanVerification";
import { isEmbeddedOAuthRejected, openPreviewUrlInSystemBrowser } from "./embeddedOAuth";

interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
}

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

/**
 * While the picker is open the person is hovering and drawing inside the guest
 * page, so the mirror has to keep up with a pointer rather than with reading.
 * Paid only for the duration of a pick, and only affordable at all because a
 * frame no longer drags a DOM and accessibility read behind it.
 */
const PICKING_FRAME_INTERVAL_MS = 300;

/**
 * Single-tab preview surface: chrome row on top, one webview below, empty
 * state when no session exists for the thread.
 */
export function PreviewView({ threadRef, tabId: requestedTabId, configuredUrls, visible }: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState<number | undefined>(undefined);
  const [pickActive, setPickActive] = useState(false);
  // DevTools is a window on the host, not pixels in the page, so it cannot
  // travel. The console behind it can.
  // Real DevTools, proxied from the machine hosting the guest. Only offered
  // where there is no local guest to open Chromium's own on.
  const [devToolsOpen, setDevToolsOpen] = useState(false);
  const [checkingVerification, setCheckingVerification] = useState(false);
  const activeRecordingTabIds = useActiveBrowserRecordingTabIds();
  const pickActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  const previewState = useThreadPreviewState(threadRef);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const environment = useEnvironment(threadRef.environmentId);
  const thread = useThreadShell(threadRef);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const open = useAtomCommand(previewEnvironment.open);
  const resize = useAtomCommand(previewEnvironment.resize, "preview viewport resize");

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const tabId = requestedTabId ?? previewState.activeTabId;
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const humanVerification = usePreviewHumanVerification(runtimeTabId);
  const recordingRuntimeTabId =
    tabId && runtimeTabId
      ? activeRecordingTabIds.has(runtimeTabId)
        ? runtimeTabId
        : findActiveBrowserRecordingRuntimeTabId(threadRef, tabId)
      : null;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const loading = desktopOverlay?.loading ?? navStatus._tag === "Loading";
  const canGoBack = desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  // The broker runs a thread's guest on the machine that owns its
  // environment, so that is the only client whose own guest is the one the
  // agent is driving. Everywhere else, render frames from that machine
  // instead of opening a second browser with different logins.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const surfaceMode = resolvePreviewSurfaceMode({
    canRenderLocalGuest: isElectron,
    environmentLocal:
      primaryEnvironmentId === null ? null : primaryEnvironmentId === threadRef.environmentId,
  });
  // Resolved here so the panel can fall back to the console when there is no
  // way to reach real DevTools — an environment served from somewhere other
  // than this page's own origin leaves the frontend with no credential to
  // present.
  const devToolsFrontend = useMemo(() => {
    if (!tabId) return null;
    const connection = readPreparedConnection(threadRef.environmentId);
    if (!connection) return null;
    return devToolsFrontendUrl({
      httpBaseUrl: connection.httpBaseUrl,
      threadId: threadRef.threadId,
      tabId,
      pageOrigin: typeof window === "undefined" ? null : window.location.origin,
    });
  }, [tabId, threadRef]);
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const controller = desktopOverlay?.controller ?? "none";
  const loadProgress = useLoadingProgress(loading);
  const displayUrl =
    url && environment && environmentHttpBaseUrl
      ? (formatPreviewUrl({
          url,
          environmentLabel: environment.label,
          environmentHttpBaseUrl,
        }) ?? undefined)
      : undefined;
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const panelRect = useBrowserSurfaceStore((state) =>
    runtimeTabId ? (state.byTabId[runtimeTabId]?.rect ?? null) : null,
  );

  const sendRemoteInput = useAtomCommand(previewEnvironment.remoteInput, {
    reportFailure: false,
  });
  // Chrome-row controls drive this machine's own guest through the bridge.
  // When the guest is on another machine there is nothing here to drive, so
  // the same intent goes to the host that has it.
  const sendGuestAction = useCallback(
    async (action: PreviewRemoteInputAction) => {
      if (!tabId) return;
      await sendRemoteInput({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId: PreviewTabId.make(tabId), action },
      });
    },
    [sendRemoteInput, tabId, threadRef],
  );

  const navigateToResolvedUrl = useCallback(
    async (resolvedUrl: string) => {
      if (surfaceMode === "remote-mirror" && tabId) {
        // No guest of ours to drive. Send it to the machine hosting the real
        // one, the same way the mirror sends everything else.
        await sendRemoteInput({
          environmentId: threadRef.environmentId,
          input: {
            threadId: threadRef.threadId,
            tabId: PreviewTabId.make(tabId),
            action: { kind: "navigate", url: resolvedUrl },
          },
        });
        rememberPreviewUrl(threadRef, resolvedUrl);
        return;
      }
      if (runtimeTabId && previewBridge) {
        // Drive the webview imperatively; `usePreviewBridge` mirrors the
        // resolved URL back to the server so other clients stay in sync.
        await previewBridge.navigate(runtimeTabId, resolvedUrl);
        rememberPreviewUrl(threadRef, resolvedUrl);
      } else {
        await openPreviewSession({
          openPreview: open,
          threadRef,
          url: resolvedUrl,
        });
      }
    },
    [open, runtimeTabId, sendRemoteInput, surfaceMode, tabId, threadRef],
  );

  const handleSubmitUrl = useCallback(
    async (next: string) => {
      try {
        await navigateToResolvedUrl(normalizePreviewUrl(next));
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [navigateToResolvedUrl],
  );

  const handleOpenServerUrl = useCallback(
    async (next: string) => {
      try {
        await navigateToResolvedUrl(resolveDiscoveredServerUrl(threadRef.environmentId, next));
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [navigateToResolvedUrl, threadRef.environmentId],
  );

  const handleRefresh = useCallback(() => {
    if (humanVerification) return;
    if (surfaceMode === "remote-mirror") {
      void sendGuestAction({ kind: "reload" });
      return;
    }
    if (previewBridge && runtimeTabId) void previewBridge.refresh(runtimeTabId);
  }, [humanVerification, runtimeTabId, sendGuestAction, surfaceMode]);

  const handleCheckHumanVerification = useCallback(async () => {
    const bridge = previewBridge;
    if (!bridge || !runtimeTabId) return;
    setCheckingVerification(true);
    try {
      const result = await inspectPreviewHumanVerification({
        runtimeTabId,
        force: true,
        evaluate: (expression) =>
          bridge.automation.evaluate(runtimeTabId, {
            expression,
            awaitPromise: true,
            returnByValue: true,
          }),
      });
      toastManager.add(
        result
          ? {
              type: "warning",
              title: "Verification is still active",
              description: "Finish the challenge manually in this tab, then check again.",
            }
          : {
              type: "success",
              title: "Browser automation resumed",
              description: "The verification gate is no longer visible in this tab.",
            },
      );
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not check the verification page",
        description: error instanceof Error ? error.message : "The browser tab is unavailable.",
      });
    } finally {
      setCheckingVerification(false);
    }
  }, [runtimeTabId]);

  const handleOpenVerificationResource = useCallback(
    async (resourceUrl: string) => {
      const result = await openPreviewSession({
        openPreview: open,
        threadRef,
        url: resourceUrl,
      });
      if (result._tag === "Failure") {
        toastManager.add({
          type: "error",
          title: "Could not open the Cloudflare resource",
          description: "The original verification tab was left unchanged.",
        });
      }
    },
    [open, threadRef],
  );

  const handleZoomIn = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.zoomIn(runtimeTabId);
  }, [runtimeTabId]);

  const handleZoomOut = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.zoomOut(runtimeTabId);
  }, [runtimeTabId]);

  const handleResetZoom = useCallback(() => {
    if (previewBridge && runtimeTabId) void previewBridge.resetZoom(runtimeTabId);
  }, [runtimeTabId]);

  const handleViewportChange = useCallback(
    async (nextViewport: PreviewViewportSetting) => {
      if (!tabId) return;
      const result = await resize({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tabId,
          viewport: nextViewport,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to resize browser viewport",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        throw error;
      }
      updatePreviewServerSnapshot(threadRef, result.value);
    },
    [resize, tabId, threadRef],
  );

  const handleToggleDeviceToolbar = () => {
    if (!runtimeTabId) return;
    if (viewport._tag !== "fill") {
      void commitBrowserViewportChange(runtimeTabId, FILL_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }

    const responsiveSize = panelRect
      ? resolveResponsiveBrowserViewportSize(panelRect, desktopOverlay?.zoomFactor)
      : { width: 1024, height: 768 };
    void commitBrowserViewportChange(runtimeTabId, { _tag: "freeform", ...responsiveSize }).catch(
      () => undefined,
    );
  };

  useEffect(() => {
    if (!runtimeTabId) return;
    return subscribeBrowserViewportChange(runtimeTabId, handleViewportChange);
  }, [handleViewportChange, runtimeTabId]);

  const handleBack = useCallback(() => {
    if (surfaceMode === "remote-mirror") {
      void sendGuestAction({ kind: "history", direction: "back" });
      return;
    }
    if (previewBridge && runtimeTabId) void previewBridge.goBack(runtimeTabId);
  }, [runtimeTabId, sendGuestAction, surfaceMode]);

  const handleForward = useCallback(() => {
    if (surfaceMode === "remote-mirror") {
      void sendGuestAction({ kind: "history", direction: "forward" });
      return;
    }
    if (previewBridge && runtimeTabId) void previewBridge.goForward(runtimeTabId);
  }, [runtimeTabId, sendGuestAction, surfaceMode]);

  const handleOpenInBrowser = useCallback(() => {
    if (!url) return;
    openPreviewUrlInSystemBrowser({
      url,
      ...(localApi ? { openNative: localApi.shell.openExternal } : {}),
      openWeb: (externalUrl) => {
        window.open(externalUrl, "_blank", "noopener,noreferrer");
      },
    });
  }, [url]);

  const embeddedOAuthRejected = isEmbeddedOAuthRejected(url);

  const handlePictureInPicture = useCallback(() => {
    if (!tabId) return;
    if (miniPlayer?.tabId === tabId) {
      usePreviewMiniPlayerStore.getState().close(threadRef);
      return;
    }
    usePreviewMiniPlayerStore.getState().open(threadRef, tabId);
    useRightPanelStore.getState().close(threadRef);
  }, [miniPlayer?.tabId, tabId, threadRef]);

  const handleNativePictureInPicture = useCallback(() => {
    if (!previewBridge || !runtimeTabId) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [desktopOverlay?.pictureInPicture, runtimeTabId]);

  const handleCapture = useCallback(
    (record: boolean) => {
      if (!previewBridge || !runtimeTabId || !tabId) return;
      const bridge = previewBridge;
      if (recordingRuntimeTabId) {
        void stopBrowserRecording(recordingRuntimeTabId).then(
          (artifact) => {
            if (!artifact) return;
            let pathCopied = false;
            let toastId: ReturnType<typeof toastManager.add>;

            const copyPath = () => {
              if (!navigator.clipboard?.writeText) {
                toastManager.update(
                  toastId,
                  stackedThreadToast({
                    type: "error",
                    title: "Unable to copy recording path",
                    description: "Clipboard API unavailable.",
                    actionProps: revealAction,
                  }),
                );
                return;
              }

              void navigator.clipboard.writeText(artifact.path).then(
                () => {
                  pathCopied = true;
                  updateRecordingToast();
                  window.setTimeout(() => {
                    pathCopied = false;
                    updateRecordingToast();
                  }, 2_000);
                },
                (error) => {
                  toastManager.update(
                    toastId,
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to copy recording path",
                      description: error instanceof Error ? error.message : "An error occurred.",
                      actionProps: revealAction,
                    }),
                  );
                },
              );
            };

            const revealAction = {
              children: revealInFileExplorerLabel(navigator.platform),
              onClick: () => void bridge.revealArtifact(artifact.path),
            };
            const updateRecordingToast = () => {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "success",
                  title: "Recording saved",
                  actionProps: revealAction,
                  data: {
                    secondaryActionProps: {
                      children: pathCopied ? "Copied!" : "Copy path",
                      disabled: pathCopied,
                      onClick: copyPath,
                    },
                    secondaryActionVariant: "outline",
                  },
                }),
              );
            };

            toastId = toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Recording saved",
                actionProps: revealAction,
                data: {
                  secondaryActionProps: {
                    children: "Copy path",
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          },
          (error) => {
            toastManager.add({
              type: "error",
              title: "Unable to stop recording",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          },
        );
        return;
      }
      if (record) {
        void startBrowserRecording(runtimeTabId, threadRef, tabId).catch((error) => {
          toastManager.add({
            type: "error",
            title: "Unable to start recording",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        });
        return;
      }
      void bridge.captureScreenshot(runtimeTabId).then(
        (artifact) => {
          const revealAction = {
            children: revealInFileExplorerLabel(navigator.platform),
            onClick: () => void bridge.revealArtifact(artifact.path),
          };
          let pathCopied = false;
          let imageCopied = false;
          let toastId: ReturnType<typeof toastManager.add>;

          const updateScreenshotToast = (
            type: "success" | "error" = "success",
            title = "Screenshot saved",
            description?: string,
          ) => {
            toastManager.update(
              toastId,
              stackedThreadToast({
                type,
                title,
                description,
                actionProps: {
                  children: imageCopied ? "Copied!" : "Copy image",
                  disabled: imageCopied,
                  onClick: copyImage,
                },
                data: {
                  additionalActions: [
                    {
                      id: "copy-path",
                      props: {
                        children: pathCopied ? "Copied!" : "Copy path",
                        disabled: pathCopied,
                        onClick: copyPath,
                      },
                    },
                  ],
                  secondaryActionProps: {
                    ...revealAction,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          };

          const copyPath = () => {
            if (!navigator.clipboard?.writeText) {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot path",
                "Clipboard API unavailable.",
              );
              return;
            }

            void navigator.clipboard.writeText(artifact.path).then(
              () => {
                pathCopied = true;
                updateScreenshotToast();
                window.setTimeout(() => {
                  pathCopied = false;
                  updateScreenshotToast();
                }, 2_000);
              },
              (error) => {
                updateScreenshotToast(
                  "error",
                  "Unable to copy screenshot path",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              },
            );
          };

          const copyImage = () => {
            void bridge.copyArtifactToClipboard(artifact.path).then(
              () => {
                imageCopied = true;
                updateScreenshotToast();
                window.setTimeout(() => {
                  imageCopied = false;
                  updateScreenshotToast();
                }, 2_000);
              },
              (error) => {
                updateScreenshotToast(
                  "error",
                  "Unable to copy screenshot",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              },
            );
          };

          toastId = toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Screenshot saved",
              actionProps: {
                children: "Copy image",
                onClick: copyImage,
              },
              data: {
                additionalActions: [
                  {
                    id: "copy-path",
                    props: {
                      children: "Copy path",
                      onClick: copyPath,
                    },
                  },
                ],
                secondaryActionProps: {
                  ...revealAction,
                },
                secondaryActionVariant: "outline",
              },
            }),
          );
        },
        (error) => {
          toastManager.add({
            type: "error",
            title: "Unable to capture screenshot",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
    },
    [recordingRuntimeTabId, runtimeTabId, tabId, threadRef],
  );

  const requestRemotePick = useAtomCommand(previewEnvironment.remotePick, {
    reportFailure: false,
  });
  // The picker's overlay lives in the guest page, so off-machine it is already
  // on screen in the mirror and already driven by forwarded input. What has to
  // travel is the start of the session and the annotation it produces.
  const pickOnHost = useCallback(async () => {
    if (!tabId || pickActiveRef.current) return;
    pickActiveRef.current = true;
    setPickActive(true);
    try {
      const result = await requestRemotePick({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId: PreviewTabId.make(tabId) },
      });
      if (result._tag === "Failure") return;
      const annotation = result.value;
      if (!annotation) return;
      addPreviewAnnotation(threadRef, annotation);
      const screenshotFile = await previewAnnotationScreenshotFile(annotation);
      if (screenshotFile && annotation.screenshot) {
        addImage(threadRef, {
          type: "image",
          id: annotation.id,
          name: screenshotFile.name,
          mimeType: screenshotFile.type,
          sizeBytes: screenshotFile.size,
          previewUrl: annotation.screenshot.dataUrl,
          file: screenshotFile,
        });
      }
    } finally {
      pickActiveRef.current = false;
      if (isMountedRef.current) setPickActive(false);
    }
  }, [addImage, addPreviewAnnotation, requestRemotePick, tabId, threadRef]);

  const handlePickElement = useCallback(() => {
    if (surfaceMode === "remote-mirror") {
      void pickOnHost();
      return;
    }
    if (!previewBridge || !runtimeTabId) return;
    if (pickActiveRef.current) {
      void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      return;
    }
    // Snapshot whatever the user was focused on (typically the chat
    // composer textarea or the chrome-row pick button) BEFORE main steals
    // focus into the guest webContents. We restore it when the pick
    // resolves so the user's typing context isn't lost — otherwise after
    // every pick they'd have to click back into the textarea.
    const previouslyFocused =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    pickActiveRef.current = true;
    setPickActive(true);
    void (async () => {
      try {
        const annotation = await previewBridge.pickElement(runtimeTabId);
        if (!annotation) return;
        addPreviewAnnotation(threadRef, annotation);
        const screenshotFile = await previewAnnotationScreenshotFile(annotation);
        if (screenshotFile && annotation.screenshot) {
          addImage(threadRef, {
            type: "image",
            id: annotation.id,
            name: screenshotFile.name,
            mimeType: screenshotFile.type,
            sizeBytes: screenshotFile.size,
            previewUrl: annotation.screenshot.dataUrl,
            file: screenshotFile,
          });
        }
      } catch {
        // Picker failed (e.g. webview navigated). Treat as silent cancel.
      } finally {
        pickActiveRef.current = false;
        // Avoid `setState on unmounted component` if the panel/thread closed
        // while the pick was in flight.
        if (isMountedRef.current) setPickActive(false);
        // Best-effort: restore focus to whatever the user had before the
        // pick stole it into the guest webContents. Skip if the previously-
        // focused element was unmounted or is no longer focusable.
        if (
          previouslyFocused &&
          previouslyFocused.isConnected &&
          typeof previouslyFocused.focus === "function"
        ) {
          try {
            previouslyFocused.focus({ preventScroll: true });
          } catch {
            // Some elements throw on .focus() (detached iframes, etc.).
          }
        }
      }
    })();
  }, [addImage, addPreviewAnnotation, pickOnHost, runtimeTabId, surfaceMode, threadRef]);

  // If the active tab changes mid-pick (close, thread switch, hot restart),
  // tell main to tear down the in-flight session AND reset our local toggle
  // state so the button doesn't get stuck pressed against a stale tab id.
  useEffect(() => {
    return () => {
      if (!pickActiveRef.current) return;
      pickActiveRef.current = false;
      if (previewBridge && runtimeTabId) {
        void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      }
      if (isMountedRef.current) setPickActive(false);
    };
  }, [runtimeTabId]);

  // Subscribe only while visible; `toggle-panel` is owned by ChatView's
  // URL-aware handler regardless of whether the panel is currently mounted.
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => {
      switch (action) {
        case "refresh":
          handleRefresh();
          return;
        case "focus-url":
          setFocusUrlNonce((value) => (value ?? 0) + 1);
          return;
        case "zoom-in":
          handleZoomIn();
          return;
        case "zoom-out":
          handleZoomOut();
          return;
        case "reset-zoom":
          handleResetZoom();
          return;
        case "toggle-panel":
          return;
      }
    });
  }, [handleRefresh, handleResetZoom, handleZoomIn, handleZoomOut, visible]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={url}
        displayUrl={displayUrl}
        loading={loading}
        loadProgress={loadProgress}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        refreshDisabled={refreshDisabled || humanVerification !== null}
        sharedBrowserProfile={thread?.browserProfileThreadId != null}
        focusUrlNonce={focusUrlNonce}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        onCapture={previewBridge && tabId ? handleCapture : undefined}
        captureDisabled={!desktopOverlay || isUnreachable}
        recording={recordingRuntimeTabId !== null}
        onPictureInPicture={previewBridge && tabId ? handlePictureInPicture : undefined}
        pictureInPicture={miniPlayer?.tabId === tabId}
        pictureInPictureDisabled={!desktopOverlay?.hasWebContents || isUnreachable}
        onToggleConsole={
          surfaceMode === "remote-mirror" && tabId
            ? () => setDevToolsOpen((open) => !open)
            : undefined
        }
        consoleOpen={devToolsOpen}
        onPickElement={
          // Pickable either through this machine's own guest or, with none, on
          // the machine hosting it. Gating on the bridge alone hid the button
          // outright in a regular browser.
          tabId && (previewBridge || surfaceMode === "remote-mirror")
            ? handlePickElement
            : undefined
        }
        pickActive={pickActive}
        // Disable when there's no tab (nothing to pick on) OR the page
        // failed to load (a React overlay covers the webview, so the
        // user wouldn't be able to actually click anything underneath).
        pickDisabled={!tabId || isUnreachable}
        pickDisabledReason={
          isUnreachable ? "Page didn't load — pick unavailable until the page renders" : undefined
        }
        trailingActions={
          previewBridge ? (
            <PreviewMoreMenu
              tabId={runtimeTabId}
              hasWebContents={desktopOverlay?.hasWebContents ?? false}
              zoomFactor={desktopOverlay?.zoomFactor ?? 1}
              colorScheme={desktopOverlay?.colorScheme ?? "system"}
              deviceToolbarVisible={viewport._tag !== "fill"}
              onToggleDeviceToolbar={handleToggleDeviceToolbar}
              nativePictureInPicture={desktopOverlay?.pictureInPicture ?? false}
              onNativePictureInPicture={handleNativePictureInPicture}
            />
          ) : null
        }
      />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeTabId && snapshot && !showEmptyState && surfaceMode === "local-guest" ? (
          <BrowserSurfaceSlot
            key={runtimeTabId}
            tabId={runtimeTabId}
            visible={visible && !isUnreachable}
            audible={visible && !isUnreachable}
            className="absolute inset-0 h-full w-full"
          />
        ) : null}
        {tabId && snapshot && !showEmptyState && surfaceMode === "remote-mirror" ? (
          <div className="absolute inset-0 flex flex-col">
            <PreviewRemoteSurface
              key={tabId}
              environmentId={threadRef.environmentId}
              threadId={threadRef.threadId}
              tabId={tabId}
              visible={visible && !isUnreachable}
              // The picker's overlay is a live UI the person is drawing in, so
              // it needs frames at something other than a browsing cadence.
              cadenceMs={pickActive ? PICKING_FRAME_INTERVAL_MS : undefined}
              // Without a reachable DevTools, the console it would have been
              // opened for is still worth showing.
              showConsole={devToolsOpen && devToolsFrontend === null}
              className="min-h-0 flex-1"
            />
            {devToolsOpen && devToolsFrontend !== null ? (
              <PreviewRemoteDevTools frontendUrl={devToolsFrontend} className="h-1/2 shrink-0" />
            ) : null}
          </div>
        ) : null}
        {showEmptyState ? (
          <PreviewEmptyState
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentlySeenUrls={previewState.recentlySeenUrls}
            onOpenUrl={(next) => void handleOpenServerUrl(next)}
          />
        ) : null}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        {desktopOverlay && !showEmptyState && !isUnreachable ? (
          <PreviewDownloadNotice downloads={desktopOverlay.downloads} />
        ) : null}
        {desktopOverlay && !showEmptyState && !isUnreachable ? (
          <PreviewDownloadApprovalPrompt approvals={desktopOverlay.pendingDownloadApprovals} />
        ) : null}
        {/* The mirrored guest's held downloads, reported by its frames. The
            answer goes back through the server to the machine holding the
            file — the same route every other viewer action takes. */}
        {surfaceMode === "remote-mirror" && tabId && !showEmptyState && !isUnreachable ? (
          <PreviewDownloadApprovalPrompt
            approvals={previewState.remoteApprovalsByTabId[tabId]}
            onAnswer={(id, decision) =>
              void sendGuestAction({ kind: "answerDownloadApproval", id, decision })
            }
          />
        ) : null}
        {runtimeTabId && desktopOverlay && !showEmptyState && !isUnreachable ? (
          <AgentBrowserCursor
            tabId={runtimeTabId}
            zoomFactor={desktopOverlay.zoomFactor}
            // While automation is holding off for the user, no agent is driving,
            // so the agent cursor stays hidden.
            controller={controller === "waiting-for-user" ? "none" : controller}
          />
        ) : null}
        {controller !== "none" ? (
          <div
            className={cn(
              "pointer-events-none absolute left-3 top-3 z-40 rounded-full border px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur",
              // Amber for the held state: it is the one of the three that means
              // something is being blocked, and a neutral chip read as ordinary
              // status rather than "the agent is stopped, waiting on you".
              controller === "waiting-for-user"
                ? "border-amber-500/45 bg-amber-500/12 text-amber-600 dark:text-amber-300"
                : "border-border/70 bg-background/90",
            )}
          >
            {controller === "agent"
              ? "Agent controlling browser"
              : controller === "waiting-for-user"
                ? "Agent paused — waiting for you to stop typing"
                : "Human control"}
          </div>
        ) : null}
        {humanVerification ? (
          <div className="absolute inset-x-3 top-3 z-50 mx-auto max-w-2xl rounded-xl border border-amber-500/40 bg-background/95 p-3 shadow-xl backdrop-blur">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-500">
                <ShieldAlertIcon className="size-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  <p className="text-sm font-semibold">Human verification needed</p>
                  {humanVerification.code ? (
                    <span className="rounded bg-amber-500/12 px-1.5 py-0.5 font-mono text-[10px] text-amber-600 dark:text-amber-400">
                      {humanVerification.code}
                    </span>
                  ) : null}
                </div>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Automation is paused for this tab. Complete the challenge manually here, keeping
                  this page and network connection in place. Because this is an embedded browser
                  with automation attached, manual completion is best-effort.
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  <Button
                    size="xs"
                    type="button"
                    disabled={checkingVerification}
                    onClick={() => void handleCheckHumanVerification()}
                  >
                    {checkingVerification ? (
                      <LoaderCircleIcon className="animate-spin motion-reduce:animate-none" />
                    ) : null}
                    Check again
                  </Button>
                  <Button
                    size="xs"
                    type="button"
                    variant="outline"
                    onClick={() =>
                      void handleOpenVerificationResource(humanVerification.compatibilityCheckUrl)
                    }
                  >
                    Compatibility check <ExternalLinkIcon />
                  </Button>
                  <Button
                    size="xs"
                    type="button"
                    variant="ghost"
                    onClick={() =>
                      void handleOpenVerificationResource(humanVerification.feedbackUrl)
                    }
                  >
                    Report issue <ExternalLinkIcon />
                  </Button>
                </div>
              </div>
            </div>
          </div>
        ) : null}
        {embeddedOAuthRejected ? (
          <div className="absolute inset-x-3 top-3 z-50 mx-auto max-w-2xl rounded-xl border border-amber-500/40 bg-background/95 p-3 shadow-xl backdrop-blur">
            <div className="flex items-start gap-2.5">
              <div className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-amber-500/12 text-amber-500">
                <ShieldAlertIcon className="size-4" aria-hidden />
              </div>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">Sign-in needs your system browser</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Google does not allow account sign-in inside embedded browsers. Retrying in
                  Preview will return to this page. Open it in your system browser to continue
                  there.
                </p>
                <Button className="mt-2" size="xs" type="button" onClick={handleOpenInBrowser}>
                  Open in browser <ExternalLinkIcon />
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
