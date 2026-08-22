import type { DesktopOrchestratorBubbleState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Electron from "electron";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { getDesktopUrl } from "../electron/ElectronProtocol.ts";
import { ORCHESTRATOR_BUBBLE_STATE_CHANNEL } from "../ipc/channels.ts";
import { makeComponentLogger } from "../app/DesktopObservability.ts";

/**
 * The floating always-on-top voice orb.
 *
 * One frameless transparent window that outlives the main window: it stays on
 * every workspace (macOS panel, like the preview picture-in-picture window) so
 * the orchestrator is reachable and its speech visible no matter what the user
 * is doing. The renderer is the ordinary web bundle deep-linked to the
 * dedicated bubble entry (`#/orchestrator-bubble`), so it ships with the app
 * like every other surface.
 *
 * The window is deliberately dumb: all voice state arrives from the main
 * window's renderer (the only place the WebRTC session can live) through the
 * relay in `ipc/methods/orchestratorBubble.ts`.
 */

const BUBBLE_WINDOW_SIZE = 128;
const BUBBLE_SCREEN_MARGIN = 24;
const DEV_LOAD_RETRY_DELAY_MS = 1_500;
const DEV_LOAD_RETRY_LIMIT = 10;

export interface OrchestratorBubblePosition {
  readonly x: number;
  readonly y: number;
}

export class OrchestratorBubbleWindow extends Context.Service<
  OrchestratorBubbleWindow,
  {
    /** Create or destroy the window. Idempotent in both directions. */
    readonly setVisible: (visible: boolean) => Effect.Effect<void>;
    /** Latch the newest voice state and forward it to the bubble window. */
    readonly publishState: (state: DesktopOrchestratorBubbleState) => Effect.Effect<void>;
    /** Move the window while dragging (absolute screen coordinates). */
    readonly move: (position: OrchestratorBubblePosition) => Effect.Effect<void>;
    /** Persist the current window position as the resting spot. */
    readonly persistPosition: Effect.Effect<void>;
    readonly destroy: Effect.Effect<void>;
  }
>()("@t3tools/desktop/window/OrchestratorBubbleWindow") {}

const { logInfo, logWarning } = makeComponentLogger("orchestrator-bubble");

/** A saved spot is only trusted while the orb still lands on a live display. */
export function resolveInitialBubblePosition(
  persisted: OrchestratorBubblePosition | null,
  displays: ReadonlyArray<Pick<Electron.Rectangle, "x" | "y" | "width" | "height">>,
): OrchestratorBubblePosition | null {
  if (persisted === null) return null;
  const fits = displays.some(
    (display) =>
      persisted.x >= display.x - BUBBLE_WINDOW_SIZE / 2 &&
      persisted.y >= display.y &&
      persisted.x + BUBBLE_WINDOW_SIZE / 2 <= display.x + display.width &&
      persisted.y + BUBBLE_WINDOW_SIZE / 2 <= display.y + display.height,
  );
  return fits ? persisted : null;
}

export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const electronWindow = yield* ElectronWindow.ElectronWindow;
  const desktopSettings = yield* DesktopAppSettings.DesktopAppSettings;
  // Electron event callbacks land outside any fiber; run follow-up effects
  // with the construction context, the same way DesktopWindow does.
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  const runPromise = Effect.runPromiseWith(context);

  const windowRef = yield* Ref.make<Option.Option<Electron.BrowserWindow>>(Option.none());
  const latchedStateRef = yield* Ref.make<DesktopOrchestratorBubbleState>({
    status: "idle",
    micLevel: 0,
    assistantLevel: 0,
  });

  const liveWindow = Ref.get(windowRef).pipe(
    Effect.map(Option.filter((window) => !window.isDestroyed())),
  );

  const defaultPosition = Effect.sync((): OrchestratorBubblePosition => {
    try {
      const workArea = Electron.screen.getPrimaryDisplay().workArea;
      return {
        x: workArea.x + workArea.width - BUBBLE_WINDOW_SIZE - BUBBLE_SCREEN_MARGIN,
        y: workArea.y + workArea.height - BUBBLE_WINDOW_SIZE - BUBBLE_SCREEN_MARGIN,
      };
    } catch {
      return { x: 80, y: 80 };
    }
  });

  const sendLatchedState = (window: Electron.BrowserWindow) =>
    Ref.get(latchedStateRef).pipe(
      Effect.flatMap((state) =>
        Effect.sync(() => {
          if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
            window.webContents.send(ORCHESTRATOR_BUBBLE_STATE_CHANNEL, state);
          }
        }),
      ),
    );

  const createWindow = Effect.gen(function* () {
    const persistedSettings = yield* desktopSettings.get;
    const displays = yield* Effect.sync(() => {
      try {
        return Electron.screen.getAllDisplays().map((display) => display.bounds);
      } catch {
        return [];
      }
    });
    const position =
      resolveInitialBubblePosition(persistedSettings.orchestratorBubblePosition, displays) ??
      (yield* defaultPosition);

    const window = yield* electronWindow
      .create({
        x: position.x,
        y: position.y,
        width: BUBBLE_WINDOW_SIZE,
        height: BUBBLE_WINDOW_SIZE,
        show: false,
        frame: false,
        transparent: true,
        hasShadow: false,
        resizable: false,
        movable: true,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        autoHideMenuBar: true,
        // Never steal keyboard focus from whatever the user is doing; clicks
        // still arrive. `acceptFirstMouse` lets the first click through when
        // the app is in the background on macOS.
        focusable: false,
        acceptFirstMouse: true,
        ...(environment.platform === "darwin" ? { type: "panel" as const } : {}),
        webPreferences: {
          preload: environment.preloadPath,
          // The orb animates with live audio levels; throttling a hidden or
          // occluded window would freeze it exactly when it is most useful.
          backgroundThrottling: false,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      })
      .pipe(
        Effect.tapCause((cause) => logWarning("failed to create bubble window", { cause })),
        Effect.option,
      );
    if (Option.isNone(window)) return;

    const bubble = window.value;
    // The bubble must never stand in for the main window (dock activations,
    // menu actions) and must be skipped by appearance syncing, which would
    // paint its transparent background opaque.
    yield* electronWindow.markAuxiliary(bubble);
    // Same visibility contract as the preview picture-in-picture window: on
    // top of everything, on every workspace, without yanking the app out of
    // its regular activation policy.
    bubble.setAlwaysOnTop(true, environment.platform === "darwin" ? "floating" : "normal");
    if (environment.platform === "darwin") {
      bubble.setVisibleOnAllWorkspaces(true, {
        visibleOnFullScreen: true,
        skipTransformProcessType: true,
      });
    }

    let devLoadRetries = 0;
    bubble.webContents.on("did-fail-load", () => {
      // The dev server may still be compiling when the bubble races it up.
      if (!environment.isDevelopment || devLoadRetries >= DEV_LOAD_RETRY_LIMIT) return;
      devLoadRetries += 1;
      runFork(
        Effect.sleep(DEV_LOAD_RETRY_DELAY_MS).pipe(
          Effect.andThen(
            Effect.sync(() => {
              if (!bubble.isDestroyed()) {
                void bubble
                  .loadURL(`${getDesktopUrl(environment.isDevelopment)}#/orchestrator-bubble`)
                  .catch(() => undefined);
              }
            }),
          ),
        ),
      );
    });
    bubble.webContents.once("did-finish-load", () => {
      if (!bubble.isDestroyed()) {
        bubble.showInactive();
      }
    });

    yield* Ref.set(windowRef, Option.some(bubble));
    bubble.once("closed", () => {
      // Clearing only if the ref still points at this window keeps a
      // close-then-recreate race from destroying the fresh window's handle.
      void runPromise(
        Ref.update(windowRef, (current) =>
          Option.isSome(current) && current.value === bubble ? Option.none() : current,
        ),
      );
    });
    // Push the latched state as soon as the renderer is able to receive it.
    bubble.webContents.once("did-finish-load", () => {
      void runPromise(sendLatchedState(bubble));
    });

    yield* Effect.sync(() => {
      // Load failures surface through `did-fail-load` above; the promise
      // rejection is the same signal twice.
      void bubble
        .loadURL(`${getDesktopUrl(environment.isDevelopment)}#/orchestrator-bubble`)
        .catch(() => undefined);
    });
    yield* logInfo("bubble window created", { x: position.x, y: position.y });
  });

  const destroy = Effect.gen(function* () {
    const window = yield* liveWindow;
    yield* Ref.set(windowRef, Option.none());
    if (Option.isSome(window)) {
      yield* Effect.sync(() => window.value.destroy());
    }
  });

  return OrchestratorBubbleWindow.of({
    setVisible: (visible) =>
      Effect.gen(function* () {
        const existing = yield* liveWindow;
        if (visible && Option.isNone(existing)) {
          yield* createWindow;
          return;
        }
        if (!visible && Option.isSome(existing)) {
          yield* destroy;
        }
      }),
    publishState: (state) =>
      Effect.gen(function* () {
        yield* Ref.set(latchedStateRef, state);
        const window = yield* liveWindow;
        if (Option.isSome(window)) {
          yield* sendLatchedState(window.value);
        }
      }),
    move: (position) =>
      liveWindow.pipe(
        Effect.flatMap(
          Option.match({
            onNone: () => Effect.void,
            onSome: (window) =>
              Effect.sync(() => {
                // setPosition with rounded ints; Electron throws on floats.
                window.setPosition(Math.round(position.x), Math.round(position.y), false);
              }),
          }),
        ),
      ),
    persistPosition: Effect.gen(function* () {
      const window = yield* liveWindow;
      if (Option.isNone(window)) return;
      const [x, y] = window.value.getPosition();
      yield* desktopSettings
        .setOrchestratorBubblePosition({ x: x ?? 0, y: y ?? 0 })
        .pipe(Effect.catchCause((cause) => logWarning("failed to persist position", { cause })));
    }),
    destroy,
  });
});

export const layer = Layer.effect(OrchestratorBubbleWindow, make);
