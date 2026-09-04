import { LockIcon, MinusIcon, PlusIcon, RotateCcwIcon, ZoomInIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

import {
  clampRemoteViewPan,
  formatRemoteViewZoom,
  isRemoteViewIdentity,
  panRemoteView,
  REMOTE_VIEW_IDENTITY,
  REMOTE_VIEW_MAX_ZOOM,
  remoteViewTransformStyle,
  zoomInRemoteView,
  zoomOutRemoteView,
  type RemoteViewPoint,
  type RemoteViewSize,
  type RemoteViewTransform,
} from "./remoteViewTransform.ts";

/**
 * One control for magnifying a mirrored remote surface.
 *
 * A phone showing someone else's screen scaled to fit cannot hit a link, and
 * the two separate zoom buttons it used to have could magnify but never move -
 * so anything outside the middle stayed out of reach. Panning and forwarding
 * drags to the remote machine are the same gesture, which is why this is a
 * mode rather than another button: while it is on, drags move the picture and
 * nothing reaches the host; pressing the toggle again locks the view in and
 * hands the drags back.
 */
export function useRemoteViewZoom(): {
  readonly view: RemoteViewTransform;
  readonly adjusting: boolean;
  readonly toggleAdjusting: () => void;
  readonly stopAdjusting: () => void;
  readonly style: ReturnType<typeof remoteViewTransformStyle>;
  readonly zoomIn: () => void;
  readonly zoomOut: () => void;
  readonly reset: () => void;
  readonly panBy: (by: RemoteViewPoint) => void;
  readonly setPane: (pane: RemoteViewSize) => void;
  /** Where the viewer last touched, so the first zoom magnifies that spot. */
  readonly setAnchor: (anchor: RemoteViewPoint) => void;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
} {
  const [view, setView] = useState<RemoteViewTransform>(REMOTE_VIEW_IDENTITY);
  const [adjusting, setAdjusting] = useState(false);
  const paneRef = useRef<RemoteViewSize | null>(null);
  const anchorRef = useRef<RemoteViewPoint | undefined>(undefined);

  const zoomIn = useCallback(() => {
    setView((current) =>
      zoomInRemoteView({
        view: current,
        ...(anchorRef.current ? { anchor: anchorRef.current } : {}),
        pane: paneRef.current,
      }),
    );
  }, []);
  const zoomOut = useCallback(() => {
    setView((current) => zoomOutRemoteView({ view: current, pane: paneRef.current }));
  }, []);
  const reset = useCallback(() => {
    setView(REMOTE_VIEW_IDENTITY);
  }, []);
  const panBy = useCallback((by: RemoteViewPoint) => {
    setView((current) => panRemoteView({ view: current, by, pane: paneRef.current }));
  }, []);
  const setPane = useCallback((pane: RemoteViewSize) => {
    paneRef.current = pane;
    // A rotation or a keyboard opening can shrink the pane out from under a
    // pan that was legal at the old size, which would leave a bar of black
    // down one edge until the next drag.
    setView((current) =>
      isRemoteViewIdentity(current)
        ? current
        : { ...current, pan: clampRemoteViewPan({ ...current, pane }) },
    );
  }, []);
  const setAnchor = useCallback((anchor: RemoteViewPoint) => {
    anchorRef.current = anchor;
  }, []);
  const toggleAdjusting = useCallback(() => {
    setAdjusting((current) => !current);
  }, []);
  const stopAdjusting = useCallback(() => {
    setAdjusting(false);
  }, []);

  return {
    view,
    adjusting,
    toggleAdjusting,
    stopAdjusting,
    style: remoteViewTransformStyle(view),
    zoomIn,
    zoomOut,
    reset,
    panBy,
    setPane,
    setAnchor,
    canZoomIn: view.zoom < REMOTE_VIEW_MAX_ZOOM,
    canZoomOut: !isRemoteViewIdentity(view),
  };
}

/** The toggle itself, styled to sit in a surface's floating control row. */
export function RemoteViewZoomToggle(props: {
  readonly adjusting: boolean;
  readonly view: RemoteViewTransform;
  readonly onToggle: () => void;
}): React.ReactElement {
  const zoomed = !isRemoteViewIdentity(props.view);
  return (
    <button
      type="button"
      aria-label={props.adjusting ? "Lock the zoom and position" : "Zoom and move the picture"}
      title={props.adjusting ? "Lock this view" : "Zoom and move the picture"}
      aria-pressed={props.adjusting}
      className={`flex cursor-pointer items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-white ${
        props.adjusting ? "bg-primary/85 hover:bg-primary" : "bg-black/70 hover:bg-black/85"
      }`}
      onClick={(event) => {
        // The surface underneath forwards clicks to the remote machine.
        event.stopPropagation();
        props.onToggle();
      }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {props.adjusting ? <LockIcon className="size-3.5" /> : <ZoomInIcon className="size-3.5" />}
      {zoomed ? (
        <span className="tabular-nums">{formatRemoteViewZoom(props.view.zoom)}</span>
      ) : null}
    </button>
  );
}

/**
 * The mode itself: a full-surface layer that swallows input, pans on drag, and
 * carries the zoom steps.
 *
 * It sits above everything else on the surface precisely so that no drag can
 * reach the host while the view is being moved — that is the whole reason the
 * zoom is a mode and not two buttons.
 */
export function RemoteViewAdjustLayer(props: {
  readonly view: RemoteViewTransform;
  readonly canZoomIn: boolean;
  readonly canZoomOut: boolean;
  readonly onZoomIn: () => void;
  readonly onZoomOut: () => void;
  readonly onReset: () => void;
  readonly onPanBy: (by: RemoteViewPoint) => void;
  readonly onPaneResize: (pane: RemoteViewSize) => void;
  readonly onDone: () => void;
  /** Clearance for whatever the host surface already floats at its bottom. */
  readonly bottomOffset?: string;
}): React.ReactElement {
  const layerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ readonly pointerId: number; x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const onPaneResizeRef = useRef(props.onPaneResize);
  onPaneResizeRef.current = props.onPaneResize;

  useEffect(() => {
    const element = layerRef.current;
    if (element === null) return;
    const report = () => {
      const rect = element.getBoundingClientRect();
      onPaneResizeRef.current({ width: rect.width, height: rect.height });
    };
    report();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(report);
    observer.observe(element);
    return () => {
      observer.disconnect();
    };
  }, []);

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
    setDragging(false);
  };

  return (
    <div
      ref={layerRef}
      data-remote-view-adjusting="true"
      // Above the picture, deliberately BELOW the floating control row that
      // holds the toggle (z-40): "press it again to lock it in" only works if
      // the toggle stays reachable. The Lock in button is the same action
      // within thumb reach.
      className={`absolute inset-0 z-[35] touch-none select-none ${
        dragging ? "cursor-grabbing" : "cursor-grab"
      }`}
      onPointerDown={(event) => {
        event.preventDefault();
        event.stopPropagation();
        if (dragRef.current !== null) return;
        dragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
        setDragging(true);
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag?.pointerId !== event.pointerId) return;
        event.preventDefault();
        event.stopPropagation();
        props.onPanBy({ x: event.clientX - drag.x, y: event.clientY - drag.y });
        drag.x = event.clientX;
        drag.y = event.clientY;
      }}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onClick={(event) => event.stopPropagation()}
      onContextMenu={(event) => event.preventDefault()}
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3"
        aria-live="polite"
      >
        <p className="rounded-full bg-black/70 px-3 py-1 text-center text-[11px] text-white/85">
          {props.view.zoom === 1
            ? "Zoom in, then drag to move around · nothing is sent while adjusting"
            : "Drag to move around · press the lock to keep this view"}
        </p>
      </div>
      <div
        className="absolute inset-x-0 flex justify-center px-3"
        style={{ bottom: props.bottomOffset ?? "calc(3.5rem + env(safe-area-inset-bottom, 0px))" }}
      >
        <div
          className="flex items-center gap-1 rounded-full bg-black/80 p-1 text-white"
          // The buttons are the point of the mode; a drag starting on them
          // would pan the picture out from under the press.
          onPointerDown={(event) => event.stopPropagation()}
        >
          <AdjustButton
            label="Zoom out"
            disabled={!props.canZoomOut}
            onPress={props.onZoomOut}
            icon={<MinusIcon className="size-4" />}
          />
          <span className="min-w-12 text-center text-xs tabular-nums">
            {formatRemoteViewZoom(props.view.zoom)}
          </span>
          <AdjustButton
            label="Zoom in"
            disabled={!props.canZoomIn}
            onPress={props.onZoomIn}
            icon={<PlusIcon className="size-4" />}
          />
          <AdjustButton
            label="Reset the view"
            disabled={isRemoteViewIdentity(props.view)}
            onPress={props.onReset}
            icon={<RotateCcwIcon className="size-4" />}
          />
          <button
            type="button"
            className="ml-1 flex h-9 cursor-pointer items-center gap-1.5 rounded-full bg-primary px-3 text-xs font-medium text-primary-foreground"
            onClick={(event) => {
              event.stopPropagation();
              props.onDone();
            }}
          >
            <LockIcon className="size-3.5" />
            Lock in
          </button>
        </div>
      </div>
    </div>
  );
}

function AdjustButton(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
  readonly icon: React.ReactElement;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-label={props.label}
      title={props.label}
      disabled={props.disabled}
      // 36px: a thumb target, not a mouse target. This is a phone control.
      className="flex size-9 cursor-pointer items-center justify-center rounded-full hover:bg-white/15 disabled:cursor-default disabled:opacity-35"
      onClick={(event) => {
        event.stopPropagation();
        props.onPress();
      }}
    >
      {props.icon}
    </button>
  );
}
