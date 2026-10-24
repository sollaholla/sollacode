const EDGE_WIDTH_PX = 20;

/** Keep edge-origin horizontal drags in the app on iOS browsers that honor touch cancellation. */
export function preventPageHistorySwipe(target: Document) {
  const view = target.defaultView;
  const navigator = view?.navigator;
  const isIOS =
    navigator &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1));
  if (!view || !isIOS) return () => {};

  let gesture: {
    identifier: number;
    x: number;
    y: number;
    direction: 1 | -1;
    blocked: boolean;
  } | null = null;

  const reset = () => {
    gesture = null;
  };
  const start = (event: TouchEvent) => {
    reset();
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch) return;

    const left = view.visualViewport?.offsetLeft ?? 0;
    const width = view.visualViewport?.width || view.innerWidth;
    const x = touch.clientX - left;
    if (width <= EDGE_WIDTH_PX * 2 || x < 0 || x > width) return;
    const direction = x <= EDGE_WIDTH_PX ? 1 : x >= width - EDGE_WIDTH_PX ? -1 : null;
    if (direction === null) return;
    gesture = {
      identifier: touch.identifier,
      x: touch.clientX,
      y: touch.clientY,
      direction,
      blocked: false,
    };
    // Canceling touchstart would also suppress native taps, focus, and scrolling at the edge.
    // Decide on the first movement instead; don't wait for a drag-distance threshold.
  };
  const move = (event: TouchEvent) => {
    if (!gesture) return;
    const touch = event.touches[0];
    if (event.touches.length !== 1 || !touch || touch.identifier !== gesture.identifier) {
      reset();
      return;
    }
    if (!gesture.blocked) {
      const dx = touch.clientX - gesture.x;
      const dy = touch.clientY - gesture.y;
      if (dx === 0 && dy === 0) return;
      if (dx * gesture.direction <= Math.abs(dy)) {
        reset();
        return;
      }
      gesture.blocked = true;
    }
    if (event.cancelable) event.preventDefault();
  };

  // Register before any touch begins so WebKit can defer its native pan recognizer.
  // Capture covers portals and surfaces that stop bubbling; app handlers still receive the events.
  const options = { passive: false, capture: true } as const;
  target.addEventListener("touchstart", start, options);
  target.addEventListener("touchmove", move, options);
  target.addEventListener("touchend", reset, true);
  target.addEventListener("touchcancel", reset, true);
  view.addEventListener("blur", reset);
  return () => {
    reset();
    target.removeEventListener("touchstart", start, options);
    target.removeEventListener("touchmove", move, options);
    target.removeEventListener("touchend", reset, true);
    target.removeEventListener("touchcancel", reset, true);
    view.removeEventListener("blur", reset);
  };
}
