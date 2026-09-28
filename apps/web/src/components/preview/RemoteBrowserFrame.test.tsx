// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { RemoteBrowserFrame } from "./RemoteBrowserFrame";

const mocks = vi.hoisted(() => ({ capture: vi.fn(), input: vi.fn() }));
vi.mock("~/state/preview", () => ({
  previewEnvironment: { remoteSnapshot: "snapshot", remoteInput: "input" },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => (command === "snapshot" ? mocks.capture : mocks.input),
}));
vi.mock("~/hooks/useOnScreenKeyboard", () => ({ useOnScreenKeyboard: () => false }));
vi.mock("./previewPageVisibility", () => ({ usePreviewPageVisible: () => true }));
vi.mock("./RemoteTabAudio", () => ({
  useRemoteTabAudio: () => ({ state: {}, toggle: vi.fn() }),
  RemoteTabAudioButton: () => null,
}));
vi.mock("../remoteView/RemoteViewZoom", () => ({
  useRemoteViewZoom: () => ({ style: {}, pinching: false, reset: vi.fn(), paneRef: () => {} }),
  RemoteViewZoomReadout: () => null,
}));
vi.mock("./RemoteAgentCursor", () => ({ RemoteAgentCursor: () => null }));

const ready = (data = "page-frame", loading = false) => ({
  _tag: "Success",
  value: {
    tabId: "tab-one",
    url: "https://example.com/",
    title: "Example",
    loading,
    capturedAt: "2026-09-28T15:00:00.000Z",
    screenshot: { mimeType: "image/jpeg", data, width: 800, height: 600 },
  },
});

describe("remote browser frame availability", () => {
  let root: Root;
  let container: HTMLDivElement;
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    mocks.capture.mockReset();
    mocks.input.mockReset();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  const render = () =>
    act(async () =>
      root.render(
        <RemoteBrowserFrame
          threadRef={{
            environmentId: EnvironmentId.make("env"),
            threadId: ThreadId.make("thread"),
          }}
          tabId="tab-one"
          visible
          agentControl="none"
        />,
      ),
    );
  const nextFrame = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

  it("freezes the last valid frame during capture failures and resumes automatically", async () => {
    mocks.capture
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce({
        _tag: "Failure",
        cause: Cause.fail(new Error("No page surface")),
      })
      .mockResolvedValue(ready("recovered-page"));
    await render();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("page-frame");
    await nextFrame();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("page-frame");
    expect(container.textContent).not.toContain("Waiting for the browser page");
    expect(container.querySelector('[aria-label="Browser error: show details"]')).not.toBeNull();
    await nextFrame();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("recovered-page");
    expect(container.querySelector('[aria-label="Browser error: show details"]')).toBeNull();
  });

  it("waits before the first valid frame instead of displaying loading pixels", async () => {
    mocks.capture
      .mockResolvedValueOnce(ready("unready-surface", true))
      .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("No page surface")) })
      .mockResolvedValue(ready("first-page"));
    await render();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("Waiting for the browser page");
    await nextFrame();
    expect(container.querySelector("img")).toBeNull();
    await nextFrame();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("first-page");
  });

  it("freezes the last valid frame during navigation even if the host returns pixels", async () => {
    mocks.capture
      .mockResolvedValueOnce(ready())
      .mockResolvedValueOnce(ready("old-surface", true))
      .mockResolvedValue(ready("new-page"));
    await render();
    await nextFrame();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("page-frame");
    expect(container.textContent).not.toContain("Waiting for the browser page");
    expect(container.querySelector('[aria-label="Browser error: show details"]')).toBeNull();
    await nextFrame();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("new-page");
  });
});
