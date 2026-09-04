import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";

import * as Electron from "electron";

import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";
import * as DesktopShutdown from "./DesktopShutdown.ts";
import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronTheme from "../electron/ElectronTheme.ts";
import * as DesktopState from "./DesktopState.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";
import {
  observeDetachedPromise,
  sendIntentionalShutdownToLiveWindows,
  shouldInterceptWindowCloseForQuit,
  withDesktopRelaunchArguments,
} from "./DesktopLifecycle.logic.ts";
import { INTENTIONAL_SHUTDOWN_CHANNEL } from "../ipc/channels.ts";

export class DesktopLifecycleRelaunchError extends Schema.TaggedErrorClass<DesktopLifecycleRelaunchError>()(
  "DesktopLifecycleRelaunchError",
  {
    reason: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Desktop relaunch failed for reason "${this.reason}".`;
  }
}

export class DesktopLifecycleDetachedActionError extends Schema.TaggedErrorClass<DesktopLifecycleDetachedActionError>()(
  "DesktopLifecycleDetachedActionError",
  {
    action: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Detached desktop lifecycle action "${this.action}" failed.`;
  }
}

export type DesktopLifecycleRuntimeServices =
  | DesktopEnvironment.DesktopEnvironment
  | DesktopShutdown.DesktopShutdown
  | DesktopState.DesktopState
  | DesktopWindow.DesktopWindow
  | ElectronApp.ElectronApp
  | ElectronTheme.ElectronTheme;

/**
 * @effect-expect-leaking DesktopEnvironment | DesktopShutdown | DesktopState | DesktopWindow | ElectronApp | ElectronTheme
 */
export class DesktopLifecycle extends Context.Service<
  DesktopLifecycle,
  {
    readonly relaunch: (
      reason: string,
    ) => Effect.Effect<void, never, DesktopLifecycleRuntimeServices>;
    readonly register: Effect.Effect<void, never, Scope.Scope | DesktopLifecycleRuntimeServices>;
  }
>()("@t3tools/desktop/app/DesktopLifecycle") {}

const {
  logInfo: logLifecycleInfo,
  logWarning: logLifecycleWarning,
  logError: logLifecycleError,
} = makeComponentLogger("desktop-lifecycle");
export const INTENTIONAL_SHUTDOWN_PAINT_DELAY_MS = 120;
export const DESKTOP_RELAUNCH_SHUTDOWN_TIMEOUT = Duration.seconds(5);

function addScopedListener<Args extends ReadonlyArray<unknown>>(
  target: unknown,
  eventName: string,
  listener: (...args: Args) => void,
): Effect.Effect<void, never, Scope.Scope> {
  const eventTarget = target as {
    on: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
    removeListener: (eventName: string, listener: (...args: Array<unknown>) => void) => unknown;
  };
  const untypedListener = listener as unknown as (...args: Array<unknown>) => void;
  return Effect.acquireRelease(
    Effect.sync(() => {
      eventTarget.on(eventName, untypedListener);
    }),
    () =>
      Effect.sync(() => {
        eventTarget.removeListener(eventName, untypedListener);
      }),
  ).pipe(Effect.asVoid);
}

const requestDesktopShutdownAndWait = Effect.fn("desktop.lifecycle.requestShutdownAndWait")(
  function* (): Effect.fn.Return<
    void,
    never,
    DesktopShutdown.DesktopShutdown | DesktopWindow.DesktopWindow
  > {
    const shutdown = yield* DesktopShutdown.DesktopShutdown;
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    yield* desktopWindow.flushMainWindowBounds;
    yield* shutdown.request;
    yield* shutdown.awaitComplete;
  },
);

const notifyIntentionalShutdown = Effect.gen(function* () {
  const failures = yield* Effect.sync(() =>
    sendIntentionalShutdownToLiveWindows(
      Electron.BrowserWindow.getAllWindows(),
      INTENTIONAL_SHUTDOWN_CHANNEL,
    ),
  );
  if (failures.length > 0) {
    yield* logLifecycleWarning("intentional shutdown overlay skipped a closing window", {
      failureCount: failures.length,
      error: failures[0],
    });
  }
  // Give Chromium one frame to paint the overlay before backend and socket
  // teardown begins. This delay happens only during an intentional quit.
  yield* Effect.sleep(INTENTIONAL_SHUTDOWN_PAINT_DELAY_MS);
});

function handleBeforeQuit(
  event: Electron.Event,
  runDetached: <A, E>(
    action: string,
    effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>,
    onSettled?: () => void,
  ) => void,
  allowQuit: () => boolean,
  markQuitAllowed: () => void,
): void {
  if (allowQuit()) {
    runDetached(
      "before-quit-allowed",
      Effect.gen(function* () {
        const state = yield* DesktopState.DesktopState;
        yield* Ref.set(state.quitting, true);
        yield* logLifecycleInfo("before-quit received");
      }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    );
    return;
  }

  event.preventDefault();
  runDetached(
    "before-quit-shutdown",
    Effect.gen(function* () {
      const state = yield* DesktopState.DesktopState;
      yield* Ref.set(state.quitting, true);
      yield* logLifecycleInfo("before-quit received");
      yield* notifyIntentionalShutdown;
      yield* requestDesktopShutdownAndWait();
    }).pipe(Effect.withSpan("desktop.lifecycle.beforeQuit")),
    () => {
      markQuitAllowed();
      runDetached(
        "quit-after-shutdown",
        Effect.gen(function* () {
          const electronApp = yield* ElectronApp.ElectronApp;
          yield* electronApp.quit;
        }).pipe(Effect.withSpan("desktop.lifecycle.quitAfterShutdown")),
      );
    },
  );
}

function quitFromSignal(
  signal: "SIGINT" | "SIGTERM",
  runDetached: <A, E>(
    action: string,
    effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>,
  ) => void,
): void {
  runDetached(
    `process-${signal.toLowerCase()}`,
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({ signal });
      const electronApp = yield* ElectronApp.ElectronApp;
      const state = yield* DesktopState.DesktopState;
      const wasQuitting = yield* Ref.getAndSet(state.quitting, true);
      if (wasQuitting) return;
      yield* logLifecycleInfo("process signal received", { signal });
      yield* notifyIntentionalShutdown;
      yield* requestDesktopShutdownAndWait();
      yield* electronApp.quit;
    }).pipe(Effect.withSpan("desktop.lifecycle.processSignal")),
  );
}

export const make = DesktopLifecycle.of({
  relaunch: Effect.fn("desktop.lifecycle.relaunch")(function* (reason) {
    const electronApp = yield* ElectronApp.ElectronApp;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const state = yield* DesktopState.DesktopState;
    yield* logLifecycleInfo("desktop relaunch requested", { reason });
    yield* Effect.gen(function* () {
      yield* Effect.yieldNow;
      yield* Ref.set(state.quitting, true);
      if (!environment.isDevelopment) {
        // Register the replacement before teardown starts. Electron launches it
        // only after this process exits, and a bounded teardown below prevents
        // a stuck provider from silently losing the restart request.
        yield* electronApp.relaunch({
          execPath: process.execPath,
          args: [...withDesktopRelaunchArguments(process.argv.slice(1))],
        });
      }
      yield* notifyIntentionalShutdown;
      const shutdownCompleted = yield* requestDesktopShutdownAndWait().pipe(
        Effect.timeoutOption(DESKTOP_RELAUNCH_SHUTDOWN_TIMEOUT),
      );
      if (Option.isNone(shutdownCompleted)) {
        yield* logLifecycleWarning("desktop relaunch teardown reached its deadline", {
          reason,
          timeoutMs: Duration.toMillis(DESKTOP_RELAUNCH_SHUTDOWN_TIMEOUT),
        });
      }
      if (environment.isDevelopment) {
        yield* electronApp.exit(75);
        return;
      }
      yield* electronApp.exit(0);
    }).pipe(
      Effect.catchCause((cause) => {
        const error = new DesktopLifecycleRelaunchError({ reason, cause });
        return logLifecycleError(error.message, { error });
      }),
      Effect.forkDetach,
      Effect.asVoid,
    );
  }),
  register: Effect.gen(function* () {
    const desktopWindow = yield* DesktopWindow.DesktopWindow;
    const electronApp = yield* ElectronApp.ElectronApp;
    const electronTheme = yield* ElectronTheme.ElectronTheme;
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    const context = yield* Effect.context<DesktopLifecycleRuntimeServices>();
    const runEffect = Effect.runPromiseWith(context);
    const runDetached = <A, E>(
      action: string,
      effect: Effect.Effect<A, E, DesktopLifecycleRuntimeServices>,
      onSettled?: () => void,
    ): void => {
      const observedEffect = effect.pipe(
        Effect.catchCause((cause) => {
          const error = new DesktopLifecycleDetachedActionError({ action, cause });
          return logLifecycleError(error.message, { error });
        }),
      );
      observeDetachedPromise(runEffect(observedEffect), onSettled);
    };
    let quitAllowed = false;
    let windowCloseQuitRequested = false;
    // Windows are created hidden and revealed on `ready-to-show`. A window that
    // never got that far was never on a screen, so its close is not the user
    // asking to quit - see shouldInterceptWindowCloseForQuit.
    let anyWindowRevealed = false;
    yield* electronTheme.onUpdated(() => {
      runDetached(
        "theme-updated",
        desktopWindow.syncAppearance.pipe(Effect.withSpan("desktop.lifecycle.themeUpdated")),
      );
    });
    yield* electronApp.on("before-quit", (event: Electron.Event) => {
      handleBeforeQuit(
        event,
        runDetached,
        () => quitAllowed,
        () => {
          quitAllowed = true;
        },
      );
    });
    yield* electronApp.on(
      "browser-window-created",
      (_event: Electron.Event, window: Electron.BrowserWindow) => {
        if (window.isVisible()) {
          anyWindowRevealed = true;
        }
        window.on("show", () => {
          anyWindowRevealed = true;
        });
        window.on("close", (closeEvent) => {
          if (
            !shouldInterceptWindowCloseForQuit({
              platform: environment.platform,
              quitAllowed,
              quitAlreadyRequested: windowCloseQuitRequested,
              windowEverRevealed: anyWindowRevealed,
            })
          ) {
            return;
          }
          closeEvent.preventDefault();
          windowCloseQuitRequested = true;
          runDetached("window-close-quit", electronApp.quit);
        });
      },
    );
    yield* electronApp.on("activate", () => {
      runDetached(
        "activate",
        desktopWindow.activate.pipe(Effect.withSpan("desktop.lifecycle.activate")),
      );
    });
    yield* electronApp.on("window-all-closed", () => {
      runDetached(
        "window-all-closed",
        Effect.gen(function* () {
          const app = yield* ElectronApp.ElectronApp;
          const state = yield* DesktopState.DesktopState;
          // Same reasoning as the close handler: if no window was ever shown,
          // the app is running without a usable display rather than having been
          // closed, and the backend should keep serving.
          if (
            anyWindowRevealed &&
            environment.platform !== "darwin" &&
            !(yield* Ref.get(state.quitting))
          ) {
            yield* app.quit;
          }
        }).pipe(Effect.withSpan("desktop.lifecycle.windowAllClosed")),
      );
    });

    if (environment.platform !== "win32") {
      yield* addScopedListener(process, "SIGINT", () => {
        quitFromSignal("SIGINT", runDetached);
      });
      yield* addScopedListener(process, "SIGTERM", () => {
        quitFromSignal("SIGTERM", runDetached);
      });
    }
  }).pipe(Effect.withSpan("desktop.lifecycle.register")),
});

export const layer = Layer.succeed(DesktopLifecycle, make);
