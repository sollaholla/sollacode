import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";

import { cn } from "~/lib/utils";
import {
  IMAGE_ZOOM_RESET,
  clampImageZoom,
  isImageZoomed,
  pinchImageZoom,
  toggleImageZoomAt,
  zoomImageAt,
  type ImagePinchStart,
  type ImageZoom,
  type ImageZoomBounds,
  type ImageZoomPoint,
} from "./imageZoom";

/** Two taps this close in time and space are a double tap. */
const DOUBLE_TAP_MS = 300;
const DOUBLE_TAP_SLOP_PX = 30;
/** A press that moves further than this is a drag, not a tap. */
const TAP_SLOP_PX = 10;
/** Trackpad pinches arrive as ctrl+wheel; this turns their delta into a scale factor. */
const WHEEL_ZOOM_SENSITIVITY = 0.01;
const SNAP_TRANSITION = "transform 180ms ease-out";

type Gesture =
  | { readonly kind: "pan"; readonly zoom: ImageZoom; readonly origin: ImageZoomPoint }
  | { readonly kind: "pinch"; readonly start: ImagePinchStart };

const distance = (a: ImageZoomPoint, b: ImageZoomPoint) => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: ImageZoomPoint, b: ImageZoomPoint) => ({
  x: (a.x + b.x) / 2,
  y: (a.y + b.y) / 2,
});

/**
 * An image the viewer can pinch, drag, and double-tap to zoom; on a desktop
 * a trackpad pinch (ctrl+wheel) and double click do the same. The page itself
 * is pinned at its initial scale, so the surface claims every touch
 * (`touch-action: none`). Zoom lives in a ref and is written straight to the
 * image's transform, so a gesture never re-renders anything. Remount it (a
 * `key`) to start a new image unzoomed.
 */
export function ZoomableImage(props: {
  readonly src: string;
  readonly alt: string;
  /** Classes for the image, which keeps its fitted size while zoomed. */
  readonly className?: string;
  /** Classes for the surface that receives gestures and clips the zoomed image. */
  readonly surfaceClassName?: string;
  readonly onError?: () => void;
}) {
  const surfaceRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const zoomRef = useRef<ImageZoom>(IMAGE_ZOOM_RESET);
  const pointersRef = useRef(new Map<number, ImageZoomPoint>());
  const gestureRef = useRef<Gesture | null>(null);
  const pressRef = useRef<{ readonly at: number; readonly origin: ImageZoomPoint } | null>(null);
  const lastTapRef = useRef<{ readonly at: number; readonly point: ImageZoomPoint } | null>(null);
  const [zoomed, setZoomed] = useState(false);

  const bounds = useCallback((): ImageZoomBounds => {
    const surface = surfaceRef.current;
    const image = imageRef.current;
    return {
      imageWidth: image?.offsetWidth ?? 0,
      imageHeight: image?.offsetHeight ?? 0,
      viewportWidth: surface?.clientWidth ?? 0,
      viewportHeight: surface?.clientHeight ?? 0,
    };
  }, []);

  const apply = useCallback((next: ImageZoom, animate = false) => {
    zoomRef.current = next;
    const image = imageRef.current;
    if (image) {
      image.style.transition = animate ? SNAP_TRANSITION : "";
      image.style.transform = isImageZoomed(next)
        ? `translate3d(${next.x}px, ${next.y}px, 0) scale(${next.scale})`
        : "";
    }
    setZoomed(isImageZoomed(next));
  }, []);

  /** A client point, measured from the surface's centre like the zoom itself. */
  const pointFrom = useCallback((clientX: number, clientY: number): ImageZoomPoint => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    return { x: clientX - (rect.left + rect.width / 2), y: clientY - (rect.top + rect.height / 2) };
  }, []);

  /** Restarts from the fingers still down, so lifting one of two keeps panning smoothly. */
  const restartGesture = useCallback(() => {
    const [first, second] = pointersRef.current.values();
    if (first && second) {
      gestureRef.current = {
        kind: "pinch",
        start: {
          zoom: zoomRef.current,
          midpoint: midpoint(first, second),
          distance: distance(first, second),
        },
      };
    } else if (first) {
      gestureRef.current = { kind: "pan", zoom: zoomRef.current, origin: first };
    } else {
      gestureRef.current = null;
    }
  }, []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    const point = pointFrom(event.clientX, event.clientY);
    pointersRef.current.set(event.pointerId, point);
    pressRef.current =
      pointersRef.current.size === 1 ? { at: event.timeStamp, origin: point } : null;
    restartGesture();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    if (!pointers.has(event.pointerId)) return;
    const point = pointFrom(event.clientX, event.clientY);
    pointers.set(event.pointerId, point);
    const press = pressRef.current;
    if (press && distance(point, press.origin) > TAP_SLOP_PX) pressRef.current = null;

    const gesture = gestureRef.current;
    if (gesture?.kind === "pinch") {
      const [first, second] = pointers.values();
      if (!first || !second) return;
      apply(
        pinchImageZoom(gesture.start, midpoint(first, second), distance(first, second), bounds()),
      );
      return;
    }
    // One finger only pans an image that is already zoomed.
    if (gesture?.kind === "pan" && isImageZoomed(gesture.zoom)) {
      apply(
        clampImageZoom(
          {
            scale: gesture.zoom.scale,
            x: gesture.zoom.x + point.x - gesture.origin.x,
            y: gesture.zoom.y + point.y - gesture.origin.y,
          },
          bounds(),
        ),
      );
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    const pointers = pointersRef.current;
    const point = pointers.get(event.pointerId);
    if (!point || !pointers.delete(event.pointerId)) return;
    const press = pressRef.current;
    const tapped =
      event.type === "pointerup" &&
      pointers.size === 0 &&
      press !== null &&
      event.timeStamp - press.at < DOUBLE_TAP_MS;
    pressRef.current = null;
    restartGesture();
    if (!tapped) return;

    const lastTap = lastTapRef.current;
    if (
      lastTap &&
      event.timeStamp - lastTap.at < DOUBLE_TAP_MS &&
      distance(point, lastTap.point) < DOUBLE_TAP_SLOP_PX
    ) {
      lastTapRef.current = null;
      apply(toggleImageZoomAt(zoomRef.current, point, bounds()), true);
      return;
    }
    lastTapRef.current = { at: event.timeStamp, point };
  };

  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface) return;
    // Registered natively: React's wheel listener is passive and cannot stop
    // the page from scrolling or the browser from zooming.
    const onWheel = (event: WheelEvent) => {
      const zoom = zoomRef.current;
      if (event.ctrlKey) {
        event.preventDefault();
        const factor = Math.exp(-event.deltaY * WHEEL_ZOOM_SENSITIVITY);
        apply(
          zoomImageAt(zoom, pointFrom(event.clientX, event.clientY), zoom.scale * factor, bounds()),
        );
        return;
      }
      if (!isImageZoomed(zoom)) return;
      event.preventDefault();
      apply(
        clampImageZoom(
          { scale: zoom.scale, x: zoom.x - event.deltaX, y: zoom.y - event.deltaY },
          bounds(),
        ),
      );
    };
    // iOS Safari still zooms the page on a pinch despite the pinned viewport
    // unless its own gesture events are cancelled.
    const cancel = (event: Event) => event.preventDefault();
    const onResize = () => apply(clampImageZoom(zoomRef.current, bounds()));
    surface.addEventListener("wheel", onWheel, { passive: false });
    surface.addEventListener("gesturestart", cancel);
    surface.addEventListener("gesturechange", cancel);
    window.addEventListener("resize", onResize);
    return () => {
      surface.removeEventListener("wheel", onWheel);
      surface.removeEventListener("gesturestart", cancel);
      surface.removeEventListener("gesturechange", cancel);
      window.removeEventListener("resize", onResize);
    };
  }, [apply, bounds, pointFrom]);

  return (
    <div
      ref={surfaceRef}
      data-zoomable-image={zoomed ? "zoomed" : "fit"}
      className={cn(
        "touch-none select-none",
        zoomed ? "cursor-grab active:cursor-grabbing" : "cursor-zoom-in",
        props.surfaceClassName,
      )}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <img
        ref={imageRef}
        src={props.src}
        alt={props.alt}
        draggable={false}
        className={cn("select-none [-webkit-touch-callout:none]", props.className)}
        onError={props.onError}
      />
    </div>
  );
}
