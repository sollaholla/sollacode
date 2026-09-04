import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type * as Electron from "electron";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopApplicationMenu from "./DesktopApplicationMenu.ts";
import * as DesktopConfig from "../app/DesktopConfig.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

const environmentInput = {
  dirname: "/repo/apps/desktop/dist-electron",
  homeDirectory: "/Users/alice",
  platform: "linux",
  processArch: "arm64",
  appVersion: "1.2.3",
  appPath: "/repo",
  isPackaged: false,
  resourcesPath: "/repo/resources",
  runningUnderArm64Translation: false,
} satisfies DesktopEnvironment.MakeDesktopEnvironmentInput;

const makeElectronAppLayer = (quit: Effect.Effect<void> = Effect.void) =>
  Layer.succeed(ElectronApp.ElectronApp, {
    metadata: Effect.die("unexpected metadata read"),
    name: Effect.succeed("Solla Code"),
    whenReady: Effect.void,
    quit,
    exit: () => Effect.void,
    relaunch: () => Effect.void,
    setPath: () => Effect.void,
    setName: () => Effect.void,
    setAboutPanelOptions: () => Effect.void,
    setAppUserModelId: () => Effect.void,
    requestSingleInstanceLock: Effect.succeed(true),
    getAppMetrics: Effect.succeed([]),
    isDefaultProtocolClient: () => Effect.succeed(false),
    setAsDefaultProtocolClient: () => Effect.succeed(true),
    setDesktopName: () => Effect.void,
    setDockIcon: () => Effect.void,
    appendCommandLineSwitch: () => Effect.void,
    on: () => Effect.void,
  } satisfies ElectronApp.ElectronApp["Service"]);

const electronAppLayer = makeElectronAppLayer();

const makeElectronDialogLayer = (
  confirm: ElectronDialog.ElectronDialog["Service"]["confirm"] = () => Effect.succeed(false),
) =>
  Layer.succeed(ElectronDialog.ElectronDialog, {
    pickFolder: () => Effect.die("unexpected pickFolder"),
    confirm,
    showMessageBox: () => Effect.die("unexpected showMessageBox"),
    showErrorBox: () => Effect.die("unexpected showErrorBox"),
  } satisfies ElectronDialog.ElectronDialog["Service"]);

const electronWindowLayer = Layer.succeed(ElectronWindow.ElectronWindow, {
  create: () => Effect.die("unexpected create"),
  main: Effect.succeed(Option.none()),
  currentMainOrFirst: Effect.succeed(Option.none()),
  focusedMainOrFirst: Effect.succeed(Option.none()),
  markAuxiliary: () => Effect.void,
  isAuxiliaryWindowId: () => false,
  setMain: () => Effect.void,
  clearMain: () => Effect.void,
  reveal: () => Effect.void,
  sendAll: () => Effect.void,
  destroyAll: Effect.void,
  syncAllAppearance: () => Effect.void,
} satisfies ElectronWindow.ElectronWindow["Service"]);

const makeDesktopWindowLayer = (selectedAction: Deferred.Deferred<string>) =>
  Layer.succeed(DesktopWindow.DesktopWindow, {
    createMain: Effect.die("unexpected createMain"),
    ensureMain: Effect.die("unexpected ensureMain"),
    revealOrCreateMain: Effect.die("unexpected revealOrCreateMain"),
    activate: Effect.void,
    createMainIfBackendReady: Effect.void,
    showConnectingSplash: Effect.void,
    handleBackendReady: () => Effect.void,
    handleBackendNotReady: Effect.void,
    flushMainWindowBounds: Effect.void,
    dispatchMenuAction: (action) => Deferred.succeed(selectedAction, action).pipe(Effect.asVoid),
    syncAppearance: Effect.void,
  } satisfies DesktopWindow.DesktopWindow["Service"]);

const makeElectronMenuLayer = (
  applicationMenuTemplate: Deferred.Deferred<readonly Electron.MenuItemConstructorOptions[]>,
) =>
  Layer.succeed(ElectronMenu.ElectronMenu, {
    setApplicationMenu: (template) =>
      Deferred.succeed(applicationMenuTemplate, template).pipe(Effect.asVoid),
    popupTemplate: () => Effect.void,
    showContextMenu: () => Effect.succeed(Option.none()),
  } satisfies ElectronMenu.ElectronMenu["Service"]);

describe("DesktopApplicationMenu", () => {
  it.effect("installs the native menu and routes Settings through DesktopWindow", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
            Layer.provideMerge(electronAppLayer),
            Layer.provideMerge(makeElectronDialogLayer()),
            Layer.provideMerge(electronWindowLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer(environmentInput).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      const fileMenu = template.find((item) => item.label === "File");
      assert.isDefined(fileMenu);
      if (!Array.isArray(fileMenu.submenu)) {
        throw new Error("Expected File menu submenu to be an array.");
      }
      const settingsItem = fileMenu.submenu.find((item) => item.label === "Settings...");
      assert.isDefined(settingsItem);
      const settingsClick = settingsItem.click;
      if (typeof settingsClick !== "function") {
        throw new Error("Expected Settings menu item to have a click handler.");
      }

      settingsClick({} as Electron.MenuItem, {} as Electron.BrowserWindow, {} as KeyboardEvent);
      assert.equal(yield* Deferred.await(selectedAction), "open-settings");
    }),
  );

  it.effect("uses the configured Solla Code identity for the macOS application menu", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
            Layer.provideMerge(electronAppLayer),
            Layer.provideMerge(makeElectronDialogLayer()),
            Layer.provideMerge(electronWindowLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer({ ...environmentInput, platform: "darwin" }).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      assert.equal(template[0]?.label, "Solla Code");
      const applicationSubmenu = template[0]?.submenu;
      if (!Array.isArray(applicationSubmenu)) {
        throw new Error("Expected application menu submenu to be an array.");
      }
      assert.equal(
        applicationSubmenu.find((item) => item.role === "about")?.label,
        "About Solla Code",
      );
      assert.equal(
        applicationSubmenu.find((item) => item.role === "hide")?.label,
        "Hide Solla Code",
      );
      assert.equal(
        applicationSubmenu.find((item) => item.accelerator === "Command+Q")?.label,
        "Quit Solla Code",
      );
    }),
  );

  it.effect("confirms Command-Q without intercepting a deliberate menu quit", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const confirmationRequested =
        yield* Deferred.make<ElectronDialog.ElectronDialogConfirmInput>();
      const quitRequested = yield* Deferred.make<void>();

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
            Layer.provideMerge(
              makeElectronAppLayer(Deferred.succeed(quitRequested, undefined).pipe(Effect.asVoid)),
            ),
            Layer.provideMerge(
              makeElectronDialogLayer((input) =>
                Deferred.succeed(confirmationRequested, input).pipe(Effect.as(false)),
              ),
            ),
            Layer.provideMerge(electronWindowLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer({ ...environmentInput, platform: "darwin" }).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      const applicationSubmenu = template[0]?.submenu;
      if (!Array.isArray(applicationSubmenu)) {
        throw new Error("Expected application menu submenu to be an array.");
      }
      const quitItem = applicationSubmenu.find((item) => item.accelerator === "Command+Q");
      const quitClick = quitItem?.click;
      if (typeof quitClick !== "function") {
        throw new Error("Expected Command-Q menu item to have a click handler.");
      }

      quitClick(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        { triggeredByAccelerator: true } as Electron.KeyboardEvent,
      );
      const confirmation = yield* Deferred.await(confirmationRequested);
      assert.equal(confirmation.message, "Are you sure you want to quit Solla Code?");
      assert.isTrue(Option.isNone(yield* Deferred.poll(quitRequested)));

      quitClick(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        { triggeredByAccelerator: false } as Electron.KeyboardEvent,
      );
      yield* Deferred.await(quitRequested);
    }),
  );

  it.effect("quits when the user confirms Command-Q", () =>
    Effect.gen(function* () {
      const selectedAction = yield* Deferred.make<string>();
      const applicationMenuTemplate =
        yield* Deferred.make<readonly Electron.MenuItemConstructorOptions[]>();
      const confirmationRequested = yield* Deferred.make<void>();
      const quitRequested = yield* Deferred.make<void>();

      yield* Effect.gen(function* () {
        const menu = yield* DesktopApplicationMenu.DesktopApplicationMenu;
        yield* menu.configure;
      }).pipe(
        Effect.provide(
          DesktopApplicationMenu.layer.pipe(
            Layer.provideMerge(makeElectronMenuLayer(applicationMenuTemplate)),
            Layer.provideMerge(makeDesktopWindowLayer(selectedAction)),
            Layer.provideMerge(
              makeElectronAppLayer(Deferred.succeed(quitRequested, undefined).pipe(Effect.asVoid)),
            ),
            Layer.provideMerge(
              makeElectronDialogLayer(() =>
                Deferred.succeed(confirmationRequested, undefined).pipe(Effect.as(true)),
              ),
            ),
            Layer.provideMerge(electronWindowLayer),
            Layer.provideMerge(
              DesktopEnvironment.layer({ ...environmentInput, platform: "darwin" }).pipe(
                Layer.provide(Layer.mergeAll(NodeServices.layer, DesktopConfig.layerTest({}))),
              ),
            ),
          ),
        ),
      );

      const template = yield* Deferred.await(applicationMenuTemplate);
      const applicationSubmenu = template[0]?.submenu;
      if (!Array.isArray(applicationSubmenu)) {
        throw new Error("Expected application menu submenu to be an array.");
      }
      const quitClick = applicationSubmenu.find((item) => item.accelerator === "Command+Q")?.click;
      if (typeof quitClick !== "function") {
        throw new Error("Expected Command-Q menu item to have a click handler.");
      }

      quitClick(
        {} as Electron.MenuItem,
        {} as Electron.BrowserWindow,
        { triggeredByAccelerator: true } as Electron.KeyboardEvent,
      );
      yield* Deferred.await(confirmationRequested);
      yield* Deferred.await(quitRequested);
    }),
  );
});
