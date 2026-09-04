import { describe, expect, it } from "vite-plus/test";

import {
  resolveProcessingComposerEnterAction,
  shouldCollapseMobileComposer,
  shouldSendComposerWhileProcessing,
} from "./mobileComposerPresentation";

const baseInput = {
  isMobileViewport: true,
  isPortraitViewport: true,
  routeKind: "server" as const,
  forceExpandedOnMobile: false,
  isComposerFocused: false,
  voiceStatus: null,
  swipeDismissed: false,
};

describe("mobile composer presentation", () => {
  it("mounts the real thread composer directly in phone portrait", () => {
    expect(shouldCollapseMobileComposer(baseInput)).toBe(false);
  });

  it("stays expanded through portrait virtual-keyboard height transitions", () => {
    // The decision intentionally depends on orientation, not visual viewport
    // height, which changes as the phone keyboard opens and closes.
    expect(shouldCollapseMobileComposer(baseInput)).toBe(false);
    expect(
      shouldCollapseMobileComposer({
        ...baseInput,
        isComposerFocused: true,
      }),
    ).toBe(false);
  });

  it("retains the existing compact landscape behavior until focused", () => {
    expect(
      shouldCollapseMobileComposer({
        ...baseInput,
        isPortraitViewport: false,
      }),
    ).toBe(true);
    expect(
      shouldCollapseMobileComposer({
        ...baseInput,
        isPortraitViewport: false,
        isComposerFocused: true,
      }),
    ).toBe(false);
  });

  it.each(["loading", "recording", "transcribing"] as const)(
    "never collapses or unmounts during voice status %s",
    (voiceStatus) => {
      expect(
        shouldCollapseMobileComposer({
          ...baseInput,
          isPortraitViewport: false,
          isComposerFocused: false,
          voiceStatus,
        }),
      ).toBe(false);
    },
  );

  it("preserves draft/new-thread and desktop behavior", () => {
    expect(
      shouldCollapseMobileComposer({
        ...baseInput,
        routeKind: "draft",
      }),
    ).toBe(true);
    expect(
      shouldCollapseMobileComposer({
        ...baseInput,
        isMobileViewport: false,
      }),
    ).toBe(false);
  });
});

describe("processing composer primary action", () => {
  it.each(["narrow portrait", "wide landscape/tablet", "desktop"])(
    "shows Send for current editor text on %s",
    () => {
      expect(
        shouldSendComposerWhileProcessing({
          isProcessing: true,
          hasCurrentEditorText: true,
        }),
      ).toBe(true);
    },
  );

  it("keeps Stop when the editor is empty or whitespace-only", () => {
    expect(
      shouldSendComposerWhileProcessing({
        isProcessing: true,
        hasCurrentEditorText: false,
      }),
    ).toBe(false);
  });

  it("shows Send for an attachment-only draft while the agent is processing", () => {
    expect(
      shouldSendComposerWhileProcessing({
        isProcessing: true,
        hasCurrentEditorText: false,
        hasPendingComposerContent: true,
      }),
    ).toBe(true);
  });

  it("does not force Send when the agent is idle", () => {
    expect(
      shouldSendComposerWhileProcessing({
        isProcessing: false,
        hasCurrentEditorText: true,
      }),
    ).toBe(false);
  });
});

describe("processing composer Enter action", () => {
  it("promotes the existing queue when the running composer is empty", () => {
    expect(
      resolveProcessingComposerEnterAction({
        hasQueuedMessages: true,
        hasCurrentSendableContent: false,
        queuedPromotionDisabled: false,
      }),
    ).toBe("promote-queued");
  });

  it("submits a new draft without conflating it with queued promotion", () => {
    expect(
      resolveProcessingComposerEnterAction({
        hasQueuedMessages: true,
        hasCurrentSendableContent: true,
        queuedPromotionDisabled: false,
      }),
    ).toBe("submit-draft");
  });

  it("submits normally when there is no queue", () => {
    expect(
      resolveProcessingComposerEnterAction({
        hasQueuedMessages: false,
        hasCurrentSendableContent: true,
        queuedPromotionDisabled: false,
      }),
    ).toBe("submit-draft");
  });

  it("does not dispatch a second promotion while the first is busy", () => {
    expect(
      resolveProcessingComposerEnterAction({
        hasQueuedMessages: true,
        hasCurrentSendableContent: false,
        queuedPromotionDisabled: true,
      }),
    ).toBeNull();
  });
});

describe("swipe down to put the composer away", () => {
  it("collapses a portrait thread composer, which nothing else does", () => {
    // The always-expanded rule for phone threads is what made the gesture look
    // broken: it dismissed the keyboard and left the composer exactly as it
    // was, on the one layout most phones are held in.
    expect(shouldCollapseMobileComposer({ ...baseInput, swipeDismissed: true })).toBe(true);
  });

  it("collapses a focused composer, keyboard and all", () => {
    expect(
      shouldCollapseMobileComposer({
        ...baseInput,
        isComposerFocused: true,
        swipeDismissed: true,
      }),
    ).toBe(true);
  });

  it("never wins over live voice capture", () => {
    // Collapsing here unmounts the recorder controls mid-take.
    expect(
      shouldCollapseMobileComposer({
        ...baseInput,
        voiceStatus: "recording",
        swipeDismissed: true,
      }),
    ).toBe(false);
  });

  it("never wins over an explicit force-expanded surface", () => {
    expect(
      shouldCollapseMobileComposer({
        ...baseInput,
        forceExpandedOnMobile: true,
        swipeDismissed: true,
      }),
    ).toBe(false);
  });

  it("leaves every existing case alone while unset", () => {
    expect(shouldCollapseMobileComposer(baseInput)).toBe(false);
    expect(shouldCollapseMobileComposer({ ...baseInput, isPortraitViewport: false })).toBe(true);
  });
});
