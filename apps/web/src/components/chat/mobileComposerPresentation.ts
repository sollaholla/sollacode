export type MobileComposerVoiceStatus = "recording" | "loading" | "transcribing" | null;

export function shouldSendComposerWhileProcessing(input: {
  readonly isProcessing: boolean;
  readonly hasCurrentEditorText: boolean;
}): boolean {
  return input.isProcessing && input.hasCurrentEditorText;
}

export function shouldCollapseMobileComposer(input: {
  readonly isMobileViewport: boolean;
  readonly isPortraitViewport: boolean;
  readonly routeKind: "server" | "draft";
  readonly forceExpandedOnMobile: boolean;
  readonly isComposerFocused: boolean;
  readonly voiceStatus: MobileComposerVoiceStatus;
}): boolean {
  if (!input.isMobileViewport || input.forceExpandedOnMobile) {
    return false;
  }

  // A phone thread uses one persistent composer in portrait. The compact
  // launcher required a first tap to mount the editor and a second tap to
  // focus it, and blur during microphone startup could unmount the recorder
  // controls. Draft/new-thread and landscape behavior remain unchanged.
  if (input.routeKind === "server" && input.isPortraitViewport) {
    return false;
  }

  // Starting capture, recording, and transcription must never cause the
  // responsive composer surface to collapse or unmount.
  if (input.voiceStatus !== null) {
    return false;
  }

  return !input.isComposerFocused;
}
