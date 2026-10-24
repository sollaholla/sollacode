// @vitest-environment happy-dom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { RemoteBrowserFrame } from "./RemoteBrowserFrame";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

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
  useRemoteTabAudio: () => ({ state: {}, toggle: vi.fn(), unlockFromGesture: vi.fn() }),
  RemoteTabAudioButton: () => null,
}));
vi.mock("../remoteView/RemoteViewZoom", () => ({
  useRemoteViewZoom: () => ({
    style: {},
    pinching: false,
    pinchingRef: { current: false },
    reset: vi.fn(),
    paneRef: () => {},
    onPointerDown: () => false,
    onPointerMove: () => false,
    onPointerUp: () => false,
  }),
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
    vi.restoreAllMocks();
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

  it("shows the tap immediately and removes only its dot when input is acknowledged, before recapture", async () => {
    const input = deferred<{ _tag: "Success"; value: { deliveredAt: string } }>();
    const recapture = deferred<ReturnType<typeof ready>>();
    mocks.capture.mockResolvedValueOnce(ready()).mockReturnValue(recapture.promise);
    mocks.input.mockReturnValue(input.promise);
    vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
    vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
    await render();
    const surface = container.querySelector('[role="application"]') as HTMLDivElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = () => false;
    const pointer = (type: string, x = 200) =>
      act(async () => {
        surface.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            button: 0,
            clientX: x,
            clientY: 300,
          }),
        );
      });
    await pointer("pointerdown");
    expect(container.querySelector('[data-remote-click="pressed"]')).not.toBeNull();
    expect(mocks.input).not.toHaveBeenCalled();
    await pointer("pointerup");
    const dot = container.querySelector('[data-remote-click="pending"]') as HTMLElement;
    expect(dot.style.left).toBe("200px");
    expect(dot.style.top).toBe("300px");
    expect(mocks.input).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          action: { kind: "click", position: { x: 0.25, y: 0.5 } },
        }),
      }),
    );
    await act(async () => input.resolve({ _tag: "Success", value: { deliveredAt: "now" } }));
    expect(container.querySelector("[data-remote-click]")).toBeNull();
    // The next image is still unresolved: input receipt, not a frame timer, retired the dot.
    expect(container.querySelector("img")?.getAttribute("src")).toContain("page-frame");
    await act(async () => recapture.resolve(ready("after-click")));
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
