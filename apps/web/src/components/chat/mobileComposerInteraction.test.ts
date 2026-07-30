import { describe, expect, it } from "vite-plus/test";

import { composerTouchMoveDisposition } from "./mobileComposerInteraction";

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
