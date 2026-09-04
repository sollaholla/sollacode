export type MobileComposerVoiceStatus =
  | "recording"
  | "loading"
  | "transcribing"
  | "refining"
  | null;

export function shouldSendComposerWhileProcessing(input: {
  readonly isProcessing: boolean;
  readonly hasCurrentEditorText: boolean;
  readonly hasPendingComposerContent?: boolean;
}): boolean {
  return (
    input.isProcessing && (input.hasCurrentEditorText || input.hasPendingComposerContent === true)
  );
}

export function resolveProcessingComposerEnterAction(input: {
  readonly hasQueuedMessages: boolean;
  readonly hasCurrentSendableContent: boolean;
  readonly queuedPromotionDisabled: boolean;
}): "promote-queued" | "submit-draft" | null {
  if (!input.hasQueuedMessages || input.hasCurrentSendableContent) return "submit-draft";
  return input.queuedPromotionDisabled ? null : "promote-queued";
}

export function shouldCollapseMobileComposer(input: {
  readonly isMobileViewport: boolean;
  readonly isPortraitViewport: boolean;
  readonly routeKind: "server" | "draft";
  readonly forceExpandedOnMobile: boolean;
  readonly isComposerFocused: boolean;
  readonly voiceStatus: MobileComposerVoiceStatus;
  /** The reader swiped the composer down to put it away. */
  readonly swipeDismissed: boolean;
}): boolean {
  if (!input.isMobileViewport || input.forceExpandedOnMobile) {
    return false;
  }

  // Starting capture, recording, and transcription must never cause the
  // responsive composer surface to collapse or unmount.
  if (input.voiceStatus !== null) {
    return false;
  }

  // An explicit swipe collapses even where the composer is otherwise kept
  // permanently open. The always-expanded rule below exists to stop an
  // AUTOMATIC collapse-on-blur from costing a second tap to get back in; a
  // deliberate downward gesture is the opposite of that, and honouring it is
  // the difference between the swipe collapsing the composer and the swipe
  // appearing to do nothing at all on the one layout most phones are in.
  if (input.swipeDismissed) {
    return true;
  }

  // A phone thread uses one persistent composer in portrait. The compact
  // launcher required a first tap to mount the editor and a second tap to
  // focus it, and blur during microphone startup could unmount the recorder
  // controls. Draft/new-thread and landscape behavior remain unchanged.
  if (input.routeKind === "server" && input.isPortraitViewport) {
    return false;
  }

  return !input.isComposerFocused;
}
