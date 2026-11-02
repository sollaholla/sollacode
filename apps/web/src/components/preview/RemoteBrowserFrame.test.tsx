// @vitest-environment happy-dom

import { TOUCH_PRESS_MARKER_DELAY_MS } from "@t3tools/client-runtime/preview/click-feedback";
import { TOUCH_TAP_GRACE_MS } from "../remoteControl/touchActionMenu";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId, ThreadId, type PreviewRemoteFrameEvent } from "@t3tools/contracts";
import type { RemoteFrameDraw } from "@t3tools/client-runtime/preview/remote-frame-feed";
import * as Cause from "effect/Cause";
import { RemoteBrowserFrame } from "./RemoteBrowserFrame";
import type { createRemotePreviewMedia } from "./remoteMedia/remotePreviewMedia";
import { isPreviewFocused } from "~/lib/previewFocus";

function deferred<A>() {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  input: vi.fn(),
  remoteFrames: vi.fn(),
  unsubscribe: vi.fn(),
  streamSupported: false,
  mediaSupported: false,
  mediaOptions: null as Parameters<typeof createRemotePreviewMedia>[0] | null,
  mediaCreate: vi.fn(),
  mediaTicket: vi.fn(),
  mediaStop: vi.fn(),
  mediaUpdate: vi.fn(),
  listeners: null as {
    onEvents: (events: ReadonlyArray<PreviewRemoteFrameEvent>) => void;
    onFailure: () => void;
  } | null,
}));
vi.mock("~/state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "env",
        {
          environment: {
            capabilities: {
              remotePreviewFrames: mocks.streamSupported,
              remotePreviewMediaChannel: mocks.mediaSupported,
            },
          },
        },
      ],
    ]),
}));
vi.mock("~/state/session", () => ({
  readPreparedConnection: () => ({ socketUrl: "ws://preview.test/ws" }),
}));
vi.mock("./remoteMedia/remotePreviewMedia", () => ({
  createRemotePreviewMedia: (options: Parameters<typeof createRemotePreviewMedia>[0]) => {
    mocks.mediaCreate();
    mocks.mediaOptions = options;
    return { stop: mocks.mediaStop, updateViewport: mocks.mediaUpdate };
  },
  listenToPreviewMedia: vi.fn(),
}));
vi.mock("./remoteFrames/remoteFrameCanvas", () => ({
  listenToRemoteFrames: (
    _registry: unknown,
    _atom: unknown,
    handlers: NonNullable<typeof mocks.listeners>,
  ) => {
    mocks.listeners = handlers;
    return mocks.unsubscribe;
  },
  // Stub image decoding so fallback and subscription lifecycle can be
  // exercised deterministically without launching a browser.
  createRemoteFramePainter: (options: {
    onPicture: (size: { width: number; height: number }) => void;
  }) => ({
    attach: () => {},
    reset: () => {},
    paint: (draws: ReadonlyArray<RemoteFrameDraw>) => {
      const newest = draws.at(-1);
      if (newest) options.onPicture({ width: newest.event.width, height: newest.event.height });
    },
  }),
}));
vi.mock("~/state/preview", () => ({
  previewEnvironment: {
    remoteSnapshot: "snapshot",
    remoteInput: "input",
    remoteFrames: mocks.remoteFrames,
    mediaTicket: "media-ticket",
  },
}));
vi.mock("~/state/use-atom-command", () => ({
  useAtomCommand: (command: string) => {
    if (command === "media-ticket") {
      // The real hook returns a new command closure on every render.
      const current = mocks.mediaTicket;
      return (...args: unknown[]) => current(...args);
    }
    return command === "snapshot" ? mocks.capture : mocks.input;
  },
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
    view: { zoom: 1 },
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
    mocks.capture.mockReset().mockResolvedValue(ready());
    mocks.input.mockReset();
    mocks.remoteFrames.mockReset();
    mocks.unsubscribe.mockReset();
    mocks.listeners = null;
    mocks.streamSupported = false;
    mocks.mediaSupported = false;
    mocks.mediaOptions = null;
    mocks.mediaCreate.mockReset();
    mocks.mediaTicket = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: { ticket: "first-ticket", expiresInMs: 30_000 },
    });
    mocks.mediaStop.mockReset();
    mocks.mediaUpdate.mockReset();
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue(
      new DOMRect(0, 0, 800, 600),
    );
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe() {}
        disconnect() {}
      },
    );
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
  const render = (visible = true, tabId = "tab-one") =>
    act(async () =>
      root.render(
        <RemoteBrowserFrame
          threadRef={{
            environmentId: EnvironmentId.make("env"),
            threadId: ThreadId.make("thread"),
          }}
          tabId={tabId}
          visible={visible}
          agentControl="none"
        />,
      ),
    );
  const nextFrame = () =>
    act(async () => {
      await vi.advanceTimersByTimeAsync(2_500);
    });

  it("keeps typing on the focused remote preview surface instead of the composer", async () => {
    mocks.mediaSupported = true;
    mocks.input.mockResolvedValue({ _tag: "Success", value: { deliveredAt: "now" } });
    container.dataset.previewPanelMode = "browser";
    await render();
    await act(async () => mocks.mediaOptions?.onPicture({ width: 1_600, height: 900 }));
    const surface = container.querySelector('[role="application"]') as HTMLDivElement;
    const composer = document.createElement("textarea");
    container.append(composer);
    // ChatView's capture listener exempts this browser-surface contract before
    // its type-to-focus behavior can move focus into the composer.
    const redirect = (event: KeyboardEvent) => {
      if (
        event.target instanceof Element &&
        event.target.closest("webview,[data-preview-viewport]")
      )
        return;
      composer.focus();
    };
    document.addEventListener("keydown", redirect, true);
    try {
      surface.focus();
      expect(isPreviewFocused()).toBe(true);
      await act(async () => {
        surface.dispatchEvent(
          new KeyboardEvent("keydown", { key: "X", bubbles: true, cancelable: true }),
        );
      });
      expect(document.activeElement).toBe(surface);
      expect(mocks.input).toHaveBeenCalledWith(
        expect.objectContaining({
          input: expect.objectContaining({ action: { kind: "press", key: "X" } }),
        }),
      );
      expect(composer.value).toBe("");
    } finally {
      document.removeEventListener("keydown", redirect, true);
      composer.remove();
    }
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

  describe("a touch that may be the start of a pinch", () => {
    const clicks = () =>
      mocks.input.mock.calls.map(
        ([request]) => (request as { input: { action: { position: { x: number } } } }).input.action,
      );
    const surfaceOf = () => {
      const surface = container.querySelector('[role="application"]') as HTMLDivElement;
      surface.setPointerCapture = vi.fn();
      surface.hasPointerCapture = () => false;
      return surface;
    };
    const touch = (surface: HTMLDivElement, type: string, x: number, pointerId = 1) =>
      act(async () => {
        surface.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId,
            pointerType: "touch",
            button: 0,
            clientX: x,
            clientY: 300,
          }),
        );
      });
    const prepare = async () => {
      mocks.input.mockResolvedValue({ _tag: "Success", value: { deliveredAt: "now" } });
      vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(800);
      vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(600);
      await render();
      return surfaceOf();
    };

    it("shows no dot at the first contact, then one if the finger stays", async () => {
      const surface = await prepare();
      await touch(surface, "pointerdown", 200);
      expect(container.querySelector("[data-remote-click]")).toBeNull();
      await act(async () => vi.advanceTimersByTime(TOUCH_PRESS_MARKER_DELAY_MS - 1));
      expect(container.querySelector("[data-remote-click]")).toBeNull();
      await act(async () => vi.advanceTimersByTime(1));
      expect(container.querySelector('[data-remote-click="pressed"]')).not.toBeNull();
    });

    it("clicks a real tap once the grace passes", async () => {
      const surface = await prepare();
      await touch(surface, "pointerdown", 200);
      await touch(surface, "pointerup", 200);
      await act(async () => vi.advanceTimersByTime(TOUCH_TAP_GRACE_MS - 1));
      expect(mocks.input).not.toHaveBeenCalled();
      await act(async () => vi.advanceTimersByTime(1));
      expect(clicks()).toMatchObject([{ kind: "click", position: { x: 0.25 } }]);
    });

    it("never clicks the first spot when a very short first touch is followed by the other finger", async () => {
      const surface = await prepare();
      await touch(surface, "pointerdown", 200);
      await touch(surface, "pointerup", 200);
      await touch(surface, "pointerdown", 600, 2);
      await act(async () => vi.advanceTimersByTime(TOUCH_TAP_GRACE_MS * 2));
      expect(mocks.input).not.toHaveBeenCalled();
    });
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
  const pushPicture = () =>
    act(async () => {
      mocks.listeners?.onEvents([
        {
          type: "state",
          state: { url: "https://example.com/", title: "Streamed", loading: false },
        },
        {
          type: "keyframe",
          sequence: 1,
          width: 800,
          height: 600,
          mimeType: "image/jpeg",
          data: "stream-frame",
        },
      ]);
    });

  it("uses the advertised stream without a duplicate startup snapshot", async () => {
    mocks.streamSupported = true;
    await render();
    expect(mocks.remoteFrames).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          tabId: "tab-one",
          patches: true,
          maxWidth: 896,
          maxHeight: 640,
        }),
      }),
    );
    expect(mocks.capture).not.toHaveBeenCalled();
    await pushPicture();
    expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("visible");
    expect(container.querySelector("img")).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(mocks.capture).not.toHaveBeenCalled();
    await render(false);
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
  });

  it("falls back to snapshots when an advertised stream never supplies its first picture", async () => {
    mocks.streamSupported = true;
    mocks.capture.mockResolvedValue(ready("old-host-fallback"));
    await render();
    expect(mocks.capture).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_050);
    });
    expect(container.querySelector("img")?.getAttribute("src")).toContain("old-host-fallback");
    expect(mocks.capture).toHaveBeenCalledOnce();
  });

  it.each(["unavailable", "failure"] as const)(
    "replaces a pushed picture with polling after %s",
    async (kind) => {
      mocks.streamSupported = true;
      mocks.capture.mockResolvedValue(ready("fallback-after-stream"));
      await render();
      await pushPicture();
      await act(async () => {
        if (kind === "unavailable")
          mocks.listeners?.onEvents([{ type: "unavailable", reason: "Host disconnected" }]);
        else mocks.listeners?.onFailure();
      });
      expect(container.querySelector("img")?.getAttribute("src")).toContain(
        "fallback-after-stream",
      );
      expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("hidden");
      await pushPicture();
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("visible");
    },
  );
  it.each(["unavailable", "failure"] as const)(
    "holds the last pushed picture through %s and failed or loading fallback captures",
    async (kind) => {
      mocks.streamSupported = true;
      mocks.capture
        .mockResolvedValueOnce({ _tag: "Failure", cause: Cause.fail(new Error("No page surface")) })
        .mockResolvedValueOnce(ready("loading-page", true))
        .mockResolvedValue(ready("valid-fallback"));
      await render();
      await pushPicture();
      await act(async () => {
        if (kind === "unavailable")
          mocks.listeners?.onEvents([{ type: "unavailable", reason: "Host disconnected" }]);
        else mocks.listeners?.onFailure();
      });
      expect(mocks.capture).toHaveBeenCalledOnce();
      expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("visible");
      expect(container.querySelector("img")).toBeNull();
      expect(container.textContent).not.toContain("Waiting for the browser page");
      await nextFrame();
      expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("visible");
      expect(container.querySelector("img")).toBeNull();
      await nextFrame();
      expect(container.querySelector("img")?.getAttribute("src")).toContain("valid-fallback");
      expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("hidden");
      await pushPicture();
      expect(container.querySelector("img")).toBeNull();
      expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("visible");
    },
  );
  it("clears a retained streamed picture when the viewer changes tabs", async () => {
    mocks.streamSupported = true;
    await render();
    await pushPicture();
    await render(true, "tab-two");
    expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("hidden");
    expect(container.textContent).toContain("Waiting for the browser page");
  });
  it("keeps a recovered stream when an older fallback capture finishes in the same turn", async () => {
    mocks.streamSupported = true;
    const fallback = deferred<ReturnType<typeof ready>>();
    mocks.capture.mockReturnValue(fallback.promise);
    await render();
    await pushPicture();
    await act(async () => {
      mocks.listeners?.onEvents([{ type: "unavailable", reason: "Host disconnected" }]);
    });
    expect(mocks.capture).toHaveBeenCalledOnce();
    await act(async () => {
      mocks.listeners?.onEvents([
        {
          type: "keyframe",
          sequence: 2,
          width: 800,
          height: 600,
          mimeType: "image/jpeg",
          data: "recovered-stream",
        },
      ]);
      fallback.resolve(ready("older-fallback"));
    });
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("canvas")?.parentElement?.style.visibility).toBe("visible");
  });
  it("uses snapshot polling if the client cannot measure the streaming pane", async () => {
    mocks.streamSupported = true;
    vi.stubGlobal("ResizeObserver", undefined);
    mocks.capture.mockResolvedValue(ready("legacy-sizing-fallback"));
    await render();
    expect(mocks.remoteFrames).not.toHaveBeenCalled();
    expect(container.querySelector("canvas")).toBeNull();
    expect(container.querySelector("img")?.getAttribute("src")).toContain("legacy-sizing-fallback");
    expect(mocks.capture).toHaveBeenCalledOnce();
    await nextFrame();
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it("keeps one decoder across renders and refreshes tickets with the current command", async () => {
    mocks.mediaSupported = true;
    mocks.streamSupported = true;
    await render();
    const viewer = mocks.mediaOptions!;
    expect(mocks.mediaCreate).toHaveBeenCalledOnce();
    await act(async () => {
      viewer.onPicture({ width: 1_800, height: 2_000 });
      viewer.onState({ url: "https://example.com", title: "Video", loading: false });
    });
    mocks.mediaTicket = vi.fn().mockResolvedValue({
      _tag: "Success",
      value: { ticket: "fresh-ticket", expiresInMs: 30_000 },
    });
    await render();
    expect(mocks.mediaCreate).toHaveBeenCalledOnce();
    expect(mocks.mediaStop).not.toHaveBeenCalled();
    await expect(viewer.resolveUrl("current-watch")).resolves.toContain("ticket=fresh-ticket");
    expect(mocks.mediaTicket).toHaveBeenCalledWith({
      environmentId: "env",
      input: { watchId: "current-watch" },
    });
    await render(false);
    expect(mocks.mediaStop).toHaveBeenCalledOnce();
    await render();
    expect(mocks.mediaCreate).toHaveBeenCalledTimes(2);
  });

  it("keeps the image until video paints, then stops JPEG bandwidth and ignores late images", async () => {
    mocks.mediaSupported = true;
    mocks.streamSupported = true;
    await render();
    await pushPicture();
    const surface = container.querySelector('[role="application"]')!;
    expect(surface.getAttribute("data-remote-preview-feed")).toBe("frames");
    expect(mocks.unsubscribe).not.toHaveBeenCalled();
    await act(async () => {
      mocks.mediaOptions?.onPicture({ width: 1_600, height: 900 });
      mocks.mediaOptions?.onState({ url: "https://example.com", title: "Video", loading: false });
    });
    expect(surface.getAttribute("data-remote-preview-feed")).toBe("video");
    expect(mocks.unsubscribe).toHaveBeenCalledOnce();
    await pushPicture();
    expect(surface.getAttribute("aria-label")).toContain("Video");
    expect(surface.getAttribute("data-remote-preview-feed")).toBe("video");
    await nextFrame();
    expect(mocks.capture).not.toHaveBeenCalled();
    await render(false);
    expect(mocks.mediaStop).toHaveBeenCalledOnce();
  });

  it("retains video through fallback until the JPEG stream supplies a replacement", async () => {
    mocks.mediaSupported = true;
    mocks.streamSupported = true;
    await render();
    await act(async () => mocks.mediaOptions?.onPicture({ width: 1_600, height: 900 }));
    await act(async () => mocks.mediaOptions?.onFallback("Host left"));
    const surface = container.querySelector('[role="application"]')!;
    expect(surface.getAttribute("data-remote-preview-feed")).toBe("video");
    expect(mocks.remoteFrames).toHaveBeenCalledTimes(2);
    await pushPicture();
    expect(surface.getAttribute("data-remote-preview-feed")).toBe("frames");
  });

  it("does not let an older snapshot replace newly decoded video", async () => {
    mocks.mediaSupported = true;
    const snapshot = deferred<ReturnType<typeof ready>>();
    mocks.capture.mockReturnValue(snapshot.promise);
    await render();
    await act(async () => {
      mocks.mediaOptions?.onPicture({ width: 1_600, height: 900 });
      snapshot.resolve(ready("older-image"));
    });
    expect(
      container.querySelector('[role="application"]')?.getAttribute("data-remote-preview-feed"),
    ).toBe("video");
    expect(container.querySelector("img")).toBeNull();
  });

  it("maps video input using the source aspect ratio and clears it on tab change", async () => {
    mocks.mediaSupported = true;
    mocks.input.mockResolvedValue({ _tag: "Success", value: { deliveredAt: "now" } });
    await render();
    await act(async () => mocks.mediaOptions?.onPicture({ width: 1_600, height: 900 }));
    const surface = container.querySelector('[role="application"]') as HTMLDivElement;
    surface.setPointerCapture = vi.fn();
    surface.hasPointerCapture = () => false;
    for (const type of ["pointerdown", "pointerup"]) {
      await act(async () => {
        surface.dispatchEvent(
          new PointerEvent(type, {
            bubbles: true,
            pointerId: 1,
            pointerType: "mouse",
            button: 0,
            clientX: 200,
            clientY: 187.5,
          }),
        );
      });
    }
    expect(mocks.input).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          action: { kind: "click", position: { x: 0.25, y: 0.25 } },
        }),
      }),
    );
    await render(true, "tab-two");
    expect(mocks.mediaStop).toHaveBeenCalledOnce();
    expect(surface.getAttribute("data-remote-preview-feed")).toBe("snapshot");
  });
});
