export function shouldOfferAppVoiceCapture(input: {
  readonly isDesktopElectron: boolean;
  readonly hasCoarsePointer: boolean;
  /**
   * The browser exposes its own speech recogniser, so a touch client can
   * dictate without the desktop bridge or a downloaded model. Without this the
   * microphone stays hidden on a phone, which leaves the OS keyboard's mic as
   * the only route - and that one edits the composer's DOM behind our back.
   */
  readonly hasNativeSpeechDictation?: boolean;
}): boolean {
  if (input.isDesktopElectron || !input.hasCoarsePointer) return true;
  return input.hasNativeSpeechDictation === true;
}
