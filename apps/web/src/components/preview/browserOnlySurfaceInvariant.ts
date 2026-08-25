export function shouldEnsureBrowserOnlySurface(input: {
  readonly browserOnly: boolean;
  readonly browserAvailable: boolean;
  readonly panelOpen: boolean;
  readonly surfaceCount: number;
}): boolean {
  return input.browserOnly && input.browserAvailable && input.panelOpen && input.surfaceCount === 0;
}
