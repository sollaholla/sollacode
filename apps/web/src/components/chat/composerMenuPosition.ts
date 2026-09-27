export interface ComposerMenuPosition {
  readonly bottom: number;
  readonly left: number;
  readonly maxHeight: number;
  readonly width: number;
}

/** Coalesce nested scroll/resize events and publish only actual anchor movement. */
export function observeComposerMenuPosition(
  anchor: HTMLElement,
  onPosition: (position: ComposerMenuPosition) => void,
): () => void {
  let frame: number | undefined;
  let previous: ComposerMenuPosition | undefined;
  const measure = () => {
    frame = undefined;
    const rect = anchor.getBoundingClientRect();
    const next = {
      bottom: window.innerHeight - rect.top + 8,
      left: rect.left,
      maxHeight: Math.max(96, rect.top - 24),
      width: rect.width,
    };
    if (
      previous?.bottom === next.bottom &&
      previous.left === next.left &&
      previous.maxHeight === next.maxHeight &&
      previous.width === next.width
    )
      return;
    previous = next;
    onPosition(next);
  };
  const schedule = () => {
    frame ??= window.requestAnimationFrame(measure);
  };
  measure();
  window.addEventListener("resize", schedule);
  window.addEventListener("scroll", schedule, true);
  const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
  observer?.observe(anchor);
  return () => {
    if (frame !== undefined) window.cancelAnimationFrame(frame);
    observer?.disconnect();
    window.removeEventListener("resize", schedule);
    window.removeEventListener("scroll", schedule, true);
  };
}
