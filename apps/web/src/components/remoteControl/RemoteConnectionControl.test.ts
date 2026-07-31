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

  it("opens connection setup for the local or disconnected environment", () => {
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: primary,
        primaryEnvironmentId: primary,
        connectionPhase: "connected",
      }),
    ).toBe("open-connections");
    expect(
      remoteConnectionHeaderAction({
        activeEnvironmentId: remote,
        primaryEnvironmentId: primary,
        connectionPhase: "disconnected",
      }),
    ).toBe("open-connections");
  });
});
