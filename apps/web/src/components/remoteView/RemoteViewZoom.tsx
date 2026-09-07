import { RotateCcwIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  clampRemoteViewPan,
  formatRemoteViewZoom,
  isRemoteViewIdentity,
  pinchRemoteView,
  REMOTE_VIEW_IDENTITY,
  remoteViewPinchOf,
  remoteViewTransformStyle,
  type RemoteViewPinch,
  type RemoteViewPoint,
  type RemoteViewSize,
  type RemoteViewTransform,
} from "./remoteViewTransform.ts";

/**
 * The minimum a pointer event has to carry for the pinch tracker. Kept to
 * plain fields so both surfaces can hand over their React pointer events
 * without an adapter.
 */
export type RemoteViewPointerSample = {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly clientX: number;
  readonly clientY: number;
};

type TrackedPointer = { x: number; y: number; readonly pinched: boolean };

/**
 * Pinch-to-zoom for a mirrored remote surface.
 *
 * A phone showing someone else's screen scaled to fit cannot hit a link. One
 * finger belongs to the remote machine, so the picture is moved with two: pinch
 * to magnify about the fingers, hold both and drag to pan. The tracker owns
 * every pointer that has ever been part of a pinch until it lifts, and reports
 * that ownership back so the surface can stop forwarding those pointers to the
 * host - a pinch must never also drag on the remote machine.
 *
 * `paneRef` goes on the element the picture fills at 1x; it is measured for
 * the pinch geometry and watched so a rotation or a keyboard cannot leave a
 * pan pointing at nothing.
 */
export function useRemoteViewZoom(): {
  readonly view: RemoteViewTransform;
  /** Two fingers are down; host input from the surface must be suspended. */
  readonly pinching: boolean;
  /** The same, readable synchronously inside a pointer handler. */
  readonly pinchingRef: React.RefObject<boolean>;
  readonly style: ReturnType<typeof remoteViewTransformStyle>;
  readonly reset: () => void;
  readonly paneRef: (element: HTMLElement | null) => void;
  /** True when the tracker now owns this pointer; the caller must not forward it. */
  readonly onPointerDown: (event: RemoteViewPointerSample) => boolean;
  readonly onPointerMove: (event: RemoteViewPointerSample) => boolean;
  readonly onPointerUp: (event: RemoteViewPointerSample) => boolean;
} {
  const [view, setView] = useState<RemoteViewTransform>(REMOTE_VIEW_IDENTITY);
  const [pinching, setPinching] = useState(false);
  const pinchingRef = useRef(false);
  const viewRef = useRef(view);
  viewRef.current = view;
  const paneElementRef = useRef<HTMLElement | null>(null);
  const paneRef = useRef<RemoteViewSize | null>(null);
  const observerRef = useRef<ResizeObserver | null>(null);
  const pointersRef = useRef(new Map<number, TrackedPointer>());
  const gestureRef = useRef<{
    readonly start: RemoteViewTransform;
    readonly from: RemoteViewPinch;
    readonly paneOrigin: RemoteViewPoint;
  } | null>(null);

  const applyPane = useCallback((pane: RemoteViewSize) => {
    paneRef.current = pane;
    // A rotation or a keyboard opening can shrink the pane out from under a
    // pan that was legal at the old size, which would leave a bar of black
    // down one edge until the next gesture.
    setView((current) =>
      isRemoteViewIdentity(current)
        ? current
        : { ...current, pan: clampRemoteViewPan({ ...current, pane }) },
    );
  }, []);

  const measurePane = useCallback((): RemoteViewPoint | null => {
    const element = paneElementRef.current;
    if (element === null) return null;
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    paneRef.current = { width: rect.width, height: rect.height };
    return { x: rect.left, y: rect.top };
  }, []);

  const paneRefCallback = useCallback(
    (element: HTMLElement | null) => {
      observerRef.current?.disconnect();
      observerRef.current = null;
      paneElementRef.current = element;
      if (element === null) return;
      const report = () => {
        const rect = element.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          applyPane({ width: rect.width, height: rect.height });
        }
      };
      report();
      if (typeof ResizeObserver === "undefined") return;
      const observer = new ResizeObserver(report);
      observer.observe(element);
      observerRef.current = observer;
    },
    [applyPane],
  );
  useEffect(
    () => () => {
      observerRef.current?.disconnect();
    },
    [],
  );

  const reset = useCallback(() => {
    setView(REMOTE_VIEW_IDENTITY);
  }, []);

  const pinchFromPointers = useCallback((paneOrigin: RemoteViewPoint): RemoteViewPinch | null => {
    const pair: RemoteViewPoint[] = [];
    for (const pointer of pointersRef.current.values()) {
      if (!pointer.pinched) continue;
      pair.push({ x: pointer.x - paneOrigin.x, y: pointer.y - paneOrigin.y });
      if (pair.length === 2) break;
    }
    const [a, b] = pair;
    return a && b ? remoteViewPinchOf(a, b) : null;
  }, []);

  const endGesture = useCallback(() => {
    gestureRef.current = null;
    pinchingRef.current = false;
    setPinching(false);
  }, []);

  const onPointerDown = useCallback(
    (event: RemoteViewPointerSample): boolean => {
      // A mouse has a wheel and never pinches; tracking it would only turn
      // a second mouse button into a phantom second finger.
      if (event.pointerType !== "touch") return false;
      const pointers = pointersRef.current;
      if (gestureRef.current !== null) {
        // A third finger joins the gesture rather than reaching the host.
        pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pinched: true });
        return true;
      }
      pointers.set(event.pointerId, { x: event.clientX, y: event.clientY, pinched: false });
      if (pointers.size < 2) return false;
      const paneOrigin = measurePane();
      if (paneOrigin === null) return false;
      for (const [id, pointer] of pointers) {
        pointers.set(id, { ...pointer, pinched: true });
      }
      const from = pinchFromPointers(paneOrigin);
      if (from === null) return false;
      gestureRef.current = { start: viewRef.current, from, paneOrigin };
      pinchingRef.current = true;
      setPinching(true);
      return true;
    },
    [measurePane, pinchFromPointers],
  );

  const onPointerMove = useCallback(
    (event: RemoteViewPointerSample): boolean => {
      const pointer = pointersRef.current.get(event.pointerId);
      if (pointer === undefined) return false;
      pointer.x = event.clientX;
      pointer.y = event.clientY;
      if (!pointer.pinched) return false;
      const gesture = gestureRef.current;
      if (gesture === null) return true;
      const to = pinchFromPointers(gesture.paneOrigin);
      if (to === null) return true;
      setView(
        pinchRemoteView({ start: gesture.start, from: gesture.from, to, pane: paneRef.current }),
      );
      return true;
    },
    [pinchFromPointers],
  );

  const onPointerUp = useCallback(
    (event: RemoteViewPointerSample): boolean => {
      const pointers = pointersRef.current;
      const pointer = pointers.get(event.pointerId);
      if (pointer === undefined) return false;
      pointers.delete(event.pointerId);
      if (!pointer.pinched) return false;
      const gesture = gestureRef.current;
      if (gesture !== null) {
        const remaining = pinchFromPointers(gesture.paneOrigin);
        if (remaining === null) {
          endGesture();
        } else {
          // One of three fingers lifted: continue from the current view with
          // the pair that is left, rather than jumping to their geometry.
          gestureRef.current = {
            start: viewRef.current,
            from: remaining,
            paneOrigin: gesture.paneOrigin,
          };
        }
      }
      // A finger that was part of a pinch stays owned until it lifts, so its
      // remaining drag does not turn into a drag on the remote machine.
      return true;
    },
    [endGesture, pinchFromPointers],
  );

  return {
    view,
    pinching,
    pinchingRef,
    style: remoteViewTransformStyle(view),
    reset,
    paneRef: paneRefCallback,
    onPointerDown,
    onPointerMove,
    onPointerUp,
  };
}

/**
 * The zoom factor, styled to sit in a surface's control row. Only rendered
 * once there is a zoom to show; pressing it returns the picture to fit, which
 * is the one thing a pinch cannot do precisely.
 */
export function RemoteViewZoomReadout(props: {
  readonly view: RemoteViewTransform;
  readonly onReset: () => void;
}): React.ReactElement | null {
  if (isRemoteViewIdentity(props.view)) return null;
  return (
    <button
      type="button"
      aria-label={`Zoomed to ${formatRemoteViewZoom(props.view.zoom)}. Reset the view`}
      title="Reset the view · pinch to zoom, drag two fingers to move"
      className="flex cursor-pointer items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs text-white hover:bg-black/85"
      onClick={(event) => {
        // The surface underneath forwards clicks to the remote machine.
        event.stopPropagation();
        props.onReset();
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <RotateCcwIcon className="size-3.5" />
      <span className="tabular-nums">{formatRemoteViewZoom(props.view.zoom)}</span>
    </button>
  );
}
