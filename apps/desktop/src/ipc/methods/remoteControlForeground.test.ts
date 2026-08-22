import { describe, expect, it, vi } from "vite-plus/test";

import { pulseRemoteControlHostWindow } from "./remoteControl.ts";

function makeWindow(input?: { readonly destroyed?: boolean; readonly alwaysOnTop?: boolean }) {
  return {
    isDestroyed: vi.fn(() => input?.destroyed ?? false),
    isAlwaysOnTop: vi.fn(() => input?.alwaysOnTop ?? false),
    setAlwaysOnTop: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
  };
}

describe("pulseRemoteControlHostWindow", () => {
  it("promotes a normal window and restores its topmost state after a bounded pulse", () => {
    const window = makeWindow();
    let reset: (() => void) | undefined;
    const scheduleReset = vi.fn((callback: () => void) => {
      reset = callback;
    });

    pulseRemoteControlHostWindow(window, scheduleReset);

    expect(window.setAlwaysOnTop).toHaveBeenCalledTimes(1);
    expect(window.setAlwaysOnTop).toHaveBeenNthCalledWith(1, true);
    expect(window.moveTop).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
    expect(scheduleReset).toHaveBeenCalledWith(expect.any(Function), 750);

    reset?.();
    expect(window.setAlwaysOnTop).toHaveBeenNthCalledWith(2, false);
  });

  it("preserves a window that was already always on top", () => {
    const window = makeWindow({ alwaysOnTop: true });
    const scheduleReset = vi.fn();

    pulseRemoteControlHostWindow(window, scheduleReset);

    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(scheduleReset).not.toHaveBeenCalled();
    expect(window.moveTop).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("does not touch a destroyed window", () => {
    const window = makeWindow({ destroyed: true });

    pulseRemoteControlHostWindow(window);

    expect(window.isAlwaysOnTop).not.toHaveBeenCalled();
    expect(window.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(window.moveTop).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });
});
