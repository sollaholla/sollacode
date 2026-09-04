import { describe, expect, it } from "vite-plus/test";

import {
  observeDetachedPromise,
  sendIntentionalShutdownToLiveWindows,
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
        windowIsAuxiliary: false,
      }),
    ).toBe(true);
  });

  it("does not intercept macOS close or the final close after shutdown", () => {
    expect(
      shouldInterceptWindowCloseForQuit({
        platform: "darwin",
        quitAllowed: false,
        quitAlreadyRequested: false,
        windowIsAuxiliary: false,
      }),
    ).toBe(false);
    expect(
      shouldInterceptWindowCloseForQuit({
        platform: "linux",
        quitAllowed: true,
        quitAlreadyRequested: true,
        windowIsAuxiliary: false,
      }),
    ).toBe(false);
  });

  it("does not quit when an auxiliary window is dismissed", () => {
    // The "Connecting to WSL" splash is taken down with an ordinary close() the
    // moment the real main window reveals. Reading that as the user closing the
    // app quit a Windows box about 140ms after its backend started answering -
    // a backend a phone talks to over the network.
    expect(
      shouldInterceptWindowCloseForQuit({
        platform: "win32",
        quitAllowed: false,
        quitAlreadyRequested: false,
        windowIsAuxiliary: true,
      }),
    ).toBe(false);
  });

  it("observes rejected detached work and still runs its completion callback", async () => {
    let settled = false;
    observeDetachedPromise(Promise.reject(new Error("shutdown failed")), () => {
      settled = true;
    });

    await Promise.resolve();
    await Promise.resolve();

    expect(settled).toBe(true);
  });

  it("contains errors thrown by a detached completion callback", async () => {
    observeDetachedPromise(Promise.resolve(), () => {
      throw new Error("quit callback failed");
    });

    await Promise.resolve();
    await Promise.resolve();
  });

  it("skips destroyed shutdown targets and contains a WebContents close race", () => {
    const delivered: Array<string> = [];
    const failures = sendIntentionalShutdownToLiveWindows(
      [
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: (channel) => delivered.push(channel),
          },
        },
        {
          isDestroyed: () => true,
          webContents: {
            isDestroyed: () => false,
            send: () => {
              throw new Error("destroyed window should not receive a message");
            },
          },
        },
        {
          isDestroyed: () => false,
          webContents: {
            isDestroyed: () => false,
            send: () => {
              throw new Error("Object has been destroyed");
            },
          },
        },
      ],
      "desktop:intentional-shutdown",
    );

    expect(delivered).toEqual(["desktop:intentional-shutdown"]);
    expect(failures).toHaveLength(1);
  });

  it("preserves exactly one auto-resume signal across a desktop relaunch", () => {
    expect(withDesktopRelaunchArguments(["--inspect=0"])).toEqual(["--inspect=0", "--auto-resume"]);
    expect(withDesktopRelaunchArguments(["--auto-resume"])).toEqual(["--auto-resume"]);
  });
});
