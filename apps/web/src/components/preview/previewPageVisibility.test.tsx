// @vitest-environment happy-dom
import { act, useEffect } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vite-plus/test";

import { usePreviewPageVisible } from "./previewPageVisibility";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("starts and stops remote media with page visibility and releases the listener", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  let visibility: DocumentVisibilityState = "hidden";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
  const removeListener = vi.spyOn(document, "removeEventListener");
  const start = vi.fn();
  const stop = vi.fn();
  function Media() {
    const visible = usePreviewPageVisible();
    useEffect(() => {
      if (!visible) return;
      start();
      return stop;
    }, [visible]);
    return null;
  }
  const root = createRoot(document.createElement("div"));
  try {
    await act(async () => root.render(<Media />));
    expect(start).not.toHaveBeenCalled();
    visibility = "visible";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(start).toHaveBeenCalledOnce();
    visibility = "hidden";
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    await act(async () => root.unmount());
  }
  expect(removeListener).toHaveBeenCalledWith("visibilitychange", expect.any(Function));
});
