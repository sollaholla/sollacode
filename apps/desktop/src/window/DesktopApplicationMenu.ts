import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type * as Electron from "electron";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as ElectronMenu from "../electron/ElectronMenu.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopWindow from "./DesktopWindow.ts";

export class DesktopApplicationMenuActionError extends Schema.TaggedErrorClass<DesktopApplicationMenuActionError>()(
  "DesktopApplicationMenuActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop menu action "${this.action}" failed.`;
  }
}

export class DesktopApplicationMenu extends Context.Service<
  DesktopApplicationMenu,
  {
    readonly configure: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopApplicationMenu") {}

type DesktopApplicationMenuRuntimeServices =
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronDialog.ElectronDialog
  | ElectronWindow.ElectronWindow;

const { logError: logMenuError } = makeComponentLogger("desktop-menu");

const dispatchMenuAction = Effect.fn("desktop.menu.dispatchMenuAction")(function* (
  action: string,
): Effect.fn.Return<void, DesktopWindow.DesktopWindowError, DesktopWindow.DesktopWindow> {
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  yield* desktopWindow.dispatchMenuAction(action);
});

export const make = Effect.gen(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const electronDialog = yield* ElectronDialog.ElectronDialog;
  const electronMenu = yield* ElectronMenu.ElectronMenu;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const appName = environment.displayName;
  const context = yield* Effect.context<DesktopApplicationMenuRuntimeServices>();
  const runPromise = Effect.runPromiseWith(context);
  let quitConfirmationPending = false;

  const runMenuEffect = <E>(
    action: string,
    effect: Effect.Effect<void, E, DesktopApplicationMenuRuntimeServices>,
  ) => {
    void runPromise(
      effect.pipe(
        Effect.annotateLogs({ action }),
        Effect.withSpan("desktop.menu.action"),
        Effect.catchCause((cause) => {
          const error = new DesktopApplicationMenuActionError({ action, cause });
          return logMenuError(error.message, { error });
        }),
      ),
    );
  };

  const configure = Effect.gen(function* () {
    const settingsClick = () => {
      runMenuEffect("open-settings", dispatchMenuAction("open-settings"));
    };
    const quitClick: NonNullable<Electron.MenuItemConstructorOptions["click"]> = (
      _menuItem,
      _window,
      event,
    ) => {
      if (event.triggeredByAccelerator !== true) {
        runMenuEffect("quit-menu", electronApp.quit);
        return;
      }
      if (quitConfirmationPending) {
        return;
      }
      quitConfirmationPending = true;
      runMenuEffect(
        "confirm-command-q",
        Effect.gen(function* () {
          const owner = yield* electronWindow.focusedMainOrFirst;
          const confirmed = yield* electronDialog.confirm({
            owner,
            message: `Are you sure you want to quit ${appName}?`,
          });
          if (confirmed) {
            yield* electronApp.quit;
          }
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              quitConfirmationPending = false;
            }),
          ),
        ),
      );
    };
    const template: Electron.MenuItemConstructorOptions[] = [];

    if (environment.platform === "darwin") {
      template.push({
        label: appName,
        submenu: [
          { label: `About ${appName}`, role: "about" },
          { type: "separator" },
          {
            label: "Settings...",
            accelerator: "CmdOrCtrl+,",
            click: settingsClick,
          },
          { type: "separator" },
          { role: "services" },
          { type: "separator" },
          { label: `Hide ${appName}`, role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          {
            label: `Quit ${appName}`,
            accelerator: "Command+Q",
            click: quitClick,
          },
        ],
      });
    }

    template.push(
      {
        label: "File",
        submenu: [
          ...(environment.platform === "darwin"
            ? []
            : [
                {
                  label: "Settings...",
                  accelerator: "CmdOrCtrl+,",
                  click: settingsClick,
                },
                { type: "separator" as const },
              ]),
          { role: environment.platform === "darwin" ? "close" : "quit" },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "forceReload" },
          { role: "toggleDevTools" },
          { type: "separator" },
          { role: "resetZoom" },
          { role: "zoomIn", accelerator: "CmdOrCtrl+=" },
          { role: "zoomIn", accelerator: "CmdOrCtrl+Plus", visible: false },
          { role: "zoomOut" },
          { type: "separator" },
          { role: "togglefullscreen" },
        ],
      },
      { role: "windowMenu" },
      { role: "help" },
    );

    yield* electronMenu.setApplicationMenu(template);
  }).pipe(Effect.withSpan("desktop.menu.configure"));

  return DesktopApplicationMenu.of({
    configure,
  });
});

export const layer = Layer.effect(DesktopApplicationMenu, make);
