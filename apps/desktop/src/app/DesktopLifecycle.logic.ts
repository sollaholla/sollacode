export function shouldInterceptWindowCloseForQuit(input: {
  readonly platform: NodeJS.Platform;
  readonly quitAllowed: boolean;
  readonly quitAlreadyRequested: boolean;
}): boolean {
  return input.platform !== "darwin" && !input.quitAllowed && !input.quitAlreadyRequested;
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
