// @vitest-environment happy-dom
import { act, StrictMode, useEffect, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

vi.mock("~/hooks/useResizableWidth", () => ({
  useResizableWidth: () => ({ width: 540, handlers: {} }),
}));

import { RightPanelTabs } from "./RightPanelTabs";

interface FakeAnimation {
  keyframes: Keyframe[];
  onfinish: (() => void) | null;
  cancel: ReturnType<typeof vi.fn>;
}

const animations: FakeAnimation[] = [];
const mounted = vi.fn();
const unmounted = vi.fn();
let root: Root;
let container: HTMLDivElement;
let reduceMotion = false;

function Content() {
  useEffect(() => {
    mounted();
    return unmounted;
  }, []);
  return <div data-panel-content />;
}

function props(open: boolean): ComponentProps<typeof RightPanelTabs> {
  const action = vi.fn();
  return {
    mode: "inline",
    open,
    surfaces: [],
    activeSurfaceId: "test-content",
    pendingSurfaceIds: new Set(),
    previewSessions: {},
    floatingPreviewTabIds: undefined,
    terminalLabelsById: new Map(),
    sideChatStatusByThreadId: new Map(),
    onActivate: action,
    onCloseSurface: action,
    onCloseOtherSurfaces: action,
    onCloseSurfacesToRight: action,
    onCloseAllSurfaces: action,
    onRenameSurface: action,
    onReorderSurface: action,
    onCopyFilePath: action,
    onCopySideChatId: action,
    onAddBrowser: action,
    onAddTerminal: action,
    onAddDiff: action,
    onAddFiles: action,
    onAddSideChat: action,
    browserAvailable: false,
    diffAvailable: false,
    filesAvailable: false,
    sideChatAvailable: false,
    children: <Content />,
  };
}

async function render(open: boolean) {
  await act(async () => root.render(<RightPanelTabs {...props(open)} />));
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  vi.spyOn(window, "matchMedia").mockImplementation((query) => ({
    matches: query.includes("prefers-reduced-motion") && reduceMotion,
    media: query,
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent: () => true,
  }));
  Object.defineProperty(Element.prototype, "getAnimations", {
    configurable: true,
    value: () => [],
  });
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value(keyframes: Keyframe[]) {
      const animation: FakeAnimation = { keyframes, onfinish: null, cancel: vi.fn() };
      animations.push(animation);
      return animation;
    },
  });
  animations.length = 0;
  mounted.mockClear();
  unmounted.mockClear();
  reduceMotion = false;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("mounts on opening and releases content only when closing finishes", async () => {
  await render(false);
  expect(mounted).not.toHaveBeenCalled();
  await render(true);
  expect(mounted).toHaveBeenCalledTimes(1);
  const panel = container.querySelector<HTMLElement>("[data-preview-panel-mode]")!;
  // The shell remains the actual flex child, preserving parent-width clamping.
  expect(panel.parentElement).toBe(container);
  await act(async () => animations.at(-1)!.onfinish?.());
  await render(false);
  expect(panel.hasAttribute("inert")).toBe(true);
  expect(unmounted).not.toHaveBeenCalled();
  await act(async () => animations.at(-1)!.onfinish?.());
  expect(unmounted).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-preview-panel-mode]")).toBeNull();
});

it("does not let an interrupted close unmount a reopened panel", async () => {
  await render(true);
  await render(false);
  const closing = animations.at(-1)!;
  await render(true);
  expect(closing.cancel).toHaveBeenCalled();
  await act(async () => closing.onfinish?.());
  expect(unmounted).not.toHaveBeenCalled();
  expect(container.querySelector("[data-panel-content]")).not.toBeNull();
});

it("restarts the entrance from outside the panel after StrictMode effect replay", async () => {
  await act(async () => {
    root.render(
      <StrictMode>
        <RightPanelTabs {...props(true)} />
      </StrictMode>,
    );
  });
  expect(animations).toHaveLength(2);
  expect(animations[0]!.cancel).toHaveBeenCalled();
  expect(animations[1]!.keyframes).toEqual([
    { translate: "100% 0", opacity: "0" },
    { translate: "0% 0", opacity: "1" },
  ]);
});

it("releases closed content immediately with reduced motion", async () => {
  reduceMotion = true;
  await render(true);
  await render(false);
  expect(animations).toHaveLength(0);
  expect(unmounted).toHaveBeenCalledTimes(1);
  expect(container.querySelector("[data-panel-content]")).toBeNull();
});
