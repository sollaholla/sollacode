import { describe, expect, it } from "vite-plus/test";

import {
  controllerPlatform,
  normalizeRemoteControlKeyCode,
  objectContainContentRect,
  normalizedRemotePoint,
  remotePointerButton,
  remoteSurfaceCursorStyle,
  shouldForwardEscapeOnPointerUnlock,
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

  it("forwards Escape only for a focused native pointer-lock release", () => {
    const nativeEscape = {
      wasLocked: true,
      isLocked: false,
      programmatic: false,
      inputCaptured: true,
      keyboardGranted: true,
      documentVisible: true,
      documentFocused: true,
    };
    expect(shouldForwardEscapeOnPointerUnlock(nativeEscape)).toBe(true);

    for (const override of [
      { wasLocked: false },
      { isLocked: true },
      { programmatic: true },
      { inputCaptured: false },
      { keyboardGranted: false },
      { documentVisible: false },
      { documentFocused: false },
    ]) {
      expect(shouldForwardEscapeOnPointerUnlock({ ...nativeEscape, ...override })).toBe(false);
    }
  });
});

describe("remoteSurfaceCursorStyle", () => {
  it("mirrors the host cursor only while captured with pointer rights", () => {
    expect(
      remoteSurfaceCursorStyle({ shape: "text", inputCaptured: true, pointerGranted: true }),
    ).toBe("text");
    expect(
      remoteSurfaceCursorStyle({ shape: "none", inputCaptured: true, pointerGranted: true }),
    ).toBe("none");
    expect(
      remoteSurfaceCursorStyle({ shape: "text", inputCaptured: false, pointerGranted: true }),
    ).toBe("default");
    expect(
      remoteSurfaceCursorStyle({ shape: "text", inputCaptured: true, pointerGranted: false }),
    ).toBe("default");
  });

  it("degrades unknown wire values to the arrow", () => {
    expect(
      remoteSurfaceCursorStyle({
        shape: "url(evil.png)",
        inputCaptured: true,
        pointerGranted: true,
      }),
    ).toBe("default");
  });
});

describe("objectContainContentRect", () => {
  it("excludes letterbox bars for a wide element showing a 16:9 picture", () => {
    const rect = objectContainContentRect(
      { left: 0, top: 0, width: 2000, height: 900 },
      { width: 1600, height: 900 },
    );
    expect(rect).toEqual({ left: 200, top: 0, width: 1600, height: 900 });
  });

  it("excludes pillar bars for a tall element", () => {
    const rect = objectContainContentRect(
      { left: 10, top: 20, width: 800, height: 1000 },
      { width: 1600, height: 900 },
    );
    expect(rect.left).toBe(10);
    expect(rect.width).toBe(800);
    expect(rect.height).toBeCloseTo(450);
    expect(rect.top).toBeCloseTo(20 + (1000 - 450) / 2);
  });

  it("falls back to the element rect when intrinsic size is unknown", () => {
    const element = { left: 0, top: 0, width: 800, height: 600 };
    expect(objectContainContentRect(element, { width: 0, height: 0 })).toBe(element);
  });
});
