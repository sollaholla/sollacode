"use client";

import {
  PreviewTabId,
  type EnvironmentId,
  type PreviewRemoteInputAction,
  type PreviewRemoteSnapshotResult,
  type ThreadId,
} from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { scopeThreadRef } from "@t3tools/client-runtime/environment";

import { cn } from "~/lib/utils";
import { applyPreviewRemoteDownloadApprovals } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { PreviewRemoteConsole } from "./PreviewRemoteConsole";
import {
  focusRemoteKeyboardForPoint,
  remoteKeyboardActionForBeforeInput,
} from "./remoteEditableRegions";
import { mapRemotePointerToViewport } from "./remotePointerMapping";
import {
  TOUCH_LONG_PRESS_MS,
  TOUCH_SCROLL_FLUSH_MS,
  beginTouchGesture,
  finishTouchGesture,
  isTouchLongPressDue,
  moveTouchGesture,
  type TouchGestureState,
} from "./remoteTouchGestures";

/**
 * A frame now costs the host one renderer-side capture rather than a full
 * snapshot's two DOM reads and an accessibility tree, so the cadence is set by
 * what is reasonable to send over a network rather than by what the guest's
 * machine can survive being asked.
 */
const REMOTE_FRAME_INTERVAL_MS = 1_000;
/**
 * Ticks a frame may survive its own capture failing before it is dropped.
 * Long enough to ride out a navigation at the default cadence, short enough
 * that a picture of the wrong guest cannot sit there looking authoritative.
 */
const MAX_STALE_FRAME_TICKS = 5;

/**
 * Keys that mean something to a page but produce no text. Anything else of
 * length 1 is a character and goes as text, so layouts and dead keys resolve
 * the way the person's own keyboard resolved them.
 */
const NON_TEXT_KEYS = new Set([
  "Enter",
  "Tab",
  "Backspace",
  "Delete",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

/**
 * The guest for this tab is a real browser on another machine. Rather than open
 * a second one here — same URL, different cookies, invisible to the agent —
 * show frames captured from the real one, and send what the person does back to
 * it.
 */
export function PreviewRemoteSurface(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly tabId: string;
  readonly visible: boolean;
  readonly interactive?: boolean;
  /** Overrides the browsing cadence while a live overlay is being driven. */
  readonly cadenceMs?: number | undefined;
  /** Shows the guest's console and failed requests beneath the frame. */
  readonly showConsole?: boolean | undefined;
  readonly className?: string;
}) {
  const {
    environmentId,
    threadId,
    tabId,
    visible,
    interactive = true,
    cadenceMs = REMOTE_FRAME_INTERVAL_MS,
    showConsole = false,
    className,
  } = props;
  const [frame, setFrame] = useState<PreviewRemoteSnapshotResult | null>(null);
  const [stale, setStale] = useState(false);
  /**
   * Consecutive failed captures. Holding the last good frame is right for a
   * page mid-navigation, which recovers in one or two ticks; it is wrong once
   * the host has stopped answering for this tab, because the picture on screen
   * then belongs to a guest the viewer is no longer connected to and there is
   * nothing to say so. Showing the wrong page confidently is worse than
   * showing none.
   */
  const consecutiveFailuresRef = useRef(0);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const virtualKeyboardInputRef = useRef<HTMLInputElement | null>(null);
  const threadRef = useMemo(
    () => scopeThreadRef(environmentId, threadId),
    [environmentId, threadId],
  );
  // One finger's worth of gesture state. Refs, not state: a drag emits no
  // renders of its own, only scroll RPCs.
  const touchGestureRef = useRef<TouchGestureState | null>(null);
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingScrollRef = useRef({ deltaX: 0, deltaY: 0 });
  const scrollFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const captureRemoteSnapshot = useAtomCommand(previewEnvironment.remoteSnapshot, {
    reportFailure: false,
  });
  const sendRemoteInput = useAtomCommand(previewEnvironment.remoteInput, {
    reportFailure: false,
  });
  // Frames are only meaningful for the tab they were captured from, and the
  // panel can switch tabs while a request is in flight.
  const tabIdRef = useRef(tabId);
  tabIdRef.current = tabId;

  const clearTouchGesture = useCallback(() => {
    touchGestureRef.current = null;
    if (longPressTimerRef.current !== null) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    if (scrollFlushTimerRef.current !== null) {
      clearTimeout(scrollFlushTimerRef.current);
      scrollFlushTimerRef.current = null;
    }
    pendingScrollRef.current = { deltaX: 0, deltaY: 0 };
  }, []);

  useEffect(() => {
    setFrame((current) => (current?.tabId === tabId ? current : null));
    setStale(false);
    consecutiveFailuresRef.current = 0;
    clearTouchGesture();
  }, [clearTouchGesture, tabId]);

  useEffect(() => clearTouchGesture, [clearTouchGesture]);

  const capture = useCallback(async () => {
    const requested = tabIdRef.current;
    const result = await captureRemoteSnapshot({
      environmentId,
      input: {
        threadId,
        tabId: PreviewTabId.make(requested),
        ...(showConsole ? { includeDiagnostics: true } : {}),
      },
    });
    if (tabIdRef.current !== requested) return;
    if (result._tag === "Failure") {
      // A dropped frame is usually a page mid-navigation, not a dead host.
      // Keep the last good one on screen and mark it rather than going blank —
      // but only for as long as that stays a fair guess. Past the bound the
      // frame is dropped, because a stale picture of another page reads as the
      // live one.
      consecutiveFailuresRef.current += 1;
      setStale(true);
      if (consecutiveFailuresRef.current >= MAX_STALE_FRAME_TICKS) setFrame(null);
      return;
    }
    consecutiveFailuresRef.current = 0;
    setFrame(result.value);
    setStale(false);
    // The frame is the only channel through which this machine learns the
    // host is holding a download. Recorded in the store rather than kept
    // here so the composer banner can raise it even with the panel closed.
    applyPreviewRemoteDownloadApprovals(
      threadRef,
      requested,
      result.value.pendingDownloadApprovals ?? [],
    );
  }, [captureRemoteSnapshot, environmentId, showConsole, threadId, threadRef]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await capture();
      if (active) timer = setTimeout(() => void tick(), cadenceMs);
    };
    void tick();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [cadenceMs, capture, visible]);

  const send = useCallback(
    async (action: PreviewRemoteInputAction) => {
      const requested = tabIdRef.current;
      await sendRemoteInput({
        environmentId,
        input: { threadId, tabId: PreviewTabId.make(requested), action },
      });
      // The next scheduled frame can be seconds away, which reads as the click
      // having done nothing. Ask for one now instead.
      if (tabIdRef.current === requested) await capture();
    },
    [capture, environmentId, sendRemoteInput, threadId],
  );

  // Input needs the guest's CSS viewport to aim at, which older hosts do not
  // report. Without it the mirror stays a picture rather than aiming blind.
  const aimable = interactive && frame?.viewport !== undefined;

  const focusKeyboardForPoint = useCallback(
    (point: { readonly x: number; readonly y: number }) => {
      // This mutation and focus must remain synchronous in the tap/click
      // handler. iOS refuses to raise its keyboard once the user-activation
      // task has returned, even though the guest click succeeds later.
      return focusRemoteKeyboardForPoint({
        keyboardTarget: virtualKeyboardInputRef.current,
        regions: frame?.editableRegions,
        point,
      });
    },
    [frame?.editableRegions],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLImageElement>) => {
      const element = imageRef.current;
      if (!aimable || !element || !frame?.viewport) return;
      const point = mapRemotePointerToViewport(
        { clientX: event.clientX, clientY: event.clientY },
        {
          element: element.getBoundingClientRect(),
          frame: { width: frame.screenshot.width, height: frame.screenshot.height },
          viewport: frame.viewport,
        },
      );
      if (!point) return;
      if (!focusKeyboardForPoint(point)) element.focus();
      void send({ kind: "click", x: point.x, y: point.y });
    },
    [aimable, focusKeyboardForPoint, frame, send],
  );

  const handleWheel = useCallback(
    (event: React.WheelEvent<HTMLImageElement>) => {
      if (!aimable) return;
      void send({ kind: "scroll", deltaX: event.deltaX, deltaY: event.deltaY });
    },
    [aimable, send],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLElement>) => {
      if (!aimable) return;
      const modifiers = (
        [
          event.altKey ? "Alt" : null,
          event.ctrlKey ? "Control" : null,
          event.metaKey ? "Meta" : null,
          event.shiftKey ? "Shift" : null,
        ] as const
      ).filter((modifier): modifier is "Alt" | "Control" | "Meta" | "Shift" => modifier !== null);
      // A bare character is text. Anything else — a named key, or a character
      // held with a command modifier — is a keypress the page should interpret.
      const isText = event.key.length === 1 && !event.ctrlKey && !event.metaKey;
      if (!isText && !NON_TEXT_KEYS.has(event.key) && event.key.length !== 1) return;
      event.preventDefault();
      void send(
        isText
          ? { kind: "type", text: event.key }
          : modifiers.length === 0
            ? { kind: "press", key: event.key }
            : { kind: "press", key: event.key, modifiers },
      );
    },
    [aimable, send],
  );

  const handleVirtualKeyboardKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (!aimable) return;
      // Plain characters are delivered by beforeinput on both software and
      // hardware keyboards. Sending them here as well duplicates every key.
      if (event.key.length === 1 && !event.ctrlKey && !event.metaKey) return;
      handleKeyDown(event);
    },
    [aimable, handleKeyDown],
  );

  const handleVirtualKeyboardBeforeInput = useCallback(
    (event: React.FormEvent<HTMLInputElement>) => {
      if (!aimable) return;
      const native = event.nativeEvent as InputEvent;
      const action = remoteKeyboardActionForBeforeInput({
        inputType: native.inputType,
        data: native.data,
      });
      if (!action) return;
      event.preventDefault();
      void send(action);
    },
    [aimable, send],
  );

  const mapClientPoint = useCallback(
    (clientX: number, clientY: number) => {
      const element = imageRef.current;
      if (!element || !frame?.viewport) return null;
      return mapRemotePointerToViewport(
        { clientX, clientY },
        {
          element: element.getBoundingClientRect(),
          frame: { width: frame.screenshot.width, height: frame.screenshot.height },
          viewport: frame.viewport,
        },
      );
    },
    [frame],
  );

  // Scroll increments are batched and sent bare — the shared `send` asks for
  // a frame after every action, which a drag would turn into a capture per
  // flush. One refreshed frame at finger-up is enough.
  const flushTouchScroll = useCallback(() => {
    scrollFlushTimerRef.current = null;
    const pending = pendingScrollRef.current;
    if (pending.deltaX === 0 && pending.deltaY === 0) return;
    pendingScrollRef.current = { deltaX: 0, deltaY: 0 };
    void sendRemoteInput({
      environmentId,
      input: {
        threadId,
        tabId: PreviewTabId.make(tabIdRef.current),
        action: { kind: "scroll", deltaX: pending.deltaX, deltaY: pending.deltaY },
      },
    });
  }, [environmentId, sendRemoteInput, threadId]);

  const handleTouchStart = useCallback(
    (event: React.TouchEvent<HTMLImageElement>) => {
      if (!aimable) return;
      if (event.touches.length !== 1) {
        // A second finger is a pinch or a mistake; either way this gesture
        // must neither tap nor right-click on release.
        const gesture = touchGestureRef.current;
        if (gesture) touchGestureRef.current = { ...gesture, mode: "consumed" };
        if (longPressTimerRef.current !== null) {
          clearTimeout(longPressTimerRef.current);
          longPressTimerRef.current = null;
        }
        return;
      }
      const touch = event.touches[0]!;
      touchGestureRef.current = beginTouchGesture({
        clientX: touch.clientX,
        clientY: touch.clientY,
        now: Date.now(),
      });
      if (longPressTimerRef.current !== null) clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        const gesture = touchGestureRef.current;
        if (!gesture || !isTouchLongPressDue(gesture, Date.now())) return;
        // Held still: a right-click, the touch spelling of "open the menu".
        touchGestureRef.current = { ...gesture, mode: "consumed" };
        const point = mapClientPoint(gesture.startClientX, gesture.startClientY);
        if (point) void send({ kind: "click", x: point.x, y: point.y, button: "right" });
      }, TOUCH_LONG_PRESS_MS);
    },
    [aimable, mapClientPoint, send],
  );

  const handleTouchMove = useCallback(
    (event: React.TouchEvent<HTMLImageElement>) => {
      const gesture = touchGestureRef.current;
      if (!gesture || event.touches.length !== 1) return;
      const touch = event.touches[0]!;
      const moved = moveTouchGesture(gesture, {
        clientX: touch.clientX,
        clientY: touch.clientY,
      });
      touchGestureRef.current = moved.gesture;
      if (moved.gesture.mode === "scrolling" && longPressTimerRef.current !== null) {
        clearTimeout(longPressTimerRef.current);
        longPressTimerRef.current = null;
      }
      if (moved.scrollDelta) {
        pendingScrollRef.current = {
          deltaX: pendingScrollRef.current.deltaX + moved.scrollDelta.deltaX,
          deltaY: pendingScrollRef.current.deltaY + moved.scrollDelta.deltaY,
        };
        scrollFlushTimerRef.current ??= setTimeout(flushTouchScroll, TOUCH_SCROLL_FLUSH_MS);
      }
    },
    [flushTouchScroll],
  );

  const handleTouchEnd = useCallback(
    (event: React.TouchEvent<HTMLImageElement>) => {
      const gesture = touchGestureRef.current;
      if (!gesture) return;
      // Also suppresses the browser's synthetic click, which would otherwise
      // land a second, differently-aimed tap through the mouse handler.
      event.preventDefault();
      const wasScrolling = gesture.mode === "scrolling";
      const outcome = finishTouchGesture(gesture);
      clearTouchGesture();
      if (outcome === "tap") {
        const point = mapClientPoint(gesture.startClientX, gesture.startClientY);
        if (!point) return;
        if (!focusKeyboardForPoint(point)) imageRef.current?.focus();
        void send({ kind: "click", x: point.x, y: point.y });
        return;
      }
      if (wasScrolling) {
        flushTouchScroll();
        void capture();
      }
    },
    [capture, clearTouchGesture, flushTouchScroll, focusKeyboardForPoint, mapClientPoint, send],
  );

  const handleTouchCancel = useCallback(() => {
    if (!touchGestureRef.current) return;
    clearTouchGesture();
  }, [clearTouchGesture]);

  return (
    <div className={cn("flex flex-col overflow-hidden bg-muted/30", className)}>
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden">
        {aimable ? (
          <input
            ref={virtualKeyboardInputRef}
            className="pointer-events-none absolute bottom-0 left-0 size-px opacity-0"
            aria-label="Remote browser keyboard input"
            tabIndex={-1}
            autoCapitalize="none"
            autoCorrect="off"
            autoComplete="off"
            spellCheck={false}
            onKeyDown={handleVirtualKeyboardKeyDown}
            onBeforeInput={handleVirtualKeyboardBeforeInput}
            onInput={(event) => {
              // Unknown edit types must not accumulate invisible local text.
              event.currentTarget.value = "";
            }}
          />
        ) : null}
        {frame ? (
          <img
            ref={imageRef}
            src={`data:${frame.screenshot.mimeType};base64,${frame.screenshot.data}`}
            alt={frame.title === "" ? frame.url : frame.title}
            className={cn(
              "h-full w-full object-contain transition-opacity",
              stale && "opacity-60",
              // touch-none hands every touch to the gesture handlers instead
              // of panning this page: the mirror is the thing being scrolled.
              aimable && "cursor-pointer touch-none focus:outline-none",
            )}
            draggable={false}
            tabIndex={aimable ? 0 : undefined}
            onClick={aimable ? handleClick : undefined}
            onWheel={aimable ? handleWheel : undefined}
            onKeyDown={aimable ? handleKeyDown : undefined}
            onTouchStart={aimable ? handleTouchStart : undefined}
            onTouchMove={aimable ? handleTouchMove : undefined}
            onTouchEnd={aimable ? handleTouchEnd : undefined}
            onTouchCancel={aimable ? handleTouchCancel : undefined}
          />
        ) : (
          <p className="px-6 text-center text-sm text-muted-foreground">
            Waiting for a frame from the machine running this environment…
          </p>
        )}
      </div>
      {showConsole ? (
        <PreviewRemoteConsole
          consoleEntries={frame?.consoleEntries}
          networkEntries={frame?.networkEntries}
          className="max-h-56 shrink-0"
        />
      ) : null}
    </div>
  );
}
