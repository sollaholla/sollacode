import { describe, expect, it } from "vite-plus/test";

import { shouldInterceptWindowCloseForQuit } from "./DesktopLifecycle.logic.ts";

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
});
