// @effect-diagnostics nodeBuiltinImport:off - this test reads sources to assert a
// wiring invariant, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * Look has to send a position that MOVES.
 *
 * The macOS host has no relative-motion path - it derives the cursor purely
 * from `x`/`y` - so sending deltas beside a frozen point warped the cursor to
 * the same coordinates on every sample and the aim never moved at all. The
 * deltas are kept for a Windows game in mouse-look, where the host takes its
 * relative branch and the position is meaningless.
 */
const SOURCE = NodeFS.readFileSync(
  NodePath.join(
    NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
    "RemoteControlViewerDialog.tsx",
  ),
  "utf8",
);

const sendFpsLookBody = (): string => {
  const start = SOURCE.indexOf("const sendFpsLook = useCallback(");
  expect(start, "sendFpsLook is gone; this check is stale").toBeGreaterThan(-1);
  return SOURCE.slice(start, SOURCE.indexOf("const sendFpsPointerButton", start));
};

describe("FPS look wiring", () => {
  it("advances the cursor instead of resending a frozen point", () => {
    const body = sendFpsLookBody();
    expect(
      body,
      "look sends a stale position, so a host with no relative path never moves the cursor",
    ).toContain("advanceFpsLookPointer({");
    expect(
      body,
      "the advanced position is never stored, so every sample starts from the same place",
    ).toContain("lastPointerPointRef.current = point");
  });

  it("still carries the deltas for a captured game", () => {
    expect(sendFpsLookBody()).toContain("dx, dy");
  });

  it("goes full screen on arming, not on capture", () => {
    // Waiting for the game to grab the mouse means setting up inside a
    // letterboxed dialog and only expanding once already playing.
    expect(SOURCE).toContain("const fpsWantsFullScreen = fpsArmed &&");
    expect(SOURCE).toContain("}, [fpsWantsFullScreen, toggleFullScreen]);");
  });
});
