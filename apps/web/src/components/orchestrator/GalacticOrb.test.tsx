// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { GalacticOrb, type OrbTint } from "./GalacticOrb";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("keeps the same clip and speed through every change of voice state", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(window, "matchMedia").mockReturnValue({ matches: false } as MediaQueryList);
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const container = document.createElement("div");
  const root = createRoot(container);
  const render = async (tint: OrbTint, animated = true) => {
    await act(async () => {
      root.render(<GalacticOrb size={56} tint={tint} animated={animated} />);
    });
  };
  try {
    await render("user");
    const clip = container.querySelector("video");
    expect(clip).not.toBeNull();
    const rate = clip?.playbackRate;
    expect(play).toHaveBeenCalledTimes(1);
    for (const tint of ["assistant", "user", "waiting", "assistant"] as const) await render(tint);
    expect(container.querySelector("video")).toBe(clip);
    expect(clip?.playbackRate).toBe(rate);
    expect(play).toHaveBeenCalledTimes(1);
    expect(pause).not.toHaveBeenCalled();

    await render("idle", false);
    expect(container.querySelector("video")).toBe(clip);
    expect(pause).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
  }
});
