import { describe, expect, it } from "vite-plus/test";

import {
  controllerPlatform,
  normalizeRemoteControlKeyCode,
  normalizedRemotePoint,
  remotePointerButton,
  shouldForwardRemoteSurfaceInput,
} from "./remoteControlInput";

describe("remote-control input mapping", () => {
  it("maps the controller's primary shortcut modifier to a host-neutral code", () => {
    expect(normalizeRemoteControlKeyCode("MetaLeft", "macos")).toBe("PrimaryLeft");
    expect(normalizeRemoteControlKeyCode("ControlRight", "windows")).toBe("PrimaryRight");
    expect(normalizeRemoteControlKeyCode("ControlLeft", "macos")).toBe("ControlLeft");
    expect(normalizeRemoteControlKeyCode("MetaRight", "windows")).toBe("MetaRight");
  });

  it("detects phone and desktop controller platforms", () => {
    expect(controllerPlatform("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)")).toBe(
      "macos",
    );
    expect(controllerPlatform("Mozilla/5.0 (Windows NT 10.0; Win64; x64)")).toBe("windows");
    expect(controllerPlatform("Mozilla/5.0 (Linux; Android 15)")).toBe("linux");
  });

  it("normalizes and clamps pointer coordinates inside the rendered frame", () => {
    const rect = { left: 100, top: 50, width: 400, height: 200 };
    expect(normalizedRemotePoint({ clientX: 300, clientY: 150, rect })).toEqual({
      x: 0.5,
      y: 0.5,
    });
    expect(normalizedRemotePoint({ clientX: 40, clientY: 400, rect })).toEqual({
      x: 0,
      y: 1,
    });
  });

  it("maps browser pointer buttons", () => {
    expect(remotePointerButton(0)).toBe("left");
    expect(remotePointerButton(1)).toBe("middle");
    expect(remotePointerButton(2)).toBe("right");
  });

  it("routes hover, wheel, and keyboard input only after the remote surface owns focus", () => {
    for (const kind of ["pointer-move", "wheel", "key"] as const) {
      expect(
        shouldForwardRemoteSurfaceInput({
          capabilityGranted: true,
          inputCaptured: false,
          kind,
        }),
      ).toBe(false);
      expect(
        shouldForwardRemoteSurfaceInput({
          capabilityGranted: true,
          inputCaptured: true,
          kind,
        }),
      ).toBe(true);
    }
  });

  it("allows the initial focus click and always releases an active pointer press", () => {
    expect(
      shouldForwardRemoteSurfaceInput({
        capabilityGranted: true,
        inputCaptured: false,
        kind: "pointer-down",
      }),
    ).toBe(true);
    expect(
      shouldForwardRemoteSurfaceInput({
        capabilityGranted: true,
        inputCaptured: false,
        kind: "pointer-up",
        hasActivePointerPress: true,
      }),
    ).toBe(true);
    expect(
      shouldForwardRemoteSurfaceInput({
        capabilityGranted: false,
        inputCaptured: true,
        kind: "pointer-down",
      }),
    ).toBe(false);
  });
});
