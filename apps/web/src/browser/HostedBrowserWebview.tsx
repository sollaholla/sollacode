"use client";

import type {
  DesktopPreviewWebviewConfig,
  PreviewViewportSetting,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import { useShallow } from "zustand/react/shallow";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { previewBridge } from "~/components/preview/previewBridge";
import { usePreviewBridge } from "~/components/preview/usePreviewBridge";
import { cn } from "~/lib/utils";

import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import {
  browserViewportSettingKey,
  resolveBrowserViewportLayout,
  resolveFillCssViewport,
  resolveFittedBrowserViewport,
} from "./browserViewportLayout";
import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { acquireDesktopTab, type AcquiredDesktopTab } from "./desktopTabLifetime";
import { acquireDesktopWebviewRegistrationOwner } from "./desktopWebviewRegistration";
import {
  applyHostedBrowserWebviewAudio,
  type AudioMutableBrowserWebview,
} from "./hostedBrowserWebviewAudio";
import {
  isHostedBrowserWebviewPresented,
  readHostedBrowserHostWindowPresenting,
  resolveHostedBrowserWebviewAccessibilityState,
  resolveHostedBrowserWebviewContainerSize,
  resolveHostedBrowserWebviewTabIndex,
  resolveHostedBrowserWebviewWrapperStyle,
} from "./hostedBrowserWebviewStyle";
import { usePreviewWebviewConfig } from "./previewWebviewConfigState";
import { useBrowserViewportResize } from "./useBrowserViewportResize";
import {
  INITIAL_WEBVIEW_CRASH_RECOVERY_STATE,
  planWebviewCrashRecovery,
  type WebviewCrashRecoveryState,
} from "./webviewCrashRecovery";

interface ElectronWebview extends HTMLElement, AudioMutableBrowserWebview {
  src: string;
  partition: string;
  preload?: string;
  webpreferences?: string;
  getWebContentsId: () => number;
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>;
}

declare global {
  interface HTMLElementTagNameMap {
    webview: ElectronWebview;
  }
}

/**
 * `webview` has no dash, so React treats it as a plain HTML element rather than
 * a custom one — and React drops unknown attributes whose value is a boolean.
 * Passing `allowpopups` as a JSX boolean therefore never reaches the DOM, and
 * without the attribute Chromium blocks every `window.open` from the guest
 * *before* Electron's window-open handler runs. The page receives a null
 * WindowProxy, which is why OAuth popups ("Sign in with Google") read as dead
 * clicks. React's own JSX types declare the attribute boolean, hence the cast.
 *
 * Applied declaratively rather than through the ref: Electron reads the
 * attribute while attaching the guest, which can race a ref callback.
 */
const ALLOW_POPUPS_ATTRIBUTE = { allowpopups: "" } as unknown as { allowpopups?: boolean };

export function HostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly browserProfileThreadId?: ThreadId | undefined;
  readonly tabId: string;
  readonly runtimeTabId: string;
  readonly syncGeneration: number;
  readonly initialUrl: string | null;
  readonly viewport: PreviewViewportSetting;
  readonly zoomFactor: number;
  readonly hostSize: { readonly width: number; readonly height: number };
}) {
  const {
    threadRef,
    browserProfileThreadId,
    tabId,
    runtimeTabId,
    syncGeneration,
    initialUrl,
    viewport,
    zoomFactor,
    hostSize,
  } = props;
  const loadedConfig = usePreviewWebviewConfig(
    threadRef.environmentId,
    threadRef.threadId,
    browserProfileThreadId,
  );
  const configRef = useRef<DesktopPreviewWebviewConfig | null>(loadedConfig);
  if (configRef.current === null && loadedConfig !== null) {
    configRef.current = loadedConfig;
  }
  // Partition, preload and web preferences are guest attach-time identity.
  // Never remove or reattach a live guest because an SWR/reconnect temporarily
  // loses the config value after the first successful resolution.
  const config = configRef.current;
  const [initialSrc] = useState(() => initialUrl ?? "about:blank");
  const tabLeaseRef = useRef<AcquiredDesktopTab | null>(null);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const webviewRef = useRef<ElectronWebview | null>(null);
  const crashRecoveryRef = useRef<WebviewCrashRecoveryState>(INITIAL_WEBVIEW_CRASH_RECOVERY_STATE);
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[runtimeTabId];
      return {
        content: current?.content ?? null,
        cornerRadius: current?.cornerRadius ?? 0,
        fitSourceContent: current?.fitSourceContent ?? false,
        fittedSourceContent: current?.fittedSourceContent ?? null,
        interactive: current?.interactive ?? true,
        rect: resolveBrowserSurfacePanelRect(state.byTabId, runtimeTabId),
        visible: current?.visible ?? false,
        audible: current?.audible ?? false,
      };
    }),
  );
  const snapshotStageId = usePreviewBridge({
    threadRef,
    tabId,
    runtimeTabId,
    syncGeneration,
  });
  const active = presentation.visible && presentation.rect !== null;
  const [documentVisible, setDocumentVisible] = useState(
    () => typeof document !== "undefined" && document.visibilityState !== "hidden",
  );
  const [ownerWindowFocused, setOwnerWindowFocused] = useState(
    () => typeof document !== "undefined" && readHostedBrowserHostWindowPresenting(document),
  );
  const surfacePresented = isHostedBrowserWebviewPresented(active, ownerWindowFocused);
  const snapshotStaged = snapshotStageId !== null && !surfacePresented;
  const audible = active && presentation.audible && documentVisible;
  const audibleRef = useRef(audible);
  audibleRef.current = audible;
  const lastRect = presentation.rect;

  useEffect(() => {
    crashRecoveryRef.current = INITIAL_WEBVIEW_CRASH_RECOVERY_STATE;
    const lease = acquireDesktopTab(runtimeTabId);
    tabLeaseRef.current = lease;
    return () => {
      if (tabLeaseRef.current === lease) tabLeaseRef.current = null;
      lease.release();
    };
  }, [runtimeTabId]);

  const [webviewGeneration, setWebviewGeneration] = useState(0);
  const [recoverySrc, setRecoverySrc] = useState(initialSrc);
  const latestUrlRef = useRef(initialUrl);

  useEffect(() => {
    latestUrlRef.current = initialUrl;
  }, [initialUrl]);

  const setWebviewRef = useCallback((node: HTMLElement | null) => {
    const webview = node as ElectronWebview | null;
    webviewRef.current = webview;
    applyHostedBrowserWebviewAudio(webview, audibleRef.current);
  }, []);

  useLayoutEffect(() => {
    applyHostedBrowserWebviewAudio(webviewRef.current, audible);
  }, [audible]);

  useEffect(() => {
    const updateVisibility = () => setDocumentVisible(document.visibilityState !== "hidden");
    document.addEventListener("visibilitychange", updateVisibility);
    return () => document.removeEventListener("visibilitychange", updateVisibility);
  }, []);

  useEffect(() => {
    const syncHostWindowPresenting = () => {
      setOwnerWindowFocused(readHostedBrowserHostWindowPresenting(document));
    };
    const syncAfterBlur = () => {
      // Window blur runs before the webview becomes document.activeElement.
      queueMicrotask(syncHostWindowPresenting);
    };
    window.addEventListener("focus", syncHostWindowPresenting);
    window.addEventListener("blur", syncAfterBlur);
    document.addEventListener("focusin", syncHostWindowPresenting);
    document.addEventListener("visibilitychange", syncHostWindowPresenting);
    return () => {
      window.removeEventListener("focus", syncHostWindowPresenting);
      window.removeEventListener("blur", syncAfterBlur);
      document.removeEventListener("focusin", syncHostWindowPresenting);
      document.removeEventListener("visibilitychange", syncHostWindowPresenting);
    };
  }, []);

  useEffect(() => {
    const webview = webviewRef.current;
    if (!webview) return;
    const syncHostWindowPresenting = () => {
      setOwnerWindowFocused(readHostedBrowserHostWindowPresenting(document));
    };
    webview.addEventListener("focus", syncHostWindowPresenting);
    webview.addEventListener("blur", syncHostWindowPresenting);
    return () => {
      webview.removeEventListener("focus", syncHostWindowPresenting);
      webview.removeEventListener("blur", syncHostWindowPresenting);
    };
  }, [webviewGeneration, config]);

  useEffect(() => {
    const webview = webviewRef.current;
    const bridge = previewBridge;
    if (!webview || !config || !bridge) return;
    let disposed = false;
    let recoveryTimeout: ReturnType<typeof setTimeout> | null = null;
    const registrationOwner = acquireDesktopWebviewRegistrationOwner(
      runtimeTabId,
      (webContentsId) => bridge.registerWebview(runtimeTabId, webContentsId),
    );
    const register = () => {
      applyHostedBrowserWebviewAudio(webview, audibleRef.current);
      const lease = tabLeaseRef.current;
      if (!lease) return;
      void (async () => {
        try {
          // The main-process tab and the DOM webview are created by separate
          // effects. Wait for the former so registration cannot race and fail
          // with PreviewTabNotFoundError on a fast about:blank attachment.
          await lease.ready;
          if (disposed || webviewRef.current !== webview) return;
          const webContentsId = webview.getWebContentsId();
          if (Number.isInteger(webContentsId) && webContentsId > 0) {
            registrationOwner.request(webContentsId);
          }
        } catch {
          // did-attach/dom-ready will retry if the guest was not ready yet.
        }
      })();
    };
    const recoverGuest = () => {
      if (disposed || recoveryTimeout !== null) return;
      const recovery = planWebviewCrashRecovery(crashRecoveryRef.current, Date.now());
      if (!recovery) return;
      crashRecoveryRef.current = recovery.state;
      recoveryTimeout = setTimeout(() => {
        recoveryTimeout = null;
        if (!disposed) {
          setRecoverySrc(latestUrlRef.current ?? initialSrc);
          setWebviewGeneration((generation) => generation + 1);
        }
      }, recovery.delayMs);
    };
    webview.addEventListener("did-attach", register);
    webview.addEventListener("dom-ready", register);
    webview.addEventListener("render-process-gone", recoverGuest);
    register();
    return () => {
      disposed = true;
      registrationOwner.release();
      if (recoveryTimeout !== null) clearTimeout(recoveryTimeout);
      webview.removeEventListener("did-attach", register);
      webview.removeEventListener("dom-ready", register);
      webview.removeEventListener("render-process-gone", recoverGuest);
    };
  }, [config, initialSrc, runtimeTabId, syncGeneration, webviewGeneration]);

  useEffect(() => {
    const bridge = previewBridge;
    const tabLease = tabLeaseRef.current;
    if (!bridge || !tabLease) return;
    let disposed = false;
    void tabLease.ready
      .then(async () => {
        if (disposed) return;
        await bridge.setUiActivity(runtimeTabId, "visible-surface", surfacePresented);
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
      if (surfacePresented) {
        void bridge.setUiActivity(runtimeTabId, "visible-surface", false).catch(() => undefined);
      }
    };
  }, [runtimeTabId, surfacePresented]);

  useLayoutEffect(() => {
    const bridge = previewBridge;
    if (!bridge || snapshotStageId === null || surfacePresented) return;
    const leaseId = `snapshot-stage:${snapshotStageId}`;
    // Layout effects run after React has placed the guest on-window. Force the
    // new geometry to resolve before acknowledging the main-process request.
    // requestAnimationFrame cannot be used as the receipt here: Chromium may
    // suspend it while the app is occluded, which is exactly when agents need
    // background snapshots to keep working.
    wrapperRef.current?.getBoundingClientRect();
    void bridge.setUiActivity(runtimeTabId, leaseId, true).catch(() => undefined);
    return () => {
      void bridge.setUiActivity(runtimeTabId, leaseId, false).catch(() => undefined);
    };
  }, [runtimeTabId, snapshotStageId, surfacePresented]);

  const normalizedZoomFactor = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const viewportWidth = viewport._tag === "fill" ? null : viewport.width;
  const viewportHeight = viewport._tag === "fill" ? null : viewport.height;
  const viewportAspectRatio =
    viewportWidth === null || viewportHeight === null ? null : viewportWidth / viewportHeight;
  const lockedAspectRatio =
    aspectRatioLocked && viewportAspectRatio !== null ? viewportAspectRatio : null;
  const handleAspectRatioChange = useCallback((aspectRatio: number | null) => {
    setAspectRatioLocked(aspectRatio !== null);
  }, []);
  const hiddenContentSize = presentation.content
    ? {
        width: presentation.content.width / presentation.content.scale,
        height: presentation.content.height / presentation.content.scale,
      }
    : null;
  const fillCssViewport =
    viewport._tag === "fill"
      ? resolveFillCssViewport({
          presented: lastRect,
          fitSourceContent: presentation.fitSourceContent,
          sourceContent: presentation.fittedSourceContent ?? presentation.content,
          zoomFactor: normalizedZoomFactor,
        })
      : null;
  const hiddenSize =
    viewport._tag !== "fill"
      ? {
          width: viewport.width * normalizedZoomFactor,
          height: viewport.height * normalizedZoomFactor,
        }
      : {
          width:
            (fillCssViewport?.width ?? hiddenContentSize?.width ?? 1280) * normalizedZoomFactor,
          height:
            (fillCssViewport?.height ?? hiddenContentSize?.height ?? 800) * normalizedZoomFactor,
        };
  const containerSize = resolveHostedBrowserWebviewContainerSize(lastRect, hiddenSize);
  const deviceToolbarVisible =
    lastRect !== null && viewport._tag !== "fill" && !presentation.fitSourceContent;
  const {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout: viewportLayout,
  } = useBrowserViewportResize({
    tabId: runtimeTabId,
    viewport,
    zoomFactor,
    containerSize,
    deviceToolbarVisible,
    aspectRatio: lockedAspectRatio,
  });
  const scaleFillCssIntoSlot =
    fillCssViewport !== null &&
    lastRect !== null &&
    (presentation.fitSourceContent ||
      fillCssViewport.width * normalizedZoomFactor > lastRect.width ||
      fillCssViewport.height * normalizedZoomFactor > lastRect.height);
  const fittedSourceViewport = scaleFillCssIntoSlot
    ? fillCssViewport
    : presentation.fitSourceContent && lastRect
      ? resolveFittedBrowserViewport(
          viewport,
          presentation.fittedSourceContent,
          normalizedZoomFactor,
        )
      : null;
  const layout =
    fittedSourceViewport && lastRect
      ? resolveBrowserViewportLayout(lastRect, fittedSourceViewport, normalizedZoomFactor)
      : viewportLayout;

  const syncContentPresentation = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    useBrowserSurfaceStore.getState().presentContent(runtimeTabId, {
      x: layout.viewportX,
      y: layout.viewportY,
      width: layout.viewportWidth,
      height: layout.viewportHeight,
      scale: layout.viewportScale,
      scrollLeft: wrapper.scrollLeft,
      scrollTop: wrapper.scrollTop,
    });
  }, [layout, runtimeTabId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncContentPresentation);
    return () => window.cancelAnimationFrame(frameId);
  }, [syncContentPresentation]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    wrapper.scrollTo({ left: 0, top: 0 });
  }, [runtimeTabId, viewport._tag, viewportHeight, viewportWidth]);

  if (!config) return null;

  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active,
    snapshotStaged,
    cornerRadius: presentation.cornerRadius,
    rect: lastRect,
    hiddenSize,
    hostSize,
    interactive: presentation.interactive,
  });
  const guestInteractive = active && presentation.interactive;
  const wrapperAccessibility = resolveHostedBrowserWebviewAccessibilityState(guestInteractive);

  return (
    <div
      ref={wrapperRef}
      {...wrapperAccessibility}
      className={cn("fixed overflow-hidden", active ? "bg-muted/35" : "bg-transparent")}
      style={{ ...wrapperStyle, overscrollBehavior: "contain" }}
      onScroll={syncContentPresentation}
      data-preview-viewport={runtimeTabId}
    >
      <div className="relative" style={{ width: layout.canvasWidth, height: layout.canvasHeight }}>
        {deviceToolbarVisible && effectiveViewport._tag !== "fill" ? (
          <BrowserDeviceToolbar
            active={guestInteractive}
            setting={effectiveViewport}
            width={Math.max(1, Math.round(containerSize.width))}
            aspectRatio={lockedAspectRatio}
            onAspectRatioChange={handleAspectRatioChange}
            onChange={commitViewportChange}
          />
        ) : null}
        <webview
          key={webviewGeneration}
          ref={setWebviewRef}
          {...ALLOW_POPUPS_ATTRIBUTE}
          src={webviewGeneration === 0 ? initialSrc : recoverySrc}
          partition={config.partition}
          webpreferences={config.webPreferences}
          {...(config.preloadUrl ? { preload: config.preloadUrl } : {})}
          data-preview-tab={runtimeTabId}
          data-preview-server-tab={tabId}
          data-preview-viewport-mode={effectiveViewport._tag}
          data-preview-viewport-key={browserViewportSettingKey(effectiveViewport)}
          tabIndex={resolveHostedBrowserWebviewTabIndex(guestInteractive)}
          data-preview-css-width={
            fittedSourceViewport
              ? fittedSourceViewport.width
              : fillCssViewport
                ? fillCssViewport.width
                : effectiveViewport._tag === "fill"
                  ? Math.max(1, Math.round(layout.viewportWidth / normalizedZoomFactor))
                  : effectiveViewport.width
          }
          data-preview-css-height={
            fittedSourceViewport
              ? fittedSourceViewport.height
              : fillCssViewport
                ? fillCssViewport.height
                : effectiveViewport._tag === "fill"
                  ? Math.max(1, Math.round(layout.viewportHeight / normalizedZoomFactor))
                  : effectiveViewport.height
          }
          className={cn(
            "absolute flex overflow-hidden bg-background",
            active && !layout.fillsPanel && "ring-1 ring-border/70 shadow-sm",
          )}
          style={{
            left: layout.viewportX,
            top: layout.viewportY,
            width: layout.viewportWidth / layout.viewportScale,
            height: layout.viewportHeight / layout.viewportScale,
            transform: layout.viewportScale < 1 ? `scale(${layout.viewportScale})` : undefined,
            transformOrigin: "top left",
          }}
        />
        {active && effectiveViewport._tag !== "fill" && !fittedSourceViewport ? (
          <>
            <BrowserViewportResizeHandles
              layout={layout}
              activeDirection={activeDrag?.direction ?? null}
              onPointerDown={handleResizePointerDown}
              onKeyDown={handleResizeKeyDown}
            />
            {activeDrag ? (
              <div
                className="pointer-events-none absolute z-40 -translate-x-1/2 rounded-md border border-border/80 bg-background/95 px-2 py-1 text-[11px] font-medium tabular-nums text-foreground shadow-md backdrop-blur-sm"
                style={{
                  left: layout.viewportX + layout.viewportWidth / 2,
                  top: layout.viewportY + 10,
                }}
                aria-hidden="true"
              >
                {activeDrag.width} × {activeDrag.height}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
