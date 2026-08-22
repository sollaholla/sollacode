import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { remoteConnectionHeaderAction } from "./RemoteConnectionControl";

const primary = EnvironmentId.make("primary");
const remote = EnvironmentId.make("remote");

describe("remote connection header action", () => {
  it("opens control directly for a connected remote environment", () => {
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: remote,
        primaryEnvironmentId: primary,
        connectionPhase: "connected",
        isDesktopApp: true,
      }),
    ).toBe("open-control");
  });

  it("stays hidden only where the viewer is the machine itself", () => {
    // The desktop app looking at its own environment: nothing to control.
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: primary,
        primaryEnvironmentId: primary,
        connectionPhase: "connected",
        isDesktopApp: true,
      }),
    ).toBe("hidden");
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: primary,
        primaryEnvironmentId: null,
        connectionPhase: "connected",
        isDesktopApp: true,
      }),
    ).toBe("hidden");
  });

  it("shows control for the primary environment on a non-desktop client", () => {
    // A phone or browser whose primary environment is a desktop somewhere
    // else — this is the connected-remotely-on-my-phone case.
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: primary,
        primaryEnvironmentId: primary,
        connectionPhase: "connected",
        isDesktopApp: false,
      }),
    ).toBe("open-control");
  });

  it("connects the thread's remote host directly when it is offline", () => {
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: remote,
        primaryEnvironmentId: primary,
        connectionPhase: "offline",
        isDesktopApp: true,
      }),
    ).toBe("connect-control");
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: remote,
        primaryEnvironmentId: primary,
        connectionPhase: "reconnecting",
        isDesktopApp: false,
      }),
    ).toBe("connect-control");
  });
});
