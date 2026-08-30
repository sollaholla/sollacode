import { it as effectIt } from "@effect/vitest";
import type { DesktopPreviewRecordingFrame, PreviewDownload } from "@t3tools/contracts";
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

describe("interpolateDragMoves", () => {
  it("inserts evenly spaced moves that land exactly on each vertex", () => {
    const moves = PreviewManager.interpolateDragMoves(
      [
        { x: 0, y: 0 },
        { x: 8, y: 4 },
      ],
      4,
    );
    expect(moves).toEqual([
      { x: 2, y: 1 },
      { x: 4, y: 2 },
      { x: 6, y: 3 },
      { x: 8, y: 4 },
    ]);
  });

  it("chains segments across a multi-point path so the stroke stays continuous", () => {
    const moves = PreviewManager.interpolateDragMoves(
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
      ],
      2,
    );
    expect(moves).toEqual([
      { x: 5, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 10, y: 10 },
    ]);
  });

  it("still produces a single closing move when steps collapse to one", () => {
    expect(
      PreviewManager.interpolateDragMoves(
        [
          { x: 3, y: 3 },
          { x: 9, y: 12 },
        ],
        1,
      ),
    ).toEqual([{ x: 9, y: 12 }]);
  });
});

const {
  browserWindowConstructor,
  createFromBuffer,
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
  createFromBuffer: vi.fn((data: Buffer) => ({
    getSize: () => ({ width: 800, height: 600 }),
    resize: () => {
      throw new Error("unexpected resize");
    },
    toJPEG: () => {
      throw new Error(`unexpected debugger JPEG re-encode: ${data.byteLength}`);
    },
  })),
  createFromPath: vi.fn((): { readonly isEmpty: () => boolean } => ({ isEmpty: () => false })),
  fromId: vi.fn((_id?: number): Electron.WebContents | null => null),
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
    createFromBuffer,
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

/** Captured so a test can land a file the way a real download would. */
let downloadListener: ((webContentsId: number, download: PreviewDownload) => void) | null = null;

/** Captured so a test can raise a hold the way a real download would. */
let downloadApprovalListener:
  | ((webContentsId: number, event: BrowserSession.DownloadApprovalEvent) => void)
  | null = null;
const answeredDownloadApprovals: Array<{ readonly id: string; readonly decision: string }> = [];

const browserSessionLayer = Layer.succeed(
  BrowserSession.BrowserSession,
  BrowserSession.BrowserSession.of({
    setDownloadDirectory: () => Effect.void,
    recentDownloads: () => [],
    onDownload: (listener) => {
      downloadListener = listener;
    },
    onDownloadApproval: (listener) => {
      downloadApprovalListener = listener;
    },
    answerDownloadApproval: (id, decision) => {
      answeredDownloadApprovals.push({ id, decision });
    },
    getPartition: () => Effect.succeed("persist:t3code-preview-test"),
    isPartition: (partition) => partition.startsWith("persist:t3code-preview-"),
    adoptLegacyProfile: () => Effect.void,
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
    createFromBuffer.mockClear();
    createFromPath.mockClear();
    webviewSend.mockClear();
    answeredDownloadApprovals.length = 0;
  });

  effectIt.effect("does not treat an empty hold list at the start of the wait as settled", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const webContents = makeTestPreviewWebContents(() =>
          Promise.reject(new Error("no capture in this test")),
        );
        fromId.mockImplementation((id) => (id === 42 ? webContents : null));
        yield* manager.createTab("tab_wait_race");
        yield* manager.registerWebview("tab_wait_race", 42);

        const waiting = yield* manager
          .automationWaitForDownload("tab_wait_race", { timeoutMs: 10_000 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("300 millis");

        downloadApprovalListener?.(42, {
          kind: "pending",
          approval: { id: "download-approval-race", domain: "grok.com", fileName: "clip.mp4" },
        });
        downloadListener?.(42, {
          fileName: "clip.mp4",
          path: "/workspace/downloads/clip.mp4",
          completedAt: "2026-08-28T00:00:00.000Z",
          succeeded: true,
        });
        downloadApprovalListener?.(42, { kind: "settled", id: "download-approval-race" });
        yield* TestClock.adjust("300 millis");

        const result = yield* Fiber.join(waiting);
        expect(result.settled).toBe(true);
        expect(result.outcome).toBe("downloaded");
        expect(result.downloads.map((download) => download.path)).toEqual([
          "/workspace/downloads/clip.mp4",
        ]);
      }),
    ),
  );

  effectIt.effect("waits out a held download and reports the file the user allowed", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        // A held download is indistinguishable from a slow one in a snapshot,
        // so without this an agent polls and cannot tell it is waiting on a
        // person rather than a server.
        const webContents = makeTestPreviewWebContents(() =>
          Promise.reject(new Error("no capture in this test")),
        );
        fromId.mockImplementation((id) => (id === 42 ? webContents : null));
        yield* manager.createTab("tab_wait");
        yield* manager.registerWebview("tab_wait", 42);
        downloadApprovalListener?.(42, {
          kind: "pending",
          approval: { id: "download-approval-1", domain: "grok.com", fileName: "clip.mp4" },
        });

        const waiting = yield* manager
          .automationWaitForDownload("tab_wait", { timeoutMs: 10_000 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        // One poll with the hold still open, so the wait is genuinely parked
        // rather than returning before the question was ever asked.
        yield* TestClock.adjust("300 millis");

        // Answering "allow" lands the file and clears the hold.
        downloadListener?.(42, {
          fileName: "clip.mp4",
          path: "/workspace/downloads/clip.mp4",
          completedAt: "2026-08-27T00:00:00.000Z",
          succeeded: true,
        });
        downloadApprovalListener?.(42, { kind: "settled", id: "download-approval-1" });
        yield* TestClock.adjust("300 millis");

        const result = yield* Fiber.join(waiting);
        expect(result.settled).toBe(true);
        expect(result.outcome).toBe("downloaded");
        expect(result.downloads.map((download) => download.path)).toEqual([
          "/workspace/downloads/clip.mp4",
        ]);
      }),
    ),
  );

  effectIt.effect("stops waiting when a held download is refused, with no file", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const webContents = makeTestPreviewWebContents(() =>
          Promise.reject(new Error("no capture in this test")),
        );
        fromId.mockImplementation((id) => (id === 42 ? webContents : null));
        yield* manager.createTab("tab_wait_deny");
        yield* manager.registerWebview("tab_wait_deny", 42);
        downloadApprovalListener?.(42, {
          kind: "pending",
          approval: { id: "download-approval-2", domain: "evil.test", fileName: "payload.bin" },
        });

        const waiting = yield* manager
          .automationWaitForDownload("tab_wait_deny", { timeoutMs: 10_000 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("300 millis");

        // A refusal settles the hold without producing a file. The wait has to
        // end on that too, or the agent hangs until its timeout on a decision
        // that has already been made.
        downloadApprovalListener?.(42, { kind: "settled", id: "download-approval-2" });
        yield* TestClock.adjust("300 millis");

        const result = yield* Fiber.join(waiting);
        expect(result.settled).toBe(true);
        expect(result.outcome).toBe("denied");
        expect(result.downloads).toEqual([]);
      }),
    ),
  );

  effectIt.effect("reports waiting instead of failure when the user has not answered yet", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const webContents = makeTestPreviewWebContents(() =>
          Promise.reject(new Error("no capture in this test")),
        );
        fromId.mockImplementation((id) => (id === 42 ? webContents : null));
        yield* manager.createTab("tab_wait_timeout");
        yield* manager.registerWebview("tab_wait_timeout", 42);
        downloadApprovalListener?.(42, {
          kind: "pending",
          approval: { id: "download-approval-wait", domain: "grok.com", fileName: "clip.mp4" },
        });

        const waiting = yield* manager
          .automationWaitForDownload("tab_wait_timeout", { timeoutMs: 250 })
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("300 millis");

        const result = yield* Fiber.join(waiting);
        expect(result.settled).toBe(false);
        expect(result.outcome).toBe("waiting");
        expect(result.message).toContain("Do not retry");
        expect(result.message).toContain("AGENT_STOP");
        expect(result.pendingDownloadApprovals).toEqual([
          { id: "download-approval-wait", domain: "grok.com", fileName: "clip.mp4" },
        ]);
      }),
    ),
  );

  effectIt.effect("fills PDF snapshot text from a child-frame accessibility tree", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const png = Buffer.from("pdf-plugin-frame").toString("base64");
        const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
          if (method === "Runtime.evaluate") {
            return {
              result: {
                value: {
                  url: "https://example.com/paper.pdf",
                  title: "paper.pdf",
                  loading: false,
                  visibleText: "",
                  documentKind: "pdf",
                  viewportWidth: 1280,
                  viewportHeight: 800,
                  interactiveElements: [],
                  structuralElements: [],
                },
              },
            };
          }
          if (method === "Page.getFrameTree") {
            return {
              frameTree: {
                frame: { id: "main" },
                childFrames: [{ frame: { id: "pdf-plugin" } }],
              },
            };
          }
          if (method === "Accessibility.getFullAXTree") {
            if (params?.["frameId"] === "pdf-plugin") {
              return {
                nodes: [
                  {
                    role: { value: "StaticText" },
                    name: { value: "Trace-based Just-in-Time" },
                  },
                ],
              };
            }
            return { nodes: [{ role: { value: "Iframe" }, name: { value: "" } }] };
          }
          if (method === "Page.captureScreenshot") return { data: png };
          return {};
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com/paper.pdf",
          getTitle: () => "paper.pdf",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          session: {},
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
          invalidate: vi.fn(),
          beginFrameSubscription: vi.fn(),
          endFrameSubscription: vi.fn(),
          capturePage: vi.fn(),
        } as never);

        yield* manager.createTab("tab_pdf_ax");
        yield* manager.registerWebview("tab_pdf_ax", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          webContents: { isDestroyed: () => false, on: vi.fn(), off: vi.fn() },
        } as never);

        const snapshot = yield* manager.automationSnapshot("tab_pdf_ax");
        expect(snapshot.documentKind).toBe("pdf");
        expect(snapshot.visibleText).toContain("Trace-based Just-in-Time");
        expect(sendCommand).toHaveBeenCalledWith("Page.enable", undefined);
        expect(sendCommand).toHaveBeenCalledWith("Page.getFrameTree", undefined);
        expect(sendCommand).toHaveBeenCalledWith("Accessibility.getFullAXTree", {
          frameId: "pdf-plugin",
        });
      }),
    ),
  );

  effectIt.effect("refuses a held download when the tab asking about it closes", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        // The card asking the question lives on the tab. Closing it without
        // this leaves a question nobody can answer and staged bytes nothing
        // will ever move or remove.
        const webContents = makeTestPreviewWebContents(() =>
          Promise.reject(new Error("no capture in this test")),
        );
        fromId.mockImplementation((id) => (id === 42 ? webContents : null));

        yield* manager.createTab("tab_hold");
        yield* manager.registerWebview("tab_hold", 42);
        downloadApprovalListener?.(42, {
          kind: "pending",
          approval: { id: "download-approval-1", domain: "grok.com", fileName: "clip.mp4" },
        });

        yield* manager.closeTab("tab_hold");

        expect(answeredDownloadApprovals).toEqual([
          { id: "download-approval-1", decision: "deny" },
        ]);
      }),
    ),
  );

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

  effectIt.effect("dispatches navigation without waiting for a background load to settle", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(() => new Promise<void>(() => undefined));
        const listeners = new Map<string, (...args: never[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://instagram.com/",
          getTitle: () => "Instagram",
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

        yield* manager.createTab("tab_background_navigation");
        yield* manager.registerWebview("tab_background_navigation", 42);
        yield* manager.navigate("tab_background_navigation", "https://youtube.com/");

        expect(loadURL).toHaveBeenCalledWith("https://youtube.com/");
        // Electron can deliver title/stop callbacks queued by Instagram after
        // the YouTube load was dispatched but before its first start event.
        listeners.get("page-title-updated")?.();
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_background_navigation")).toMatchObject({
          url: "https://youtube.com/",
          title: "Instagram",
          loading: true,
        });
      }),
    ),
  );

  effectIt.effect(
    "foregrounds every live tab immediately and releases the fleet one minute after activity",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const guests = new Map<
            number,
            {
              readonly setBackgroundThrottling: ReturnType<typeof vi.fn>;
              readonly invalidate: ReturnType<typeof vi.fn>;
              readonly sendCommand: ReturnType<typeof vi.fn>;
              readonly webContents: Electron.WebContents;
            }
          >();
          const makeGuest = (id: number) => {
            const setBackgroundThrottling = vi.fn();
            const invalidate = vi.fn();
            const sendCommand = vi.fn(
              async (_method: string, _params?: Record<string, unknown>): Promise<unknown> =>
                undefined,
            );
            const webContents = {
              id,
              isDestroyed: () => false,
              getType: () => "webview",
              getURL: () => `https://example-${id}.com/`,
              getTitle: () => `Example ${id}`,
              isLoading: () => false,
              isDevToolsOpened: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              setBackgroundThrottling,
              invalidate,
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
            } as unknown as Electron.WebContents;
            const guest = { setBackgroundThrottling, invalidate, sendCommand, webContents };
            guests.set(id, guest);
            return guest;
          };
          const first = makeGuest(41);
          const second = makeGuest(42);
          fromId.mockImplementation((id) =>
            id === undefined ? null : (guests.get(id)?.webContents ?? null),
          );

          yield* manager.createTab("tab_first");
          yield* manager.registerWebview("tab_first", 41);
          yield* manager.createTab("tab_second");
          yield* manager.registerWebview("tab_second", 42);
          yield* manager.renewAutomationForeground();

          for (const guest of [first, second]) {
            expect(guest.setBackgroundThrottling).toHaveBeenCalledWith(false);
            expect(guest.invalidate).toHaveBeenCalledOnce();
            expect(guest.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
              enabled: true,
            });
          }

          // A guest attached after the lease starts inherits foreground
          // semantics before registration completes.
          const third = makeGuest(43);
          yield* manager.createTab("tab_third");
          yield* manager.registerWebview("tab_third", 43);
          expect(third.setBackgroundThrottling).toHaveBeenCalledWith(false);
          expect(third.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
            enabled: true,
          });

          // A renewal resets the one-minute idle boundary without repeating
          // expensive debugger work for guests that are already foregrounded.
          yield* TestClock.adjust(59_000);
          yield* manager.renewAutomationForeground();
          expect(first.invalidate).toHaveBeenCalledOnce();
          yield* TestClock.adjust(59_999);
          yield* Effect.yieldNow;
          expect(
            first.sendCommand.mock.calls.some(
              ([method, params]) =>
                method === "Emulation.setFocusEmulationEnabled" && params?.enabled === false,
            ),
          ).toBe(false);

          yield* TestClock.adjust(1);
          yield* Effect.yieldNow;
          for (const guest of [first, second, third]) {
            expect(guest.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
              enabled: false,
            });
          }

          // The first request after idling reactivates every tab before its
          // preview operation can continue.
          yield* manager.renewAutomationForeground();
          for (const guest of [first, second, third]) {
            const focusCalls = guest.sendCommand.mock.calls.filter(
              ([method]) => method === "Emulation.setFocusEmulationEnabled",
            );
            expect(focusCalls.at(-1)?.[1]).toEqual({ enabled: true });
          }
        }),
      ),
  );

  effectIt.effect("reactivates a tab whose registration crosses the foreground lease expiry", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let resolveActivationStarted: (() => void) | undefined;
        let resolveActivation: (() => void) | undefined;
        const activationStarted = new Promise<void>((resolve) => {
          resolveActivationStarted = resolve;
        });
        const continueActivation = new Promise<void>((resolve) => {
          resolveActivation = resolve;
        });
        let blockLateGuestActivation = true;
        const guests = new Map<number, Electron.WebContents>();
        const makeGuest = (id: number) => {
          const invalidate = vi.fn();
          const sendCommand = vi.fn(
            async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              if (
                id === 42 &&
                blockLateGuestActivation &&
                method === "Emulation.setFocusEmulationEnabled" &&
                params?.enabled === true
              ) {
                blockLateGuestActivation = false;
                resolveActivationStarted?.();
                await continueActivation;
              }
              return undefined;
            },
          );
          const webContents = {
            id,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => `https://example-${id}.com/`,
            getTitle: () => `Example ${id}`,
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            invalidate,
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
          } as unknown as Electron.WebContents;
          guests.set(id, webContents);
          return { invalidate, sendCommand };
        };
        makeGuest(41);
        const lateGuest = makeGuest(42);
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));

        yield* manager.createTab("tab_initial");
        yield* manager.registerWebview("tab_initial", 41);
        yield* manager.renewAutomationForeground();
        yield* TestClock.adjust(59_999);

        yield* manager.createTab("tab_late");
        const registration = yield* Effect.forkChild(manager.registerWebview("tab_late", 42), {
          startImmediately: true,
        });
        yield* Effect.promise(() => activationStarted);

        // Expiry is now queued behind the registration activation. Before
        // this handoff was serialized, release cleared the fleet and the
        // late activation added a stale id after it had already finished.
        yield* TestClock.adjust(1);
        yield* Effect.yieldNow;
        resolveActivation?.();
        yield* Fiber.join(registration);
        yield* Effect.yieldNow;

        yield* manager.renewAutomationForeground();
        const enabledCalls = lateGuest.sendCommand.mock.calls.filter(
          ([method, params]) =>
            method === "Emulation.setFocusEmulationEnabled" && params?.enabled === true,
        );
        expect(enabledCalls).toHaveLength(2);
        expect(lateGuest.invalidate).toHaveBeenCalledTimes(2);
      }),
    ),
  );

  effectIt.effect(
    "isolates DevTools and external-debugger conflicts from the foreground fleet",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const guests = new Map<
            number,
            {
              readonly invalidate: ReturnType<typeof vi.fn>;
              readonly sendCommand: ReturnType<typeof vi.fn>;
              readonly webContents: Electron.WebContents;
            }
          >();
          const makeGuest = (id: number, debuggerOwner: "none" | "devtools" | "external") => {
            const invalidate = vi.fn();
            const sendCommand = vi.fn(async (): Promise<unknown> => undefined);
            const webContents = {
              id,
              isDestroyed: () => false,
              getType: () => "webview",
              getURL: () => `https://example-${id}.com/`,
              getTitle: () => `Example ${id}`,
              isLoading: () => false,
              isDevToolsOpened: () => debuggerOwner === "devtools",
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              setBackgroundThrottling: vi.fn(),
              invalidate,
              on: vi.fn(),
              off: vi.fn(),
              ipc: { on: vi.fn(), off: vi.fn() },
              send: webviewSend,
              navigationHistory: { canGoBack: () => false, canGoForward: () => false },
              setWindowOpenHandler: vi.fn(),
              debugger: {
                isAttached: () => debuggerOwner === "external",
                attach: vi.fn(),
                detach: vi.fn(),
                sendCommand,
                on: vi.fn(),
                off: vi.fn(),
              },
            } as unknown as Electron.WebContents;
            const guest = { invalidate, sendCommand, webContents };
            guests.set(id, guest);
            return guest;
          };
          makeGuest(41, "devtools");
          makeGuest(42, "external");
          const healthy = makeGuest(43, "none");
          fromId.mockImplementation((id) =>
            id === undefined ? null : (guests.get(id)?.webContents ?? null),
          );

          yield* manager.createTab("tab_devtools");
          yield* manager.registerWebview("tab_devtools", 41);
          yield* manager.createTab("tab_external_debugger");
          yield* manager.registerWebview("tab_external_debugger", 42);
          yield* manager.createTab("tab_healthy");
          yield* manager.registerWebview("tab_healthy", 43);

          const renewal = yield* Effect.exit(manager.renewAutomationForeground());
          expect(Exit.isSuccess(renewal)).toBe(true);
          expect(yield* manager.automationStatus("tab_devtools")).toMatchObject({
            available: false,
          });
          expect(yield* manager.automationStatus("tab_external_debugger")).toMatchObject({
            available: false,
          });
          expect(yield* manager.automationStatus("tab_healthy")).toMatchObject({
            available: true,
          });
          expect(healthy.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
            enabled: true,
          });
          expect(healthy.invalidate).toHaveBeenCalledOnce();

          const repeatedDevToolsRegistration = yield* Effect.exit(
            manager.registerWebview("tab_devtools", 41),
          );
          expect(Exit.isSuccess(repeatedDevToolsRegistration)).toBe(true);
          expect(yield* manager.automationStatus("tab_devtools")).toMatchObject({
            available: false,
          });

          makeGuest(44, "external");
          const replacementRegistration = yield* Effect.exit(
            manager.registerWebview("tab_healthy", 44),
          );
          expect(Exit.isSuccess(replacementRegistration)).toBe(true);
          expect(yield* manager.automationStatus("tab_healthy")).toMatchObject({
            available: false,
          });

          const lateHealthy = makeGuest(45, "none");
          yield* manager.createTab("tab_late_healthy");
          const registration = yield* Effect.exit(manager.registerWebview("tab_late_healthy", 45));
          expect(Exit.isSuccess(registration)).toBe(true);
          expect(yield* manager.automationStatus("tab_late_healthy")).toMatchObject({
            available: true,
          });
          expect(lateHealthy.sendCommand).toHaveBeenCalledWith(
            "Emulation.setFocusEmulationEnabled",
            { enabled: true },
          );
        }),
      ),
  );

  effectIt.effect("isolates DevTools ownership acquired while the foreground fleet attaches", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let devToolsOpened = false;
        const racedDetach = vi.fn();
        const racedSendCommand = vi.fn(async (): Promise<unknown> => undefined);
        const healthySendCommand = vi.fn(async (): Promise<unknown> => undefined);
        const guests = new Map<number, Electron.WebContents>();
        guests.set(41, {
          id: 41,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://raced.example.com/",
          getTitle: () => "Raced",
          isLoading: () => false,
          isDevToolsOpened: () => devToolsOpened,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          invalidate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(() => {
              devToolsOpened = true;
              throw new Error("DevTools acquired the debugger");
            }),
            detach: racedDetach,
            sendCommand: racedSendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as unknown as Electron.WebContents);
        guests.set(42, {
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://healthy.example.com/",
          getTitle: () => "Healthy",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          invalidate: vi.fn(),
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
            sendCommand: healthySendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as unknown as Electron.WebContents);
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));

        yield* manager.createTab("tab_attach_race");
        yield* manager.registerWebview("tab_attach_race", 41);
        yield* manager.createTab("tab_attach_healthy");
        yield* manager.registerWebview("tab_attach_healthy", 42);

        const renewal = yield* Effect.exit(manager.renewAutomationForeground());
        expect(Exit.isSuccess(renewal)).toBe(true);
        expect(yield* manager.automationStatus("tab_attach_race")).toMatchObject({
          available: false,
        });
        expect(yield* manager.automationStatus("tab_attach_healthy")).toMatchObject({
          available: true,
        });
        expect(healthySendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });

        const direct = yield* Effect.exit(manager.automationSnapshot("tab_attach_race"));
        expect(Exit.isFailure(direct)).toBe(true);
        if (Exit.isFailure(direct)) {
          expect(Option.getOrThrow(Cause.findErrorOption(direct.cause))._tag).toBe(
            "PreviewAutomationDevToolsOpenError",
          );
        }
        expect(racedDetach).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect(
    "isolates debugger ownership acquired while an active registration initializes",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let debuggerOwner: "none" | "manager" | "external" = "none";
          let detachListener: ((event: Electron.Event, reason: string) => void) | undefined;
          let takeOverDuringInitialization = true;
          const racedDetach = vi.fn(() => {
            debuggerOwner = "none";
          });
          const racedOff = vi.fn((event: string, listener: typeof detachListener) => {
            if (event === "detach" && detachListener === listener) detachListener = undefined;
          });
          const racedSendCommand = vi.fn(async (method: string): Promise<unknown> => {
            if (method === "Runtime.enable" && takeOverDuringInitialization) {
              takeOverDuringInitialization = false;
              debuggerOwner = "external";
              detachListener?.({} as Electron.Event, "replaced_with_devtools");
              throw new Error("external debugger acquired the target");
            }
            return undefined;
          });
          const healthySendCommand = vi.fn(async (): Promise<unknown> => undefined);
          const guests = new Map<number, Electron.WebContents>();
          guests.set(41, {
            id: 41,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://initializing.example.com/",
            getTitle: () => "Initializing",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            invalidate: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => debuggerOwner !== "none",
              attach: vi.fn(() => {
                debuggerOwner = "manager";
              }),
              detach: racedDetach,
              sendCommand: racedSendCommand,
              on: vi.fn((event: string, listener: typeof detachListener) => {
                if (event === "detach") detachListener = listener;
              }),
              off: racedOff,
            },
          } as unknown as Electron.WebContents);
          guests.set(42, {
            id: 42,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://healthy.example.com/",
            getTitle: () => "Healthy",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            invalidate: vi.fn(),
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
              sendCommand: healthySendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
          } as unknown as Electron.WebContents);
          fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));

          yield* manager.renewAutomationForeground();
          yield* manager.createTab("tab_initialization_race");
          const racedRegistration = yield* Effect.exit(
            manager.registerWebview("tab_initialization_race", 41),
          );
          expect(Exit.isSuccess(racedRegistration)).toBe(true);
          expect(yield* manager.automationStatus("tab_initialization_race")).toMatchObject({
            available: false,
          });

          yield* manager.createTab("tab_initialization_healthy");
          const healthyRegistration = yield* Effect.exit(
            manager.registerWebview("tab_initialization_healthy", 42),
          );
          expect(Exit.isSuccess(healthyRegistration)).toBe(true);
          expect(yield* manager.automationStatus("tab_initialization_healthy")).toMatchObject({
            available: true,
          });
          expect(healthySendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
            enabled: true,
          });

          const direct = yield* Effect.exit(manager.automationSnapshot("tab_initialization_race"));
          expect(Exit.isFailure(direct)).toBe(true);
          if (Exit.isFailure(direct)) {
            expect(Option.getOrThrow(Cause.findErrorOption(direct.cause))._tag).toBe(
              "PreviewAutomationDebuggerAttachedError",
            );
          }
          expect(racedOff).toHaveBeenCalledWith("detach", expect.any(Function));
          expect(racedDetach).not.toHaveBeenCalled();
        }),
      ),
  );

  effectIt.effect(
    "rejects direct automation after successful initialization loses debugger ownership",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let debuggerOwner: "none" | "manager" | "external" = "none";
          let detachListener: ((event: Electron.Event, reason: string) => void) | undefined;
          let takeOverDuringInitialization = true;
          const detach = vi.fn(() => {
            debuggerOwner = "none";
          });
          const off = vi.fn((event: string, listener: typeof detachListener) => {
            if (event === "detach" && detachListener === listener) detachListener = undefined;
          });
          const sendCommand = vi.fn(async (method: string): Promise<unknown> => {
            if (method === "Runtime.enable" && takeOverDuringInitialization) {
              takeOverDuringInitialization = false;
              debuggerOwner = "external";
              detachListener?.({} as Electron.Event, "replaced_with_devtools");
            }
            return undefined;
          });
          fromId.mockReturnValue({
            id: 42,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://initializing.example.com/",
            getTitle: () => "Initializing",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            invalidate: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => debuggerOwner !== "none",
              attach: vi.fn(() => {
                debuggerOwner = "manager";
              }),
              detach,
              sendCommand,
              on: vi.fn((event: string, listener: typeof detachListener) => {
                if (event === "detach") detachListener = listener;
              }),
              off,
            },
          } as never);

          yield* manager.createTab("tab_direct_initialization_race");
          yield* manager.registerWebview("tab_direct_initialization_race", 42);
          const direct = yield* Effect.exit(
            manager.automationSnapshot("tab_direct_initialization_race"),
          );

          expect(Exit.isFailure(direct)).toBe(true);
          if (Exit.isFailure(direct)) {
            expect(Option.getOrThrow(Cause.findErrorOption(direct.cause))._tag).toBe(
              "PreviewAutomationDebuggerAttachedError",
            );
          }
          expect(
            sendCommand.mock.calls.every(([method]) =>
              ["Runtime.enable", "Accessibility.enable", "Network.enable", "Log.enable"].includes(
                method,
              ),
            ),
          ).toBe(true);
          expect(off).toHaveBeenCalledWith("detach", expect.any(Function));
          expect(detach).not.toHaveBeenCalled();
        }),
      ),
  );

  effectIt.effect(
    "does not publish readiness after a successful focus command loses debugger ownership",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let debuggerOwner: "none" | "manager" | "external" = "none";
          let detachListener: ((event: Electron.Event, reason: string) => void) | undefined;
          let takeOverDuringFocus = true;
          const racedDetach = vi.fn(() => {
            debuggerOwner = "none";
          });
          const racedOff = vi.fn((event: string, listener: typeof detachListener) => {
            if (event === "detach" && detachListener === listener) detachListener = undefined;
          });
          const racedSendCommand = vi.fn(
            async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
              if (
                method === "Emulation.setFocusEmulationEnabled" &&
                params?.enabled === true &&
                takeOverDuringFocus
              ) {
                takeOverDuringFocus = false;
                debuggerOwner = "external";
                detachListener?.({} as Electron.Event, "replaced_with_devtools");
              }
              return undefined;
            },
          );
          const healthySendCommand = vi.fn(async (): Promise<unknown> => undefined);
          const guests = new Map<number, Electron.WebContents>();
          guests.set(41, {
            id: 41,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://focus-race.example.com/",
            getTitle: () => "Focus race",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            invalidate: vi.fn(),
            on: vi.fn(),
            off: vi.fn(),
            ipc: { on: vi.fn(), off: vi.fn() },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setWindowOpenHandler: vi.fn(),
            debugger: {
              isAttached: () => debuggerOwner !== "none",
              attach: vi.fn(() => {
                debuggerOwner = "manager";
              }),
              detach: racedDetach,
              sendCommand: racedSendCommand,
              on: vi.fn((event: string, listener: typeof detachListener) => {
                if (event === "detach") detachListener = listener;
              }),
              off: racedOff,
            },
          } as unknown as Electron.WebContents);
          guests.set(42, {
            id: 42,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://healthy.example.com/",
            getTitle: () => "Healthy",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            invalidate: vi.fn(),
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
              sendCommand: healthySendCommand,
              on: vi.fn(),
              off: vi.fn(),
            },
          } as unknown as Electron.WebContents);
          fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));

          yield* manager.renewAutomationForeground();
          yield* manager.createTab("tab_focus_race");
          const racedRegistration = yield* Effect.exit(
            manager.registerWebview("tab_focus_race", 41),
          );
          expect(Exit.isSuccess(racedRegistration)).toBe(true);
          expect(yield* manager.automationStatus("tab_focus_race")).toMatchObject({
            available: false,
          });

          yield* manager.createTab("tab_focus_healthy");
          const healthyRegistration = yield* Effect.exit(
            manager.registerWebview("tab_focus_healthy", 42),
          );
          expect(Exit.isSuccess(healthyRegistration)).toBe(true);
          expect(yield* manager.automationStatus("tab_focus_healthy")).toMatchObject({
            available: true,
          });
          expect(healthySendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
            enabled: true,
          });

          const direct = yield* Effect.exit(manager.automationSnapshot("tab_focus_race"));
          expect(Exit.isFailure(direct)).toBe(true);
          if (Exit.isFailure(direct)) {
            expect(Option.getOrThrow(Cause.findErrorOption(direct.cause))._tag).toBe(
              "PreviewAutomationDebuggerAttachedError",
            );
          }
          yield* Effect.promise(() =>
            vi.waitFor(() => expect(racedOff).toHaveBeenCalledWith("detach", expect.any(Function))),
          );
          expect(racedDetach).not.toHaveBeenCalled();
        }),
      ),
  );

  effectIt.effect("isolates an existing control session replaced by an external debugger", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let debuggerOwner: "none" | "manager" | "external" = "none";
        let detachListener: ((event: Electron.Event, reason: string) => void) | undefined;
        const racedDetach = vi.fn(() => {
          debuggerOwner = "none";
        });
        const racedOff = vi.fn((event: string, listener: typeof detachListener) => {
          if (event === "detach" && detachListener === listener) detachListener = undefined;
        });
        const racedSendCommand = vi.fn(async (): Promise<unknown> => undefined);
        const healthySendCommand = vi.fn(async (): Promise<unknown> => undefined);
        const guests = new Map<number, Electron.WebContents>();
        guests.set(41, {
          id: 41,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://external.example.com/",
          getTitle: () => "External",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          invalidate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => debuggerOwner !== "none",
            attach: vi.fn(() => {
              debuggerOwner = "manager";
            }),
            detach: racedDetach,
            sendCommand: racedSendCommand,
            on: vi.fn((event: string, listener: typeof detachListener) => {
              if (event === "detach") detachListener = listener;
            }),
            off: racedOff,
          },
        } as unknown as Electron.WebContents);
        guests.set(42, {
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://healthy.example.com/",
          getTitle: () => "Healthy",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          invalidate: vi.fn(),
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
            sendCommand: healthySendCommand,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as unknown as Electron.WebContents);
        fromId.mockImplementation((id) => (id === undefined ? null : (guests.get(id) ?? null)));

        yield* manager.createTab("tab_external_takeover");
        yield* manager.registerWebview("tab_external_takeover", 41);
        yield* manager.createTab("tab_external_healthy");
        yield* manager.registerWebview("tab_external_healthy", 42);
        yield* manager.renewAutomationForeground();
        expect(debuggerOwner).toBe("manager");

        debuggerOwner = "external";
        detachListener?.({} as Electron.Event, "replaced_with_devtools");

        const renewal = yield* Effect.exit(manager.renewAutomationForeground());
        expect(Exit.isSuccess(renewal)).toBe(true);
        expect(yield* manager.automationStatus("tab_external_takeover")).toMatchObject({
          available: false,
        });
        expect(yield* manager.automationStatus("tab_external_healthy")).toMatchObject({
          available: true,
        });
        expect(healthySendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
          enabled: true,
        });

        const direct = yield* Effect.exit(manager.automationSnapshot("tab_external_takeover"));
        expect(Exit.isFailure(direct)).toBe(true);
        if (Exit.isFailure(direct)) {
          expect(Option.getOrThrow(Cause.findErrorOption(direct.cause))._tag).toBe(
            "PreviewAutomationDebuggerAttachedError",
          );
        }
        yield* Effect.promise(() =>
          vi.waitFor(() => expect(racedOff).toHaveBeenCalledWith("detach", expect.any(Function))),
        );
        expect(racedDetach).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect(
    "isolates and releases a partially foregrounded fleet after activation fails",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const guests = new Map<
            number,
            {
              readonly invalidate: ReturnType<typeof vi.fn>;
              readonly sendCommand: ReturnType<typeof vi.fn>;
              readonly webContents: Electron.WebContents;
            }
          >();
          const makeGuest = (id: number, failActivation: boolean) => {
            const invalidate = vi.fn();
            const sendCommand = vi.fn(
              async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
                if (
                  failActivation &&
                  method === "Emulation.setFocusEmulationEnabled" &&
                  params?.enabled === true
                ) {
                  throw new Error("focus emulation unavailable");
                }
                return undefined;
              },
            );
            const webContents = {
              id,
              isDestroyed: () => false,
              getType: () => "webview",
              getURL: () => `https://example-${id}.com/`,
              getTitle: () => `Example ${id}`,
              isLoading: () => false,
              isDevToolsOpened: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              setBackgroundThrottling: vi.fn(),
              invalidate,
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
            } as unknown as Electron.WebContents;
            guests.set(id, { invalidate, sendCommand, webContents });
          };
          makeGuest(41, true);
          makeGuest(42, false);
          fromId.mockImplementation((id) =>
            id === undefined ? null : (guests.get(id)?.webContents ?? null),
          );

          yield* manager.createTab("tab_broken");
          yield* manager.registerWebview("tab_broken", 41);
          yield* manager.createTab("tab_healthy");
          yield* manager.registerWebview("tab_healthy", 42);

          const activation = yield* Effect.exit(manager.renewAutomationForeground());
          expect(Exit.isSuccess(activation)).toBe(true);
          expect(yield* manager.automationStatus("tab_broken")).toMatchObject({
            available: false,
          });
          expect(yield* manager.automationStatus("tab_healthy")).toMatchObject({
            available: true,
          });
          const healthy = guests.get(42)!;
          expect(healthy.sendCommand).toHaveBeenCalledWith("Emulation.setFocusEmulationEnabled", {
            enabled: true,
          });
          expect(healthy.invalidate).toHaveBeenCalledOnce();

          yield* TestClock.adjust(60_000);
          yield* Effect.yieldNow;
          expect(healthy.sendCommand.mock.calls.at(-1)).toEqual([
            "Emulation.setFocusEmulationEnabled",
            { enabled: false },
          ]);
        }),
      ),
  );

  effectIt.effect("fails a new registration closed when active foregrounding fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let failFocusEmulation = true;
        const states: PreviewManager.PreviewTabState[] = [];
        const sendCommand = vi.fn(
          async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
            if (
              failFocusEmulation &&
              method === "Emulation.setFocusEmulationEnabled" &&
              params?.enabled === true
            ) {
              throw new Error("focus emulation unavailable");
            }
            return undefined;
          },
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com/",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          invalidate: vi.fn(),
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
        } as never);

        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => {
            states.push(state);
          }),
        );
        yield* manager.renewAutomationForeground();
        yield* manager.createTab("tab_registration_failure");
        const registration = yield* Effect.exit(
          manager.registerWebview("tab_registration_failure", 42),
        );
        expect(Exit.isFailure(registration)).toBe(true);
        expect(yield* manager.automationStatus("tab_registration_failure")).toMatchObject({
          available: false,
        });
        expect(states.at(-1)?.webContentsId).toBe(42);

        failFocusEmulation = false;
        yield* manager.renewAutomationForeground();
        expect(yield* manager.automationStatus("tab_registration_failure")).toMatchObject({
          available: true,
        });
        expect(states.at(-1)?.webContentsId).toBe(42);
      }),
    ),
  );

  effectIt.effect("fails a new registration closed when debugger attachment genuinely fails", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const detach = vi.fn();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com/",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          invalidate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(() => {
              throw new Error("debugger transport unavailable");
            }),
            detach,
            sendCommand: vi.fn(async (): Promise<unknown> => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);

        yield* manager.renewAutomationForeground();
        yield* manager.createTab("tab_attach_failure");
        const registration = yield* Effect.exit(manager.registerWebview("tab_attach_failure", 42));

        expect(Exit.isFailure(registration)).toBe(true);
        expect(yield* manager.automationStatus("tab_attach_failure")).toMatchObject({
          available: false,
        });
        expect(detach).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect(
    "fails a new registration closed when debugger initialization genuinely fails",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let attached = false;
          const detach = vi.fn(() => {
            attached = false;
          });
          fromId.mockReturnValue({
            id: 42,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => "https://example.com/",
            getTitle: () => "Example",
            isLoading: () => false,
            isDevToolsOpened: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            setBackgroundThrottling: vi.fn(),
            invalidate: vi.fn(),
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
              sendCommand: vi.fn(async (method: string): Promise<unknown> => {
                if (method === "Runtime.enable") {
                  throw new Error("debugger initialization transport failed");
                }
                return undefined;
              }),
              on: vi.fn(),
              off: vi.fn(),
            },
          } as never);

          yield* manager.renewAutomationForeground();
          yield* manager.createTab("tab_initialization_failure");
          const registration = yield* Effect.exit(
            manager.registerWebview("tab_initialization_failure", 42),
          );

          expect(Exit.isFailure(registration)).toBe(true);
          if (Exit.isFailure(registration)) {
            expect(Option.getOrThrow(Cause.findErrorOption(registration.cause))._tag).toBe(
              "PreviewOperationError",
            );
          }
          expect(yield* manager.automationStatus("tab_initialization_failure")).toMatchObject({
            available: false,
          });
          expect(detach).toHaveBeenCalledOnce();
        }),
      ),
  );

  effectIt.effect("clears foreground readiness on debugger detach and retries reactivation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let attached = false;
        let detachListener: ((event: Electron.Event, reason: string) => void) | undefined;
        let focusAttempts = 0;
        const attach = vi.fn(() => {
          attached = true;
        });
        const sendCommand = vi.fn(
          async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
            if (method === "Emulation.setFocusEmulationEnabled" && params?.enabled === true) {
              focusAttempts += 1;
              if (focusAttempts === 2) throw new Error("reattach focus failed");
            }
            return undefined;
          },
        );
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://example.com/",
          getTitle: () => "Example",
          isLoading: () => false,
          isDevToolsOpened: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          setBackgroundThrottling: vi.fn(),
          invalidate: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => attached,
            attach,
            detach: vi.fn(() => {
              attached = false;
            }),
            sendCommand,
            on: vi.fn((event: string, listener: typeof detachListener) => {
              if (event === "detach") detachListener = listener;
            }),
            off: vi.fn((event: string, listener: typeof detachListener) => {
              if (event === "detach" && detachListener === listener) detachListener = undefined;
            }),
          },
        } as never);

        yield* manager.createTab("tab_debugger_detach");
        yield* manager.registerWebview("tab_debugger_detach", 42);
        yield* manager.renewAutomationForeground();
        expect(focusAttempts).toBe(1);

        attached = false;
        detachListener?.({} as Electron.Event, "target_closed");
        yield* Effect.promise(() => vi.waitFor(() => expect(focusAttempts).toBe(2)));
        expect(yield* manager.automationStatus("tab_debugger_detach")).toMatchObject({
          available: false,
        });

        yield* manager.renewAutomationForeground();
        expect(focusAttempts).toBe(3);
        expect(attach).toHaveBeenCalledTimes(2);
        expect(yield* manager.automationStatus("tab_debugger_detach")).toMatchObject({
          available: true,
        });
      }),
    ),
  );

  effectIt.effect("does not settle a same-URL reload from queued old-page events", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const url = "https://youtube.com/";
        let loading = false;
        const reload = vi.fn(() => {
          loading = true;
        });
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => url,
          getTitle: () => "YouTube",
          isLoading: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          reload,
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

        yield* manager.createTab("tab_same_url");
        yield* manager.registerWebview("tab_same_url", 42);
        yield* manager.navigate("tab_same_url", url);
        expect(reload).toHaveBeenCalledOnce();

        // Both callbacks may already be queued from the document that was
        // visible before reload() was dispatched.
        loading = false;
        listeners.get("page-title-updated")?.();
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_same_url")).toMatchObject({
          url,
          loading: true,
        });

        loading = true;
        listeners.get("did-start-navigation")?.({}, url, false, true);
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_same_url")).toMatchObject({
          url,
          loading: true,
        });

        listeners.get("did-navigate")?.({}, url);
        loading = false;
        listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_same_url")).toMatchObject({
          url,
          title: "YouTube",
          loading: false,
        });
      }),
    ),
  );

  effectIt.effect("settles a started navigation at its redirected main-frame URL", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        let currentUrl = "https://old.example/";
        let loading = false;
        let rejectLoad: ((cause: unknown) => void) | undefined;
        const loadURL = vi.fn(() => {
          loading = true;
          return new Promise<void>((_resolve, reject) => {
            rejectLoad = reject;
          });
        });
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => currentUrl,
          getTitle: () => (currentUrl.includes("final") ? "Final" : "Old"),
          isLoading: () => loading,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL,
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

        yield* manager.createTab("tab_redirect");
        yield* manager.registerWebview("tab_redirect", 42);
        yield* manager.navigate("tab_redirect", "https://start.example/");

        loading = false;
        listeners.get("did-navigate")?.({}, "https://old.example/");
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_redirect")).toMatchObject({
          url: "https://start.example/",
          loading: true,
        });

        loading = true;
        listeners.get("did-start-navigation")?.({}, "https://start.example/", false, true);
        rejectLoad?.(new Error("ERR_ABORTED (-3)"));
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_redirect")).toMatchObject({
          url: "https://start.example/",
          loading: true,
        });

        currentUrl = "https://final.example/";
        loading = false;
        listeners.get("did-navigate")?.({}, currentUrl);
        yield* Effect.yieldNow;

        expect(yield* manager.automationStatus("tab_redirect")).toMatchObject({
          url: "https://final.example/",
          title: "Final",
          loading: false,
        });
      }),
    ),
  );

  effectIt.effect(
    "publishes a redirected main-frame URL while the committed page is still loading",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let currentUrl = "https://accounts.google.com/";
          let loading = false;
          const loadURL = vi.fn(() => {
            loading = true;
            return new Promise<void>(() => undefined);
          });
          const listeners = new Map<string, (...args: unknown[]) => void>();
          fromId.mockReturnValue({
            id: 42,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => currentUrl,
            getTitle: () => (currentUrl.includes("mail.google") ? "Gmail" : "Google Accounts"),
            isLoading: () => loading,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            loadURL,
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

          yield* manager.createTab("tab_gmail_redirect");
          yield* manager.registerWebview("tab_gmail_redirect", 42);
          yield* manager.navigate("tab_gmail_redirect", "https://accounts.google.com/");

          loading = true;
          listeners.get("did-start-navigation")?.({}, "https://accounts.google.com/", false, true);
          currentUrl = "https://mail.google.com/mail/u/0/#inbox";
          listeners.get("did-navigate")?.({}, currentUrl);
          yield* Effect.yieldNow;

          expect(yield* manager.automationStatus("tab_gmail_redirect")).toMatchObject({
            url: "https://mail.google.com/mail/u/0/#inbox",
            title: "Gmail",
            loading: true,
          });
        }),
      ),
  );

  effectIt.effect("publishes a redirected main-frame failure after the target starts", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const requestedUrl = "https://start.example/";
        const redirectedUrl = "https://final.example/";
        const listeners = new Map<string, (...args: unknown[]) => void>();
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://old.example/",
          getTitle: () => "Old",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL: vi.fn(() => new Promise<void>(() => undefined)),
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

        yield* manager.createTab("tab_redirect_failure");
        yield* manager.registerWebview("tab_redirect_failure", 42);
        yield* manager.navigate("tab_redirect_failure", requestedUrl);

        // A queued failure from the previous page is not evidence about the
        // requested navigation until its matching main-frame start arrives.
        listeners.get("did-fail-load")?.(
          {},
          -102,
          "ERR_CONNECTION_REFUSED",
          "https://old.example/",
          true,
        );
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_redirect_failure")).toMatchObject({
          url: requestedUrl,
          loading: true,
        });

        listeners.get("did-start-navigation")?.({}, requestedUrl, false, true);
        listeners.get("did-fail-load")?.({}, -105, "ERR_NAME_NOT_RESOLVED", redirectedUrl, true);
        yield* Effect.yieldNow;

        expect(yield* manager.automationStatus("tab_redirect_failure")).toMatchObject({
          url: redirectedUrl,
          loading: false,
          loadFailure: {
            code: -105,
            description: "ERR_NAME_NOT_RESOLVED",
          },
        });
      }),
    ),
  );

  effectIt.effect("never turns a pre-start aborted target into the old page", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://tiktok.com/",
          getTitle: () => "TikTok",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL: vi.fn(async () => {
            throw new Error("ERR_ABORTED (-3)");
          }),
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

        yield* manager.createTab("tab_aborted_before_start");
        yield* manager.registerWebview("tab_aborted_before_start", 42);
        yield* manager.navigate("tab_aborted_before_start", "https://youtube.com/");
        yield* Effect.yieldNow;

        expect(yield* manager.automationStatus("tab_aborted_before_start")).toMatchObject({
          url: "https://youtube.com/",
          title: "TikTok",
          loading: false,
          loadFailure: {
            code: -3,
            description: "ERR_ABORTED",
          },
        });
      }),
    ),
  );

  effectIt.effect(
    "reconciles failed loads without letting an old attempt overwrite a newer one",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let currentUrl = "https://instagram.com/";
          let rejectFirst: ((cause: unknown) => void) | undefined;
          let resolveSecond: (() => void) | undefined;
          const loadURL = vi.fn((url: string) => {
            if (url.includes("first")) {
              return new Promise<void>((_resolve, reject) => {
                rejectFirst = reject;
              });
            }
            return new Promise<void>((resolve) => {
              resolveSecond = () => {
                currentUrl = url;
                resolve();
              };
            });
          });
          fromId.mockReturnValue({
            id: 42,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => currentUrl,
            getTitle: () => (currentUrl.includes("second") ? "Second" : "Instagram"),
            isLoading: () => false,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            loadURL,
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

          yield* manager.createTab("tab_navigation_attempts");
          yield* manager.registerWebview("tab_navigation_attempts", 42);
          yield* manager.navigate("tab_navigation_attempts", "https://first.example/");
          yield* manager.navigate("tab_navigation_attempts", "https://second.example/");

          rejectFirst?.(new Error("ERR_NAME_NOT_RESOLVED (-105)"));
          yield* Effect.yieldNow;
          expect(yield* manager.automationStatus("tab_navigation_attempts")).toMatchObject({
            url: "https://second.example/",
            loading: true,
          });

          resolveSecond?.();
          yield* Effect.yieldNow;
          expect(yield* manager.automationStatus("tab_navigation_attempts")).toMatchObject({
            url: "https://second.example/",
            title: "Second",
            loading: false,
          });
        }),
      ),
  );

  effectIt.effect("ignores retired guest navigation, input, popup, and destroy callbacks", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const stateChanges: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((_tabId, state) =>
          Effect.sync(() => stateChanges.push(state)),
        );

        const makeGuest = (id: number, initialUrl: string) => {
          let currentUrl = initialUrl;
          let loading = false;
          let windowOpenHandler:
            | ((details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse)
            | undefined;
          const listeners = new Map<string, (...args: unknown[]) => void>();
          const ipcListeners = new Map<string, (...args: unknown[]) => void>();
          const wc = {
            id,
            isDestroyed: () => false,
            getType: () => "webview",
            getURL: () => currentUrl,
            getTitle: () => (currentUrl.includes("target") ? "Target" : `Guest ${id}`),
            isLoading: () => loading,
            getZoomFactor: () => 1,
            setZoomFactor: vi.fn(),
            loadURL: vi.fn(() => {
              loading = true;
              return new Promise<void>(() => undefined);
            }),
            on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
              listeners.set(event, listener);
            }),
            off: vi.fn(),
            ipc: {
              on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
                ipcListeners.set(event, listener);
              }),
              off: vi.fn(),
            },
            send: webviewSend,
            navigationHistory: { canGoBack: () => false, canGoForward: () => false },
            setWindowOpenHandler: vi.fn(
              (
                handler: (details: Electron.HandlerDetails) => Electron.WindowOpenHandlerResponse,
              ) => {
                windowOpenHandler = handler;
              },
            ),
            debugger: {
              isAttached: () => false,
              attach: vi.fn(),
              sendCommand: vi.fn(async () => undefined),
              on: vi.fn(),
              off: vi.fn(),
            },
          };
          return {
            wc: wc as never,
            listeners,
            ipcListeners,
            settleNavigation: (url: string) => {
              currentUrl = url;
              loading = false;
            },
            openWindow: () =>
              windowOpenHandler?.({
                url: "https://example.com/popup",
                frameName: "",
                features: "",
                disposition: "new-window",
                referrer: { url: "", policy: "default" },
              } as Electron.HandlerDetails),
          };
        };

        const retired = makeGuest(42, "https://old.example/");
        const successor = makeGuest(43, "https://successor.example/");
        fromId.mockImplementation((id) => {
          if (id === 42) return retired.wc;
          if (id === 43) return successor.wc;
          return null;
        });

        yield* manager.createTab("tab_replaced_callbacks");
        yield* manager.registerWebview("tab_replaced_callbacks", 42);
        const retiredInput = [...retired.ipcListeners.values()][0];
        retiredInput?.({});
        yield* Effect.yieldNow;
        yield* TestClock.adjust("500 millis");
        retiredInput?.({});
        yield* Effect.yieldNow;
        yield* TestClock.adjust("300 millis");
        // The first timer has elapsed, but the newer input still owns the
        // indicator and its full debounce window.
        expect(stateChanges.at(-1)?.controller).toBe("human");

        yield* manager.registerWebview("tab_replaced_callbacks", 43);
        expect(stateChanges.at(-1)).toMatchObject({ webContentsId: 43, controller: "none" });
        yield* manager.navigate("tab_replaced_callbacks", "https://target.example/");

        retired.listeners.get("did-stop-loading")?.();
        retired.listeners.get("did-fail-load")?.(
          {},
          -105,
          "ERR_NAME_NOT_RESOLVED",
          "https://stale.example/",
          true,
        );
        retired.listeners.get("destroyed")?.();
        retiredInput?.({});
        expect(retired.openWindow()).toEqual({ action: "deny" });
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");

        expect(yield* manager.automationStatus("tab_replaced_callbacks")).toMatchObject({
          available: true,
          url: "https://target.example/",
          loading: true,
        });
        expect(stateChanges.at(-1)).toMatchObject({ webContentsId: 43, controller: "none" });

        successor.listeners.get("did-start-navigation")?.(
          {},
          "https://target.example/",
          false,
          true,
        );
        successor.settleNavigation("https://target.example/");
        successor.listeners.get("did-navigate")?.({}, "https://target.example/");
        successor.listeners.get("did-stop-loading")?.();
        yield* Effect.yieldNow;
        expect(yield* manager.automationStatus("tab_replaced_callbacks")).toMatchObject({
          available: true,
          url: "https://target.example/",
          title: "Target",
          loading: false,
        });
      }),
    ),
  );

  effectIt.effect(
    "keeps the predecessor authoritative if its successor dies before publication",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const predecessor = makeTestPreviewWebContents(
            vi.fn(async () => ({
              getSize: () => ({ width: 800, height: 600 }),
              toJPEG: () => Buffer.from("predecessor"),
            })),
            42,
          );
          let successorHealthChecks = 0;
          const successor = {
            ...(makeTestPreviewWebContents(
              vi.fn(async () => ({
                getSize: () => ({ width: 800, height: 600 }),
                toJPEG: () => Buffer.from("successor"),
              })),
              43,
            ) as object),
            id: 43,
            isDestroyed: () => {
              successorHealthChecks += 1;
              return successorHealthChecks >= 3;
            },
          } as never;
          fromId.mockImplementation((id) => {
            if (id === 42) return predecessor;
            if (id === 43) return successor;
            return null;
          });

          yield* manager.createTab("tab_successor_dies");
          yield* manager.registerWebview("tab_successor_dies", 42);
          const registration = yield* Effect.exit(
            manager.registerWebview("tab_successor_dies", 43),
          );

          expect(Exit.isFailure(registration)).toBe(true);
          expect(yield* manager.automationStatus("tab_successor_dies")).toMatchObject({
            available: true,
            url: "https://example.com",
            title: "Example",
          });
        }),
      ),
  );

  effectIt.effect("publishes a load failure when Electron rejects the current navigation", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const loadURL = vi.fn(async () => {
          throw new Error("ERR_NAME_NOT_RESOLVED (-105)");
        });
        fromId.mockReturnValue({
          id: 42,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://instagram.com/",
          getTitle: () => "Instagram",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          loadURL,
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

        yield* manager.createTab("tab_rejected_navigation");
        yield* manager.registerWebview("tab_rejected_navigation", 42);
        yield* manager.navigate("tab_rejected_navigation", "https://missing.example/");
        yield* Effect.yieldNow;

        expect(yield* manager.automationStatus("tab_rejected_navigation")).toMatchObject({
          url: "https://missing.example/",
          title: "Instagram",
          loading: false,
          loadFailure: {
            code: -105,
            description: "ERR_NAME_NOT_RESOLVED",
          },
        });
      }),
    ),
  );

  effectIt.effect("invalidates a background guest when its UI becomes visible again", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const invalidate = vi.fn();
        const focusApp = vi.fn();
        const windowListeners = new Map<string, () => void>();
        const hostWebContents = {
          isDestroyed: () => false,
          focus: focusApp,
          on: vi.fn(),
          off: vi.fn(),
        };
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          once: vi.fn(),
          on: vi.fn((event: string, listener: () => void) => {
            windowListeners.set(event, listener);
          }),
          off: vi.fn(),
          webContents: hostWebContents,
        } as never);
        const guest = {
          id: 42,
          hostWebContents,
          isDestroyed: () => false,
          getType: () => "webview",
          getURL: () => "https://www.youtube.com/",
          getTitle: () => "YouTube",
          isLoading: () => false,
          getZoomFactor: () => 1,
          setZoomFactor: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          ipc: { on: vi.fn(), off: vi.fn() },
          send: webviewSend,
          invalidate,
          navigationHistory: { canGoBack: () => false, canGoForward: () => false },
          setWindowOpenHandler: vi.fn(),
          debugger: {
            isAttached: () => false,
            attach: vi.fn(),
            sendCommand: vi.fn(async () => undefined),
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never;
        fromId.mockReturnValue(guest);

        yield* manager.createTab("tab_reactivated");
        yield* manager.setUiActivity("tab_reactivated", "visible-surface", true);
        expect(invalidate).not.toHaveBeenCalled();
        yield* manager.registerWebview("tab_reactivated", 42);
        yield* manager.setUiActivity("tab_reactivated", "visible-surface", true);
        expect(invalidate).toHaveBeenCalledOnce();

        windowListeners.get("focus")?.();
        yield* Effect.yieldNow;
        expect(invalidate).toHaveBeenCalledTimes(2);

        getFocusedWebContents.mockReturnValue(guest);
        yield* manager.setUiActivity("tab_reactivated", "visible-surface", false);
        expect(focusApp).toHaveBeenCalledOnce();
        yield* manager.setUiActivity("tab_reactivated", "visible-surface", true);
        expect(invalidate).toHaveBeenCalledTimes(3);

        windowListeners.get("blur")?.();
        yield* manager.setUiActivity("tab_reactivated", "visible-surface", false);
        expect(focusApp).toHaveBeenCalledOnce();
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
          on: vi.fn(),
          off: vi.fn(),
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

  effectIt.effect(
    "defers preview input through a long push-to-talk hold and release cooldown",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          const mainWindowListeners = new Map<
            string,
            (event: Electron.Event, input: Electron.Input) => void
          >();
          const mainWebContents = {
            isDestroyed: () => false,
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
            on: vi.fn(),
            off: vi.fn(),
            webContents: mainWebContents,
          } as never);

          const sendCommand = vi.fn(async (method: string, _params?: Record<string, unknown>) =>
            method === "Runtime.evaluate"
              ? { result: { value: { width: 800, height: 600 } } }
              : undefined,
          );
          fromId.mockReturnValue({
            id: 42,
            hostWebContents: mainWebContents,
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
          yield* manager.createTab("tab_dictation");
          yield* manager.registerWebview("tab_dictation", 42);

          mainWindowListeners.get("before-input-event")?.({} as Electron.Event, {
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
          });
          yield* Effect.yieldNow;

          const click = yield* manager
            .automationClick("tab_dictation", { x: 120, y: 80 })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(12_000);
          expect(sendCommand).not.toHaveBeenCalled();

          mainWindowListeners.get("before-input-event")?.({} as Electron.Event, {
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
          });
          yield* Effect.yieldNow;
          yield* TestClock.adjust(1_999);
          expect(sendCommand).not.toHaveBeenCalled();

          yield* TestClock.adjust(1);
          yield* TestClock.adjust(200);
          yield* Fiber.join(click);
          expect(
            sendCommand.mock.calls
              .filter(([method]) => method === "Input.dispatchMouseEvent")
              .map(([, params]) => (params as { readonly type?: string } | undefined)?.type),
          ).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);

          sendCommand.mockClear();
          const press: Electron.Input = {
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
          const release: Electron.Input = {
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
          };
          mainWindowListeners.get("before-input-event")?.({} as Electron.Event, press);
          mainWindowListeners.get("before-input-event")?.({} as Electron.Event, release);
          // A second hold starts before the first release's async clock read
          // resumes. That stale release must not clear the new generation.
          mainWindowListeners.get("before-input-event")?.({} as Electron.Event, press);
          const rapidRepressClick = yield* manager
            .automationClick("tab_dictation", { x: 120, y: 80 })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* Effect.yieldNow;
          yield* TestClock.adjust(3_000);
          expect(sendCommand).not.toHaveBeenCalled();

          mainWindowListeners.get("before-input-event")?.({} as Electron.Event, release);
          yield* Effect.yieldNow;
          yield* TestClock.adjust(2_200);
          yield* Fiber.join(rapidRepressClick);
          expect(
            sendCommand.mock.calls
              .filter(([method]) => method === "Input.dispatchMouseEvent")
              .map(([, params]) => (params as { readonly type?: string } | undefined)?.type),
          ).toEqual(["mouseMoved", "mousePressed", "mouseReleased"]);
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
          on: vi.fn(),
          off: vi.fn(),
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
        const liveHiddenPng = Buffer.from("signed-in-live-hidden-snapshot").toString("base64");
        const capturePage = vi.fn(async () => {
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
        const staleImage = {
          ...stagedImage,
          toJPEG: () => Buffer.from("stale-pre-navigation-snapshot"),
        };
        let presentedFrameAvailable = false;
        let replayStaleFrameOnSubscription = false;
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
            if (replayStaleFrameOnSubscription) {
              queueMicrotask(() => callback(staleImage, { x: 0, y: 0, width: 800, height: 600 }));
            }
          },
        );
        const endFrameSubscription = vi.fn();
        let debuggerScreenshotAvailable = true;
        let debuggerScreencastAvailable = false;
        const stablePage = {
          url: "https://example.com",
          title: "Example",
          loading: false,
          visibleText: "Example",
          viewportWidth: 800,
          viewportHeight: 600,
          interactiveElements: [] as Array<{
            tag: string;
            role: string | null;
            name: string;
            selector: string;
            x: number;
            y: number;
            width: number;
            height: number;
          }>,
        };
        const runtimePages: Array<typeof stablePage> = [];
        const debuggerScreenshots: string[] = [];
        const webContentsListeners = new Map<string, (...args: unknown[]) => void>();
        let runtimeReadCount = 0;
        let advanceNavigationGenerationAtRuntimeRead: number | null = null;
        let inPageNavigationAtRuntimeRead: {
          readonly read: number;
          readonly isMainFrame: boolean;
        } | null = null;
        const previewSession = {};
        const debuggerMessages = new Set<
          (event: unknown, method: string, params: Record<string, unknown>) => void
        >();
        const sendCommand = vi.fn(async (method: string) => {
          if (method === "Runtime.evaluate") {
            runtimeReadCount += 1;
            if (runtimeReadCount === advanceNavigationGenerationAtRuntimeRead) {
              webContentsListeners.get("did-start-navigation")?.(
                {},
                "https://example.com",
                false,
                true,
              );
            }
            if (runtimeReadCount === inPageNavigationAtRuntimeRead?.read) {
              webContentsListeners.get("did-navigate-in-page")?.(
                {},
                "https://example.com/#updated",
                inPageNavigationAtRuntimeRead.isMainFrame,
              );
            }
            return {
              result: {
                value: runtimePages.shift() ?? stablePage,
              },
            };
          }
          if (method === "Page.captureScreenshot") {
            return debuggerScreenshotAvailable
              ? { data: debuggerScreenshots.shift() ?? debuggerPng }
              : {};
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
          queueMicrotask(() =>
            presentedFrame?.(stagedImage, { x: 0, y: 0, width: 800, height: 600 }),
          );
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
          on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
            webContentsListeners.set(event, listener);
          }),
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
        const windowListeners = new Map<string, () => void>();
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => true,
          once: vi.fn(),
          on: vi.fn((event: string, listener: () => void) => {
            windowListeners.set(event, listener);
          }),
          off: vi.fn(),
          webContents: {
            isDestroyed: () => false,
            on: vi.fn(),
            off: vi.fn(),
          },
        } as never);
        const states: PreviewManager.PreviewTabState[] = [];
        let acknowledgeSnapshotStage = true;
        yield* manager.subscribeStateChanges((tabId, state) =>
          Effect.gen(function* () {
            states.push(state);
            if (acknowledgeSnapshotStage && state.snapshotStageId !== null) {
              yield* manager
                .setUiActivity(tabId, `snapshot-stage:${state.snapshotStageId}`, true)
                .pipe(Effect.orDie);
            }
          }),
        );
        yield* manager.setUiActivity("tab_hidden_snapshot", "test", true);
        const snapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");

        expect(capturePage).not.toHaveBeenCalled();
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
        });
        beginFrameSubscription.mockClear();
        endFrameSubscription.mockClear();
        invalidate.mockClear();

        // React has not released its visible-surface lease yet, but native
        // window blur is authoritative: the next snapshot must stage instead
        // of trusting the now-occluded compositor frame.
        windowListeners.get("blur")?.();
        presentedFrameAvailable = true;
        replayStaleFrameOnSubscription = true;
        debuggerScreenshots.push(liveHiddenPng);
        acknowledgeSnapshotStage = false;
        const statesBeforeHiddenCapture = states.length;
        const stagedSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        // A staged native capture would replay stale pre-auth pixels here. The
        // hidden snapshot must instead read the current live renderer first.
        expect(capturePage).not.toHaveBeenCalled();
        expect(invalidate).not.toHaveBeenCalled();
        expect(beginFrameSubscription).not.toHaveBeenCalled();
        expect(endFrameSubscription).not.toHaveBeenCalled();
        expect(stagedSnapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: liveHiddenPng,
          width: 800,
          height: 600,
        });
        expect(sendCommand).toHaveBeenCalledWith("Page.captureScreenshot", {
          format: "jpeg",
          quality: 78,
          fromSurface: true,
          captureBeyondViewport: false,
        });
        expect(
          states.slice(statesBeforeHiddenCapture).some((state) => state.snapshotStageId !== null),
        ).toBe(false);

        // Large debugger screenshots are resized locally without a CDP clip,
        // which avoids Page.captureScreenshot's viewport resize/restore path.
        const largePng = Buffer.from("large-live-hidden-snapshot").toString("base64");
        const resizedPng = Buffer.from("resized-live-hidden-snapshot");
        createFromBuffer.mockImplementationOnce(
          () =>
            ({
              getSize: () => ({ width: 1600, height: 900 }),
              resize: (size: { readonly width: number }) => {
                expect(size).toEqual({ width: 1024 });
                return {
                  getSize: () => ({ width: 1024, height: 576 }),
                  toJPEG: (quality: number) => {
                    expect(quality).toBe(78);
                    return resizedPng;
                  },
                };
              },
              toJPEG: () => {
                throw new Error("unexpected large source JPEG encode");
              },
            }) as never,
        );
        debuggerScreenshots.push(largePng);
        const resizedSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(resizedSnapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: resizedPng.toString("base64"),
          width: 1024,
          height: 576,
        });
        const debuggerCaptureCalls = (
          sendCommand.mock.calls as unknown as Array<
            readonly [string, Readonly<Record<string, unknown>>]
          >
        ).filter(([method]) => method === "Page.captureScreenshot");
        expect(debuggerCaptureCalls.every(([, params]) => !("clip" in params))).toBe(true);

        // Snapshot semantics are authoritative for the exact live guest. If a
        // delayed lifecycle callback left the persisted URL on the login
        // route, a stable authenticated page repairs that metadata in place.
        const authenticatedPage = {
          ...stablePage,
          url: "https://x.com/home",
          title: "Home / X",
          visibleText: "For you Following Account menu",
        };
        runtimePages.push(authenticatedPage, authenticatedPage);
        debuggerScreenshots.push(Buffer.from("authenticated-home").toString("base64"));
        const authenticatedSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(authenticatedSnapshot.url).toBe("https://x.com/home");
        expect(states.at(-1)?.navStatus).toEqual({
          kind: "Success",
          url: "https://x.com/home",
          title: "Home / X",
        });

        // If all direct renderer captures fail, the staged native path remains
        // available. It rejects the cached first frame and accepts the repaint.
        acknowledgeSnapshotStage = true;
        yield* manager.setUiActivity("tab_hidden_snapshot", "test", false);
        debuggerScreenshotAvailable = false;
        const nativeFallbackSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(invalidate).toHaveBeenCalledTimes(2);
        expect(beginFrameSubscription).toHaveBeenCalledWith(false, expect.any(Function));
        expect(endFrameSubscription).toHaveBeenCalledOnce();
        expect(nativeFallbackSnapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: stagedPng.toString("base64"),
          width: 800,
          height: 600,
        });
        expect(states.at(-1)?.snapshotStageId).toBeNull();

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

        // A stage receipt that arrives after timeout must not resurrect its Ui
        // lease. Otherwise a focused app would misclassify this background tab
        // as visible and try the stale native frame before the live renderer.
        debuggerScreencastAvailable = false;
        acknowledgeSnapshotStage = false;
        const statesBeforeExpiredStage = states.length;
        const expiredStageFiber = yield* manager
          .automationSnapshot("tab_hidden_snapshot")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("2 seconds");
        const expiredStage = yield* Fiber.join(expiredStageFiber);
        expect(expiredStage.screenshot).toBeUndefined();
        expect(expiredStage.screenshotError).toContain("rest of this snapshot is complete");
        const expiredStageId = states
          .slice(statesBeforeExpiredStage)
          .find((state) => state.snapshotStageId !== null)?.snapshotStageId;
        expect(expiredStageId).toBeTruthy();
        expect(states.at(-1)?.snapshotStageId).toBeNull();

        yield* manager.setUiActivity(
          "tab_hidden_snapshot",
          `snapshot-stage:${expiredStageId!}`,
          true,
        );
        windowListeners.get("focus")?.();
        beginFrameSubscription.mockClear();
        debuggerScreenshotAvailable = true;
        const postTimeoutPng = Buffer.from("post-timeout-live-frame").toString("base64");
        debuggerScreenshots.push(postTimeoutPng);
        const statesBeforePostTimeoutCapture = states.length;
        const postTimeoutSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(postTimeoutSnapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: postTimeoutPng,
          width: 800,
          height: 600,
        });
        expect(beginFrameSubscription).not.toHaveBeenCalled();
        expect(
          states
            .slice(statesBeforePostTimeoutCapture)
            .some((state) => state.snapshotStageId !== null),
        ).toBe(false);
        windowListeners.get("blur")?.();
        acknowledgeSnapshotStage = true;

        debuggerScreenshotAvailable = true;
        const dynamicPng = Buffer.from("dynamic-live-feed").toString("base64");
        const retryDynamicPng = Buffer.from("retry-dynamic-live-feed").toString("base64");
        const dynamicControl = (name: string) => ({
          tag: "button",
          role: "button",
          name,
          selector: "#like",
          x: 20,
          y: 20,
          width: 80,
          height: 32,
        });
        runtimePages.push(
          {
            ...stablePage,
            title: "Live feed (3)",
            visibleText: "Views 1,234 0:10",
            interactiveElements: [dynamicControl("Like 12")],
          },
          {
            ...stablePage,
            title: "Live feed (4)",
            visibleText: "Views 1,235 0:11",
            interactiveElements: [{ ...dynamicControl("Like 13"), x: 21 }],
          },
          {
            ...stablePage,
            title: "Live feed (5)",
            visibleText: "Views 1,236 0:12",
            interactiveElements: [{ ...dynamicControl("Like 14"), x: 22 }],
          },
          {
            ...stablePage,
            title: "Live feed (6)",
            visibleText: "Views 1,237 0:13",
            interactiveElements: [{ ...dynamicControl("Like 15"), x: 23 }],
          },
        );
        debuggerScreenshots.push(dynamicPng, retryDynamicPng);
        const screenshotsBeforeDynamicPage = sendCommand.mock.calls.filter(
          ([method]) => method === "Page.captureScreenshot",
        ).length;
        const dynamicSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(dynamicSnapshot.visibleText).toBe("Views 1,237 0:13");
        expect(dynamicSnapshot.screenshot).toBeUndefined();
        expect(dynamicSnapshot.screenshotError).toContain("live page changed");
        expect(
          sendCommand.mock.calls.filter(([method]) => method === "Page.captureScreenshot").length,
        ).toBe(screenshotsBeforeDynamicPage + 2);

        const subframePng = Buffer.from("subframe-did-not-replace-main-page").toString("base64");
        runtimePages.push(stablePage, stablePage);
        debuggerScreenshots.push(subframePng);
        inPageNavigationAtRuntimeRead = {
          read: runtimeReadCount + 2,
          isMainFrame: false,
        };
        const screenshotsBeforeSubframeNavigation = sendCommand.mock.calls.filter(
          ([method]) => method === "Page.captureScreenshot",
        ).length;
        const subframeSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(subframeSnapshot.screenshot?.data).toBe(subframePng);
        expect(
          sendCommand.mock.calls.filter(([method]) => method === "Page.captureScreenshot").length,
        ).toBe(screenshotsBeforeSubframeNavigation + 1);
        inPageNavigationAtRuntimeRead = null;

        const staleGenerationPng = Buffer.from("stale-document-generation").toString("base64");
        const currentGenerationPng = Buffer.from("current-document-generation").toString("base64");
        runtimePages.push(stablePage, stablePage, stablePage, stablePage);
        debuggerScreenshots.push(staleGenerationPng, currentGenerationPng);
        advanceNavigationGenerationAtRuntimeRead = runtimeReadCount + 2;
        const screenshotsBeforeGenerationChange = sendCommand.mock.calls.filter(
          ([method]) => method === "Page.captureScreenshot",
        ).length;
        const generationSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(generationSnapshot.screenshot?.data).toBe(currentGenerationPng);
        expect(
          sendCommand.mock.calls.filter(([method]) => method === "Page.captureScreenshot").length,
        ).toBe(screenshotsBeforeGenerationChange + 2);
        advanceNavigationGenerationAtRuntimeRead = null;

        const staleOpeningReadPng = Buffer.from("stale-opening-read").toString("base64");
        const currentOpeningReadPng = Buffer.from("current-opening-read").toString("base64");
        const oldOpeningPage = {
          ...stablePage,
          visibleText: "Old document",
          interactiveElements: [dynamicControl("Account")],
        };
        const currentOpeningPage = {
          ...stablePage,
          visibleText: "Current document",
          interactiveElements: [dynamicControl("Account")],
        };
        runtimePages.push(
          oldOpeningPage,
          currentOpeningPage,
          currentOpeningPage,
          currentOpeningPage,
        );
        debuggerScreenshots.push(staleOpeningReadPng, currentOpeningReadPng);
        // The main-frame generation changes inside the opening Runtime.evaluate.
        // Its returned DOM belongs to the old document, even though URL and
        // structural controls are indistinguishable from the current one.
        advanceNavigationGenerationAtRuntimeRead = runtimeReadCount + 1;
        const screenshotsBeforeOpeningGenerationChange = sendCommand.mock.calls.filter(
          ([method]) => method === "Page.captureScreenshot",
        ).length;
        const openingGenerationSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(openingGenerationSnapshot.visibleText).toBe("Current document");
        expect(openingGenerationSnapshot.screenshot?.data).toBe(currentOpeningReadPng);
        expect(
          sendCommand.mock.calls.filter(([method]) => method === "Page.captureScreenshot").length,
        ).toBe(screenshotsBeforeOpeningGenerationChange + 2);
        advanceNavigationGenerationAtRuntimeRead = null;

        const staleMainFramePng = Buffer.from("stale-main-frame-history").toString("base64");
        const currentMainFramePng = Buffer.from("current-main-frame-history").toString("base64");
        runtimePages.push(stablePage, stablePage, stablePage, stablePage);
        debuggerScreenshots.push(staleMainFramePng, currentMainFramePng);
        inPageNavigationAtRuntimeRead = {
          read: runtimeReadCount + 2,
          isMainFrame: true,
        };
        const screenshotsBeforeMainFrameNavigation = sendCommand.mock.calls.filter(
          ([method]) => method === "Page.captureScreenshot",
        ).length;
        const mainFrameSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(mainFrameSnapshot.screenshot?.data).toBe(currentMainFramePng);
        expect(
          sendCommand.mock.calls.filter(([method]) => method === "Page.captureScreenshot").length,
        ).toBe(screenshotsBeforeMainFrameNavigation + 2);
        inPageNavigationAtRuntimeRead = null;

        const skeletonPng = Buffer.from("logged-out-skeleton").toString("base64");
        const signedInPng = Buffer.from("signed-in-feed").toString("base64");
        const authControl = (name: string, selector: string) => ({
          ...dynamicControl(name),
          selector,
        });
        const signedInPage = {
          ...stablePage,
          title: "TikTok",
          visibleText: "For You Following Profile",
          interactiveElements: [authControl("Profile", "#profile")],
        };
        runtimePages.push(
          {
            ...stablePage,
            title: "Log in | TikTok",
            visibleText: "Sign up Log in",
            interactiveElements: [authControl("Log in", "#login")],
          },
          signedInPage,
          signedInPage,
          signedInPage,
        );
        debuggerScreenshots.push(skeletonPng, signedInPng);
        const screenshotsBeforeAuthTransition = sendCommand.mock.calls.filter(
          ([method]) => method === "Page.captureScreenshot",
        ).length;
        const axBeforeAuthTransition = sendCommand.mock.calls.filter(
          ([method]) => method === "Accessibility.getFullAXTree",
        ).length;
        const authSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(authSnapshot.visibleText).toBe("For You Following Profile");
        expect(authSnapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: signedInPng,
          width: 800,
          height: 600,
        });
        expect(
          sendCommand.mock.calls.filter(([method]) => method === "Page.captureScreenshot").length,
        ).toBe(screenshotsBeforeAuthTransition + 2);
        expect(
          sendCommand.mock.calls.filter(([method]) => method === "Accessibility.getFullAXTree")
            .length,
        ).toBe(axBeforeAuthTransition + 2);

        const accountState = (visibleText: string, name: string) => ({
          ...stablePage,
          title: "TikTok",
          visibleText,
          interactiveElements: [authControl(name, "#account")],
        });
        runtimePages.push(
          accountState("Sign up Log in", "Log in"),
          accountState("For You Following Profile", "Profile"),
          accountState("Session expired Log in", "Log in"),
          accountState("For You Following Profile", "Profile"),
        );
        debuggerScreenshots.push(skeletonPng, signedInPng);
        const sameSelectorAuthSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(sameSelectorAuthSnapshot.visibleText).toBe("For You Following Profile");
        expect(sameSelectorAuthSnapshot.interactiveElements).toEqual([
          expect.objectContaining({ selector: "#account", name: "Profile" }),
        ]);
        expect(sameSelectorAuthSnapshot.screenshot).toBeUndefined();
        expect(sameSelectorAuthSnapshot.screenshotError).toContain("live page changed");

        runtimePages.push(
          {
            ...stablePage,
            visibleText: "Hydrating account",
            interactiveElements: [authControl("Continue", "#hydrate")],
          },
          {
            ...stablePage,
            visibleText: "Loading profile",
            interactiveElements: [authControl("Profile", "#profile")],
          },
          {
            ...stablePage,
            visibleText: "Loading feed",
            interactiveElements: [authControl("Feed", "#feed-loading")],
          },
          {
            ...stablePage,
            visibleText: "Signed-in feed",
            interactiveElements: [authControl("Feed", "#feed")],
          },
        );
        debuggerScreenshots.push(skeletonPng, signedInPng);
        const unstableSnapshot = yield* manager.automationSnapshot("tab_hidden_snapshot");
        expect(unstableSnapshot.visibleText).toBe("Signed-in feed");
        expect(unstableSnapshot.screenshot).toBeUndefined();
        expect(unstableSnapshot.screenshotError).toContain("live page changed");
        expect(unstableSnapshot.accessibilityTree).toEqual({ nodes: [] });

        // Every live capture strategy can fail on an occluded compositor. The
        // snapshot must still return its live DOM, but it must never re-load
        // an authenticated URL in a second renderer to invent replacement
        // pixels with unrelated in-memory auth state.
        debuggerScreenshotAvailable = false;
        const degradedSnapshotFiber = yield* manager
          .automationSnapshot("tab_hidden_snapshot")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("5 seconds");
        const degradedSnapshot = yield* Fiber.await(degradedSnapshotFiber);
        expect(states.at(-1)?.snapshotStageId).toBeNull();
        expect(Exit.isSuccess(degradedSnapshot)).toBe(true);
        if (Exit.isSuccess(degradedSnapshot)) {
          expect(degradedSnapshot.value.screenshot).toBeUndefined();
          expect(degradedSnapshot.value.screenshotError).toContain(
            "rest of this snapshot is complete",
          );
          // The part the caller actually needs to decide what to do next.
          expect(degradedSnapshot.value.visibleText).toBe("Example");
          expect(degradedSnapshot.value.url).toBe("https://example.com");
        }
        expect(browserWindowConstructor).not.toHaveBeenCalled();
      }),
    ),
  );

  effectIt.effect("never transfers an old guest snapshot stage to its replacement", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const page = {
          url: "https://example.com/home",
          title: "Home",
          loading: false,
          visibleText: "Authenticated home",
          viewportWidth: 800,
          viewportHeight: 600,
          interactiveElements: [],
        };
        const replacementPng = Buffer.from("replacement-live-frame").toString("base64");
        const makeGuest = (id: number, screenshot: string | null) => {
          const beginFrameSubscription = vi.fn();
          const sendCommand = vi.fn(async (method: string) => {
            if (method === "Runtime.evaluate") return { result: { value: page } };
            if (method === "Page.captureScreenshot") {
              return screenshot === null ? {} : { data: screenshot };
            }
            if (method === "Accessibility.getFullAXTree") return { nodes: [] };
            return {};
          });
          return {
            wc: {
              id,
              isDestroyed: () => false,
              getType: () => "webview",
              getURL: () => page.url,
              getTitle: () => page.title,
              isLoading: () => false,
              isDevToolsOpened: () => false,
              getZoomFactor: () => 1,
              setZoomFactor: vi.fn(),
              session: {},
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
              invalidate: vi.fn(),
              beginFrameSubscription,
              endFrameSubscription: vi.fn(),
              capturePage: vi.fn(),
            } as never,
            beginFrameSubscription,
          };
        };
        const hostWebContents = {
          isDestroyed: () => false,
          on: vi.fn(),
          off: vi.fn(),
        };
        const predecessor = makeGuest(42, null);
        const successor = makeGuest(43, replacementPng);
        Object.assign(predecessor.wc, { hostWebContents });
        Object.assign(successor.wc, { hostWebContents });
        fromId.mockImplementation((id) => {
          if (id === 42) return predecessor.wc;
          if (id === 43) return successor.wc;
          return null;
        });

        yield* manager.createTab("tab_snapshot_replacement");
        yield* manager.registerWebview("tab_snapshot_replacement", 42);
        yield* manager.setMainWindow({
          isDestroyed: () => false,
          isFocused: () => false,
          once: vi.fn(),
          on: vi.fn(),
          off: vi.fn(),
          webContents: hostWebContents,
        } as never);

        let oldStageId: string | null = null;
        let replacementRegistered = false;
        const states: PreviewManager.PreviewTabState[] = [];
        yield* manager.subscribeStateChanges((tabId, state) => {
          states.push(state);
          if (
            !replacementRegistered &&
            state.webContentsId === 42 &&
            state.snapshotStageId !== null
          ) {
            replacementRegistered = true;
            oldStageId = state.snapshotStageId;
            return manager.registerWebview(tabId, 43).pipe(Effect.orDie);
          }
          return Effect.void;
        });

        const snapshotFiber = yield* manager
          .automationSnapshot("tab_snapshot_replacement")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const snapshot = yield* Fiber.join(snapshotFiber);

        expect(replacementRegistered).toBe(true);
        expect(oldStageId).toBeTruthy();
        expect(snapshot.screenshot).toEqual({
          mimeType: "image/jpeg",
          data: replacementPng,
          width: 800,
          height: 600,
        });
        expect(predecessor.beginFrameSubscription).not.toHaveBeenCalled();
        expect(
          states.some(
            (state) => state.webContentsId === 43 && state.snapshotStageId === oldStageId,
          ),
        ).toBe(false);
        expect(states.at(-1)).toMatchObject({ webContentsId: 43, snapshotStageId: null });
      }),
    ),
  );

  effectIt.effect("bounds a visible native capture that never settles", () =>
    withManager((manager) =>
      Effect.gen(function* () {
        const debuggerPng = Buffer.from("debugger-timeout-snapshot").toString("base64");
        const capturePage = vi.fn(() => new Promise<never>(() => {}));
        const beginFrameSubscription = vi.fn();
        const endFrameSubscription = vi.fn();
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
          invalidate: vi.fn(),
          beginFrameSubscription,
          endFrameSubscription,
          capturePage,
        } as never);

        yield* manager.createTab("tab_snapshot_timeout");
        yield* manager.registerWebview("tab_snapshot_timeout", 42);
        yield* manager.setUiActivity("tab_snapshot_timeout", "test", true);

        const snapshotFiber = yield* manager
          .automationSnapshot("tab_snapshot_timeout")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* Effect.yieldNow;
        yield* TestClock.adjust("1 second");
        const snapshot = yield* Fiber.join(snapshotFiber);

        expect(beginFrameSubscription).toHaveBeenCalledOnce();
        expect(endFrameSubscription).toHaveBeenCalledOnce();
        expect(capturePage).not.toHaveBeenCalled();
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
        const debuggerPng = png.toString("base64");
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

        // The first context is destroyed. The retry brackets its live image
        // with one opening and one closing DOM read.
        expect(evaluationAttempts).toBe(3);
        expect(capturePage).not.toHaveBeenCalled();
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

  effectIt.effect(
    "presses, drags through interpolated held moves, and releases along a stroke",
    () =>
      withManager((manager) =>
        Effect.gen(function* () {
          let humanInput: ((_event: unknown, signal: unknown) => void) | undefined;
          const phases: string[] = [];
          const sendCommand = vi.fn(async (method: string, params?: Record<string, unknown>) => {
            if (method === "Runtime.evaluate") {
              return { result: { value: { width: 800, height: 600 } } };
            }
            if (method === "Input.dispatchMouseEvent" && params?.type === "mousePressed") {
              humanInput?.({}, { kind: "pointer", x: params.x, y: params.y, button: 0 });
            }
            return undefined;
          });
          fromId.mockReturnValue({
            id: 43,
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
              phases.push(event.phase);
            }),
          );
          yield* manager.createTab("tab_drag");
          yield* manager.registerWebview("tab_drag", 43);
          const drag = yield* manager
            .automationDrag("tab_drag", {
              from: { x: 100, y: 100 },
              to: { x: 180, y: 140 },
              steps: 4,
            })
            .pipe(Effect.forkChild({ startImmediately: true }));
          yield* TestClock.adjust(2000);
          yield* Fiber.join(drag);

          const mouseEvents = sendCommand.mock.calls
            .filter(([method]) => method === "Input.dispatchMouseEvent")
            .map(([, params]) => params);
          // Approach move (button none), press, four held drag moves, release.
          expect(mouseEvents.map((params) => params?.type)).toEqual([
            "mouseMoved",
            "mousePressed",
            "mouseMoved",
            "mouseMoved",
            "mouseMoved",
            "mouseMoved",
            "mouseReleased",
          ]);
          expect(mouseEvents[0]).toEqual({
            type: "mouseMoved",
            x: 100,
            y: 100,
            button: "none",
          });
          expect(mouseEvents[1]).toEqual({
            type: "mousePressed",
            x: 100,
            y: 100,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          // Every held move carries the buttons bitmask so the guest reads a
          // drag rather than a hover, and lands on the interpolated points.
          expect(mouseEvents.slice(2, 6)).toEqual([
            { type: "mouseMoved", x: 120, y: 110, button: "left", buttons: 1 },
            { type: "mouseMoved", x: 140, y: 120, button: "left", buttons: 1 },
            { type: "mouseMoved", x: 160, y: 130, button: "left", buttons: 1 },
            { type: "mouseMoved", x: 180, y: 140, button: "left", buttons: 1 },
          ]);
          expect(mouseEvents[6]).toEqual({
            type: "mouseReleased",
            x: 180,
            y: 140,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
          // UI cursor: approach move, press (rendered as a click), then one
          // pointer move per held drag step.
          expect(phases).toEqual(["move", "click", "move", "move", "move", "move"]);
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

describe("describeScreenshotFailure", () => {
  it("reassures that the live snapshot survived a capture fault", () => {
    const described = PreviewManager.describeScreenshotFailure(
      new Error("live compositor surface was not available"),
    );
    expect(described).toContain("rest of this snapshot is complete");
  });

  it("describes a non-Error cause without throwing", () => {
    expect(PreviewManager.describeScreenshotFailure("capture unavailable")).toContain(
      "rest of this snapshot is complete",
    );
  });
});

describe("PREVIEW_TYPED_TEXT_LANDED_JS", () => {
  class FakeInput {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  }
  class FakeTextArea {
    value: string;
    constructor(value: string) {
      this.value = value;
    }
  }

  /** Run the page-side source exactly as the guest would, with DOM stand-ins. */
  const landed = (element: unknown, inserted: string): boolean =>
    (
      new Function(
        "HTMLInputElement",
        "HTMLTextAreaElement",
        `return ${PreviewManager.PREVIEW_TYPED_TEXT_LANDED_JS};`,
      ) as (input: unknown, textarea: unknown) => (element: unknown, inserted: string) => boolean
    )(FakeInput, FakeTextArea)(element, inserted);

  it("accepts multi-line text a contenteditable stored as line breaks", () => {
    // Chromium turns the newline into a <br>, so textContent has no newline at
    // all. Reading textContent used to fail text that had plainly landed.
    expect(
      landed(
        { innerText: "line one\nline two", textContent: "line oneline two" },
        "line one\nline two",
      ),
    ).toBe(true);
  });

  it("accepts spaces a contenteditable stored as non-breaking", () => {
    expect(landed({ innerText: "hello world" }, "hello world")).toBe(true);
  });

  it("accepts a field that normalised CRLF to LF", () => {
    expect(landed(new FakeTextArea("line one\nline two"), "line one\r\nline two")).toBe(true);
  });

  it("still reports text that never reached the guest", () => {
    expect(landed({ innerText: "", textContent: "" }, "line one\nline two")).toBe(false);
  });

  it("reads an input's value rather than its text content", () => {
    expect(landed(new FakeInput("typed"), "typed")).toBe(true);
  });

  it("reports an element that exposes no readable text", () => {
    expect(landed({}, "typed")).toBe(false);
  });
});
