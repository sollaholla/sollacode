export function shouldOfferAppVoiceCapture(input: {
  readonly isDesktopElectron: boolean;
  readonly hasCoarsePointer: boolean;
}): boolean {
  return input.isDesktopElectron || !input.hasCoarsePointer;
}
