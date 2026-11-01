// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { AgentGlyph } from "./AgentGlyph";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("moves only by transform: no reduced motion, offline or hidden gestures, no image swaps", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(
        private callback: (entries: Array<{ isIntersecting: boolean; target: Element }>) => void,
      ) {}
      observe(target: Element) {
        this.callback([{ isIntersecting: true, target }]);
      }
      unobserve() {}
      disconnect() {}
    },
  );
  let reduced = true;
  let visibility: DocumentVisibilityState = "visible";
  const preference = Object.assign(new EventTarget(), {
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });
  Object.defineProperty(preference, "matches", { get: () => reduced });
  vi.spyOn(window, "matchMedia").mockReturnValue(preference as unknown as MediaQueryList);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  const render = async (online: boolean, mood?: "idle" | "happy") => {
    await act(async () => {
      root.render(<AgentGlyph agentId="agent-0" online={online} mood={mood} />);
    });
  };
  const previous = HTMLElement.prototype.animate;
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  try {
    await render(true);
    const sources = () => [...container.querySelectorAll("img")].map((image) => image.src);
    const before = sources();
    expect(before).toHaveLength(2);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(animate).not.toHaveBeenCalled();

    reduced = false;
    await act(async () => {
      preference.dispatchEvent(new Event("change"));
    });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(animate).toHaveBeenCalled();
    expect(sources()).toEqual(before);

    const playedWhileVisible = animate.mock.calls.length;
    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(animate).toHaveBeenCalledTimes(playedWhileVisible);
    expect(vi.getTimerCount()).toBe(0);

    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const beforeMood = animate.mock.calls.length;
    await render(true, "happy");
    expect(animate.mock.calls.length).toBeGreaterThan(beforeMood);

    const beforeOffline = animate.mock.calls.length;
    await render(false);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(animate).toHaveBeenCalledTimes(beforeOffline);
    expect(container.querySelector("span")?.dataset.online).toBe("false");
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: previous,
    });
    container.remove();
  }
});
