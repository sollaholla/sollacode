export type ComposerTouchMoveDisposition = "allow-editor-scroll" | "block";

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

export function installMobileComposerTouchBoundary(root: HTMLElement): () => void {
  let activeTouch:
    | {
        identifier: number;
        lastY: number;
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
