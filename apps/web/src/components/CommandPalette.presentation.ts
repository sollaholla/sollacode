export function shouldShowCommandPaletteKeybindingLegend(input: {
  readonly isNarrowViewport: boolean;
  readonly hasCoarsePointer: boolean;
}): boolean {
  return !input.isNarrowViewport && !input.hasCoarsePointer;
}
