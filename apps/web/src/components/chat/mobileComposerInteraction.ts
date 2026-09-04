export type ComposerTouchMoveDisposition = "allow-editor-scroll" | "block";

/**
 * Downward travel that commits the collapse.
 *
 * Generous on purpose. This gesture shares a surface with the editor's own
 * scrolling and with a plain tap-to-place-the-caret, so anything short enough
 * to trigger on a lazy thumb would dismiss the keyboard mid-sentence - a far
 * worse failure than having to swipe again.
 */
export const COMPOSER_SWIPE_DOWN_DISMISS_PX = 64;

/**
 * Whether a downward drag on the composer should put the keyboard away.
 *
 * Only when the editor has nothing left to scroll up into: with text above the
 * fold, a downward drag is the user reading what they have written, and
 * stealing it to dismiss would make long prompts unreadable. At the top edge
 * there is nothing else the gesture could mean.
 *
 * Travel is measured from where the finger went down rather than summed from
 * per-move deltas, so a drag that wanders down, up and back down again does
 * not accumulate its way past the threshold.
 */
export function shouldDismissComposerOnSwipeDown(input: {
  readonly totalDeltaY: number;
  readonly editorScrollTop: number | null;
}): boolean {
  if (input.totalDeltaY < COMPOSER_SWIPE_DOWN_DISMISS_PX) return false;
  // Null means the touch did not start in the editor's scroll container - the
  // padding around it, the toolbar - where there is no scroll to protect.
  return (input.editorScrollTop ?? 0) <= SCROLL_EDGE_EPSILON;
}

const SCROLL_EDGE_EPSILON = 1;
const COMPOSER_SCROLL_CONTAINER_SELECTOR = '[data-chat-composer-scroll-container="true"]';

export function composerTouchMoveDisposition(input: {
  readonly deltaY: number;
  readonly editorScrollTop: number | null;
  readonly editorScrollHeight: number | null;
  readonly editorClientHeight: number | null;
}): ComposerTouchMoveDisposition {
  if (
    input.editorScrollTop === null ||
    input.editorScrollHeight === null ||
    input.editorClientHeight === null
  ) {
    return "block";
  }

  const maxScrollTop = Math.max(0, input.editorScrollHeight - input.editorClientHeight);
  if (maxScrollTop <= SCROLL_EDGE_EPSILON) {
    return "block";
  }
  if (input.deltaY > 0) {
    return input.editorScrollTop > SCROLL_EDGE_EPSILON ? "allow-editor-scroll" : "block";
  }
  if (input.deltaY < 0) {
    return input.editorScrollTop < maxScrollTop - SCROLL_EDGE_EPSILON
      ? "allow-editor-scroll"
      : "block";
  }
  return "block";
}

function findTouch(touches: TouchList, identifier: number): Touch | null {
  for (let index = 0; index < touches.length; index += 1) {
    const touch = touches.item(index);
    if (touch?.identifier === identifier) {
      return touch;
    }
  }
  return null;
}

export function installMobileComposerTouchBoundary(
  root: HTMLElement,
  options: {
    /**
     * Swipe-down-to-collapse. Called at most once per touch; the caller owns
     * what "collapse" means and, importantly, whether it is allowed at all -
     * dismissing during voice capture would unmount the recorder mid-take.
     */
    readonly onSwipeDownDismiss?: () => void;
  } = {},
): () => void {
  let activeTouch:
    | {
        identifier: number;
        lastY: number;
        startY: number;
        dismissed: boolean;
        editorScrollElement: HTMLElement | null;
      }
    | undefined;

  const onTouchStart = (event: TouchEvent) => {
    const touch = event.changedTouches.item(0);
    if (!touch) return;
    const target = event.target;
    const editorScrollElement =
      target instanceof Element
        ? target.closest<HTMLElement>(COMPOSER_SCROLL_CONTAINER_SELECTOR)
        : null;
    activeTouch = {
      identifier: touch.identifier,
      lastY: touch.clientY,
      startY: touch.clientY,
      dismissed: false,
      editorScrollElement:
        editorScrollElement && root.contains(editorScrollElement) ? editorScrollElement : null,
    };
  };

  const onTouchMove = (event: TouchEvent) => {
    if (!activeTouch) return;
    const touch = findTouch(event.touches, activeTouch.identifier);
    if (!touch) return;

    const deltaY = touch.clientY - activeTouch.lastY;
    activeTouch.lastY = touch.clientY;
    const editorScrollElement = activeTouch.editorScrollElement;
    const disposition = composerTouchMoveDisposition({
      deltaY,
      editorScrollTop: editorScrollElement?.scrollTop ?? null,
      editorScrollHeight: editorScrollElement?.scrollHeight ?? null,
      editorClientHeight: editorScrollElement?.clientHeight ?? null,
    });

    if (
      !activeTouch.dismissed &&
      options.onSwipeDownDismiss &&
      shouldDismissComposerOnSwipeDown({
        totalDeltaY: touch.clientY - activeTouch.startY,
        editorScrollTop: editorScrollElement?.scrollTop ?? null,
      })
    ) {
      // Latched for the rest of the touch: the finger keeps moving after the
      // keyboard starts closing, and firing per move would re-dismiss against
      // a composer the user may already be tapping back into.
      activeTouch.dismissed = true;
      options.onSwipeDownDismiss();
    }

    if (disposition === "block" && event.cancelable) {
      event.preventDefault();
    }
    // The history list and document must never inherit a gesture that started
    // in the composer, including when the editor reaches either scroll edge.
    event.stopPropagation();
  };

  const clearActiveTouch = (event: TouchEvent) => {
    if (!activeTouch || !findTouch(event.changedTouches, activeTouch.identifier)) return;
    activeTouch = undefined;
  };

  root.addEventListener("touchstart", onTouchStart, { passive: true });
  root.addEventListener("touchmove", onTouchMove, { passive: false });
  root.addEventListener("touchend", clearActiveTouch, { passive: true });
  root.addEventListener("touchcancel", clearActiveTouch, { passive: true });

  return () => {
    root.removeEventListener("touchstart", onTouchStart);
    root.removeEventListener("touchmove", onTouchMove);
    root.removeEventListener("touchend", clearActiveTouch);
    root.removeEventListener("touchcancel", clearActiveTouch);
  };
}
