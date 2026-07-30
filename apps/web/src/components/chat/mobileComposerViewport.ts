const PHONE_KEYBOARD_MINIMUM_INSET = 80;

export function visualViewportBottomInset(input: {
  readonly layoutViewportBottom: number;
  readonly visualViewportHeight: number;
  readonly visualViewportOffsetTop: number;
}): number {
  return Math.max(
    0,
    Math.round(
      input.layoutViewportBottom - (input.visualViewportOffsetTop + input.visualViewportHeight),
    ),
  );
}

export function resolvePhoneKeyboardInset(input: {
  readonly paneBottom: number;
  readonly visualViewportHeight: number;
  readonly visualViewportOffsetTop: number;
  readonly composerFocused: boolean;
  readonly currentInset: number;
}): number {
  if (!input.composerFocused) {
    return 0;
  }

  const inset = visualViewportBottomInset({
    layoutViewportBottom: input.paneBottom,
    visualViewportHeight: input.visualViewportHeight,
    visualViewportOffsetTop: input.visualViewportOffsetTop,
  });
  return inset >= PHONE_KEYBOARD_MINIMUM_INSET ? inset : 0;
}

export function composerViewportBottomInset(input: {
  readonly composerHeight: number;
  readonly keyboardInset: number;
}): number {
  // Floating overlays such as the preview mini-player still need the complete
  // footer stack plus the keyboard edge. The timeline itself does not use this
  // value because the active-chat footer participates in flex layout.
  return Math.max(0, input.composerHeight) + Math.max(0, input.keyboardInset);
}

export type ChatFooterLayoutMode = "draft-hero-overlay" | "draft-docked-overlay" | "flow";

export interface ChatFooterLayout {
  readonly mode: ChatFooterLayoutMode;
  readonly timelineEndInset: 0;
  readonly bottomOffset: number;
  readonly marginBottom: number;
}

export function resolveChatFooterLayout(input: {
  readonly isDraftHeroState: boolean;
  readonly dockPhoneDraftComposer: boolean;
  readonly keyboardInset: number;
}): ChatFooterLayout {
  const keyboardInset = Math.max(0, input.keyboardInset);
  if (!input.isDraftHeroState) {
    return {
      mode: "flow",
      timelineEndInset: 0,
      bottomOffset: 0,
      marginBottom: keyboardInset,
    };
  }

  if (input.dockPhoneDraftComposer) {
    return {
      mode: "draft-docked-overlay",
      timelineEndInset: 0,
      bottomOffset: keyboardInset,
      marginBottom: 0,
    };
  }

  return {
    mode: "draft-hero-overlay",
    timelineEndInset: 0,
    bottomOffset: 0,
    marginBottom: 0,
  };
}

export function shouldFollowTimelineEndAfterFooterResize(input: {
  readonly layoutMode: ChatFooterLayoutMode;
  readonly liveFollowEnabled: boolean;
  readonly previousOccupiedHeight: number | null;
  readonly nextOccupiedHeight: number;
}): boolean {
  return (
    input.layoutMode === "flow" &&
    input.liveFollowEnabled &&
    input.previousOccupiedHeight !== null &&
    input.previousOccupiedHeight !== input.nextOccupiedHeight
  );
}

export function shouldDismissMobileKeyboardOnSubmit(input: {
  readonly isMobileViewport: boolean;
  readonly submitBlocked: boolean;
  readonly hasSubmitAction: boolean;
}): boolean {
  return input.isMobileViewport && !input.submitBlocked && input.hasSubmitAction;
}

export function shouldDockPhoneDraftComposer(input: {
  readonly isDraftHeroState: boolean;
  readonly isPhonePortrait: boolean;
  readonly isComposerFocused: boolean;
}): boolean {
  return !input.isDraftHeroState || (input.isPhonePortrait && input.isComposerFocused);
}
