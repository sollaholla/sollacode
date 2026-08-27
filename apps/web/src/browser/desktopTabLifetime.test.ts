import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { closeTab, createTab, stopBrowserRecording } = vi.hoisted(() => ({
  closeTab: vi.fn<(tabId: string) => Promise<void>>(async () => undefined),
  createTab: vi.fn<() => Promise<void>>(),
  stopBrowserRecording: vi.fn(async () => null),
}));

vi.mock("~/components/preview/previewBridge", () => ({
  previewBridge: { closeTab, createTab },
}));

vi.mock("./browserRecording", () => ({
  stopBrowserRecording,
}));

import { acquireDesktopTab } from "./desktopTabLifetime";
import { previewRuntimeTabId } from "./previewRuntimeTabId";

describe("desktopTabLifetime", () => {
  beforeEach(() => {
    closeTab.mockClear();
    createTab.mockClear();
    stopBrowserRecording.mockClear();
    vi.stubGlobal("window", globalThis);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("shares tab creation readiness across concurrent leases", async () => {
    let resolveCreation: (() => void) | undefined;
    createTab.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveCreation = resolve;
      }),
    );

    const first = acquireDesktopTab("tab_readiness");
    const second = acquireDesktopTab("tab_readiness");

    expect(createTab).toHaveBeenCalledOnce();
    expect(first.ready).toBe(second.ready);

    let ready = false;
    void first.ready.then(() => {
      ready = true;
    });
    await Promise.resolve();
    expect(ready).toBe(false);

    resolveCreation?.();
    await first.ready;
    expect(ready).toBe(true);
  });

  it("keeps identical server tab ids from two environments in separate desktop slots", async () => {
    vi.useFakeTimers();
    createTab.mockResolvedValue(undefined);
    const tabA = previewRuntimeTabId(
      {
        environmentId: EnvironmentId.make("environment-a"),
        threadId: ThreadId.make("thread-a"),
      },
      "epoch-a",
      "tab_1",
    );
    const tabB = previewRuntimeTabId(
      {
        environmentId: EnvironmentId.make("environment-b"),
        threadId: ThreadId.make("thread-b"),
      },
      "epoch-b",
      "tab_1",
    );

    const first = acquireDesktopTab(tabA);
    const second = acquireDesktopTab(tabB);
    await Promise.all([first.ready, second.ready]);

    expect(createTab).toHaveBeenCalledWith(tabA);
    expect(createTab).toHaveBeenCalledWith(tabB);
    expect(createTab).toHaveBeenCalledTimes(2);

    first.release();
    second.release();
    await vi.advanceTimersByTimeAsync(0);
  });

  it("shares one native guest for a persisted tab across server epochs", async () => {
    vi.useFakeTimers();
    createTab.mockResolvedValue(undefined);
    const threadRef = {
      environmentId: EnvironmentId.make("environment-a"),
      threadId: ThreadId.make("thread-a"),
    };
    const tabId = "tab_9be1ed02-7d29-4b42-b73b-ebbe32462445";
    const beforeRestart = previewRuntimeTabId(threadRef, "epoch-a", tabId);
    const afterRestart = previewRuntimeTabId(threadRef, "epoch-b", tabId);

    const first = acquireDesktopTab(beforeRestart);
    const second = acquireDesktopTab(afterRestart);
    await Promise.all([first.ready, second.ready]);

    expect(afterRestart).toBe(beforeRestart);
    expect(createTab).toHaveBeenCalledOnce();

    first.release();
    second.release();
    await vi.advanceTimersByTimeAsync(0);
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("closes the final desktop tab lease without waiting for recording cleanup", async () => {
    vi.useFakeTimers();
    let resolveStop: (() => void) | undefined;
    stopBrowserRecording.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveStop = () => resolve(null);
      }),
    );
    createTab.mockResolvedValueOnce(undefined);

    const lease = acquireDesktopTab("tab_recording_cleanup");
    await lease.ready;
    lease.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(stopBrowserRecording).toHaveBeenCalledWith("tab_recording_cleanup");
    expect(closeTab).toHaveBeenCalledWith("tab_recording_cleanup");

    resolveStop?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(closeTab).toHaveBeenCalledOnce();
  });

  it("still closes the desktop tab when recording cleanup rejects", async () => {
    vi.useFakeTimers();
    const cleanupError = new Error("recording cleanup failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createTab.mockResolvedValueOnce(undefined);
    stopBrowserRecording.mockRejectedValueOnce(cleanupError);

    const lease = acquireDesktopTab("tab_recording_cleanup_failure");
    await lease.ready;
    lease.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(closeTab).toHaveBeenCalledWith("tab_recording_cleanup_failure");
    expect(consoleError).toHaveBeenCalledWith("[desktop-tab-lifetime] stop-recording failed", {
      tabId: "tab_recording_cleanup_failure",
      cause: cleanupError,
    });
  });

  it("reports a native close failure instead of silently discarding it", async () => {
    vi.useFakeTimers();
    const closeError = new Error("native close failed");
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    createTab.mockResolvedValueOnce(undefined);
    closeTab.mockRejectedValueOnce(closeError);

    const lease = acquireDesktopTab("tab_native_cleanup_failure");
    await lease.ready;
    lease.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(closeTab).toHaveBeenCalledWith("tab_native_cleanup_failure");
    expect(consoleError).toHaveBeenCalledWith("[desktop-tab-lifetime] close-tab failed", {
      tabId: "tab_native_cleanup_failure",
      cause: closeError,
    });
  });

  it("waits for an in-flight close before recreating a reacquired tab", async () => {
    vi.useFakeTimers();
    let resolveClose: (() => void) | undefined;
    createTab.mockResolvedValue(undefined);
    closeTab.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolveClose = resolve;
      }),
    );

    const initial = acquireDesktopTab("tab_close_reacquire");
    await initial.ready;
    initial.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(closeTab).toHaveBeenCalledWith("tab_close_reacquire");

    const reacquired = acquireDesktopTab("tab_close_reacquire");
    expect(createTab).toHaveBeenCalledTimes(1);

    resolveClose?.();
    await reacquired.ready;
    expect(createTab).toHaveBeenCalledTimes(2);
  });

  it("waits for recording cleanup before recreating after native close finishes", async () => {
    vi.useFakeTimers();
    let resolveStop: (() => void) | undefined;
    createTab.mockResolvedValue(undefined);
    closeTab.mockResolvedValueOnce(undefined);
    stopBrowserRecording.mockReturnValueOnce(
      new Promise<null>((resolve) => {
        resolveStop = () => resolve(null);
      }),
    );

    const initial = acquireDesktopTab("tab_recording_reacquire");
    await initial.ready;
    initial.release();
    await vi.advanceTimersByTimeAsync(0);

    expect(closeTab).toHaveBeenCalledWith("tab_recording_reacquire");

    const reacquired = acquireDesktopTab("tab_recording_reacquire");
    await Promise.resolve();
    expect(createTab).toHaveBeenCalledTimes(1);

    resolveStop?.();
    await reacquired.ready;
    expect(createTab).toHaveBeenCalledTimes(2);
  });
});
