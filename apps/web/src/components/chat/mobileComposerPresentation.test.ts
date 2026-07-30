import { describe, expect, it } from "vite-plus/test";

import {
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

  it("does not force Send when the agent is idle", () => {
    expect(
      shouldSendComposerWhileProcessing({
        isProcessing: false,
        hasCurrentEditorText: true,
      }),
    ).toBe(false);
  });
});
