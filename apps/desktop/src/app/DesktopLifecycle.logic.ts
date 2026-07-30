export function shouldInterceptWindowCloseForQuit(input: {
  readonly platform: NodeJS.Platform;
  readonly quitAllowed: boolean;
  readonly quitAlreadyRequested: boolean;
}): boolean {
  return input.platform !== "darwin" && !input.quitAllowed && !input.quitAlreadyRequested;
}
