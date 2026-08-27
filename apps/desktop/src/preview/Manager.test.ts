import { it as effectIt } from "@effect/vitest";
import type { DesktopPreviewRecordingFrame } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import { TestClock } from "effect/testing";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as BrowserSession from "./BrowserSession.ts";
import * as PreviewManager from "./Manager.ts";

describe("fitPictureInPictureContentSize", () => {
  it("preserves the PiP content area across aspect-ratio changes", () => {
    expect(PreviewManager.fitPictureInPictureContentSize([480, 320], 16 / 9)).toEqual([523, 294]);
    expect(PreviewManager.fitPictureInPictureContentSize([480, 320], 9 / 16)).toEqual([294, 523]);
  });

  it("does not collapse toward the minimum size when orientation changes repeatedly", () => {
    const portrait = PreviewManager.fitPictureInPictureContentSize([523, 294], 9 / 16);
    const landscape = PreviewManager.fitPictureInPictureContentSize(portrait, 16 / 9);

    expect(portrait).toEqual([294, 523]);
    expect(landscape).toEqual([523, 294]);
  });
});

const {
  browserWindowConstructor,
  createFromPath,
  fromId,
  getFocusedWebContents,
  mkdir,
  showItemInFolder,
  webviewSend,
  writeFile,
  writeImage,
} = vi.hoisted(() => ({
  browserWindowConstructor: vi.fn(),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  fromId: vi.fn((_id?: number) => null),
  getFocusedWebContents: vi.fn(() => null),
  mkdir: vi.fn((_path: string) => undefined),
  showItemInFolder: vi.fn(),
  webviewSend: vi.fn(),
  writeFile: vi.fn((_path: string, _data: Uint8Array) => undefined),
  writeImage: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: browserWindowConstructor,
  clipboard: {
    writeImage,
  },
  nativeImage: {
    createFromPath,
  },
  shell: {
    showItemInFolder,
  },
  session: {
    fromPartition: vi.fn(),
  },
  webContents: {
    fromId,
    getFocusedWebContents,
  },
}));

const browserSessionLayer = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    setDownloadDirectory: () => Effect.void,
    recentDownloads: () => [],
    onDownload: () => undefined,
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    getSession: () => Effect.die("unexpected getSession"),
    clearCookies: () => Effect.void,
    clearCache: () => Effect.void,
  }),
);

const environmentLayer = Layer.succeed(
  DesktopEnvironment.DesktopEnvironment,
  DesktopEnvironment.DesktopEnvironment.of({
    browserArtifactsDir: "/tmp/t3/dev/browser-artifacts",
    dirname: "/tmp/t3/desktop",
    path: {
      join: (...parts: ReadonlyArray<string>) => parts.join("/"),
    },
  } as DesktopEnvironment.DesktopEnvironment["Service"]),
);

const fileSystemLayer = FileSystem.layerNoop({
  makeDirectory: (path) =>
    Effect.sync(() => {
      mkdir(path);
    }),
  writeFile: (path, data) =>
    Effect.sync(() => {
      writeFile(path, data);
    }),
  stat: () => Effect.succeed({ type: "File", size: 1n } as never),
});

const layer = PreviewManager.layer.pipe(
  Layer.provideMerge(browserSessionLayer),
  Layer.provideMerge(environmentLayer),
  Layer.provideMerge(fileSystemLayer),
  Layer.provideMerge(Path.layer),
  Layer.provideMerge(Layer.succeed(HostProcessPlatform, "darwin")),
);
const encodePreviewManagerError = Schema.encodeSync(PreviewManager.PreviewManagerError);

const withManager = <A>(
  use: (
    manager: PreviewManager.PreviewManager["Service"],
  ) => Effect.Effect<A, PreviewManager.PreviewManagerError, Scope.Scope>,
) =>
  Effect.gen(function* () {
    const manager = yield* PreviewManager.PreviewManager;
    return yield* use(manager);
  }).pipe(Effect.provide(layer), Effect.scoped);

interface TestCapturedPreviewImage {
  readonly toJPEG: () => Buffer;
  readonly getSize: () => { readonly width: number; readonly height: number };
}

const makeTestPreviewWebContents = (
  capturePage: () => Promise<TestCapturedPreviewImage>,
  id = 42,
) =>
  ({
    id,
    isDestroyed: () => false,
    getType: () => "webview",
    getURL: () => "https://example.com",
    getTitle: () => "Example",
    isLoading: () => false,
    getZoomFactor: () => 1,
    setZoomFactor: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    ipc: { on: vi.fn(), off: vi.fn() },
    send: webviewSend,
    navigationHistory: { canGoBack: () => false, canGoForward: () => false },
    setWindowOpenHandler: vi.fn(),
    debugger: {
      isAttached: () => false,
      attach: vi.fn(),
      sendCommand: vi.fn(async () => undefined),
      on: vi.fn(),
      off: vi.fn(),
    },
    capturePage,
  }) as never;

const makeTestPictureInPictureWindow = (loadURL: () => Promise<void> = async () => undefined) => {
  const listeners = new Map<string, () => void>();
  const send = vi.fn();
  let destroyed = false;
  const pictureInPictureWindow = {
    isDestroyed: vi.fn(() => destroyed),
    once: vi.fn((event: string, listener: () => void) => {
      listeners.set(event, listener);
    }),
    setAlwaysOnTop: vi.fn(),
    setVisibleOnAllWorkspaces: vi.fn(),
    setAspectRatio: vi.fn(),
    getContentSize: vi.fn(() => [480, 320]),
    setContentSize: vi.fn(),
    loadURL: vi.fn(loadURL),
    showInactive: vi.fn(() => {
      if (destroyed) throw new Error("Picture-in-picture window is closed.");
    }),
    close: vi.fn(() => {
      if (destroyed) return;
      destroyed = true;
      listeners.get("closed")?.();
    }),
    webContents: {
      send,
    },
  };
  return { pictureInPictureWindow, send };
};

describe("PreviewManager", () => {
  beforeEach(() => {
    browserWindowConstructor.mockReset();
    fromId.mockClear();
    getFocusedWebContents.mockReset();
    getFocusedWebContents.mockReturnValue(null);
    mkdir.mockClear();
    writeFile.mockClear();
    showItemInFolder.mockClear();
    writeImage.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
  });

  effectIt.effect("reports an unregistered webview as temporarily unavailable", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });

        yield* manager.createTab("tab_1");

        expect(yield* manager.automationStatus("tab_1")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_1",
          url: null,
          title: null,
          loading: false,
        });
        expect(fromId).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("isolates failed state listeners and continues delivery", () => {
    const loggedErrors: Array<unknown> = [];
    const logger = Logger.make(({ message }) => {
      for (const value of Array.isArray(message) ? message : [message]) {
        if (typeof value === "object" && value !== null && "cause" in value) {
          loggedErrors.push(Cause.squash(value.cause as Cause.Cause<never>));
        }
      }
    });
    const deliveryError = new ElectronWindow.ElectronWindowOperationError({
      operation: "send-window-message",
      platform: "darwin",
      windowId: 42,
      channel: "preview:state-change",
      cause: new Error("renderer unavailable"),
    });
    const delivered = vi.fn();

    return withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.subscribeStateChanges(() => Effect.die(deliveryError));
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.sync(() => {
            delivered(tabId, state);
          }),
        );

        const state = yield* manager.createTab("tab_listener_failure");

        expect(delivered).toHaveBeenCalledOnce();
        expect(delivered).toHaveBeenCalledWith("tab_listener_failure", state);
        expect(loggedErrors).toHaveLength(1);
        expect(loggedErrors[0]).toBeInstanceOf(ElectronWindow.ElectronWindowOperationError);
        expect(loggedErrors[0]).toMatchObject({
          operation: "send-window-message",
          windowId: 42,
          channel: "preview:state-change",
        });
      }),
    ).pipe(
      Effect.provide(
        Logger.layer([logger], {
          mergeWithExisting: false,
        }),
      ),
    );
  });

  effectIt.effect("does not swallow state listener interruption", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const exit = yield* Effect.scoped(
          Effect.gen(function* () {
            yield* manager.subscribeStateChanges(() => Effect.interrupt);
            return yield* Effect.exit(manager.createTab("tab_interrupted_listener"));
          }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isFailure(exit)) {
          expect(Cause.hasInterrupts(exit.cause)).toBe(true);
        }
      }),
    ),
  );

  effectIt.effect("queues navigation until the webview registers", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => undefined);
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "about:blank",
          getTitle: () => "",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL,
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.navigate("tab_pending", "localhost:3200");

        expect(yield* manager.automationStatus("tab_pending")).toEqual({
          available: false,
          visible: true,
          tabId: "tab_pending",
          url: "http://localhost:3200/",
          title: "",
          loading: true,
        });

        yield* manager.registerWebview("tab_pending", 42);
        yield* Effect.yieldNow;

        expect(loadURL).toHaveBeenCalledOnce();
        expect(loadURL).toHaveBeenCalledWith("http://localhost:3200/");
      }),
    ),
  );

  effectIt.effect("emits guest new-tab links without navigating the source tab", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => undefined);
        let openHandler:
          | ((details: {
              readonly url: string;
              readonly disposition: string;
              readonly features: string;
              readonly frameName: string;
              readonly postBody?: { readonly data: ReadonlyArray<unknown> };
            }) => unknown)
          | undefined;
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com/source",
          getTitle: () => "Source",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn((handler) => {
            openHandler = handler;
          }),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const requests: Array<{ readonly sourceTabId: string; readonly url: string }> = [];

        yield* manager.subscribeNewTabRequests((request) =>
          Effect.sync(() => {
            requests.push(request);
          }),
        );
        yield* manager.createTab("runtime-source");
        yield* manager.registerWebview("runtime-source", 42);

        expect(
          openHandler?.({
            url: "https://example.com/next",
            disposition: "foreground-tab",
            features: "",
            frameName: "",
          }),
        ).toEqual({ action: "deny" });
        yield* Effect.yieldNow;

        expect(requests).toEqual([
          { sourceTabId: "runtime-source", url: "https://example.com/next" },
        ]);
        expect(loadURL).not.toHaveBeenCalled();

        // The regression this exists for: Google Identity Services opens a
        // sized popup that Chromium does not report as `new-window`. Denying it
        // returned a null WindowProxy, GSI logged "Failed to open popup window
        // … Maybe blocked by the browser?", and Sign in with Google looked dead.
        expect(
          openHandler?.({
            url: "https://accounts.google.com/gsi/select?client_id=x",
            disposition: "foreground-tab",
            features: "width=500,height=600",
            frameName: "",
          }),
        ).toEqual({
          action: "allow",
          overrideBrowserWindowOptions: { autoHideMenuBar: true },
        });
        expect(requests).toHaveLength(1);

        // Scripted OAuth clients often use an unnamed/_blank child without
        // popup-shaped features. It still needs a synchronous WindowProxy.
        expect(
          openHandler?.({
            url: "https://example.com/target-blank",
            disposition: "new-window",
            features: "noopener,noreferrer",
            frameName: "_blank",
          }),
        ).toEqual({
          action: "allow",
          overrideBrowserWindowOptions: { autoHideMenuBar: true },
        });
        expect(requests).toHaveLength(1);

        expect(
          openHandler?.({
            url: "https://accounts.example.com/oauth",
            disposition: "new-window",
            features: "popup,width=500,height=700",
            frameName: "oauth-login",
          }),
        ).toEqual({
          action: "allow",
          overrideBrowserWindowOptions: { autoHideMenuBar: true },
        });
        expect(requests).toHaveLength(1);

        // OAuth clients commonly create a named about:blank child first and
        // navigate it only after obtaining a provider URL. It still needs a
        // real opener from its first instant or the flow becomes a dead click.
        expect(
          openHandler?.({
            url: "about:blank",
            disposition: "new-window",
            features: "",
            frameName: "oauth-login",
          }),
        ).toEqual({
          action: "allow",
          overrideBrowserWindowOptions: { autoHideMenuBar: true },
        });
        expect(requests).toHaveLength(1);

        // Form-backed OAuth launches carry a POST body. That body cannot be
        // reconstructed by the renderer's asynchronous sibling-tab path.
        expect(
          openHandler?.({
            url: "https://accounts.example.com/oauth",
            disposition: "foreground-tab",
            features: "",
            frameName: "_blank",
            postBody: { data: [] },
          }),
        ).toEqual({
          action: "allow",
          overrideBrowserWindowOptions: { autoHideMenuBar: true },
        });
        expect(requests).toHaveLength(1);
      }),
    ),
  );

  effectIt.effect("forwards both halves of push-to-talk when a guest owns keyboard focus", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const sendInputEvent = vi.fn();
        const mainWindowListeners = new Map<
          string,
          (event: Electron.Event, input: Electron.Input) => void
        >();
        const mainWebContents = {
          sendInputEvent,
          on: vi.fn(
            (event: string, listener: (event: Electron.Event, input: Electron.Input) => void) => {
              mainWindowListeners.set(event, listener);
            },
          ),
          off: vi.fn(),
        };
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          webContents: mainWebContents,
        } as never);

        let beforeInput:
          | ((event: { preventDefault: () => void }, input: Electron.Input) => void)
          | undefined;
        fromId.mockReturnValue({
          id: 42,
          hostWebContents: mainWebContents,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: typeof beforeInput) => {
            if (event === "before-input-event") beforeInput = listener;
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("runtime-source");
        yield* manager.registerWebview("runtime-source", 42);

        const pressInput: Electron.Input = {
          type: "keyDown",
          key: "d",
          code: "KeyD",
          isAutoRepeat: false,
          isComposing: false,
          shift: false,
          control: false,
          alt: false,
          meta: true,
          location: 0,
          modifiers: ["meta"],
        };
        const press = vi.fn();
        beforeInput?.({ preventDefault: press }, pressInput);
        yield* Effect.yieldNow;

        const release = vi.fn();
        beforeInput?.(
          { preventDefault: release },
          {
            type: "keyUp",
            key: "Meta",
            code: "MetaLeft",
            isAutoRepeat: false,
            isComposing: false,
            shift: false,
            control: false,
            alt: false,
            meta: false,
            location: 1,
            modifiers: [],
          },
        );
        yield* Effect.yieldNow;

        expect(press).toHaveBeenCalledOnce();
        expect(release).toHaveBeenCalledOnce();
        expect(sendInputEvent.mock.calls).toEqual([
          [
            {
              type: "keyDown",
              keyCode: "d",
              modifiers: ["meta"],
            },
          ],
          [
            {
              type: "keyUp",
              keyCode: "Meta",
              modifiers: [],
            },
          ],
        ]);

        sendInputEvent.mockClear();

        // The next press begins in the composer. Before it is released, focus
        // moves into the guest. The desktop must join those two halves and
        // forward the release even though the guest never saw the press.
        mainWindowListeners.get("before-input-event")?.({} as Electron.Event, pressInput);
        const crossFocusRelease = vi.fn();
        beforeInput?.(
          { preventDefault: crossFocusRelease },
          {
            type: "keyUp",
            key: "Meta",
            code: "MetaLeft",
            isAutoRepeat: false,
            isComposing: false,
            shift: false,
            control: false,
            alt: false,
            meta: false,
            location: 1,
            modifiers: [],
          },
        );
        yield* Effect.yieldNow;

        expect(crossFocusRelease).toHaveBeenCalledOnce();
        expect(sendInputEvent.mock.calls).toEqual([
          [
            {
              type: "keyUp",
              keyCode: "Meta",
              modifiers: [],
            },
          ],
        ]);
      }),
    ),
  );

  effectIt.effect("does not dereference the main WebContents after its window closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let closed = false;
        let onClosed: (() => void) | undefined;
        const mainWebContents = {
          isDestroyed: vi.fn(() => closed),
          on: vi.fn(),
          off: vi.fn(),
        };
        const window = {
          isDestroyed: () => closed,
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "closed") onClosed = listener;
          }),
          get webContents() {
            if (closed) throw new Error("Object has been destroyed");
            return mainWebContents;
          },
        };

        yield* manager.setMainWindow(window as never);
        closed = true;

        expect(() => onClosed?.()).not.toThrow();
        expect(mainWebContents.off).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("mirrors Electron's effective zoom across registration and navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let effectiveZoom = 0.9;
        let zoomReadable = true;
        let url = "https://example.com";
        const listeners = new Map<string, (...args: unknown[]) => void>();
        const setZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => {
            if (!zoomReadable) throw new Error("zoom unavailable");
            return effectiveZoom;
          },
          setZoomFactor,
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_zoom");
        yield* manager.registerWebview("tab_zoom", 42);

        expect(states.at(-1)?.zoomFactor).toBe(0.9);
        expect(setZoomFactor).not.toHaveBeenCalled();

        effectiveZoom = 1.25;
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.zoomFactor).toBe(1.25);
        expect(setZoomFactor).not.toHaveBeenCalled();

        zoomReadable = false;
        url = "https://example.com/after-zoom-read-failed";
        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;

        expect(states.at(-1)?.navStatus).toEqual({
          kind: "Success",
          url,
          title: "Example",
        });
        expect(states.at(-1)?.zoomFactor).toBe(1.25);

        const replacementSetZoomFactor = vi.fn();
        fromId.mockReturnValue({
          id: 43,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: replacementSetZoomFactor,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.registerWebview("tab_zoom", 43);

        expect(replacementSetZoomFactor).toHaveBeenCalledWith(1.25);
        expect(states.at(-1)?.zoomFactor).toBe(1.25);
      }),
    ),
  );

  effectIt.effect("emulates prefers-color-scheme and re-applies it across webview swaps", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const makeWebContents = (id: number) => {
          const sendCommand = vi.fn(async () => undefined);
          return {
            sendCommand,
            wc: {
              id,
              isDestroyed: () => false,
              isDevToolsOpened: () => false,
              getType: () => "webview",
              getURL: () => "https://example.com",
              getTitle: () => "Example",
              isLoading: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              on: vi.fn(),
              off: vi.fn(),
              ipc: { on: vi.fn(), off: vi.fn() },
              send: webviewSend,
              navigationHistory: { canGoBack: () => false, canGoForward: () => false },
              setWindowOpenHandler: vi.fn(),
              debugger: {
                isAttached: () => false,
                attach: vi.fn(),
                sendCommand,
                on: vi.fn(),
                off: vi.fn(),
              },
            } as never,
          };
        };
        const first = makeWebContents(42);
        fromId.mockReturnValue(first.wc);
        const states: PreviewManager.PreviewTabState[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_scheme");
        yield* manager.registerWebview("tab_scheme", 42);
        yield* Effect.yieldNow;

        yield* manager.setColorScheme("tab_scheme", "dark");

        expect(first.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("dark");

        const replacement = makeWebContents(43);
        fromId.mockReturnValue(replacement.wc);
        yield* manager.registerWebview("tab_scheme", 43);
        yield* Effect.yieldNow;

        expect(replacement.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "dark" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("dark");

        yield* manager.setColorScheme("tab_scheme", "system");

        expect(replacement.sendCommand).toHaveBeenCalledWith("Emulation.setEmulatedMedia", {
          features: [{ name: "prefers-color-scheme", value: "" }],
        });
        expect(states.at(-1)?.colorScheme).toBe("system");
      }),
    ),
  );

  effectIt.effect("attaches CDP only while automation or an emulation override needs it", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let attached = false;
        let devToolsOpened = false;
        let onDevToolsClosed: (() => void) | undefined;
        const attach = vi.fn(() => {
          attached = true;
        });
        const detach = vi.fn(() => {
          attached = false;
        });
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { result: { value: 2 } } : undefined,
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => devToolsOpened,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          once: vi.fn((event: string, listener: () => void) => {
            if (event === "devtools-closed") onDevToolsClosed = listener;
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          openDevTools: vi.fn(() => {
            devToolsOpened = true;
          }),
          debugger: {
            isAttached: () => attached,
            attach,
            detach,
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_control_lease");
        yield* manager.registerWebview("tab_control_lease", 42);
        yield* Effect.yieldNow;

        expect(attach).not.toHaveBeenCalled();

        expect(
          yield* manager.automationEvaluate("tab_control_lease", { expression: "1 + 1" }),
        ).toBe(2);
        expect(sendCommand).toHaveBeenCalledWith(
          "Runtime.evaluate",
          expect.objectContaining({
            expression: "1 + 1",
            userGesture: false,
          }),
        );
        expect(attach).toHaveBeenCalledTimes(1);
        expect(detach).toHaveBeenCalledTimes(1);

        yield* manager.setColorScheme("tab_control_lease", "dark");
        expect(attach).toHaveBeenCalledTimes(2);
        expect(detach).toHaveBeenCalledTimes(1);

        yield* manager.setColorScheme("tab_control_lease", "system");
        expect(detach).toHaveBeenCalledTimes(2);

        yield* manager.openDevTools("tab_control_lease");
        devToolsOpened = false;
        onDevToolsClosed?.();
        yield* Effect.yieldNow;

        expect(attach).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect("blocks late webview and capture starts during tab close", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("close-race-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const firstWebContents = makeTestPreviewWebContents(capturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(capturePage, 43);
        const replacementListenerSpies = replacementWebContents as unknown as {
          readonly on: ReturnType<typeof vi.fn>;
          readonly off: ReturnType<typeof vi.fn>;
          readonly ipc: { readonly off: ReturnType<typeof vi.fn> };
        };
        fromId.mockImplementation((id) => {
          if (id === 42) return firstWebContents;
          if (id === 43) return replacementWebContents;
          return null;
        });
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_close_register_race");
        yield* manager.registerWebview("tab_close_register_race", 42);
        yield* manager.openPictureInPicture("tab_close_register_race");

        const closeCleanupPaused = yield* Deferred.make<void>();
        const continueCloseCleanup = yield* Deferred.make<void>();
        yield* manager.subscribeStateChanges((_tabId, state) =>
          !state.pictureInPicture && state.webContentsId === 42
            ? Deferred.succeed(closeCleanupPaused, undefined).pipe(
                Effect.andThen(Deferred.await(continueCloseCleanup)),
              )
            : Effect.void,
        );

        const closeFiber = yield* manager
          .closeTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Deferred.await(closeCleanupPaused);
        const recreateFiber = yield* manager
          .createTab("tab_close_register_race")
          .pipe(Effect.forkChild({ startImmediately: true }));
        const registrationFiber = yield* manager
          .registerWebview("tab_close_register_race", 43)
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        yield* manager.closeTab("tab_close_register_race");
        const recordingExit = yield* Effect.exit(manager.startRecording("tab_close_register_race"));
        yield* Deferred.succeed(continueCloseCleanup, undefined);
        yield* Fiber.join(closeFiber);
        const recreated = yield* Fiber.join(recreateFiber);
        const registrationExit = yield* Fiber.await(registrationFiber);

        for (const exit of [registrationExit, recordingExit]) {
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isSuccess(exit)) continue;
          expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toMatchObject({
            _tag: "PreviewTabNotFoundError",
            tabId: "tab_close_register_race",
          });
        }
        expect(replacementListenerSpies.on).not.toHaveBeenCalled();
        expect(replacementListenerSpies.off).not.toHaveBeenCalled();
        expect(replacementListenerSpies.ipc.off).not.toHaveBeenCalled();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(recreated.webContentsId).toBeNull();
      }),
    ),
  );

  effectIt.effect("interrupts a pending control command before closing its tab", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let attached = false;
        let markEvaluationStarted: (() => void) | undefined;
        const evaluationStarted = new Promise<void>((resolve) => {
          markEvaluationStarted = resolve;
        });
        const sendCommand = vi.fn((method: string) => {
          if (method === "Runtime.evaluate") {
            markEvaluationStarted?.();
            return new Promise<never>(() => undefined);
          }
          return Promise.resolve({});
        });
        const detach = vi.fn(() => {
          attached = false;
        });
        const webContents = {
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => attached,
            attach: vi.fn(() => {
              attached = true;
            }),
            detach,
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        };
        fromId.mockReturnValue(webContents as never);

        yield* manager.createTab("tab_pending_close");
        yield* manager.registerWebview("tab_pending_close", 42);
        const action = yield* manager
          .automationEvaluate("tab_pending_close", { expression: "location.href" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => evaluationStarted);

        yield* manager.closeTab("tab_pending_close");
        const actionExit = yield* Fiber.await(action);

        expect(Exit.isFailure(actionExit)).toBe(true);
        if (Exit.isFailure(actionExit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(actionExit.cause))).toMatchObject({
            _tag: "PreviewWebContentsNotFoundError",
            tabId: "tab_pending_close",
            webContentsId: 42,
          });
        }
        expect(detach).toHaveBeenCalledOnce();
      }),
    ),
  );

  effectIt.effect("settles pending automation without touching a destroyed guest", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let destroyed = false;
        let attached = false;
        let destroyedListener: (() => void) | undefined;
        let markEvaluationStarted: (() => void) | undefined;
        const evaluationStarted = new Promise<void>((resolve) => {
          markEvaluationStarted = resolve;
        });
        const sendCommand = vi.fn((method: string) => {
          if (method === "Runtime.evaluate") {
            markEvaluationStarted?.();
            return new Promise<never>(() => undefined);
          }
          return Promise.resolve({});
        });
        const off = vi.fn(() => {
          if (destroyed) throw new Error("Object has been destroyed");
        });
        const ipcOff = vi.fn(() => {
          if (destroyed) throw new Error("Object has been destroyed");
        });
        const debuggerOff = vi.fn(() => {
          if (destroyed) throw new Error("Object has been destroyed");
        });
        const detach = vi.fn(() => {
          if (destroyed) throw new Error("Object has been destroyed");
          attached = false;
        });
        const webContents = {
          id: 42,
          isDestroyed: () => destroyed,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: () => void) => {
            if (event === "destroyed") destroyedListener = listener;
          }),
          off,
          ipc: { on: vi.fn(), off: ipcOff },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => attached,
            attach: vi.fn(() => {
              attached = true;
            }),
            detach,
            sendCommand,
            on: vi.fn(),
            off: debuggerOff,
          },
        };
        fromId.mockReturnValue(webContents as never);
        const detachedState = yield* Deferred.make<void>();

        yield* manager.createTab("tab_destroyed_during_command");
        yield* manager.registerWebview("tab_destroyed_during_command", 42);
        yield* manager.subscribeStateChanges((tabId, state) =>
          tabId === "tab_destroyed_during_command" && state.webContentsId === null
            ? Deferred.succeed(detachedState, undefined).pipe(Effect.asVoid)
            : Effect.void,
        );
        const action = yield* manager
          .automationEvaluate("tab_destroyed_during_command", { expression: "location.href" })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => evaluationStarted);

        destroyed = true;
        destroyedListener?.();
        yield* Deferred.await(detachedState);
        const actionExit = yield* Fiber.await(action);

        expect(Exit.isFailure(actionExit)).toBe(true);
        if (Exit.isFailure(actionExit)) {
          expect(Option.getOrThrow(Cause.findErrorOption(actionExit.cause))).toMatchObject({
            _tag: "PreviewWebContentsNotFoundError",
            tabId: "tab_destroyed_during_command",
            webContentsId: 42,
          });
        }
        expect(off).not.toHaveBeenCalled();
        expect(ipcOff).not.toHaveBeenCalled();
        expect(debuggerOff).not.toHaveBeenCalled();
        expect(detach).not.toHaveBeenCalled();
        expect(yield* manager.automationStatus("tab_destroyed_during_command")).toMatchObject({
          available: false,
          tabId: "tab_destroyed_during_command",
        });
      }),
    ),
  );

  effectIt.effect("keeps a main-frame load failure visible until a retry starts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "http://localhost:5733/";
        let loading = false;
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "localhost:5733",
          isLoading: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const statuses: PreviewManager.PreviewNavStatus[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            statuses.push(state.navStatus);
          }),
        );
        yield* manager.createTab("tab_failed");
        yield* manager.registerWebview("tab_failed", 42);

        listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "https://missing-frame.example/",
          false,
        );
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        listeners.get("did-stop-loading")?.();
        listeners.get("page-title-updated")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)).toEqual({
          kind: "LoadFailed",
          url,
          title: "localhost:5733",
          code: -102,
          description: "ERR_CONNECTION_REFUSED",
        });

        loading = true;
        listeners.get("did-start-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Loading");

        loading = false;
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");

        listeners.get("did-fail-load")?.({}, -102, "ERR_CONNECTION_REFUSED", url, true);
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("LoadFailed");

        listeners.get("did-navigate")?.();
        yield* Effect.yieldNow;
        expect(statuses.at(-1)?.kind).toBe("Success");
      }),
    ),
  );

  effectIt.effect("captures a PNG screenshot into browser artifacts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("preview-png");
        const capturePage = vi.fn(async () => ({ toPNG: () => png }));
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com:8443/path?query=value",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: never[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        expect(webviewSend).toHaveBeenCalledWith(
          "preview:annotation-theme",
          expect.objectContaining({
            colorScheme: "light",
            primary: "oklch(0.488 0.217 264)",
          }),
        );

        const artifact = yield* manager.captureScreenshot("tab_1");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(mkdir).toHaveBeenCalledWith("/tmp/t3/dev/browser-artifacts");
        expect(writeFile).toHaveBeenCalledWith(artifact.path, png);
        expect(artifact).toMatchObject({
          tabId: "tab_1",
          mimeType: "image/png",
          sizeBytes: png.byteLength,
        });
        expect(artifact.path).toMatch(
          /\/browser-artifacts\/browser-screenshot-example-com-[^.]+\.png$/,
        );

        const captureCause = new Error("capture failed");
        capturePage.mockRejectedValueOnce(captureCause);
        const exit = yield* Effect.exit(manager.captureScreenshot("tab_1"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewOperationError",
          operation: "captureScreenshot.capturePage",
          tabId: "tab_1",
          webContentsId: 42,
          cause: captureCause,
        });
      }),
    ),
  );

  effectIt.effect("stages a hidden tab until its compositor surface is ready", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const debuggerPng = Buffer.from("debugger-automation-snapshot").toString("base64");
        const stagedPng = Buffer.from("staged-automation-snapshot");
        let nativeScreenshotAvailable = false;
        const capturePage = vi.fn(async () => {
          if (!nativeScreenshotAvailable) throw new Error("UnknownVizError");
          return {
            getSize: () => ({ width: 800, height: 600 }),
            resize: () => {
              throw new Error("unexpected resize");
            },
            toJPEG: (quality: number) => {
              expect(quality).toBe(78);
              return stagedPng;
            },
          };
        });
        const stagedImage = {
          getSize: () => ({ width: 800, height: 600 }),
          resize: () => {
            throw new Error("unexpected resize");
          },
          toJPEG: (quality: number) => {
            expect(quality).toBe(78);
            return stagedPng;
          },
        };
        let presentedFrameAvailable = false;
        let presentedFrame:
          | ((image: typeof stagedImage, dirtyRect: Electron.Rectangle) => void)
          | undefined;
        const beginFrameSubscription = vi.fn(
          (
            _onlyDirty: boolean,
            callback: (image: typeof stagedImage, dirtyRect: Electron.Rectangle) => void,
          ) => {
            if (!presentedFrameAvailable) throw new Error("presentation unavailable");
            presentedFrame = callback;
          },
        );
        const endFrameSubscription = vi.fn();
        let debuggerScreenshotAvailable = true;
        let debuggerScreencastAvailable = false;
        const previewSession = {};
        const debuggerMessages = new Set<
          (event: unknown, method: string, params: Record<string, unknown>) => void
        >();
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: {
                  url: "https://example.com",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  viewportWidth: 800,
                  viewportHeight: 600,
                  interactiveElements: [],
                },
              },
            };
          }
          if (method === "Page.captureScreenshot") {
            return debuggerScreenshotAvailable ? { data: debuggerPng } : {};
          }
          if (method === "Page.startScreencast" && debuggerScreencastAvailable) {
            queueMicrotask(() => {
              for (const listener of debuggerMessages) {
                listener({}, "Page.screencastFrame", {
                  sessionId: 1,
                  data: debuggerPng,
                  metadata: { deviceWidth: 800, deviceHeight: 600 },
                });
              }
            });
          }
          if (method === "Accessibility.getFullAXTree") return { nodes: [] };
          return {};
        });
        const invalidate = vi.fn(() => {
          if (!presentedFrameAvailable) return;
          presentedFrame?.(stagedImage, { x: 0, y: 0, width: 800, height: 600 });
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          session: previewSession,
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            detach: vi.fn(),
            sendCommand,
            on: vi.fn(
              (
                event: string,
                listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
              ) => {
                if (event === "message") debuggerMessages.add(listener);
              },
            ),
            off: vi.fn(
              (
                event: string,
                listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
              ) => {
                if (event === "message") debuggerMessages.delete(listener);
              },
            ),
          },
          invalidate,
          beginFrameSubscription,
          endFrameSubscription,
          capturePage,
        } as never);

        yield* manager.createTab("tab_hidden_snapshot");
        yield* manager.registerWebview("tab_hidden_snapshot", 42);
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.gen(function* () {
            states.push(state);
            if (state.snapshotStageId !== null) {
              yield* manager
                .setUiActivity(tabId, `snapshot-stage:${state.snapshotStageId}`, true)
                .pipe(Effect.orDie);
            }
          }),
        );
        yield* manager.setUiActivity("tab_hidden_snapshot", "test", true);
        const snapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenLastCalledWith(undefined, {
          stayHidden: true,
          stayAwake: true,
        });
        expect(snapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: debuggerPng,
          width: 800,
          height: 600,
        });
        expect(snapshot.visibleText).toBe("Example");
        expect(sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
          format: "jpeg",
          quality: 78,
          fromSurface: true,
          captureBeyondViewport: false,
          clip: { x: 0, y: 0, width: 800, height: 600, scale: 1 },
        });

        yield* manager.setUiActivity("tab_hidden_snapshot", "test", false);
        debuggerScreenshotAvailable = false;
        presentedFrameAvailable = true;
        const stagedSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        // A synchronous presentation callback can win before capturePage is
        // even started, avoiding the native promise that hangs on occluded macOS guests.
        expect(capturePage).toHaveBeenCalledOnce();
        expect(invalidate).toHaveBeenCalledOnce();
        expect(beginFrameSubscription).toHaveBeenCalledWith(false, expect.any(Function));
        expect(endFrameSubscription).toHaveBeenCalledOnce();
        expect(stagedSnapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: stagedPng.toString("base64"),
          width: 800,
          height: 600,
        });
        expect(states.some((state) => state.snapshotStageId !== null)).toBe(true);
        expect(states.at(-1)?.snapshotStageId).toBeNull();

        nativeScreenshotAvailable = false;
        presentedFrameAvailable = false;
        debuggerScreencastAvailable = true;
        const screencastSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(screencastSnapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: debuggerPng,
          width: 800,
          height: 600,
        });
        expect(sendCommand).toHaveBeenCalledWith("Page.startScreencast", {
          format: "jpeg",
          quality: 78,
          maxWidth: 800,
          maxHeight: 600,
          everyNthFrame: 1,
        });
        expect(sendCommand).toHaveBeenCalledWith("Page.stopScreencast");

        debuggerScreencastAvailable = false;
        const mirrorPng = Buffer.from("offscreen-mirror-snapshot");
        const mirrorImage = {
          getSize: () => ({ width: 800, height: 600 }),
          resize: () => {
            throw new Error("unexpected resize");
          },
          toJPEG: (quality: number) => {
            expect(quality).toBe(78);
            return mirrorPng;
          },
        };
        let paintListener:
          | ((event: unknown, dirtyRect: Electron.Rectangle, image: typeof mirrorImage) => void)
          | undefined;
        const mirrorWebContents = {
          isDestroyed: vi.fn(() => false),
          setAudioMuted: vi.fn(),
          setWindowOpenHandler: vi.fn(),
          setFrameRate: vi.fn(),
          on: vi.fn(
            (
              event: string,
              listener: (
                event: unknown,
                dirtyRect: Electron.Rectangle,
                image: typeof mirrorImage,
              ) => void,
            ) => {
              if (event === "paint") paintListener = listener;
            },
          ),
          off: vi.fn(),
          startPainting: vi.fn(),
          stopPainting: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          invalidate: vi.fn(() =>
            paintListener?.({}, { x: 0, y: 0, width: 800, height: 600 }, mirrorImage),
          ),
        };
        const mirrorWindow = {
          webContents: mirrorWebContents,
          isDestroyed: vi.fn(() => false),
          destroy: vi.fn(),
        };
        browserWindowConstructor.mockImplementation(function () {
          return mirrorWindow;
        });
        const mirrorSnapshotFiber = yield* manager
          .automationSnapshot("tab_hidden_snapshot")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("3 seconds");
        const mirrorSnapshot = yield* Fiber.join(mirrorSnapshotFiber);
        expect(mirrorSnapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: mirrorPng.toString("base64"),
          width: 800,
          height: 600,
        });
        expect(browserWindowConstructor).toHaveBeenCalledWith({
          width: 800,
          height: 600,
          show: false,
          frame: false,
          skipTaskbar: true,
          paintWhenInitiallyHidden: true,
          webPreferences: {
            session: previewSession,
            offscreen: true,
            backgroundThrottling: false,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: true,
          },
        });
        expect(mirrorWebContents.setAudioMuted).toHaveBeenCalledWith(true);
        expect(mirrorWebContents.setAudioMuted.mock.invocationCallOrder[0]).toBeLessThan(
          mirrorWebContents.loadURL.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
        );
        expect(mirrorWebContents.setWindowOpenHandler).toHaveBeenCalledOnce();
        expect(mirrorWebContents.startPainting).toHaveBeenCalledOnce();
        expect(mirrorWebContents.loadURL).toHaveBeenCalledWith("https://example.com");
        expect(mirrorWebContents.invalidate).toHaveBeenCalledOnce();
        expect(mirrorWebContents.stopPainting).toHaveBeenCalledOnce();
        expect(mirrorWindow.destroy).toHaveBeenCalledOnce();

        mirrorWebContents.loadURL.mockRejectedValue(new Error("mirror load failed"));
        const failedSnapshotFiber = yield* manager
          .automationSnapshot("tab_hidden_snapshot")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("10 seconds");
        const failedSnapshot = yield* Fiber.await(failedSnapshotFiber);
        expect(Exit.isFailure(failedSnapshot)).toBe(true);
        expect(states.at(-1)?.snapshotStageId).toBeNull();
        if (Exit.isFailure(failedSnapshot)) {
          expect(Option.getOrThrow(Cause.findErrorOption(failedSnapshot.cause))).toMatchObject({
            _tag: "PreviewOperationError",
            operation: "automationSnapshot.offscreenMirror.loadURL",
          });
        }
      }),
    ),
  );

  effectIt.effect("bounds a visible native capture that never settles", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const debuggerPng = Buffer.from("debugger-timeout-snapshot").toString("base64");
        const capturePage = vi.fn(() => new Promise<never>(() => {}));
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: {
                  url: "https://example.com",
                  title: "Example",
                  loading: false,
                  visibleText: "Example",
                  viewportWidth: 800,
                  viewportHeight: 600,
                  interactiveElements: [],
                },
              },
            };
          }
          if (method === "Page.captureScreenshot") return { data: debuggerPng };
          if (method === "Accessibility.getFullAXTree") return { nodes: [] };
          return {};
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            detach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_snapshot_timeout");
        yield* manager.registerWebview("tab_snapshot_timeout", 42);
        yield* manager.setUiActivity("tab_snapshot_timeout", "test", true);

        const snapshot = yield* manager.automationSnapshot("tab_snapshot_timeout");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(snapshot.visibleText).toBe("Example");
        expect(snapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: debuggerPng,
          width: 800,
          height: 600,
        });
      }),
    ),
  );

  effectIt.effect("re-resolves a snapshot after navigation destroys its JavaScript context", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("snapshot-after-navigation");
        const capturePage = vi.fn(async () => ({
          getSize: () => ({ width: 800, height: 600 }),
          toJPEG: (quality: number) => {
            expect(quality).toBe(78);
            return png;
          },
        }));
        let evaluationAttempts = 0;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            evaluationAttempts += 1;
            if (evaluationAttempts === 1) {
              throw new Error("Execution context was destroyed during navigation");
            }
            return {
              result: {
                value: {
                  url: "https://example.com/claims",
                  title: "Claims",
                  loading: false,
                  visibleText: "Claims",
                  interactiveElements: [],
                },
              },
            };
          }
          if (method === "Accessibility.getFullAXTree") return { nodes: [] };
          return {};
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com/claims",
          getTitle: () => "Claims",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            detach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        yield* manager.createTab("tab_navigation_snapshot");
        yield* manager.registerWebview("tab_navigation_snapshot", 42);
        yield* manager.setUiActivity("tab_navigation_snapshot", "test", true);
        const fiber = yield* manager
          .automationSnapshot("tab_navigation_snapshot")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust(50);
        const snapshot = yield* Fiber.join(fiber);

        expect(evaluationAttempts).toBe(2);
        expect(capturePage).toHaveBeenCalledOnce();
        expect(snapshot).toMatchObject({
          url: "https://example.com/claims",
          visibleText: "Claims",
          screenshot: { data: png.toString("base64") },
        });
      }),
    ),
  );

  effectIt.effect("captures hidden preview recordings independently for concurrent tabs", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const firstJpeg = Buffer.from("first-recording-frame");
        const secondJpeg = Buffer.from("second-recording-frame");
        const firstCapturePage = vi.fn(async () => ({
          toJPEG: () => firstJpeg,
          getSize: () => ({ width: 800, height: 600 }),
        }));
        const secondCapturePage = vi.fn(async () => ({
          toJPEG: () => secondJpeg,
          getSize: () => ({ width: 390, height: 844 }),
        }));
        const firstSendCommand = vi.fn(async () => undefined);
        const secondSendCommand = vi.fn(async () => undefined);
        const makeWebContents = (
          id: number,
          capturePage: typeof firstCapturePage,
          sendCommand: typeof firstSendCommand,
        ) =>
          ({
            id,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => `https://example.com/${id}`,
            getTitle: () => `Example ${id}`,
            isLoading: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
            capturePage,
          }) as never;
        const webContentsById = new Map([
          [41, makeWebContents(41, firstCapturePage, firstSendCommand)],
          [42, makeWebContents(42, secondCapturePage, secondSendCommand)],
        ]);
        fromId.mockImplementation((id) =>
          id === undefined ? null : (webContentsById.get(id) ?? null),
        );
        const frames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.createTab("tab_2");
        yield* manager.registerWebview("tab_1", 41);
        yield* manager.registerWebview("tab_2", 42);
        yield* Effect.all([manager.startRecording("tab_1"), manager.startRecording("tab_2")], {
          concurrency: 2,
          discard: true,
        });

        expect(firstCapturePage).toHaveBeenCalledOnce();
        expect(secondCapturePage).toHaveBeenCalledOnce();
        expect(frames).toHaveLength(2);
        expect(frames).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              tabId: "tab_1",
              data: firstJpeg.toString("base64"),
              width: 800,
              height: 600,
            }),
            expect.objectContaining({
              tabId: "tab_2",
              data: secondJpeg.toString("base64"),
              width: 390,
              height: 844,
            }),
          ]),
        );
        expect(firstSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );
        expect(secondSendCommand).not.toHaveBeenCalledWith(
          "Page.startScreencast",
          expect.anything(),
        );

        yield* Effect.all([manager.stopRecording("tab_1"), manager.stopRecording("tab_2")], {
          concurrency: 2,
          discard: true,
        });
      }),
    ),
  );

  effectIt.effect("drops a captured frame when the tab webview changes during capture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const staleImage: TestCapturedPreviewImage = {
          toJPEG: vi.fn(() => Buffer.from("stale-recording-frame")),
          getSize: vi.fn(() => ({ width: 1280, height: 720 })),
        };
        let markCaptureStarted!: () => void;
        const captureStarted = new Promise<void>((resolve) => {
          markCaptureStarted = resolve;
        });
        let resolveCapture: ((image: TestCapturedPreviewImage) => void) | undefined;
        const staleCapturePage = vi.fn(() => {
          markCaptureStarted();
          return new Promise<TestCapturedPreviewImage>((resolve) => {
            resolveCapture = resolve;
          });
        });
        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const initialWebContents = makeTestPreviewWebContents(staleCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;
          if (webContentsId === 43) return replacementWebContents;
          return null;
        });
        const frames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        );
        yield* manager.createTab("tab_capture_replaced");
        yield* manager.registerWebview("tab_capture_replaced", 42);
        const recordingFiber = yield* manager
          .startRecording("tab_capture_replaced")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => captureStarted);

        yield* manager.registerWebview("tab_capture_replaced", 43);
        resolveCapture?.(staleImage);
        yield* Fiber.join(recordingFiber);

        expect(staleImage.getSize).not.toHaveBeenCalled();
        expect(staleImage.toJPEG).not.toHaveBeenCalled();
        expect(frames).toHaveLength(0);
        expect(replacementCapturePage).not.toHaveBeenCalled();

        yield* manager.stopRecording("tab_capture_replaced");
      }),
    ),
  );

  effectIt.effect("keeps an in-flight frame when a capture consumer is added", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const image: TestCapturedPreviewImage = {
          toJPEG: vi.fn(() => Buffer.from("shared-in-flight-frame")),
          getSize: vi.fn(() => ({ width: 1280, height: 720 })),
        };
        let markCaptureStarted!: () => void;
        const captureStarted = new Promise<void>((resolve) => {
          markCaptureStarted = resolve;
        });
        let resolveCapture: ((captured: TestCapturedPreviewImage) => void) | undefined;
        const capturePage = vi.fn(() => {
          markCaptureStarted();
          return new Promise<TestCapturedPreviewImage>((resolve) => {
            resolveCapture = resolve;
          });
        });
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const recordingFrames: DesktopPreviewRecordingFrame[] = [];
        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            recordingFrames.push(frame);
          }),
        );

        yield* manager.createTab("tab_capture_consumer_added");
        yield* manager.registerWebview("tab_capture_consumer_added", 42);
        const recordingFiber = yield* manager
          .startRecording("tab_capture_consumer_added")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.promise(() => captureStarted);

        yield* manager.openPictureInPicture("tab_capture_consumer_added");
        resolveCapture?.(image);
        yield* Fiber.join(recordingFiber);

        expect(recordingFrames).toHaveLength(1);
        expect(send).toHaveBeenCalledWith(
          "desktop:preview-pip-frame",
          expect.objectContaining({
            tabId: "tab_capture_consumer_added",
            data: Buffer.from("shared-in-flight-frame").toString("base64"),
          }),
        );

        yield* manager.stopRecording("tab_capture_consumer_added");
        yield* manager.closePictureInPicture("tab_capture_consumer_added");
      }),
    ),
  );

  effectIt.effect("emits debugger screencast frames only while recording is active", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let debuggerMessage:
          | ((event: unknown, method: string, params: Record<string, unknown>) => void)
          | undefined;
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("scheduled-recording-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { result: { value: null } } : undefined,
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(
              (
                event: string,
                listener: (event: unknown, method: string, params: Record<string, unknown>) => void,
              ) => {
                if (event === "message") debuggerMessage = listener;
              },
            ),
            off: vi.fn(),
          },
          capturePage,
        } as never);
        const recordingFrames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            recordingFrames.push(frame);
          }),
        );
        yield* manager.createTab("tab_screencast_guard");
        yield* manager.registerWebview("tab_screencast_guard", 42);
        yield* manager.automationEvaluate("tab_screencast_guard", { expression: "null" });

        debuggerMessage?.({}, "Page.screencastFrame", {
          sessionId: 1,
          data: "inactive-frame",
          metadata: { deviceWidth: 1280, deviceHeight: 720 },
        });
        yield* Effect.yieldNow;
        expect(recordingFrames).toHaveLength(0);

        yield* manager.startRecording("tab_screencast_guard");
        recordingFrames.length = 0;
        debuggerMessage?.({}, "Page.screencastFrame", {
          sessionId: 2,
          data: "active-frame",
          metadata: { deviceWidth: 1280, deviceHeight: 720 },
        });
        yield* Effect.yieldNow;

        expect(recordingFrames).toEqual([
          expect.objectContaining({
            tabId: "tab_screencast_guard",
            data: "active-frame",
            width: 1280,
            height: 720,
          }),
        ]);
        yield* manager.stopRecording("tab_screencast_guard");
      }),
    ),
  );

  effectIt.effect("shares background frame capture between recording and picture-in-picture", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("shared-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
          capturePage,
        } as never);

        const pictureInPictureListeners = new Map<string, () => void>();
        const pictureInPictureSend = vi.fn();
        const pictureInPictureWindow = {
          isDestroyed: vi.fn(() => false),
          once: vi.fn((event: string, listener: () => void) => {
            pictureInPictureListeners.set(event, listener);
          }),
          setAlwaysOnTop: vi.fn(),
          setVisibleOnAllWorkspaces: vi.fn(),
          setAspectRatio: vi.fn(),
          getContentSize: vi.fn(() => [480, 320] as [number, number]),
          setContentSize: vi.fn(),
          loadURL: vi.fn(async () => undefined),
          showInactive: vi.fn(),
          close: vi.fn(() => {
            pictureInPictureListeners.get("closed")?.();
          }),
          webContents: {
            send: pictureInPictureSend,
          },
        };
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        const recordingFrames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            recordingFrames.push(frame);
          }),
        );
        yield* manager.createTab("tab_pip");
        yield* manager.registerWebview("tab_pip", 42);
        yield* manager.openPictureInPicture("tab_pip");

        expect(browserWindowConstructor).toHaveBeenCalledWith(
          expect.objectContaining({
            alwaysOnTop: true,
            show: false,
            skipTaskbar: true,
            webPreferences: expect.objectContaining({
              preload: "/tmp/t3/desktop/preview-pip-preload.cjs",
              backgroundThrottling: false,
            }),
          }),
        );
        expect(pictureInPictureWindow.showInactive).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        });
        expect(pictureInPictureWindow.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(pictureInPictureWindow.setContentSize).toHaveBeenCalledWith(523, 294, false);
        expect(pictureInPictureWindow.setAspectRatio.mock.invocationCallOrder[0]).toBeLessThan(
          pictureInPictureWindow.setContentSize.mock.invocationCallOrder[0] ?? 0,
        );
        expect(pictureInPictureWindow.setContentSize.mock.invocationCallOrder[0]).toBeLessThan(
          pictureInPictureWindow.setAspectRatio.mock.invocationCallOrder[1] ?? 0,
        );
        expect(pictureInPictureSend).toHaveBeenCalledWith(
          "desktop:preview-pip-frame",
          expect.objectContaining({
            tabId: "tab_pip",
            data: jpeg.toString("base64"),
            width: 1280,
            height: 720,
          }),
        );
        expect(states.at(-1)?.pictureInPicture).toBe(true);
        expect(capturePage).toHaveBeenCalledOnce();

        yield* manager.startRecording("tab_pip");
        expect(capturePage).toHaveBeenCalledOnce();
        expect(recordingFrames).toHaveLength(0);

        yield* TestClock.adjust(100);
        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(recordingFrames).toHaveLength(1);

        yield* manager.stopRecording("tab_pip");
        const framesBeforePictureInPictureOnlyTick = pictureInPictureSend.mock.calls.length;
        yield* TestClock.adjust(100);
        expect(capturePage).toHaveBeenCalledTimes(3);
        expect(pictureInPictureSend.mock.calls.length).toBeGreaterThan(
          framesBeforePictureInPictureOnlyTick,
        );
        expect(recordingFrames).toHaveLength(1);

        yield* manager.closePictureInPicture("tab_pip");
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("retries a cold hidden-tab capture without dropping recording", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const jpeg = Buffer.from("recovered-preview-frame");
        const capturePage = vi.fn(async () => ({
          toJPEG: () => jpeg,
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        capturePage.mockRejectedValueOnce(new Error("UnknownVizError"));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const frames: DesktopPreviewRecordingFrame[] = [];

        yield* manager.subscribeRecordingFrames((frame) =>
          Effect.sync(() => {
            frames.push(frame);
          }),
        );
        yield* manager.createTab("tab_cold_capture");
        yield* manager.registerWebview("tab_cold_capture", 42);

        yield* manager.startRecording("tab_cold_capture");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(frames).toHaveLength(0);

        yield* TestClock.adjust(100);

        expect(capturePage).toHaveBeenCalledTimes(2);
        expect(frames).toEqual([
          expect.objectContaining({
            tabId: "tab_cold_capture",
            data: jpeg.toString("base64"),
            width: 1280,
            height: 720,
          }),
        ]);

        yield* manager.stopRecording("tab_cold_capture");
      }),
    ),
  );

  effectIt.effect("drops empty frames before picture-in-picture delivery", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const validImage: TestCapturedPreviewImage = {
          toJPEG: () => Buffer.from("valid-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        };
        const capturePage = vi.fn(async () => validImage);
        capturePage.mockResolvedValueOnce({
          toJPEG: () => Buffer.from("empty-preview-frame"),
          getSize: () => ({ width: 0, height: 0 }),
        });
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow, send } = makeTestPictureInPictureWindow();
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_empty_frame");
        yield* manager.registerWebview("tab_empty_frame", 42);
        yield* manager.openPictureInPicture("tab_empty_frame");

        expect(capturePage).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.setAspectRatio).not.toHaveBeenCalled();
        expect(send).not.toHaveBeenCalled();

        yield* TestClock.adjust(100);

        expect(pictureInPictureWindow.setAspectRatio.mock.calls).toEqual([[0], [1280 / 720]]);
        expect(send).toHaveBeenCalledOnce();
        yield* manager.closePictureInPicture("tab_empty_frame");
      }),
    ),
  );

  effectIt.effect("does not publish picture-in-picture readiness after window teardown", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("closing-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow();
        pictureInPictureWindow.showInactive.mockImplementationOnce(() => {
          pictureInPictureWindow.close();
        });
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );

        yield* manager.createTab("tab_pip_teardown");
        yield* manager.registerWebview("tab_pip_teardown", 42);
        const openExit = yield* Effect.exit(manager.openPictureInPicture("tab_pip_teardown"));

        expect(Exit.hasInterrupts(openExit)).toBe(true);
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(states.some((state) => state.pictureInPicture)).toBe(false);
        expect(states.at(-1)?.pictureInPicture).toBe(false);
      }),
    ),
  );

  effectIt.effect("closes an initializing picture-in-picture without blocking later opens", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const capturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("serialized-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        fromId.mockReturnValue(makeTestPreviewWebContents(capturePage));
        const { pictureInPictureWindow: initializingWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>(() => {
              // Simulate a renderer load that never settles.
            }),
        );
        const { pictureInPictureWindow: reopenedWindow } = makeTestPictureInPictureWindow();
        browserWindowConstructor
          .mockImplementationOnce(function () {
            return initializingWindow;
          })
          .mockImplementationOnce(function () {
            return reopenedWindow;
          });
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.createTab("tab_concurrent_pip");
        yield* manager.registerWebview("tab_concurrent_pip", 42);

        const firstOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const secondOpen = yield* manager
          .openPictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;
        const close = yield* manager
          .closePictureInPicture("tab_concurrent_pip")
          .pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(initializingWindow.loadURL).toHaveBeenCalledOnce();
        expect(initializingWindow.close).toHaveBeenCalledOnce();
        const [firstOpenExit, secondOpenExit] = yield* Effect.all([
          Fiber.await(firstOpen),
          Fiber.await(secondOpen),
        ]);
        yield* Fiber.join(close);

        expect(Exit.hasInterrupts(firstOpenExit)).toBe(true);
        expect(Exit.hasInterrupts(secondOpenExit)).toBe(true);
        expect(initializingWindow.showInactive).not.toHaveBeenCalled();
        expect(capturePage).not.toHaveBeenCalled();
        expect(states.at(-1)?.pictureInPicture).toBe(false);

        yield* manager.openPictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.showInactive).toHaveBeenCalledOnce();
        expect(capturePage).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(true);

        yield* manager.closePictureInPicture("tab_concurrent_pip");

        expect(browserWindowConstructor).toHaveBeenCalledTimes(2);
        expect(reopenedWindow.close).toHaveBeenCalledOnce();
        expect(states.at(-1)?.pictureInPicture).toBe(false);
        const capturesAfterClose = capturePage.mock.calls.length;
        yield* TestClock.adjust(200);
        expect(capturePage).toHaveBeenCalledTimes(capturesAfterClose);
      }),
    ),
  );

  effectIt.effect("rejects picture-in-picture when its webview changes during initialization", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const initialCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("stale-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const replacementCapturePage = vi.fn(async () => ({
          toJPEG: () => Buffer.from("replacement-preview-frame"),
          getSize: () => ({ width: 1280, height: 720 }),
        }));
        const initialWebContents = makeTestPreviewWebContents(initialCapturePage, 42);
        const replacementWebContents = makeTestPreviewWebContents(replacementCapturePage, 43);
        fromId.mockImplementation((webContentsId?: number) => {
          if (webContentsId === 42) return initialWebContents;
          if (webContentsId === 43) return replacementWebContents;
          return null;
        });
        let resolveLoad: (() => void) | undefined;
        const { pictureInPictureWindow } = makeTestPictureInPictureWindow(
          () =>
            new Promise<void>((resolve) => {
              resolveLoad = resolve;
            }),
        );
        browserWindowConstructor.mockImplementation(function () {
          return pictureInPictureWindow;
        });

        yield* manager.createTab("tab_replaced_webview");
        yield* manager.registerWebview("tab_replaced_webview", 42);
        const open = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        expect(pictureInPictureWindow.loadURL).toHaveBeenCalledOnce();
        expect(resolveLoad).toBeDefined();
        const concurrentOpen = yield* manager
          .openPictureInPicture("tab_replaced_webview")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;

        yield* manager.registerWebview("tab_replaced_webview", 43);
        resolveLoad?.();

        const openExits = yield* Effect.all([Fiber.await(open), Fiber.await(concurrentOpen)]);
        for (const openExit of openExits) {
          expect(Exit.isFailure(openExit)).toBe(true);
          if (Exit.isSuccess(openExit)) continue;
          const error = Option.getOrThrow(Cause.findErrorOption(openExit.cause));
          expect(error).toMatchObject({
            _tag: "PreviewOperationError",
            operation: "pictureInPicture.validateWebContents",
            tabId: "tab_replaced_webview",
            webContentsId: 42,
          });
        }
        expect(browserWindowConstructor).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.close).toHaveBeenCalledOnce();
        expect(pictureInPictureWindow.showInactive).not.toHaveBeenCalled();
        expect(initialCapturePage).not.toHaveBeenCalled();
        expect(replacementCapturePage).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("keeps element picking active during subframe navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isFocused: () => true,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          once: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn(), removeListener: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const pick = yield* manager.pickElement("tab_1").pipe(Effect.forkChild);
        yield* Effect.yieldNow;

        listeners.get("did-start-navigation")?.({}, "about:blank", false, false);
        yield* Effect.yieldNow;
        expect(pick.pollUnsafe()).toBeUndefined();

        listeners.get("did-start-navigation")?.({}, "https://example.com/next", false, true);
        expect(yield* Fiber.join(pick)).toBeNull();
      }),
    ),
  );

  effectIt.effect("reveals only files inside the configured browser artifact directory", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        yield* manager.revealArtifact("/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png");

        expect(showItemInFolder).toHaveBeenCalledWith(
          "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png",
        );
        const exit = yield* Effect.exit(manager.revealArtifact("/tmp/t3/dev/settings.json"));
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("copies screenshot artifacts to the system clipboard", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const artifactPath = "/tmp/t3/dev/browser-artifacts/browser-screenshot-test.png";

        yield* manager.copyArtifactToClipboard(artifactPath);

        expect(createFromPath).toHaveBeenCalledWith(artifactPath);
        expect(writeImage).toHaveBeenCalledOnce();
        const exit = yield* Effect.exit(
          manager.copyArtifactToClipboard("/tmp/t3/dev/settings.json"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewArtifactPathOutsideDirectoryError",
          artifactPath: "/tmp/t3/dev/settings.json",
          artifactDirectory: "/tmp/t3/dev/browser-artifacts",
        });
        expect("cause" in error).toBe(false);

        createFromPath.mockReturnValueOnce({ isEmpty: () => true });
        const invalidImageExit = yield* Effect.exit(manager.copyArtifactToClipboard(artifactPath));
        expect(Exit.isFailure(invalidImageExit)).toBe(true);
        if (Exit.isSuccess(invalidImageExit)) return;
        expect(Option.getOrThrow(Cause.findErrorOption(invalidImageExit.cause))).toMatchObject({
          _tag: "PreviewArtifactImageLoadError",
          artifactPath,
        });
      }),
    ),
  );

  effectIt.effect("emits the resolved pointer target before dispatching an automation click", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const activity: string[] = [];
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
            activity.push("mousePressed");
            humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.subscribePointerEvents((event) =>
          Effect.sync(() => {
            activity.push(event.phase);
          }),
        );
        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        yield* Fiber.join(click);

        expect(activity).toEqual(["move", "click", "mousePressed"]);
        expect(
          sendCommand.mock.calls
            .filter(([method]) => method === "Input.dispatchMouseEvent")
            .map(([, params]) => params?.type),
        ).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mouseMoved",
          x: 120,
          y: 80,
          button: "none",
        });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
        expect(sendCommand).toHaveBeenCalledWith("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x: 120,
          y: 80,
          button: "left",
          clickCount: 1,
        });
      }),
    ),
  );

  effectIt.effect("keeps Playwright out of the main world and renews it after navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const listeners = new Map<string, (...args: unknown[]) => void>();
        let nextExecutionContextId = 100;
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { id: "main-frame" } } };
          }
          if (method === "Page.createIsolatedWorld") {
            nextExecutionContextId += 1;
            return { executionContextId: nextExecutionContextId };
          }
          if (method !== "Runtime.evaluate") return undefined;
          const expression = String(params?.["expression"] ?? "");
          if (expression.includes("const module = { exports: {} };")) {
            return { result: { value: true } };
          }
          if (expression === "Boolean(globalThis.__t3PlaywrightInjected)") {
            return { result: { value: false } };
          }
          if (expression.includes("target.scrollBy")) {
            return { result: { value: { ok: true } } };
          }
          return { result: { value: null } };
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            listeners.set(event, listener);
          }),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_utility_world");
        yield* manager.registerWebview("tab_utility_world", 42);
        yield* manager.automationScroll("tab_utility_world", {
          selector: "#target",
          deltaY: 10,
        });
        yield* manager.automationScroll("tab_utility_world", {
          selector: "#target",
          deltaY: 20,
        });
        expect(
          yield* manager.automationEvaluate("tab_utility_world", {
            expression: "Boolean(globalThis.__t3PlaywrightInjected)",
          }),
        ).toBe(false);

        listeners.get("did-start-navigation")?.(
          {} as Electron.Event,
          "https://example.com/next",
          false,
          true,
        );
        yield* manager.automationScroll("tab_utility_world", {
          selector: "#target",
          deltaY: 30,
        });

        const isolatedWorldCalls = sendCommand.mock.calls.filter(
          ([method]) => method === "Page.createIsolatedWorld",
        );
        expect(isolatedWorldCalls).toEqual([
          [
            "Page.createIsolatedWorld",
            { frameId: "main-frame", worldName: "t3-preview-playwright" },
          ],
          [
            "Page.createIsolatedWorld",
            { frameId: "main-frame", worldName: "t3-preview-playwright" },
          ],
        ]);
        const runtimeEvaluations = sendCommand.mock.calls.filter(
          ([method]) => method === "Runtime.evaluate",
        );
        const installEvaluations = runtimeEvaluations.filter(([, params]) =>
          String(params?.["expression"] ?? "").includes("const module = { exports: {} };"),
        );
        expect(installEvaluations.map(([, params]) => params?.["contextId"])).toEqual([101, 102]);
        expect(installEvaluations.every(([, params]) => params?.["userGesture"] === false)).toBe(
          true,
        );
        const locatorEvaluations = runtimeEvaluations.filter(([, params]) =>
          String(params?.["expression"] ?? "").includes("target.scrollBy"),
        );
        expect(locatorEvaluations.map(([, params]) => params?.["contextId"])).toEqual([
          101, 101, 102,
        ]);
        const mainWorldEvaluation = runtimeEvaluations.find(
          ([, params]) => params?.["expression"] === "Boolean(globalThis.__t3PlaywrightInjected)",
        );
        expect(mainWorldEvaluation?.[1]).toMatchObject({
          userGesture: false,
          returnByValue: true,
        });
        expect(mainWorldEvaluation?.[1]).not.toHaveProperty("contextId");
      }),
    ),
  );

  effectIt.effect(
    "uses native CDP text input in background webviews and preserves key cleanup",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let failKeyDown = false;
          let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
          const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
            if (
              failKeyDown &&
              method === "Input.dispatchKeyEvent" &&
              (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
            ) {
              throw new Error("key dispatch failed");
            }
            if (
              method === "Input.dispatchKeyEvent" &&
              (params?.["type"] === "keyDown" || params?.["type"] === "rawKeyDown")
            ) {
              humanInput?.(
                {},
                {
                  kind: "key",
                  key: params["key"],
                  code: params["code"] ?? "Digit1",
                },
              );
            }
            return method === "Runtime.evaluate" ? { result: { value: { ok: true } } } : undefined;
          });
          const restoreFocus = vi.fn();
          const previousFocusTarget = {
            id: 7,
            isDestroyed: () => false,
            focus: restoreFocus,
          };
          // Model focus faithfully rather than pinning one answer: focusing the
          // guest makes it the focused WebContents, which is exactly what the
          // restore guard reads back after the dispatch.
          let focusedWebContents: { id: number } | null = previousFocusTarget;
          const focus = vi.fn(() => {
            focusedWebContents = { id: 42 };
          });
          restoreFocus.mockImplementation(() => {
            focusedWebContents = previousFocusTarget;
          });
          getFocusedWebContents.mockImplementation(() => focusedWebContents as never);
          fromId.mockReturnValue({
            id: 42,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://example.com",
            getTitle: () => "Example",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            focus,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            ipc: {
              on: vi.fn((channel: string, listener: typeof humanInput) => {
                if (channel === "preview:human-input") humanInput = listener;
              }),
              off: vi.fn(),
            },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
          } as never);

          yield* manager.createTab("tab_input");
          yield* manager.registerWebview("tab_input", 42);
          yield* manager.automationType("tab_input", { text: "hello", clear: true });
          yield* manager.automationType("tab_input", { text: "", clear: true });
          yield* manager.automationPress("tab_input", { key: "x" });

          const calls = sendCommand.mock.calls;
          const methods = calls.map(([method]) => method);
          const enableIndex = methods.indexOf("Input.setIgnoreInputEvents");
          const focusOnIndex = calls.findIndex(
            ([method, params]) =>
              method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === true,
          );
          const xKeyDownIndex = calls.findIndex(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" &&
              params?.["type"] === "keyDown" &&
              params?.["key"] === "x",
          );
          const xKeyUpIndex = calls.findIndex(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" &&
              params?.["type"] === "keyUp" &&
              params?.["key"] === "x",
          );
          const focusOffIndex = calls.findIndex(
            ([method, params]) =>
              method === "Emulation.setFocusEmulationEnabled" && params?.["enabled"] === false,
          );
          const insertTextIndex = calls.findIndex(
            ([method, params]) => method === "Input.insertText" && params?.["text"] === "hello",
          );
          const backspaceDownIndex = calls.findIndex(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" &&
              params?.["type"] === "rawKeyDown" &&
              params?.["key"] === "Backspace",
          );
          const backspaceUpIndex = calls.findIndex(
            ([method, params]) =>
              method === "Input.dispatchKeyEvent" &&
              params?.["type"] === "keyUp" &&
              params?.["key"] === "Backspace",
          );
          const legacyTypingExpressions = calls.filter(
            ([method, params]) =>
              method === "Runtime.evaluate" &&
              typeof params?.["expression"] === "string" &&
              [
                "execCommand",
                "Object.getOwnPropertyDescriptor",
                "InputEvent",
                "dispatchEvent",
              ].some((legacy) => (params["expression"] as string).includes(legacy)),
          );
          expect(legacyTypingExpressions).toEqual([]);
          expect(sendCommand).toHaveBeenCalledWith("Input.insertText", { text: "hello" });
          expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
            type: "rawKeyDown",
            key: "Backspace",
            code: "Backspace",
            modifiers: 0,
            windowsVirtualKeyCode: 8,
            location: 0,
            isKeypad: false,
          });
          expect(enableIndex).toBeGreaterThanOrEqual(0);
          // Focus emulation alone does not deliver `Input.insertText` to a
          // hidden guest, so the guest must really be focused for the dispatch
          // and handed back afterwards.
          expect(focus).toHaveBeenCalledTimes(3);
          expect(restoreFocus).toHaveBeenCalledTimes(3);
          expect(methods).toContain("Page.bringToFront");
          expect(enableIndex).toBeLessThan(focusOnIndex);
          expect(focusOnIndex).toBeLessThan(insertTextIndex);
          expect(insertTextIndex).toBeLessThan(focusOffIndex);
          expect(backspaceDownIndex).toBeGreaterThan(insertTextIndex);
          expect(backspaceDownIndex).toBeLessThan(backspaceUpIndex);
          expect(xKeyDownIndex).toBeLessThan(xKeyUpIndex);
          expect(
            calls.filter(
              ([method, params]) =>
                method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
            ),
          ).toHaveLength(2);
          expect(sendCommand).toHaveBeenCalledWith("Input.setIgnoreInputEvents", { ignore: false });

          // A user clicking into the visible preview mid-dispatch must win.
          // Handing focus back to whoever held it before would drop their next
          // keystroke or paste into the composer instead of the page.
          const restoreCallsBeforeStolenFocus = restoreFocus.mock.calls.length;
          focus.mockImplementationOnce(() => {
            focusedWebContents = { id: 99 };
          });
          yield* manager.automationPress("tab_input", { key: "z" });
          expect(restoreFocus.mock.calls.length).toBe(restoreCallsBeforeStolenFocus);
          focusedWebContents = previousFocusTarget;

          sendCommand.mockClear();
          failKeyDown = true;
          const failedPress = yield* Effect.exit(
            manager.automationPress("tab_input", { key: "y" }),
          );

          expect(Exit.isFailure(failedPress)).toBe(true);
          expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
            type: "keyUp",
            key: "y",
            code: "KeyY",
            modifiers: 0,
            windowsVirtualKeyCode: 89,
            location: 0,
            isKeypad: false,
          });
          expect(sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
            enabled: false,
          });
          expect(restoreFocus).toHaveBeenCalledTimes(4);
          expect(
            sendCommand.mock.calls.filter(
              ([method, params]) =>
                method === "Input.dispatchKeyEvent" && params?.["type"] === "keyUp",
            ),
          ).toHaveLength(1);

          sendCommand.mockClear();
          failKeyDown = false;
          yield* manager.automationPress("tab_input", { key: "!" });
          expect(sendCommand).toHaveBeenCalledWith("Input.dispatchKeyEvent", {
            type: "keyDown",
            key: "!",
            code: "Digit1",
            modifiers: 0,
            windowsVirtualKeyCode: 49,
            location: 0,
            isKeypad: false,
            text: "!",
            unmodifiedText: "!",
          });
          expect(restoreFocus).toHaveBeenCalledTimes(5);
        }),
      ),
  );

  effectIt.effect("uploads local files through a page file input without an OS picker", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Page.getFrameTree") {
            return { frameTree: { frame: { id: "drive-main-frame" } } };
          }
          if (method === "Page.createIsolatedWorld") return { executionContextId: 77 };
          if (method !== "Runtime.evaluate") return undefined;
          if (String(params?.["expression"] ?? "").includes("const module = { exports: {} };")) {
            return { result: { value: true } };
          }
          return params?.["returnByValue"] === false
            ? { result: { objectId: "file-input-object" } }
            : { result: { value: { ok: true } } };
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://drive.google.com",
          getTitle: () => "Drive",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_upload");
        yield* manager.registerWebview("tab_upload", 42);
        const result = yield* manager.automationUpload("tab_upload", {
          paths: ["/tmp/MedXRNativePrototype.apk"],
          selector: "input[type='file']",
        });

        expect(result).toEqual({
          fileCount: 1,
          fileNames: ["MedXRNativePrototype.apk"],
        });
        expect(sendCommand).toHaveBeenCalledWith("DOM.setFileInputFiles", {
          files: ["/tmp/MedXRNativePrototype.apk"],
          objectId: "file-input-object",
        });
        expect(
          sendCommand.mock.calls
            .filter(
              ([method, params]) =>
                method === "Runtime.evaluate" &&
                String(params?.["expression"] ?? "").includes("__t3PlaywrightInjected"),
            )
            .every(
              ([, params]) => params?.["contextId"] === 77 && params?.["userGesture"] === false,
            ),
        ).toBe(true);
      }),
    ),
  );

  effectIt.effect("still interrupts agent control for a different human pointer event", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: { width: 800, height: 600 },
              },
            };
          }
          if (method === "Input.dispatchMouseEvent") {
            humanInput?.({}, { kind: "pointer", x: 400, y: 300, button: 0 });
          }
          return undefined;
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: {
            on: vi.fn((channel: string, listener: typeof humanInput) => {
              if (channel === "preview:human-input") humanInput = listener;
            }),
            off: vi.fn(),
          },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);

        const click = yield* manager
          .automationClick("tab_1", { x: 120, y: 80 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust(200);
        const exit = yield* Fiber.await(click);
        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationControlInterruptedError",
          operation: "click",
          tabId: "tab_1",
          webContentsId: 42,
        });
        expect(error).toBeInstanceOf(Error);
        if (error instanceof Error) {
          expect(error.name).toBe("PreviewAutomationControlInterruptedError");
        }
        expect("cause" in error).toBe(false);
      }),
    ),
  );

  effectIt.effect("derives evaluation detail kind and length from the same non-empty source", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const text = "ReferenceError: fallbackDetail is not defined";
        const exceptionDetails = {
          text,
          exception: { description: "" },
        };
        const sendCommand = vi.fn(async (method: string) =>
          method === "Runtime.evaluate" ? { exceptionDetails } : undefined,
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.createTab("tab_1");
        yield* manager.registerWebview("tab_1", 42);
        const exit = yield* Effect.exit(
          manager.automationEvaluate("tab_1", { expression: "fallbackDetail" }),
        );

        expect(Exit.isFailure(exit)).toBe(true);
        if (Exit.isSuccess(exit)) return;
        const error = Option.getOrThrow(Cause.findErrorOption(exit.cause));
        expect(error).toMatchObject({
          _tag: "PreviewAutomationEvaluationError",
          detailKind: "exception-text",
          detailLength: text.length,
          cause: exceptionDetails,
        });
      }),
    ),
  );
});

describe("PreviewOperationError", () => {
  it("keeps timeline detail separate from its structured message", () => {
    const cause = new Error("CDP command failed with an invalid node id");
    const error = new PreviewManager.PreviewOperationError({
      operation: "click.DOM.resolveNode",
      tabId: "tab_1",
      webContentsId: 42,
      cause,
    });

    expect(error.message).not.toContain(cause.message);
    expect(PreviewManager.PreviewOperationError.toTimelineMessage(error)).toBe(cause.message);
  });
});

describe("Preview automation diagnostics", () => {
  it("keeps browser exception detail out of structural diagnostics", () => {
    const secret = "unrelated-browser-payload-secret";
    const detail = "ReferenceError: missingValue is not defined";
    const cause = {
      text: "Uncaught Error",
      exception: { description: detail },
      unsafePayload: secret,
    };
    const error = new PreviewManager.PreviewAutomationEvaluationError({
      tabId: "tab_1",
      detailKind: "exception-description",
      detailLength: detail.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error.message).toBe("Preview JavaScript evaluation failed in tab tab_1");
    expect(error.message).not.toContain(secret);
    expect(JSON.stringify(encodedDiagnostics)).not.toContain(secret);
    expect("detail" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).toBe(detail);
    expect(PreviewManager.PreviewAutomationEvaluationError.toTimelineMessage(error)).not.toContain(
      secret,
    );
  });

  it("retains bounded selector diagnostics without exposing selector or reason text", () => {
    const selector = "role=button[name='selector-secret']";
    const reason = "Unexpected token near reason-secret";
    const cause = { invalidSelector: true as const, message: reason };
    const error = new PreviewManager.PreviewAutomationInvalidSelectorError({
      operation: "click",
      tabId: "tab_1",
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
      cause,
    });

    const encoded = encodePreviewManagerError(error);
    const { cause: encodedCause, ...encodedDiagnostics } = encoded as typeof encoded & {
      readonly cause?: unknown;
    };

    expect(error.cause).toBe(cause);
    expect(encodedCause).toStrictEqual(cause);
    expect(error).toMatchObject({
      selectorKind: "locator",
      selectorLength: selector.length,
      reasonLength: reason.length,
    });
    expect(error.detail).toEqual({
      selectorKind: "locator",
      selectorLength: selector.length,
    });
    expect(error.message).not.toContain("secret");
    expect(JSON.stringify(encodedDiagnostics)).not.toContain("secret");
    expect("selector" in error).toBe(false);
    expect("reason" in error).toBe(false);
    expect(PreviewManager.PreviewAutomationInvalidSelectorError.toTimelineMessage(error)).toBe(
      reason,
    );
  });

  it("does not retain a missing target locator", () => {
    const selector = "[data-token='target-secret']";
    const error = new PreviewManager.PreviewAutomationTargetNotFoundError({
      operation: "scroll",
      tabId: "tab_1",
      selectorKind: "selector",
      selectorLength: selector.length,
    });

    expect(error.message).not.toContain(selector);
    expect(JSON.stringify(error)).not.toContain(selector);
    expect("locator" in error).toBe(false);
  });
});
