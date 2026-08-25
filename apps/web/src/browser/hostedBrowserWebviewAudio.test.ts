import { describe, expect, it, vi } from "vite-plus/test";

import { applyHostedBrowserWebviewAudio } from "./hostedBrowserWebviewAudio";

describe("applyHostedBrowserWebviewAudio", () => {
  it("mutes a guest that is not the selected sidebar tab", () => {
    const setAudioMuted = vi.fn();

    applyHostedBrowserWebviewAudio({ setAudioMuted }, false);

    expect(setAudioMuted).toHaveBeenCalledExactlyOnceWith(true);
  });

  it("unmutes only an explicitly audible guest", () => {
    const setAudioMuted = vi.fn();

    applyHostedBrowserWebviewAudio({ setAudioMuted }, true);

    expect(setAudioMuted).toHaveBeenCalledExactlyOnceWith(false);
  });

  it("does not break rendering while Electron's guest methods are not ready", () => {
    const setAudioMuted = vi.fn(() => {
      throw new Error("The WebView must be attached to the DOM");
    });

    expect(() => applyHostedBrowserWebviewAudio({ setAudioMuted }, false)).not.toThrow();
    expect(setAudioMuted).toHaveBeenCalledExactlyOnceWith(true);
  });
});
