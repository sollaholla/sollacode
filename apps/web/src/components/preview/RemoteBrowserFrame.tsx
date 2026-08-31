import {
  PreviewTabId,
  type PreviewRemoteInputAction,
  type PreviewRemoteSnapshotResult,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import {
  FRAME_TAP_SLOP_PX,
  containedFrameRect,
  frameFraction,
  resolveFrameGesture,
  type FramePoint,
  type FrameSize,
} from "@t3tools/shared/remoteFrameGestures";
import * as Cause from "effect/Cause";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { cn } from "~/lib/utils";

const LIVE_FRAME_INTERVAL_MS = 2_500;
const WHEEL_FLUSH_MS = 140;

/** Keys forwarded from a physical keyboard while the frame is focused. */
const FORWARDED_PRESS_KEYS = new Set([
  "Enter",
  "Backspace",
  "Tab",
  "Escape",
  "Delete",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "PageUp",
  "PageDown",
]);

interface ActiveGesture {
  readonly pointerId: number;
  readonly pointerType: string;
  /** Viewport-absolute origin of the letterboxed content rect. */
  readonly origin: FramePoint;
  readonly contentSize: FrameSize;
  readonly startedAt: number;
  readonly start: FramePoint;
  end: FramePoint;
  maxDistancePx: number;
  firstMovedAt: number | null;
}

function commandError(cause: Cause.Cause<unknown>, fallback: string): string {
  const error = Cause.squash(cause);
  return error instanceof Error && error.message.trim().length > 0 ? error.message : fallback;
}

/**
 * The web stand-in for the desktop's embedded browser surface: a near-live
 * frame of the desktop host's real tab, with touches, wheel, and keys
 * forwarded through the same automation operations agents use. Rendering
 * never changes hands — the desktop keeps its own guest; this view only
 * exists where no local guest can (phone Safari, plain browsers).
 */
export function RemoteBrowserFrame(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly visible: boolean;
  readonly className?: string;
}) {
  const { threadRef, tabId, visible } = props;
  const [frame, setFrame] = useState<PreviewRemoteSnapshotResult | null>(null);
  const [frameError, setFrameError] = useState<string | null>(null);
  const [keyboardText, setKeyboardText] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<PreviewRemoteSnapshotResult | null>(null);
  frameRef.current = frame;
  const gestureRef = useRef<ActiveGesture | null>(null);
  const wheelAccumulatorRef = useRef({ x: 0, y: 0 });
  const wheelFlushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const captureRemoteSnapshot = useAtomCommand(previewEnvironment.remoteSnapshot, {
    reportFailure: false,
  });
  const sendRemoteInput = useAtomCommand(previewEnvironment.remoteInput, {
    reportFailure: false,
  });

  const capture = useCallback(async () => {
    const result = await captureRemoteSnapshot({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, tabId: PreviewTabId.make(tabId) },
    });
    if (result._tag === "Failure") {
      setFrameError(
        commandError(result.cause, "The desktop browser host did not return a rendered frame."),
      );
      return;
    }
    setFrame(result.value);
    setFrameError(null);
  }, [captureRemoteSnapshot, threadRef.environmentId, threadRef.threadId, tabId]);

  useEffect(() => {
    setFrame(null);
    setFrameError(null);
  }, [tabId]);

  useEffect(() => {
    if (!visible) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      await capture();
      if (active) timer = setTimeout(() => void tick(), LIVE_FRAME_INTERVAL_MS);
    };
    void tick();
    return () => {
      active = false;
      if (timer !== null) clearTimeout(timer);
    };
  }, [capture, visible]);

  const dispatchInput = useCallback(
    async (action: PreviewRemoteInputAction) => {
      const result = await sendRemoteInput({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId, tabId: PreviewTabId.make(tabId), action },
      });
      if (result._tag === "Failure") {
        setFrameError(commandError(result.cause, "The desktop browser did not accept the input."));
        return;
      }
      setFrameError(null);
      // Show the gesture's effect right away instead of waiting for the poll.
      await capture();
    },
    [capture, sendRemoteInput, threadRef.environmentId, threadRef.threadId, tabId],
  );
  const dispatchInputRef = useRef(dispatchInput);
  dispatchInputRef.current = dispatchInput;

  const contentGeometry = useCallback((): {
    readonly origin: FramePoint;
    readonly size: FrameSize;
  } | null => {
    const element = containerRef.current;
    const current = frameRef.current;
    if (element === null || current === null) return null;
    const bounds = element.getBoundingClientRect();
    const rect = containedFrameRect(
      { width: bounds.width, height: bounds.height },
      { width: current.screenshot.width, height: current.screenshot.height },
    );
    if (rect === null) return null;
    return {
      origin: { x: bounds.left + rect.left, y: bounds.top + rect.top },
      size: { width: rect.width, height: rect.height },
    };
  }, []);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || gestureRef.current !== null) return;
    const geometry = contentGeometry();
    if (geometry === null) return;
    const start = {
      x: event.clientX - geometry.origin.x,
      y: event.clientY - geometry.origin.y,
    };
    // Input landing in the letterbox bars belongs to the panel, not the page.
    if (
      start.x < 0 ||
      start.y < 0 ||
      start.x > geometry.size.width ||
      start.y > geometry.size.height
    ) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    gestureRef.current = {
      pointerId: event.pointerId,
      pointerType: event.pointerType,
      origin: geometry.origin,
      contentSize: geometry.size,
      startedAt: Date.now(),
      start,
      end: start,
      maxDistancePx: 0,
      firstMovedAt: null,
    };
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    const point = {
      x: event.clientX - gesture.origin.x,
      y: event.clientY - gesture.origin.y,
    };
    gesture.end = point;
    const distance = Math.hypot(point.x - gesture.start.x, point.y - gesture.start.y);
    if (distance > gesture.maxDistancePx) gesture.maxDistancePx = distance;
    // The drag-hold clock starts when the pointer truly leaves the tap slop;
    // press-time jitter must not count as movement.
    if (gesture.firstMovedAt === null && distance > FRAME_TAP_SLOP_PX) {
      gesture.firstMovedAt = Date.now();
    }
  };

  const handlePointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    const gesture = gestureRef.current;
    if (gesture === null || gesture.pointerId !== event.pointerId) return;
    gestureRef.current = null;
    const sample = {
      startedAt: gesture.startedAt,
      start: gesture.start,
      end: gesture.end,
      maxDistancePx: gesture.maxDistancePx,
      firstMovedAt: gesture.firstMovedAt,
    };
    // A mouse drags deliberately (there is a wheel for scrolling); touch pans
    // to scroll and holds to drag, matching the native mobile app.
    let action: PreviewRemoteInputAction | null;
    if (gesture.pointerType === "mouse" && gesture.maxDistancePx > FRAME_TAP_SLOP_PX) {
      const from = frameFraction(gesture.contentSize, gesture.start);
      const to = frameFraction(gesture.contentSize, gesture.end);
      action = from !== null && to !== null ? { kind: "drag", from, to } : null;
    } else {
      action = resolveFrameGesture(gesture.contentSize, sample);
    }
    if (action !== null) void dispatchInputRef.current(action);
  };

  const handlePointerCancel = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (gestureRef.current?.pointerId === event.pointerId) gestureRef.current = null;
  };

  useEffect(() => {
    const element = containerRef.current;
    if (element === null || !visible) return;
    const flush = () => {
      wheelFlushTimerRef.current = null;
      const accumulated = wheelAccumulatorRef.current;
      wheelAccumulatorRef.current = { x: 0, y: 0 };
      const geometry = contentGeometry();
      if (geometry === null) return;
      const deltaX = accumulated.x / geometry.size.width;
      const deltaY = accumulated.y / geometry.size.height;
      if (deltaX === 0 && deltaY === 0) return;
      void dispatchInputRef.current({ kind: "scroll", deltaX, deltaY });
    };
    // React's synthetic wheel handlers are passive; preventing the panel from
    // scrolling underneath the frame needs a non-passive native listener.
    const onWheel = (event: WheelEvent) => {
      if (frameRef.current === null) return;
      event.preventDefault();
      wheelAccumulatorRef.current = {
        x: wheelAccumulatorRef.current.x + event.deltaX,
        y: wheelAccumulatorRef.current.y + event.deltaY,
      };
      wheelFlushTimerRef.current ??= setTimeout(flush, WHEEL_FLUSH_MS);
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      element.removeEventListener("wheel", onWheel);
      if (wheelFlushTimerRef.current !== null) {
        clearTimeout(wheelFlushTimerRef.current);
        wheelFlushTimerRef.current = null;
      }
    };
  }, [contentGeometry, visible]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (event.target !== event.currentTarget) return;
    if (FORWARDED_PRESS_KEYS.has(event.key) || event.key.length === 1) {
      event.preventDefault();
      void dispatchInputRef.current({ kind: "press", key: event.key });
    }
  };

  const sendKeyboardText = async () => {
    const text = keyboardText;
    if (text.length === 0) return;
    setKeyboardText("");
    await dispatchInput({ kind: "type", text });
  };

  return (
    <div className={cn("flex min-h-0 flex-col bg-background", props.className)}>
      <div
        ref={containerRef}
        aria-label={
          frame
            ? `Rendered browser tab ${frame.title || frame.url}. Touches are sent to the desktop tab.`
            : "Waiting for the desktop browser host"
        }
        className="relative min-h-0 flex-1 select-none overflow-hidden bg-black outline-none"
        role="application"
        style={{ touchAction: "none" }}
        tabIndex={0}
        onKeyDown={handleKeyDown}
        onPointerCancel={handlePointerCancel}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        {frame ? (
          <img
            alt=""
            className="absolute inset-0 h-full w-full object-contain"
            draggable={false}
            src={`data:${frame.screenshot.mimeType};base64,${frame.screenshot.data}`}
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-sm text-white/70">
            Waiting for the desktop browser host…
          </div>
        )}
        {frameError ? (
          <div className="absolute inset-x-3 bottom-3 rounded-lg border border-red-500/30 bg-red-950/80 px-3 py-2 text-xs text-red-200">
            {frameError}
          </div>
        ) : null}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-t border-border bg-background px-2 py-2">
        <input
          aria-label="Text to type into the desktop tab"
          autoCapitalize="none"
          autoComplete="off"
          autoCorrect="off"
          className="min-w-0 flex-1 rounded-lg border border-border bg-background px-3 py-1.5 text-sm outline-none focus:border-ring"
          placeholder="Type into the page"
          value={keyboardText}
          onChange={(event) => setKeyboardText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void sendKeyboardText();
            }
          }}
        />
        <button
          aria-label="Send text to the desktop tab"
          className="shrink-0 rounded-lg bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground disabled:opacity-50"
          disabled={keyboardText.length === 0}
          type="button"
          onClick={() => void sendKeyboardText()}
        >
          Type
        </button>
        <button
          aria-label="Press Enter in the desktop tab"
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm"
          type="button"
          onClick={() => void dispatchInput({ kind: "press", key: "Enter" })}
        >
          ⏎
        </button>
        <button
          aria-label="Press Backspace in the desktop tab"
          className="shrink-0 rounded-lg border border-border px-3 py-1.5 text-sm"
          type="button"
          onClick={() => void dispatchInput({ kind: "press", key: "Backspace" })}
        >
          ⌫
        </button>
      </div>
    </div>
  );
}
