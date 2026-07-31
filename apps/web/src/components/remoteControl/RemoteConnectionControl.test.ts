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
      }),
    ).toBe("open-control");
  });

  it("stays hidden for a local environment", () => {
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: primary,
        primaryEnvironmentId: primary,
        connectionPhase: "connected",
      }),
    ).toBe("hidden");
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: primary,
        primaryEnvironmentId: null,
        connectionPhase: "connected",
      }),
    ).toBe("hidden");
  });

  it("connects the thread's remote host directly when it is offline", () => {
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: remote,
        primaryEnvironmentId: primary,
        connectionPhase: "offline",
      }),
    ).toBe("connect-control");
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: remote,
        primaryEnvironmentId: primary,
        connectionPhase: "reconnecting",
      }),
    ).toBe("connect-control");
  });
});
