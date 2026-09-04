// @effect-diagnostics nodeBuiltinImport:off - this test reads sources to assert a
// wiring invariant, which is a build-time concern rather than app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { describe, expect, it } from "vite-plus/test";

/**
 * `shouldInterceptWindowCloseForQuit` can be correct on its own and still let
 * the app quit on startup, because the guard only works if two separate places
 * agree: the splash has to be tagged auxiliary when it is created, and the
 * close handler has to actually ask whether the closing window carries that
 * tag. A unit test over the pure function sees neither.
 *
 * That is the shape of the failure this replaced - a first fix keyed on
 * "was the window ever revealed", which the splash flipped to true the instant
 * it appeared, so the guard shipped inert and the Windows box still quit 140ms
 * after its backend came up.
 */
const SRC = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

const read = (...segments: readonly string[]): string =>
  NodeFS.readFileSync(NodePath.join(SRC, ...segments), "utf8");

describe("splash dismissal must not quit the app", () => {
  it("tags the connecting splash as auxiliary before tracking it", () => {
    const source = read("window", "DesktopWindow.ts");
    const splashSection = source.slice(source.indexOf("showConnectingSplash"));
    const tagIndex = splashSection.indexOf("markAuxiliary(splash)");
    const trackIndex = splashSection.indexOf("Ref.set(splashWindowRef, Option.some(splash))");
    expect(
      tagIndex,
      "the splash is never tagged auxiliary, so dismissing it reads as the user closing the app",
    ).toBeGreaterThan(-1);
    expect(trackIndex).toBeGreaterThan(-1);
    expect(tagIndex).toBeLessThan(trackIndex);
  });

  it("asks whether the closing window is auxiliary before quitting", () => {
    const source = read("app", "DesktopLifecycle.ts");
    const call = source.slice(source.indexOf("shouldInterceptWindowCloseForQuit({"));
    const args = call.slice(0, call.indexOf("})"));
    expect(args).toContain("windowIsAuxiliary");
    expect(
      source,
      "the close handler decides without reading the auxiliary tag, so the guard cannot fire",
    ).toContain("isAuxiliaryWindowId(window.id)");
  });

  it("exposes the tag synchronously, because `close` cannot await a fiber", () => {
    const source = read("electron", "ElectronWindow.ts");
    expect(source).toContain("isAuxiliaryWindowId: (windowId) => auxiliaryWindowIds.has(windowId)");
  });
});
