/** Keep multi-touch gestures owned by app surfaces without suppressing single-touch editing. */
export function preventPagePinchZoom(target: Document) {
  const preventGesture = (event: Event) => {
    if (event.cancelable) event.preventDefault();
  };
  const preventMultiTouch = (event: TouchEvent) => {
    if (event.touches.length > 1 && event.cancelable) event.preventDefault();
  };
  const options = { passive: false, capture: true } as const;
  target.addEventListener("gesturestart", preventGesture, options);
  target.addEventListener("gesturechange", preventGesture, options);
  target.addEventListener("touchstart", preventMultiTouch, options);
  target.addEventListener("touchmove", preventMultiTouch, options);
  return () => {
    target.removeEventListener("gesturestart", preventGesture, options);
    target.removeEventListener("gesturechange", preventGesture, options);
    target.removeEventListener("touchstart", preventMultiTouch, options);
    target.removeEventListener("touchmove", preventMultiTouch, options);
  };
}
