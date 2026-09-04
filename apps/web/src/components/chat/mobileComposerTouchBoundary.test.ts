// @vitest-environment happy-dom
import { describe, expect, it } from "vite-plus/test";

import { installMobileComposerTouchBoundary } from "./mobileComposerInteraction.ts";

function touchEvent(type: string, id: number, clientY: number, target: EventTarget): Event {
  const touch = { identifier: id, clientY, clientX: 0, target } as unknown as Touch;
  const list = Object.assign([touch], {
    item: (index: number) => (index === 0 ? touch : null),
    length: 1,
  }) as unknown as TouchList;
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: list });
  Object.defineProperty(event, "changedTouches", { value: list });
  return event;
}

describe("installMobileComposerTouchBoundary swipe-down", () => {
  it("calls the dismiss callback for a downward drag past the threshold", () => {
    const root = document.createElement("form");
    const scroller = document.createElement("div");
    scroller.setAttribute("data-chat-composer-scroll-container", "true");
    root.append(scroller);
    document.body.append(root);

    let dismissed = 0;
    const uninstall = installMobileComposerTouchBoundary(root, {
      onSwipeDownDismiss: () => {
        dismissed += 1;
      },
    });

    scroller.dispatchEvent(touchEvent("touchstart", 1, 100, scroller));
    scroller.dispatchEvent(touchEvent("touchmove", 1, 180, scroller));

    expect(dismissed).toBe(1);

    // Latched: further movement in the same touch must not re-fire.
    scroller.dispatchEvent(touchEvent("touchmove", 1, 260, scroller));
    expect(dismissed).toBe(1);

    uninstall();
    root.remove();
  });

  it("does not fire for a short drag", () => {
    const root = document.createElement("form");
    document.body.append(root);
    let dismissed = 0;
    const uninstall = installMobileComposerTouchBoundary(root, {
      onSwipeDownDismiss: () => {
        dismissed += 1;
      },
    });
    root.dispatchEvent(touchEvent("touchstart", 2, 100, root));
    root.dispatchEvent(touchEvent("touchmove", 2, 130, root));
    expect(dismissed).toBe(0);
    uninstall();
    root.remove();
  });
});
