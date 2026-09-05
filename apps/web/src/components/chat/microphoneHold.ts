type MicrophoneHoldTrigger =
  | { readonly kind: "pointer"; readonly pointerId: number }
  | { readonly kind: "key"; readonly key: " " | "Enter" };

export interface MicrophoneHold {
  readonly isHolding: () => boolean;
  readonly dispose: () => void;
}

const documentHolds = new WeakMap<Document, MicrophoneHold>();
const HOLD_ATTRIBUTE = "data-microphone-hold";

/** Owns input until the microphone gesture ends, including secondary fingers. */
export function beginMicrophoneHold(
  button: HTMLButtonElement,
  trigger: MicrophoneHoldTrigger,
  onRelease: () => void,
): MicrophoneHold {
  const doc = button.ownerDocument;
  const win = doc.defaultView;
  if (!win) return { isHolding: () => false, dispose: () => undefined };
  documentHolds.get(doc)?.dispose();

  let holding = true;
  let disposed = false;
  let releaseTimer: ReturnType<typeof setTimeout> | undefined;
  const pointers = new Set(trigger.kind === "pointer" ? [trigger.pointerId] : []);
  const removers: Array<() => void> = [];
  const previousAttribute = doc.documentElement.getAttribute(HOLD_ATTRIBUTE);
  const style = doc.createElement("style");
  style.textContent = `
    :root[${HOLD_ATTRIBUTE}], :root[${HOLD_ATTRIBUTE}] * {
      -webkit-user-select: none !important;
      user-select: none !important;
      -webkit-touch-callout: none !important;
    }
    :root[${HOLD_ATTRIBUTE}] iframe, :root[${HOLD_ATTRIBUTE}] webview {
      pointer-events: none !important;
    }
  `;
  doc.head.append(style);
  doc.documentElement.setAttribute(HOLD_ATTRIBUTE, "true");

  const interactionLocked = () => holding || pointers.size > 0;
  const block = (event: Event) => {
    if (event.cancelable) event.preventDefault();
    event.stopImmediatePropagation();
  };
  const clearSelection = () => {
    const selection = doc.getSelection();
    if (selection && selection.rangeCount > 0) selection.removeAllRanges();
  };
  clearSelection();
  const focused = doc.activeElement;
  if (focused instanceof HTMLInputElement || focused instanceof HTMLTextAreaElement) {
    const end = focused.selectionEnd;
    if (end !== null) focused.setSelectionRange(end, end);
  }

  const restorePresentation = () => {
    style.remove();
    if (previousAttribute === null) doc.documentElement.removeAttribute(HOLD_ATTRIBUTE);
    else doc.documentElement.setAttribute(HOLD_ATTRIBUTE, previousAttribute);
  };
  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    clearTimeout(releaseTimer);
    for (const remove of removers) remove();
    if (trigger.kind === "pointer") {
      try {
        if (button.hasPointerCapture?.(trigger.pointerId)) {
          button.releasePointerCapture(trigger.pointerId);
        }
      } catch {
        // Navigation may already have detached the capture target.
      }
    }
    restorePresentation();
    if (documentHolds.get(doc) === hold) documentHolds.delete(doc);
  };
  const releaseInteraction = () => {
    if (interactionLocked() || disposed || releaseTimer !== undefined) return;
    restorePresentation();
    // WebKit may deliver a compatibility click after touch/pointer release.
    // A fresh gesture removes this tail immediately, so the next tap works.
    releaseTimer = setTimeout(cleanup, 750);
  };
  const releaseRecording = () => {
    if (!holding) return;
    holding = false;
    releaseInteraction();
    onRelease();
  };
  const dispose = () => {
    pointers.clear();
    cleanup();
    releaseRecording();
  };
  const hold: MicrophoneHold = { isHolding: () => holding, dispose };
  documentHolds.set(doc, hold);

  const listen = (
    target: Window | Document | HTMLElement,
    type: string,
    listener: EventListener,
    capture = true,
  ) => {
    target.addEventListener(type, listener, { capture, passive: false });
    removers.push(() => target.removeEventListener(type, listener, capture));
  };
  const blockWhileHeld = (event: Event) => {
    if (interactionLocked()) block(event);
  };
  listen(win, "pointerdown", (event) => {
    if (!interactionLocked()) {
      cleanup();
      return;
    }
    pointers.add((event as PointerEvent).pointerId);
    block(event);
  });
  const endPointer = (event: Event) => {
    const pointerId = (event as PointerEvent).pointerId;
    if (!interactionLocked()) return;
    block(event);
    pointers.delete(pointerId);
    if (trigger.kind === "pointer" && pointerId === trigger.pointerId) releaseRecording();
    releaseInteraction();
  };
  listen(win, "pointerup", endPointer);
  listen(win, "pointercancel", endPointer);
  listen(button, "lostpointercapture", (event) => {
    if (trigger.kind === "pointer" && (event as PointerEvent).pointerId === trigger.pointerId) {
      releaseRecording();
    }
  });
  for (const type of [
    "pointermove",
    "mousedown",
    "mouseup",
    "touchstart",
    "touchmove",
    "touchend",
    "touchcancel",
    "selectstart",
    "dragstart",
    "beforeinput",
    "wheel",
  ])
    listen(win, type, blockWhileHeld);
  for (const type of ["click", "auxclick", "contextmenu"]) listen(win, type, block);
  listen(doc, "selectionchange", () => {
    if (interactionLocked()) clearSelection();
  });
  listen(win, "keydown", (event) => {
    if (!interactionLocked()) return;
    block(event);
    if ((event as KeyboardEvent).key === "Escape") dispose();
  });
  listen(win, "keyup", (event) => {
    if (!interactionLocked()) return;
    block(event);
    if (trigger.kind === "key" && (event as KeyboardEvent).key === trigger.key) releaseRecording();
  });
  // Element blur does not bubble. Only losing the window ends the gesture.
  listen(win, "blur", dispose, false);
  listen(doc, "visibilitychange", () => {
    if (doc.visibilityState === "hidden") dispose();
  });
  if (trigger.kind === "pointer") {
    try {
      button.setPointerCapture?.(trigger.pointerId);
    } catch {
      // Window listeners still receive release if capture is unavailable.
    }
  }
  return hold;
}

/** Native, non-passive touch handling also suppresses Safari's selection loupe. */
export function preventMicrophoneTouchDefault(event: TouchEvent): void {
  if (event.cancelable) event.preventDefault();
}
