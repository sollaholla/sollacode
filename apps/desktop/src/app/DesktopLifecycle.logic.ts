export function shouldInterceptWindowCloseForQuit(input: {
  readonly platform: NodeJS.Platform;
  readonly quitAllowed: boolean;
  readonly quitAlreadyRequested: boolean;
  /**
   * Whether the closing window is an auxiliary surface - the "Connecting to
   * WSL" splash or the floating voice orb - rather than the app's own window.
   */
  readonly windowIsAuxiliary: boolean;
}): boolean {
  // Dismissing an auxiliary window is not the user asking to quit. The splash
  // is taken down with an ordinary `close()` the moment the real main window
  // reveals, so on Windows - where closing the app's window does quit - a
  // WSL-only boot killed the process about 140ms after the backend had come up
  // and started answering requests. That machine is reached over the network
  // from a phone, so tearing the server down was the worst possible response to
  // the app finishing its own startup.
  if (input.windowIsAuxiliary) return false;
  return input.platform !== "darwin" && !input.quitAllowed && !input.quitAlreadyRequested;
}

/**
 * Electron event handlers cannot await application effects. Observe the
 * detached promise all the way through its completion callback so a rejected
 * shutdown effect (or callback) never becomes a main-process unhandled
 * rejection dialog.
 */
export function observeDetachedPromise(promise: Promise<unknown>, onSettled?: () => void): void {
  void promise
    .then(
      () => onSettled?.(),
      () => onSettled?.(),
    )
    .catch(() => undefined);
}

interface IntentionalShutdownWindow {
  readonly isDestroyed: () => boolean;
  readonly webContents: {
    readonly isDestroyed: () => boolean;
    readonly send: (channel: string) => void;
  };
}

/**
 * Windows can disappear between BrowserWindow enumeration and WebContents
 * delivery while Electron is quitting. A best-effort paint notification must
 * never abort the actual shutdown.
 */
export function sendIntentionalShutdownToLiveWindows(
  windows: ReadonlyArray<IntentionalShutdownWindow>,
  channel: string,
): ReadonlyArray<unknown> {
  const failures: Array<unknown> = [];
  for (const window of windows) {
    try {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      window.webContents.send(channel);
    } catch (error) {
      failures.push(error);
    }
  }
  return failures;
}

const AUTO_RESUME_ARGUMENT = "--auto-resume";

/**
 * A desktop relaunch can interrupt a provider while the backend drains. Carry
 * the recovery signal into the replacement process, but never duplicate it
 * when the current launch was itself an auto-resume.
 */
export function withDesktopRelaunchArguments(argv: readonly string[]): readonly string[] {
  return argv.includes(AUTO_RESUME_ARGUMENT) ? argv : [...argv, AUTO_RESUME_ARGUMENT];
}
