// @effect-diagnostics nodeBuiltinImport:off - The tray opens from a native callback outside any Effect.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import type { DesktopMenuBarStats } from "@t3tools/contracts";
import * as Electron from "electron";

import * as DesktopAssets from "../app/DesktopAssets.ts";
import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as DesktopWindow from "./DesktopWindow.ts";
import {
  EMPTY_MENU_BAR_STATS,
  menuBarChatLines,
  menuBarResources,
  menuBarSummary,
  menuBarTitle,
  openThreadMenuAction,
  parseProcessMemoryBytes,
  processMemoryCommand,
} from "./DesktopMenuBar.logic.ts";

/**
 * The bolt in the macOS menu bar and the icon in the Windows tray. Closing the
 * window only hides it, so this is how the app stays visible and reachable while
 * its chats keep working. Quitting is a choice made here or from the app menu.
 * Linux has neither.
 */
export class DesktopMenuBar extends Context.Service<
  DesktopMenuBar,
  {
    readonly configure: Effect.Effect<void>;
    /** Sent by the app window, the one place that knows every computer's chats. */
    readonly publishStats: (stats: DesktopMenuBarStats) => Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/DesktopMenuBar") {}

const { logWarning } = makeComponentLogger("desktop-menu-bar");

const TEMPLATE_ICON_FILE = "trayTemplate.png";

export const make = Effect.gen(function* () {
  const assets = yield* DesktopAssets.DesktopAssets;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const electronApp = yield* ElectronApp.ElectronApp;
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  let tray: Electron.Tray | null = null;
  let stats = EMPTY_MENU_BAR_STATS;

  // The server is a plain child process, so Electron's metrics don't include it
  // and it is usually the largest part. Asked only when the menu opens.
  const readServerMemoryBytes = async (): Promise<number> => {
    try {
      const runtime = await NodeFSP.readFile(
        NodePath.join(environment.stateDir, "server-runtime.json"),
        "utf8",
      );
      const { pid } = JSON.parse(runtime) as { readonly pid?: unknown };
      if (typeof pid !== "number") return 0;
      const { command, args } = processMemoryCommand(environment.platform, pid);
      const stdout = await new Promise<string>((resolve) => {
        NodeChildProcess.execFile(
          command,
          [...args],
          { timeout: 1_000, windowsHide: true },
          (_error, output) => resolve(output),
        );
      });
      return parseProcessMemoryBytes(environment.platform, stdout);
    } catch {
      return 0;
    }
  };

  const resources = (serverMemoryBytes: number) => {
    const metrics = Electron.app.getAppMetrics();
    return menuBarResources({
      memoryBytes:
        metrics.reduce((sum, entry) => sum + entry.memory.workingSetSize * 1024, 0) +
        serverMemoryBytes,
      cpuPercent: metrics.reduce((sum, entry) => sum + entry.cpu.percentCPUUsage, 0),
      uptimeSeconds: process.uptime(),
    });
  };

  const openApp = () => runFork(desktopWindow.activate.pipe(Effect.ignore));
  const sendToApp = (action: string) =>
    runFork(
      desktopWindow.activate.pipe(
        Effect.andThen(desktopWindow.dispatchMenuAction(action)),
        Effect.ignore,
      ),
    );

  // Built fresh on every open, so the numbers are never older than the click.
  const menu = (serverMemoryBytes: number) => {
    const chats = menuBarChatLines(stats);
    return Electron.Menu.buildFromTemplate([
      { label: menuBarSummary(stats), enabled: false },
      { label: resources(serverMemoryBytes), enabled: false },
      ...(chats.length === 0 ? [] : [{ type: "separator" as const }]),
      ...chats.map(({ label, chat }) =>
        chat === undefined
          ? { label, enabled: false }
          : { label, click: () => sendToApp(openThreadMenuAction(chat)) },
      ),
      { type: "separator" },
      { label: `Open ${environment.displayName}`, click: openApp },
      { label: "Settings…", click: () => sendToApp("open-settings") },
      { type: "separator" },
      {
        label: `Exit ${environment.displayName}`,
        click: () => runFork(electronApp.quit),
      },
    ]);
  };

  const configure = Effect.gen(function* () {
    const isMac = environment.platform === "darwin";
    if ((!isMac && environment.platform !== "win32") || tray !== null) return;
    const iconPath = isMac
      ? yield* assets.resolveResourcePath(TEMPLATE_ICON_FILE)
      : (yield* assets.iconPaths).ico;
    if (Option.isNone(iconPath)) {
      yield* logWarning("menu bar icon is missing");
      return;
    }
    const image = Electron.nativeImage.createFromPath(iconPath.value);
    // A template image is drawn by macOS in black or white to suit the bar.
    if (isMac) image.setTemplateImage(true);
    const created = new Electron.Tray(image);
    created.setToolTip(environment.displayName);
    // On Windows a click on a tray icon opens the app; the menu is a right click.
    const openMenu = () => {
      void readServerMemoryBytes().then((bytes) => {
        if (tray === created) created.popUpContextMenu(menu(bytes));
      });
    };
    created.on("click", () => (isMac ? openMenu() : openApp()));
    created.on("right-click", openMenu);
    tray = created;
  }).pipe(Effect.catchCause((cause) => logWarning("menu bar icon could not start", { cause })));

  const publishStats = (next: DesktopMenuBarStats) =>
    Effect.sync(() => {
      stats = next;
      if (environment.platform === "darwin") tray?.setTitle(menuBarTitle(next));
      else tray?.setToolTip(`${environment.displayName}\n${menuBarSummary(next)}`);
    });

  return { configure, publishStats };
});

export const layer = Layer.effect(DesktopMenuBar, make);
