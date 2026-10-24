// @vitest-environment happy-dom
import { act } from "react";
import { createRoot } from "react-dom/client";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import ChatMarkdown from "./ChatMarkdown";
import { useRightPanelStore, selectActiveRightPanelSurface } from "../rightPanelStore";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  openExternal: vi.fn(),
  openInPreview: vi.fn(),
}));
vi.mock("@tanstack/react-router", async (original) => ({
  ...(await original<typeof import("@tanstack/react-router")>()),
  useRouter: () => ({ navigate: mocks.navigate }),
}));
vi.mock("../localApi", async (original) => ({
  ...(await original<typeof import("../localApi")>()),
  readLocalApi: () => ({ shell: { openExternal: mocks.openExternal } }),
}));
vi.mock("../browser/openFileInPreview", async (original) => ({
  ...(await original<typeof import("../browser/openFileInPreview")>()),
  openUrlInPreview: mocks.openInPreview,
}));

const environmentId = "c7aa9515-0f3f-4f89-ac5e-5c845c26263d";
const threadId = "26d1fe19-752c-4a81-a866-4f7349a7daca";
const artifactId = "7fd8fde5-bbf7-475a-ab87-9949009abcb5";
const target = { environmentId, threadId } as ScopedThreadRef;
const relative = `/${environmentId}/${threadId}?artifact=${artifactId}`;
const absolute = `https://solomans-macbook-pro.tail0b929e.ts.net${relative}`;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.navigate.mockReset().mockResolvedValue(undefined);
  mocks.openExternal.mockReset().mockResolvedValue(undefined);
  mocks.openInPreview.mockReset();
  useRightPanelStore.getState().removeThread(target);
});
afterEach(() => {
  vi.unstubAllGlobals();
  Reflect.deleteProperty(window, "desktopBridge");
  useRightPanelStore.getState().removeThread(target);
});

it.each([
  { url: absolute },
  { url: relative },
  { url: absolute, desktop: true },
  { url: absolute, anotherThread: true },
  { url: absolute, reopen: true },
  { url: absolute, modified: true },
  { url: absolute, fails: true },
])("opens artifact links inside the existing app: %o", async (options) => {
  if ("desktop" in options)
    Object.defineProperty(window, "desktopBridge", { configurable: true, value: {} });
  if ("fails" in options) mocks.navigate.mockRejectedValue(new Error("Host unavailable"));
  if ("reopen" in options) {
    useRightPanelStore.getState().openArtifact(target, artifactId, 2, "My artifact");
    useRightPanelStore.getState().close(target);
  }
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await act(async () =>
      root.render(
        <ChatMarkdown
          cwd={undefined}
          text={`[View artifact](${options.url})`}
          threadRef={
            "anotherThread" in options
              ? ({ ...target, threadId: "message-thread" } as ScopedThreadRef)
              : target
          }
        />,
      ),
    );
    const link = container.querySelector("a")!;
    expect(link).not.toBeNull();
    expect(link.getAttribute("target")).not.toBe("_blank");
    const event = new MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      metaKey: "modified" in options,
    });
    await act(async () => {
      link.dispatchEvent(event);
    });
    expect(mocks.openExternal).not.toHaveBeenCalled();
    expect(mocks.openInPreview).not.toHaveBeenCalled();
    if ("modified" in options) {
      expect(event.defaultPrevented).toBe(false);
      expect(mocks.navigate).not.toHaveBeenCalled();
    } else {
      expect(event.defaultPrevented).toBe(true);
      expect(mocks.navigate).toHaveBeenCalledExactlyOnceWith({
        to: "/$environmentId/$threadId",
        params: target,
        search: { artifact: artifactId },
      });
    }
    if ("reopen" in options) {
      expect(
        selectActiveRightPanelSurface(useRightPanelStore.getState().byThreadKey, target)?.id,
      ).toBe(`artifact:${artifactId}`);
    }
  } finally {
    await act(async () => root.unmount());
  }
});
