// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { agentAvatarMotion } from "@t3tools/client-runtime/state/agent-avatar-motion";
import { AgentGlyph } from "./AgentGlyph";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("stays still with reduced motion, then stops and opens its eyes when hidden or offline", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const cancel = vi.fn();
  const animate = vi.fn(() => ({ cancel }));
  vi.stubGlobal(
    "IntersectionObserver",
    class {
      constructor(private callback: (entries: Array<{ isIntersecting: boolean }>) => void) {}
      observe() {
        this.callback([{ isIntersecting: true }]);
      }
      disconnect() {}
    },
  );
  let reduced = true;
  let visibility: DocumentVisibilityState = "visible";
  const preference = Object.assign(new EventTarget(), {
    matches: reduced,
    media: "(prefers-reduced-motion: reduce)",
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
  });
  Object.defineProperty(preference, "matches", { get: () => reduced });
  vi.spyOn(window, "matchMedia").mockReturnValue(preference as MediaQueryList);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const container = document.createElement("div");
  const root = createRoot(container);
  document.body.append(container);
  const render = async (online: boolean) => {
    await act(async () => {
      root.render(<AgentGlyph agentId="agent-0" online={online} />);
    });
  };
  // Register the browser's animation API before the first effect runs.
  const previous = HTMLImageElement.prototype.animate;
  Object.defineProperty(HTMLImageElement.prototype, "animate", {
    configurable: true,
    value: animate,
  });
  try {
    await render(true);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(animate).not.toHaveBeenCalled();
    reduced = false;
    await act(async () => {
      preference.dispatchEvent(new Event("change"));
    });
    await act(async () => {
      vi.advanceTimersByTime(agentAvatarMotion("agent-0").firstDelay);
    });
    expect(animate).toHaveBeenCalledTimes(1);
    for (
      let step = 0;
      step < 8 && container.querySelector("img")?.dataset.blinking !== "true";
      step += 1
    ) {
      await act(async () => {
        vi.advanceTimersToNextTimer();
      });
    }
    expect(container.querySelector("img")?.dataset.blinking).toBe("true");
    visibility = "hidden";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(container.querySelector("img")?.dataset.blinking).toBe("false");
    expect(cancel).toHaveBeenCalled();
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(animate).toHaveBeenCalledTimes(1);
    visibility = "visible";
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await render(false);
    await act(async () => {
      vi.advanceTimersByTime(20_000);
    });
    expect(animate).toHaveBeenCalledTimes(1);
    expect(container.querySelector("img")?.dataset.online).toBe("false");
  } finally {
    await act(async () => root.unmount());
    Object.defineProperty(HTMLImageElement.prototype, "animate", {
      configurable: true,
      value: previous,
    });
    container.remove();
  }
});
