// @effect-diagnostics nodeBuiltinImport:off - this test reads sources to assert a
// wiring invariant, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * The gesture is only correct if the composer hands the boundary a dismiss
 * callback AND that callback refuses while the microphone is live. The
 * predicate cannot see either: it takes a distance and a scroll position.
 *
 * The recorder guard matters because blurring during capture unmounts the
 * recorder controls - `shouldCollapseMobileComposer` already carries an
 * explicit carve-out for exactly that, so a second path into the same blur has
 * to honour it too.
 */
const SOURCE = NodeFS.readFileSync(
  NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "ChatComposer.tsx"),
  "utf8",
);

describe("composer swipe-down wiring", () => {
  it("hands the touch boundary a dismiss callback", () => {
    const install = SOURCE.slice(SOURCE.indexOf("installMobileComposerTouchBoundary(composerForm"));
    expect(
      install.slice(0, 400),
      "the boundary is installed without onSwipeDownDismiss, so the gesture is inert",
    ).toContain("onSwipeDownDismiss");
  });

  it("actually collapses the composer, not just the keyboard", () => {
    // The first version only blurred. On a phone thread in portrait -- the one
    // layout most phones are held in -- shouldCollapseMobileComposer returns
    // false unconditionally, so the keyboard went away and the composer stayed
    // exactly the same size: "swipe down does nothing".
    expect(SOURCE).toContain("setSwipeDismissedMobileComposer(true)");
    const call = SOURCE.slice(SOURCE.indexOf("shouldCollapseMobileComposer({"));
    expect(
      call.slice(0, call.indexOf("})")),
      "the collapse decision never sees the swipe, so the gesture cannot collapse anything",
    ).toContain("swipeDismissed");
  });

  it("reopens on the next focus, so the collapse is not a trap", () => {
    expect(SOURCE).toContain("setSwipeDismissedMobileComposer(false)");
  });

  it("refuses to collapse while the microphone is live", () => {
    const handler = SOURCE.slice(SOURCE.indexOf("swipeDownDismissRef.current = "));
    const body = handler.slice(0, handler.indexOf("};"));
    expect(
      body,
      "a swipe during voice capture would blur the composer and unmount the recorder mid-take",
    ).toContain("pushToTalkStatus");
    expect(body).toContain("blurFocusedComposerElement");
  });
});
