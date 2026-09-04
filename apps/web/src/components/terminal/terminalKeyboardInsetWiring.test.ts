// @effect-diagnostics nodeBuiltinImport:off - this test reads sources to assert a
// wiring invariant, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The inset is worth nothing unless it reaches the pane as padding. It has to
 * be padding specifically: the xterm mount is the pane's `flex-1` child and is
 * watched by a ResizeObserver, so shrinking the box is what makes the terminal
 * reflow. Translating the pane instead would keep the same number of rows and
 * simply move some of them under the keyboard.
 */
const SOURCE = NodeFS.readFileSync(
  NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "..",
    "ThreadTerminalDrawer.tsx",
  ),
  "utf8",
);

describe("terminal keyboard inset wiring", () => {
  it("applies the inset to the pane as bottom padding", () => {
    expect(SOURCE).toContain("resolveTerminalKeyboardInset({");
    expect(SOURCE).toContain("paddingBottom: keyboardInset");
    expect(
      SOURCE,
      "a transform would move rows under the keyboard instead of reflowing them away",
    ).not.toContain("translateY(-${keyboardInset}");
  });

  it("recomputes on focus changes, not only on viewport resizes", () => {
    // Tapping between the terminal and the composer moves the keyboard's owner
    // without changing its size.
    expect(SOURCE).toContain('document.addEventListener("focusin"');
    expect(SOURCE).toContain('document.addEventListener("focusout"');
  });
});
