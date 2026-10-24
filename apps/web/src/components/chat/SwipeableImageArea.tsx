import { type PointerEvent, type ReactNode, useLayoutEffect, useRef } from "react";

import { cn } from "~/lib/utils";
import { IMAGE_SWIPE_AXIS_LOCK_PX, imageSwipeDirection } from "./imageSwipe";

const SETTLE_TRANSITION = "transform 180ms ease-out, opacity 180ms ease-out";
/** How far a newly shown image slides in from, toward the side it came from. */
const ENTER_OFFSET_PX = 48;

interface ActiveSwipe {
  readonly pointerId: number;
  readonly x: number;
  readonly y: number;
  readonly at: number;
  axis: "x" | "y" | null;
  dx: number;
  dy: number;
}

/** True when the press began on an image that is zoomed in, where a drag pans instead. */
function startsOnZoomedImage(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest('[data-zoomable-image="zoomed"]') !== null;
}

/**
 * Lets a finger drag the shown image sideways to move to the next or previous
 * one; it follows the finger and settles back when the drag falls short.
 * Mouse drags, pinches, and a zoomed image (which pans instead) are left to
 * the image. Each time `slideKey` changes, the new image slides in from
 * `enterFrom`'s side.
 */
export function SwipeableImageArea(props: {
  readonly enabled: boolean;
  /** 1 for the next image, -1 for the previous one. */
  readonly onSwipe: (direction: -1 | 1) => void;
  readonly slideKey: string;
  readonly enterFrom: -1 | 1 | null;
  readonly className?: string;
  readonly contentClassName?: string;
  readonly children: ReactNode;
}) {
  const contentRef = useRef<HTMLDivElement>(null);
  const pointersRef = useRef(new Set<number>());
  const swipeRef = useRef<ActiveSwipe | null>(null);

  const place = (offset: number, animate: boolean) => {
    const content = contentRef.current;
    if (!content) return;
    content.style.transition = animate ? SETTLE_TRANSITION : "";
    content.style.transform = offset === 0 ? "" : `translate3d(${offset}px, 0, 0)`;
  };

  const { slideKey, enterFrom } = props;
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || enterFrom === null) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    content.style.transition = "";
    content.style.transform = `translate3d(${enterFrom * ENTER_OFFSET_PX}px, 0, 0)`;
    content.style.opacity = "0.4";
    // Commit the starting position so the browser animates away from it.
    content.getBoundingClientRect();
    content.style.transition = SETTLE_TRANSITION;
    content.style.transform = "";
    content.style.opacity = "";
  }, [slideKey, enterFrom]);

  const cancel = () => {
    if (swipeRef.current === null) return;
    swipeRef.current = null;
    place(0, true);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    // A primary pointer starts a fresh gesture, so a finger whose lift never
    // reached this area can't leave every later drag looking like a pinch.
    if (event.isPrimary) pointersRef.current.clear();
    pointersRef.current.add(event.pointerId);
    if (
      !props.enabled ||
      event.pointerType === "mouse" ||
      pointersRef.current.size > 1 ||
      startsOnZoomedImage(event.target)
    ) {
      cancel();
      return;
    }
    swipeRef.current = {
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      at: event.timeStamp,
      axis: null,
      dx: 0,
      dy: 0,
    };
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const swipe = swipeRef.current;
    if (swipe === null || swipe.pointerId !== event.pointerId) return;
    swipe.dx = event.clientX - swipe.x;
    swipe.dy = event.clientY - swipe.y;
    if (swipe.axis === null && Math.hypot(swipe.dx, swipe.dy) > IMAGE_SWIPE_AXIS_LOCK_PX) {
      swipe.axis = Math.abs(swipe.dx) > Math.abs(swipe.dy) ? "x" : "y";
    }
    if (swipe.axis === "x") place(swipe.dx, false);
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    pointersRef.current.delete(event.pointerId);
    const swipe = swipeRef.current;
    if (swipe === null || swipe.pointerId !== event.pointerId) return;
    swipeRef.current = null;
    const direction =
      event.type === "pointerup" && swipe.axis === "x"
        ? imageSwipeDirection({ dx: swipe.dx, dy: swipe.dy, elapsedMs: event.timeStamp - swipe.at })
        : null;
    if (direction === null) {
      place(0, true);
      return;
    }
    place(0, false);
    props.onSwipe(direction);
  };

  return (
    <div
      data-swipeable-image-area
      className={cn("touch-none", props.className)}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerEnd}
      onPointerCancel={onPointerEnd}
    >
      <div ref={contentRef} className={props.contentClassName}>
        {props.children}
      </div>
    </div>
  );
}
