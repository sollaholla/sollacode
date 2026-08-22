import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { shouldShowOpenInPicker } from "./ChatHeader";

describe("shouldShowOpenInPicker", () => {
  const primaryEnvironmentId = EnvironmentId.make("environment-primary");

  it("shows the picker for projects in the primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        isDesktopClient: true,
      }),
    ).toBe(true);
  });

  it("hides the picker when hosted static mode has no primary environment", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId: null,
        isDesktopClient: true,
      }),
    ).toBe(false);
  });

  it("hides the picker for remote environments", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: "codething-mvp",
        activeThreadEnvironmentId: EnvironmentId.make("environment-remote"),
        primaryEnvironmentId,
        isDesktopClient: true,
      }),
    ).toBe(false);
  });

  it("hides the picker when there is no active project", () => {
    expect(
      shouldShowOpenInPicker({
        activeProjectName: undefined,
        activeThreadEnvironmentId: primaryEnvironmentId,
        primaryEnvironmentId,
        isDesktopClient: true,
      }),
    ).toBe(false);
  });
});

describe("shouldShowOpenInPicker on clients that cannot open a directory", () => {
  const primary = EnvironmentId.make("env-primary");
  const base = {
    activeProjectName: "solla",
    activeThreadEnvironmentId: primary,
    primaryEnvironmentId: primary,
    isDesktopClient: true,
  };

  it("offers it in the local desktop app", () => {
    expect(shouldShowOpenInPicker(base)).toBe(true);
  });

  it("hides it from a browser reaching the same environment", () => {
    // A phone or a remote browser is looking at the primary environment, but
    // "reveal in Finder" would act on the host it is talking to, not the
    // machine in the user's hand.
    expect(shouldShowOpenInPicker({ ...base, isDesktopClient: false })).toBe(false);
  });
});
