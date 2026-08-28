"use client";

import {
  parseScopedThreadKey,
  scopedThreadKey,
  scopeThreadRef,
} from "@t3tools/client-runtime/environment";
import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewSessionSnapshot,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { useEffect, useMemo, useRef, useState } from "react";

import { openRequestedPreviewTab } from "~/components/preview/openRequestedPreviewTab";
import { isElectron } from "~/env";
import { useTheme } from "~/hooks/useTheme";
import { useActivePreviewSessions } from "~/previewStateStore";
import { useThreadShells } from "~/state/entities";
import { useAtomCommand } from "~/state/use-atom-command";
import { previewEnvironment } from "~/state/preview";

import { readPreviewAnnotationTheme } from "./annotationTheme";
import { useBrowserPointerStore } from "./browserPointerStore";
import { resolveHostedBrowserProfileBinding } from "./hostedBrowserProfileBinding";
import { HostedBrowserWebview } from "./HostedBrowserWebview";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

interface HostedBrowserProfileShell {
  readonly threadId: ThreadId;
  readonly browserProfileThreadId: ThreadId | null | undefined;
}

function BoundHostedBrowserWebview(props: {
  readonly threadRef: ScopedThreadRef;
  readonly profileShell: HostedBrowserProfileShell | undefined;
  readonly snapshot: PreviewSessionSnapshot;
  readonly runtimeTabId: string;
  readonly syncGeneration: number;
  readonly zoomFactor: number;
  readonly hostSize: { readonly width: number; readonly height: number };
}) {
  const { hostSize, profileShell, runtimeTabId, snapshot, syncGeneration, threadRef, zoomFactor } =
    props;
  const profileBindingRef = useRef(resolveHostedBrowserProfileBinding(null, profileShell));
  profileBindingRef.current = resolveHostedBrowserProfileBinding(
    profileBindingRef.current,
    profileShell,
  );

  // A late thread shell may reveal an inherited browser profile. Waiting here
  // prevents the guest from first attaching to the wrong partition; once
  // attached, the binding is immutable across shell/reconnect churn.
  const profileBinding = profileBindingRef.current;
  if (!profileBinding) return null;
  const url = snapshot.navStatus._tag === "Idle" ? null : snapshot.navStatus.url;
  return (
    <HostedBrowserWebview
      threadRef={threadRef}
      browserProfileThreadId={profileBinding.profileThreadId}
      tabId={snapshot.tabId}
      runtimeTabId={runtimeTabId}
      syncGeneration={syncGeneration}
      initialUrl={url}
      viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
      zoomFactor={zoomFactor}
      hostSize={hostSize}
    />
  );
}

export function ElectronBrowserHost() {
  const { resolvedTheme } = useTheme();
  const previewByThreadKey = useActivePreviewSessions();
  const threadShells = useThreadShells();
  const openPreview = useAtomCommand(previewEnvironment.open);
  const [hostSize, setHostSize] = useState(() => ({
    width: typeof window === "undefined" ? 1280 : window.innerWidth,
    height: typeof window === "undefined" ? 800 : window.innerHeight,
  }));
  useEffect(() => {
    const update = () => setHostSize({ width: window.innerWidth, height: window.innerHeight });
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  const profileShellByThreadKey = useMemo(
    () =>
      new Map(
        threadShells.map((thread) => [
          scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id)),
          {
            threadId: thread.id,
            browserProfileThreadId: thread.browserProfileThreadId,
          } satisfies HostedBrowserProfileShell,
        ]),
      ),
    [threadShells],
  );
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        return threadRef
          ? Object.values(previewState.hostedSessions).map((snapshot) => ({
              threadRef,
              profileShell: profileShellByThreadKey.get(threadKey),
              snapshot,
              runtimeTabId: previewRuntimeTabId(
                threadRef,
                previewState.serverEpoch,
                snapshot.tabId,
              ),
              syncGeneration: previewState.hostSyncGeneration,
              zoomFactor: previewState.desktopByTabId[snapshot.tabId]?.zoomFactor ?? 1,
            }))
          : [];
      }),
    [previewByThreadKey, profileShellByThreadKey],
  );

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;

    let lastSerializedTheme = "";
    const syncTheme = () => {
      const theme = readPreviewAnnotationTheme();
      const serializedTheme = JSON.stringify(theme);
      if (serializedTheme === lastSerializedTheme) return;
      lastSerializedTheme = serializedTheme;
      void preview.setAnnotationTheme(theme).catch(() => {
        lastSerializedTheme = "";
      });
    };
    const frameId = window.requestAnimationFrame(syncTheme);
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "style"],
    });
    const headObserver = new MutationObserver(syncTheme);
    headObserver.observe(document.head, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => {
      window.cancelAnimationFrame(frameId);
      observer.disconnect();
      headObserver.disconnect();
    };
  }, [resolvedTheme]);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onPointerEvent((event) => {
      useBrowserPointerStore.getState().apply(event);
    });
  }, []);

  useEffect(() => {
    const preview = window.desktopBridge?.preview;
    if (!preview) return;
    return preview.onNewTabRequested((request) => {
      void openRequestedPreviewTab({
        sourceRuntimeTabId: request.sourceTabId,
        url: request.url,
        sessions,
        openPreview,
      });
    });
  }, [openPreview, sessions]);

  if (!isElectron) return null;
  return (
    <div className="contents" data-electron-browser-host>
      {sessions.map(
        ({ threadRef, profileShell, snapshot, runtimeTabId, syncGeneration, zoomFactor }) => (
          <BoundHostedBrowserWebview
            key={runtimeTabId}
            threadRef={threadRef}
            profileShell={profileShell}
            snapshot={snapshot}
            runtimeTabId={runtimeTabId}
            syncGeneration={syncGeneration}
            zoomFactor={zoomFactor}
            hostSize={hostSize}
          />
        ),
      )}
    </div>
  );
}
