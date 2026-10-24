// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import ChatMarkdown from "./ChatMarkdown";

const mocks = vi.hoisted(() => ({ openExternal: vi.fn(), openInPreview: vi.fn() }));
vi.mock("../localApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../localApi")>()),
  readLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("../browser/openFileInPreview", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../browser/openFileInPreview")>()),
  openUrlInPreview: mocks.openInPreview,
}));
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.openExternal.mockReset().mockResolvedValue(undefined);
  mocks.openInPreview.mockReset().mockResolvedValue(AsyncResult.success(undefined));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(window, "desktopBridge");
});

it.each([
  { url: "http://192.168.1.20:3000/path?x=1#part", preview: true },
  { url: "http://localhost:5173/", preview: true },
  { url: "https://example.com/", preview: false },
  { url: "http://192.168.1.20:3000/", preview: false, desktop: true },
  { url: "http://localhost:3000/", preview: true, fails: true },
])("routes a remote markdown click on $url", async ({ url, preview, ...options }) => {
  if ("desktop" in options)
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  if ("fails" in options) {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mocks.openInPreview.mockResolvedValue(
      AsyncResult.failure(Cause.fail(new Error("host offline"))),
    );
  }
  const threadRef = { environmentId: "host-1", threadId: "thread-1" } as ScopedThreadRef;
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChatMarkdown text={`[Open page](${url})`} threadRef={threadRef} cwd={undefined} />,
      ),
    );
    const link = container.querySelector("a");
    expect(link).not.toBeNull();
    await act(async () => {
      link!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    if (preview) {
      expect(mocks.openInPreview).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ threadRef, url }),
      );
      expect(mocks.openExternal).not.toHaveBeenCalled();
    } else {
      expect(mocks.openExternal).toHaveBeenCalledExactlyOnceWith(url);
      expect(mocks.openInPreview).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
