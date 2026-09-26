// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vite-plus/test";

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
  it.each(["textarea", "input", "contenteditable"])(
    "collapses from an unfocused %s without stealing its initial tap or scroll",
    (kind) => {
      const root = document.createElement("form");
      const editor = document.createElement(kind === "contenteditable" ? "div" : kind);
      if (kind === "contenteditable") editor.setAttribute("contenteditable", "true");
      editor.setAttribute("data-chat-composer-scroll-container", "true");
      root.append(editor);
      document.body.append(root);
      const dismiss = vi.fn();
      const uninstall = installMobileComposerTouchBoundary(root, { onSwipeDownDismiss: dismiss });
      try {
        editor.dispatchEvent(touchEvent("touchstart", 1, 100, editor));
        const shortMove = touchEvent("touchmove", 1, 120, editor);
        editor.dispatchEvent(shortMove);
        expect(shortMove.defaultPrevented).toBe(false);
        expect(dismiss).not.toHaveBeenCalled();
        editor.dispatchEvent(touchEvent("touchmove", 1, 180, editor));
        expect(dismiss).toHaveBeenCalledOnce();
      } finally {
        uninstall();
        root.remove();
      }
    },
  );

  it.each(["focus-gained", "focus-lost"])(
    "protects an editing gesture when %s during the swipe",
    (transition) => {
      // happy-dom's form proxy breaks contains(activeElement); a plain root
      // exercises the same HTMLElement boundary without that emulator defect.
      const root = document.createElement("div");
      const editor = document.createElement("textarea");
      root.append(editor);
      document.body.append(root);
      const dismiss = vi.fn();
      const uninstall = installMobileComposerTouchBoundary(root, { onSwipeDownDismiss: dismiss });
      try {
        if (transition === "focus-lost") editor.focus();
        editor.dispatchEvent(touchEvent("touchstart", 1, 100, editor));
        if (transition === "focus-gained") editor.focus();
        else editor.blur();
        const move = touchEvent("touchmove", 1, 220, editor);
        editor.dispatchEvent(move);
        expect(move.defaultPrevented).toBe(false);
        expect(dismiss).not.toHaveBeenCalled();
      } finally {
        uninstall();
        root.remove();
      }
    },
  );

  it.each(["textarea", "input", "contenteditable"])(
    "leaves %s selection drags and native scrolling to the browser",
    (kind) => {
      const root = document.createElement("div");
      const editor = document.createElement(kind === "contenteditable" ? "div" : kind);
      if (kind === "contenteditable") editor.setAttribute("contenteditable", "true");
      editor.setAttribute("data-chat-composer-scroll-container", "true");
      root.append(editor);
      document.body.append(root);
      editor.tabIndex = 0;
      editor.focus();
      expect(root.ownerDocument.activeElement).toBe(editor);
      expect(root.contains(root.ownerDocument.activeElement)).toBe(true);
      const dismiss = vi.fn();
      const uninstall = installMobileComposerTouchBoundary(root, {
        onSwipeDownDismiss: dismiss,
      });

      try {
        // A short, unscrollable editor was the worst case: every movement was
        // cancelled, and dragging a selection handle down hid the keyboard.
        editor.dispatchEvent(touchEvent("touchstart", 3, 100, editor));
        expect(root.ownerDocument.activeElement).toBe(editor);
        for (const position of [110, 80, 190, 260]) {
          const move = touchEvent("touchmove", 3, position, editor);
          editor.dispatchEvent(move);
          expect(move.defaultPrevented).toBe(false);
        }
        expect(dismiss).not.toHaveBeenCalled();
        editor.dispatchEvent(touchEvent("touchend", 3, 260, editor));

        // The frame also preserves focus. Collapse becomes available after blur.
        root.dispatchEvent(touchEvent("touchstart", 4, 100, root));
        root.dispatchEvent(touchEvent("touchmove", 4, 180, root));
        expect(dismiss).not.toHaveBeenCalled();
        root.dispatchEvent(touchEvent("touchend", 4, 180, root));
        editor.blur();
        root.dispatchEvent(touchEvent("touchstart", 5, 100, root));
        root.dispatchEvent(touchEvent("touchmove", 5, 180, root));
        expect(dismiss).toHaveBeenCalledOnce();
      } finally {
        uninstall();
        root.remove();
      }
    },
  );

  it("blocks control callouts even when Safari targets the form, but leaves editor selection native", () => {
    const root = document.createElement("form");
    const mic = document.createElement("button");
    const editor = document.createElement("textarea");
    editor.value = "Keep this selection";
    root.append(mic, editor);
    document.body.append(root);
    const uninstall = installMobileComposerTouchBoundary(root);
    try {
      mic.dispatchEvent(touchEvent("touchstart", 1, 100, mic));
      for (const type of ["selectstart", "contextmenu"]) {
        const callout = new Event(type, { bubbles: true, cancelable: true });
        root.dispatchEvent(callout);
        expect(callout.defaultPrevented).toBe(true);
      }
      mic.dispatchEvent(touchEvent("touchend", 1, 100, mic));
      editor.focus();
      editor.setSelectionRange(5, 9, "backward");
      editor.dispatchEvent(touchEvent("touchstart", 2, 100, editor));
      for (const type of ["selectstart", "contextmenu"]) {
        const selection = new Event(type, { bubbles: true, cancelable: true });
        editor.dispatchEvent(selection);
        expect(selection.defaultPrevented).toBe(false);
      }
      editor.dispatchEvent(touchEvent("touchmove", 2, 250, editor));
      expect([editor.selectionStart, editor.selectionEnd, editor.selectionDirection]).toEqual([
        5,
        9,
        "backward",
      ]);
    } finally {
      uninstall();
      root.remove();
    }
  });

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
