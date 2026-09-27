// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { highlightSettingsSearchResult } from "./settingsSearchHighlight";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("settings search highlight", () => {
  it("finds a lazy row after a slow panel load and cleans up the highlight", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const cleanup = highlightSettingsSearchResult(root, "provider-options");
    await vi.advanceTimersByTimeAsync(5000);
    const row = document.createElement("div");
    row.id = "provider-options";
    root.append(row);
    await vi.advanceTimersByTimeAsync(0);
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "center" });
    expect(row.hasAttribute("data-settings-highlight")).toBe(true);
    await vi.advanceTimersByTimeAsync(2400);
    expect(row.hasAttribute("data-settings-highlight")).toBe(false);
    cleanup();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not scroll a stale result after navigation or retain its observer", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const scroll = vi.spyOn(HTMLElement.prototype, "scrollIntoView");
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const cleanup = highlightSettingsSearchResult(root, "old-setting");
    cleanup();
    root.innerHTML = '<div id="old-setting"></div>';
    await vi.advanceTimersByTimeAsync(0);
    expect(scroll).not.toHaveBeenCalled();
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops observing a missing result after the loading allowance", async () => {
    vi.useFakeTimers();
    const root = document.createElement("div");
    document.body.append(root);
    const disconnect = vi.spyOn(MutationObserver.prototype, "disconnect");
    const cleanup = highlightSettingsSearchResult(root, "missing-setting");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(disconnect).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
  });
});
