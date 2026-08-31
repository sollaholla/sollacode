"use client";

import type { ScopedThreadRef } from "@t3tools/contracts";
import { PanelRightIcon, PictureInPicture2, XIcon } from "lucide-react";
import { type PointerEvent as ReactPointerEvent, useLayoutEffect, useRef } from "react";

import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { isElectron } from "~/env";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { Button } from "~/components/ui/button";
import { toastManager } from "~/components/ui/toast";
import { useThreadPreviewState } from "~/previewStateStore";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import {
  clampPreviewMiniPlayerPosition,
  clampPreviewMiniPlayerSize,
  PREVIEW_MINI_PLAYER_DEFAULT_SIZE,
  type PreviewMiniPlayerResizeCorner,
  resolvePreviewMiniPlayerResize,
} from "./previewMiniPlayerLayout";

interface DragState {
  readonly pointerId: number;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly playerX: number;
  readonly playerY: number;
}

interface ResizeState {
  readonly pointerId: number;
  readonly corner: PreviewMiniPlayerResizeCorner;
  readonly pointerX: number;
  readonly pointerY: number;
  readonly width: number;
  readonly height: number;
  readonly playerX: number;
  readonly playerY: number;
}

interface Props {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly bottomInset: number;
  /** The sidebar tab currently presenting this guest, when one is visible. */
  readonly activePanelTabId?: string | null;
}

export function ThreadPreviewMiniPlayer({
  threadRef,
  tabId,
  bottomInset,
  activePanelTabId = null,
}: Props) {
  const rootRef = useRef<HTMLElement | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const resizeRef = useRef<ResizeState | null>(null);
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const previewState = useThreadPreviewState(threadRef);
  const snapshot = previewState.sessions[tabId] ?? null;
  const runtimeTabId = previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId);
  const desktopOverlay = previewState.desktopByTabId[tabId] ?? null;
  const position = miniPlayer?.tabId === tabId ? miniPlayer.position : null;
  const size =
    miniPlayer?.tabId === tabId && miniPlayer.size
      ? miniPlayer.size
      : PREVIEW_MINI_PLAYER_DEFAULT_SIZE;
  const close = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
  };

  const openInPanel = () => {
    usePreviewMiniPlayerStore.getState().close(threadRef);
    useRightPanelStore.getState().openBrowser(threadRef, tabId);
  };

  const toggleNativePictureInPicture = () => {
    if (!previewBridge) return;
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
  };

  useLayoutEffect(() => {
    const clampAndMove = () => {
      const root = rootRef.current;
      const parent = root?.offsetParent;
      if (!root || !(parent instanceof HTMLElement)) return;
      const nextSize = clampPreviewMiniPlayerSize(
        { width: root.offsetWidth, height: root.offsetHeight },
        { width: parent.clientWidth, height: parent.clientHeight },
        bottomInset,
      );
      usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, nextSize);
      const next = clampPreviewMiniPlayerPosition(
        position ?? { x: root.offsetLeft, y: root.offsetTop },
        { width: parent.clientWidth, height: parent.clientHeight },
        nextSize,
        bottomInset,
      );
      usePreviewMiniPlayerStore.getState().move(threadRef, tabId, next);
    };
    clampAndMove();
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement) || typeof ResizeObserver === "undefined") {
      return;
    }
    const observer = new ResizeObserver(clampAndMove);
    observer.observe(root);
    observer.observe(parent);
    return () => observer.disconnect();
  }, [bottomInset, position, tabId, threadRef]);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!root || !(parent instanceof HTMLElement)) return;
    const rootRect = root.getBoundingClientRect();
    const parentRect = parent.getBoundingClientRect();
    dragRef.current = {
      pointerId: event.pointerId,
      pointerX: event.clientX,
      pointerY: event.clientY,
      playerX: rootRect.left - parentRect.left,
      playerY: rootRect.top - parentRect.top,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    event.preventDefault();
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (!drag || drag.pointerId !== event.pointerId || !root || !(parent instanceof HTMLElement)) {
      return;
    }
    const next = clampPreviewMiniPlayerPosition(
      {
        x: drag.playerX + event.clientX - drag.pointerX,
        y: drag.playerY + event.clientY - drag.pointerY,
      },
      { width: parent.clientWidth, height: parent.clientHeight },
      { width: root.offsetWidth, height: root.offsetHeight },
      bottomInset,
    );
    usePreviewMiniPlayerStore.getState().move(threadRef, tabId, next);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleResizePointerDown =
    (corner: PreviewMiniPlayerResizeCorner) => (event: ReactPointerEvent<HTMLButtonElement>) => {
      if (event.button !== 0) return;
      const root = rootRef.current;
      const parent = root?.offsetParent;
      if (!root || !(parent instanceof HTMLElement)) return;
      const rootRect = root.getBoundingClientRect();
      const parentRect = parent.getBoundingClientRect();
      resizeRef.current = {
        pointerId: event.pointerId,
        corner,
        pointerX: event.clientX,
        pointerY: event.clientY,
        width: root.offsetWidth,
        height: root.offsetHeight,
        playerX: rootRect.left - parentRect.left,
        playerY: rootRect.top - parentRect.top,
      };
      event.currentTarget.setPointerCapture(event.pointerId);
      event.preventDefault();
      // Resizing and dragging share the surface now, so a corner press must not
      // also start a move.
      event.stopPropagation();
    };

  const handleResizePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const resize = resizeRef.current;
    const root = rootRef.current;
    const parent = root?.offsetParent;
    if (
      !resize ||
      resize.pointerId !== event.pointerId ||
      !root ||
      !(parent instanceof HTMLElement)
    ) {
      return;
    }
    const next = resolvePreviewMiniPlayerResize({
      corner: resize.corner,
      origin: {
        position: { x: resize.playerX, y: resize.playerY },
        size: { width: resize.width, height: resize.height },
      },
      delta: { x: event.clientX - resize.pointerX, y: event.clientY - resize.pointerY },
      container: { width: parent.clientWidth, height: parent.clientHeight },
      bottomInset,
    });
    usePreviewMiniPlayerStore.getState().resize(threadRef, tabId, next.size);
    usePreviewMiniPlayerStore.getState().move(threadRef, tabId, next.position);
  };

  const endResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (resizeRef.current?.pointerId !== event.pointerId) return;
    resizeRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  // Automation may request a floating presentation for the tab that is
  // already open in the sidebar. Do not mount a second surface owner during
  // the effect that clears that redundant mini-player state.
  // Non-Electron clients have no local guest to float; their browser lives in
  // the panel's RemoteBrowserFrame, so a thumbnail would just be a black box.
  if (!isElectron || !snapshot || miniPlayer?.tabId !== tabId || activePanelTabId === tabId) {
    return null;
  }

  return (
    <section
      ref={rootRef}
      aria-label="Floating browser preview"
      data-preview-mini-player={tabId}
      className="pointer-events-none absolute select-none"
      style={
        position
          ? { left: position.x, top: position.y, width: size.width, height: size.height }
          : {
              right: 16,
              top: 16,
              width: size.width,
              height: size.height,
            }
      }
    >
      <div className="group relative h-full min-h-0">
        <div className="absolute inset-0 z-[29] rounded-xl bg-muted shadow-2xl/35" />
        {/* The guest paints at z-30 between the backdrop and the controls. It is
            presented non-interactively: floating, this is a thumbnail you move,
            so a click must never land in the page. Interactivity is what
            "Open" promotes you to. */}
        <BrowserSurfaceSlot
          tabId={runtimeTabId}
          visible={Boolean(desktopOverlay?.hasWebContents)}
          audible={false}
          cornerRadius={12}
          fitSourceContent
          interactive={false}
          layoutVersion={position ? `${position.x}:${position.y}` : `initial:${bottomInset}`}
          className="absolute inset-0"
        />
        <div className="pointer-events-none absolute inset-0 z-[31] rounded-xl ring-1 ring-inset ring-border/80" />
        {!desktopOverlay?.hasWebContents ? (
          <div className="pointer-events-none absolute inset-0 z-[31] flex items-center justify-center rounded-xl bg-muted text-xs text-muted-foreground">
            Reconnecting preview…
          </div>
        ) : null}

        {/* Drag surface. Explicit rather than relying on the guest's
            `pointer-events: none` letting clicks fall through to the backdrop:
            this layer sits above the guest, so dragging works the same however
            the surface is hosted. */}
        <div
          data-preview-mini-player-drag=""
          className="pointer-events-auto absolute inset-0 z-[32] cursor-grab rounded-xl active:cursor-grabbing"
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        />

        <div className="pointer-events-none absolute inset-0 z-[33] flex items-center justify-center rounded-xl bg-background/50 opacity-0 backdrop-blur-[2px] transition-opacity duration-150 group-focus-within:opacity-100 group-hover:opacity-100">
          <Button
            variant="secondary"
            size="sm"
            data-testid="preview-mini-player-open"
            aria-label="Open preview in right panel"
            title="Open in right panel"
            className="pointer-events-auto shadow-lg"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={openInPanel}
          >
            <PanelRightIcon />
            Open
          </Button>
        </div>

        <div className="pointer-events-none absolute right-1.5 top-1.5 z-[34] flex h-8 items-center gap-0.5 rounded-lg border border-border/80 bg-popover/92 p-0.5 opacity-0 shadow-lg/20 backdrop-blur-xl transition-opacity group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          <Button
            variant={desktopOverlay?.pictureInPicture ? "secondary" : "ghost"}
            size="icon-xs"
            aria-label={
              desktopOverlay?.pictureInPicture
                ? "Close popped-out preview"
                : "Pop preview into separate window"
            }
            title={
              desktopOverlay?.pictureInPicture
                ? "Close separate window"
                : "Pop into separate window"
            }
            disabled={!desktopOverlay?.hasWebContents}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={toggleNativePictureInPicture}
          >
            <PictureInPicture2 />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Close floating preview"
            title="Close floating preview"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={close}
          >
            <XIcon />
          </Button>
        </div>

        <button
          type="button"
          aria-label="Resize floating preview from the bottom left"
          title="Resize floating preview"
          data-testid="preview-mini-player-resize-left"
          className="pointer-events-auto absolute bottom-0 left-0 z-[35] size-5 cursor-nesw-resize rounded-bl-xl after:absolute after:bottom-1 after:left-1 after:size-2 after:border-b after:border-l after:border-foreground/45"
          onPointerDown={handleResizePointerDown("left")}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
        <button
          type="button"
          aria-label="Resize floating preview from the bottom right"
          title="Resize floating preview"
          data-testid="preview-mini-player-resize-right"
          className="pointer-events-auto absolute bottom-0 right-0 z-[35] size-5 cursor-nwse-resize rounded-br-xl after:absolute after:bottom-1 after:right-1 after:size-2 after:border-b after:border-r after:border-foreground/45"
          onPointerDown={handleResizePointerDown("right")}
          onPointerMove={handleResizePointerMove}
          onPointerUp={endResize}
          onPointerCancel={endResize}
        />
      </div>
    </section>
  );
}
