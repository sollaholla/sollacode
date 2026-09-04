import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_SWIPE_DOWN_DISMISS_PX,
  composerTouchMoveDisposition,
  shouldDismissComposerOnSwipeDown,
} from "./mobileComposerInteraction";

describe("mobile composer touch boundary", () => {
  it.each([
    { label: "composer shell", scrollTop: null, scrollHeight: null, clientHeight: null },
    { label: "send and toolbar controls", scrollTop: null, scrollHeight: null, clientHeight: null },
    { label: "single-line editor", scrollTop: 0, scrollHeight: 80, clientHeight: 80 },
  ])("blocks a downward drag starting in $label", ({ scrollTop, scrollHeight, clientHeight }) => {
    expect(
      composerTouchMoveDisposition({
        deltaY: 40,
        editorScrollTop: scrollTop,
        editorScrollHeight: scrollHeight,
        editorClientHeight: clientHeight,
      }),
    ).toBe("block");
  });

  it("blocks iOS-style downward rubber-band at the editor's top edge", () => {
    expect(
      composerTouchMoveDisposition({
        deltaY: 48,
        editorScrollTop: 0,
        editorScrollHeight: 320,
        editorClientHeight: 140,
      }),
    ).toBe("block");
  });

  it("blocks upward scroll chaining at the editor's bottom edge", () => {
    expect(
      composerTouchMoveDisposition({
        deltaY: -48,
        editorScrollTop: 180,
        editorScrollHeight: 320,
        editorClientHeight: 140,
      }),
    ).toBe("block");
  });

  it("preserves genuine internal multiline editor scrolling in either direction", () => {
    expect(
      composerTouchMoveDisposition({
        deltaY: 32,
        editorScrollTop: 80,
        editorScrollHeight: 320,
        editorClientHeight: 140,
      }),
    ).toBe("allow-editor-scroll");
    expect(
      composerTouchMoveDisposition({
        deltaY: -32,
        editorScrollTop: 80,
        editorScrollHeight: 320,
        editorClientHeight: 140,
      }),
    ).toBe("allow-editor-scroll");
  });
});

describe("shouldDismissComposerOnSwipeDown", () => {
  it("dismisses once the drag passes the threshold at the top of the editor", () => {
    expect(
      shouldDismissComposerOnSwipeDown({
        totalDeltaY: COMPOSER_SWIPE_DOWN_DISMISS_PX,
        editorScrollTop: 0,
      }),
    ).toBe(true);
  });

  it("ignores a drag that has not travelled far enough", () => {
    // Short of the threshold this is a lazy thumb on the way to tapping the
    // caret, and dismissing there would close the keyboard mid-sentence.
    expect(
      shouldDismissComposerOnSwipeDown({
        totalDeltaY: COMPOSER_SWIPE_DOWN_DISMISS_PX - 1,
        editorScrollTop: 0,
      }),
    ).toBe(false);
  });

  it("never steals a scroll from a prompt with text above the fold", () => {
    // Dragging down here is the user reading back what they wrote.
    expect(shouldDismissComposerOnSwipeDown({ totalDeltaY: 400, editorScrollTop: 120 })).toBe(
      false,
    );
  });

  it("treats a touch outside the editor's scroller as dismissable", () => {
    // The padding and the toolbar have no scroll position to protect.
    expect(shouldDismissComposerOnSwipeDown({ totalDeltaY: 400, editorScrollTop: null })).toBe(
      true,
    );
  });

  it("does not fire on an upward drag", () => {
    expect(shouldDismissComposerOnSwipeDown({ totalDeltaY: -400, editorScrollTop: 0 })).toBe(false);
  });

  it("measures from where the finger went down, not from summed deltas", () => {
    // A wandering drag that ends 20px below its origin has not asked for
    // anything, however far it travelled getting there.
    expect(shouldDismissComposerOnSwipeDown({ totalDeltaY: 20, editorScrollTop: 0 })).toBe(false);
  });
});
