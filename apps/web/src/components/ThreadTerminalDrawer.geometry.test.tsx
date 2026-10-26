// @vitest-environment happy-dom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import { TerminalViewport } from "./ThreadTerminalDrawer";
import { requestTerminalGeometryActivation } from "../terminalGeometryActivation";
import { terminalClientId } from "../terminalClientIdentity";

const mocks = vi.hoisted(() => ({
  resize: vi.fn(),
  owner: "other-device",
  cols: 120,
  rows: 40,
  fit: { cols: 52, rows: 20 },
  viewport: { width: 416, height: 320 },
  focus: true,
}));
vi.mock("../state/environments", () => ({ useEnvironment: () => null }));
vi.mock("../hooks/useArtifactLinkOpener", () => ({
  useArtifactLinkOpener: () => ({ openArtifactLink: vi.fn() }),
}));
vi.mock("../editorPreferences", () => ({ useOpenInPreferredEditor: () => vi.fn() }));
vi.mock("@effect/atom-react", async (original) => ({
  ...(await original<typeof import("@effect/atom-react")>()),
  useAtomValue: () => null,
}));
vi.mock("../state/server", () => ({
  serverEnvironment: { configValueAtom: () => null },
}));
vi.mock("../state/terminal", () => ({
  terminalEnvironment: { open: "open", resize: "resize", write: "write" },
}));
vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: (command: string) =>
    command === "resize" ? mocks.resize : vi.fn(async () => ({ _tag: "Success" })),
}));
vi.mock("../state/terminalSessions", () => ({
  useAttachedTerminalSession: () => ({
    buffer: "ready",
    status: "running",
    version: 1,
    error: null,
    isPending: false,
    hasRunningSubprocess: true,
    replayComplete: true,
    replayGeometry: { cols: mocks.cols, rows: mocks.rows },
    summary: { cols: mocks.cols, rows: mocks.rows, geometryOwner: mocks.owner, label: "Kimi" },
    refresh: vi.fn(),
  }),
  useKnownTerminalSessions: () => [],
}));
vi.mock("../localApi", () => ({ readLocalApi: () => null }));
vi.mock("./terminal/cursorStability", () => ({
  installConptyCursorStability: () => ({ reset: vi.fn(), dispose: vi.fn() }),
}));
vi.mock("./terminal/TerminalMobileKeyBar", () => ({ TerminalMobileKeyBar: () => null }));
vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: class {
    onContextLoss() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({
  FitAddon: class {
    fit() {}
    proposeDimensions() {
      return mocks.fit;
    }
  },
}));
vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    textarea = document.createElement("textarea");
    buffer = { active: { viewportY: 0, baseY: 0 } };
    screen = document.createElement("div");
    open(mount: HTMLElement) {
      this.screen.className = "xterm-screen";
      Object.defineProperties(this.screen, {
        clientWidth: { get: () => this.cols * 8 },
        clientHeight: { get: () => this.rows * 16 },
      });
      mount.append(this.screen, this.textarea);
    }
    resize(cols: number, rows: number) {
      this.cols = cols;
      this.rows = rows;
    }
    loadAddon() {}
    attachCustomKeyEventHandler() {}
    registerLinkProvider() {
      return { dispose() {} };
    }
    onKey() {
      return { dispose() {} };
    }
    onData() {
      return { dispose() {} };
    }
    onSelectionChange() {
      return { dispose() {} };
    }
    hasSelection() {
      return false;
    }
    clearSelection() {}
    write(_data: string, complete?: () => void) {
      complete?.();
    }
    reset() {}
    refresh() {}
    scrollToBottom() {}
    focus() {}
    dispose() {}
  },
}));

const threadRef = scopeThreadRef(EnvironmentId.make("host"), ThreadId.make("thread"));
let root: Root;
let container: HTMLDivElement;
let frames: Map<number, FrameRequestCallback>;
let nextFrame: number;

async function render(
  options: { visible?: boolean; focusRequestId?: number; locallyOpening?: boolean } = {},
) {
  await act(async () => {
    root.render(
      <TerminalViewport
        threadRef={threadRef}
        threadId={threadRef.threadId}
        terminalId="term-1"
        terminalLabel="Kimi"
        cwd="/workspace"
        onSessionExited={() => undefined}
        onAddTerminalContext={() => undefined}
        focusRequestId={options.focusRequestId ?? 0}
        autoFocus
        surfaceVisible={options.visible ?? true}
        locallyOpening={options.locallyOpening ?? false}
        resizeEpoch={0}
        drawerHeight={320}
        keybindings={[]}
      />,
    );
  });
}

async function settle() {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      const current = [...frames.values()];
      frames.clear();
      current.forEach((frame) => frame(performance.now()));
      await vi.advanceTimersByTimeAsync(150);
    });
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  frames = new Map();
  nextFrame = 0;
  vi.stubGlobal("requestAnimationFrame", (frame: FrameRequestCallback) => {
    frames.set(++nextFrame, frame);
    return nextFrame;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal(
    "ResizeObserver",
    class {
      observe() {}
      disconnect() {}
    },
  );
  mocks.resize.mockReset().mockResolvedValue({ _tag: "Success" });
  mocks.owner = "other-device";
  mocks.cols = 120;
  mocks.rows = 40;
  mocks.fit = { cols: 52, rows: 20 };
  mocks.focus = true;
  vi.spyOn(document, "hasFocus").mockImplementation(() => mocks.focus);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({
    ...mocks.viewport,
    top: 0,
    left: 0,
    right: 416,
    bottom: 320,
    x: 0,
    y: 0,
    toJSON() {},
  }));
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it("fits a deliberately opened terminal on its first visible mount, without a second tab switch", async () => {
  requestTerminalGeometryActivation(threadRef, "term-1");
  await render();
  await settle();
  expect(mocks.resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: expect.objectContaining({
      terminalId: "term-1",
      cols: 52,
      rows: 20,
      claimGeometry: true,
    }),
  });
});

it("takes the local size on a tap inside an unchanged passive terminal", async () => {
  await render();
  await settle();
  expect(mocks.resize).not.toHaveBeenCalled();
  await act(async () => {
    const mount = container.querySelector(".xterm-screen")!.parentElement!;
    mount.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, buttons: 0 }));
  });
  await settle();
  expect(mocks.resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: expect.objectContaining({ cols: 52, rows: 20, claimGeometry: true }),
  });
});

it("keeps passive mounting and focus refreshes on the remote owner's grid", async () => {
  await render();
  await settle();
  await render({ focusRequestId: 1 });
  window.dispatchEvent(new Event("focus"));
  await settle();
  expect(mocks.resize).not.toHaveBeenCalled();
});

it("fits a locally created pane even when its opening tap preceded the lazy mount", async () => {
  await render({ locallyOpening: true });
  await settle();
  expect(mocks.resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: expect.objectContaining({ cols: 52, rows: 20, claimGeometry: true }),
  });
});

it("waits until a requested pane is visible and consumes activation only once", async () => {
  requestTerminalGeometryActivation(threadRef, "term-1");
  await render({ visible: false });
  await settle();
  expect(mocks.resize).not.toHaveBeenCalled();
  await render({ visible: true });
  await settle();
  expect(mocks.resize).toHaveBeenCalledOnce();
  // Another device takes ownership later. Ordinary metadata updates and
  // restoring this pane must not replay its earlier activation request.
  mocks.owner = "third-device";
  mocks.cols = 100;
  await render({ visible: false });
  await settle();
  await render({ visible: true, focusRequestId: 2 });
  await settle();
  expect(mocks.resize).toHaveBeenCalledOnce();
});

it("does not resize again on keyboard input after the local claim is acknowledged", async () => {
  requestTerminalGeometryActivation(threadRef, "term-1");
  await render();
  await settle();
  mocks.owner = terminalClientId();
  mocks.cols = mocks.fit.cols;
  mocks.rows = mocks.fit.rows;
  await render();
  await settle();
  await act(async () => {
    container
      .querySelector("textarea")!
      .dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "a" }));
  });
  await settle();
  expect(mocks.resize).toHaveBeenCalledOnce();
});

it("transfers same-sized ownership without requiring a fake column resize", async () => {
  mocks.cols = mocks.fit.cols;
  mocks.rows = mocks.fit.rows;
  requestTerminalGeometryActivation(threadRef, "term-1");
  await render();
  await settle();
  expect(mocks.resize).toHaveBeenCalledExactlyOnceWith({
    environmentId: threadRef.environmentId,
    input: expect.objectContaining({ cols: 52, rows: 20, claimGeometry: true }),
  });
});
