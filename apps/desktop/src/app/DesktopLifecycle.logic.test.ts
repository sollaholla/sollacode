import { describe, expect, it } from "vite-plus/test";

import {
  shouldInterceptWindowCloseForQuit,
  withDesktopRelaunchArguments,
} from "./DesktopLifecycle.logic.ts";

describe("shouldInterceptWindowCloseForQuit", () => {
  it("keeps a non-macOS main window alive long enough to show intentional shutdown", () => {
    expect(
      shouldInterceptWindowCloseForQuit({
        platform: "win32",
        quitAllowed: false,
        quitAlreadyRequested: false,
      }),
    ).toBe(true);
  });

  it("does not intercept macOS close or the final close after shutdown", () => {
    expect(
      shouldInterceptWindowCloseForQuit({
        platform: "darwin",
        quitAllowed: false,
        quitAlreadyRequested: false,
      }),
    ).toBe(false);
    expect(
      shouldInterceptWindowCloseForQuit({
        platform: "linux",
        quitAllowed: true,
        quitAlreadyRequested: true,
      }),
    ).toBe(false);
  });

  it("preserves exactly one auto-resume signal across a desktop relaunch", () => {
    expect(withDesktopRelaunchArguments(["--inspect=0"])).toEqual(["--inspect=0", "--auto-resume"]);
    expect(withDesktopRelaunchArguments(["--auto-resume"])).toEqual(["--auto-resume"]);
  });
});
