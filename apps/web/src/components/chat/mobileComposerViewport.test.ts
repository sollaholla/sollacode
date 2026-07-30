import { describe, expect, it } from "vite-plus/test";

import {
  composerViewportBottomInset,
  resolveChatFooterLayout,
  resolvePhoneKeyboardInset,
  shouldDockPhoneDraftComposer,
  shouldDismissMobileKeyboardOnSubmit,
  shouldFollowTimelineEndAfterFooterResize,
  visualViewportBottomInset,
} from "./mobileComposerViewport";

describe("phone portrait composer viewport", () => {
  it("leaves an untouched new-chat hero unfocused and undocked", () => {
    expect(
      shouldDockPhoneDraftComposer({
        isDraftHeroState: true,
        isPhonePortrait: true,
        isComposerFocused: false,
      }),
    ).toBe(false);
  });

  it("docks the draft composer after explicit focus", () => {
    expect(
      shouldDockPhoneDraftComposer({
        isDraftHeroState: true,
        isPhonePortrait: true,
        isComposerFocused: true,
      }),
    ).toBe(true);
  });

  it("tracks the keyboard edge including visual viewport offset", () => {
    expect(
      visualViewportBottomInset({
        layoutViewportBottom: 844,
        visualViewportHeight: 500,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(344);
    expect(
      visualViewportBottomInset({
        layoutViewportBottom: 844,
        visualViewportHeight: 480,
        visualViewportOffsetTop: 24,
      }),
    ).toBe(340);
  });

  it("never returns a negative settled inset", () => {
    expect(
      visualViewportBottomInset({
        layoutViewportBottom: 500,
        visualViewportHeight: 520,
        visualViewportOffsetTop: 0,
      }),
    ).toBe(0);
  });

  it("does not double-offset a pane that already ends at the visible keyboard edge", () => {
    expect(
      resolvePhoneKeyboardInset({
        paneBottom: 500,
        visualViewportHeight: 500,
        visualViewportOffsetTop: 0,
        composerFocused: true,
        currentInset: 0,
      }),
    ).toBe(0);
  });

  it("clears keyboard reservation immediately after composer blur", () => {
    expect(
      resolvePhoneKeyboardInset({
        paneBottom: 844,
        visualViewportHeight: 500,
        visualViewportOffsetTop: 0,
        composerFocused: false,
        currentInset: 344,
      }),
    ).toBe(0);
    expect(
      resolvePhoneKeyboardInset({
        paneBottom: 844,
        visualViewportHeight: 800,
        visualViewportOffsetTop: 0,
        composerFocused: false,
        currentInset: 344,
      }),
    ).toBe(0);
    expect(
      resolvePhoneKeyboardInset({
        paneBottom: 844,
        visualViewportHeight: 800,
        visualViewportOffsetTop: 0,
        composerFocused: false,
        currentInset: 0,
      }),
    ).toBe(0);
  });

  it("reserves the keyboard and composer together for floating overlays", () => {
    expect(
      composerViewportBottomInset({
        composerHeight: 132,
        keyboardInset: 344,
      }),
    ).toBe(476);
    expect(
      composerViewportBottomInset({
        composerHeight: 132,
        keyboardInset: 0,
      }),
    ).toBe(132);
  });

  it("adds the complete measured footer stack to the keyboard exactly once", () => {
    const providerUsageHeight = 54;
    const providerUsageGap = 4;
    const composerAndSafeAreaHeight = 132;

    expect(
      composerViewportBottomInset({
        composerHeight: providerUsageHeight + providerUsageGap + composerAndSafeAreaHeight,
        keyboardInset: 344,
      }),
    ).toBe(534);
  });

  it("keeps active-chat footer sizing in flow with no synthetic timeline inset", () => {
    expect(
      resolveChatFooterLayout({
        isDraftHeroState: false,
        dockPhoneDraftComposer: true,
        keyboardInset: 344,
      }),
    ).toEqual({
      mode: "flow",
      timelineEndInset: 0,
      bottomOffset: 0,
      marginBottom: 344,
    });
  });

  it("uses the keyboard edge once while draft overlays remain out of flow", () => {
    expect(
      resolveChatFooterLayout({
        isDraftHeroState: true,
        dockPhoneDraftComposer: true,
        keyboardInset: 344,
      }),
    ).toEqual({
      mode: "draft-docked-overlay",
      timelineEndInset: 0,
      bottomOffset: 344,
      marginBottom: 0,
    });
    expect(
      resolveChatFooterLayout({
        isDraftHeroState: true,
        dockPhoneDraftComposer: false,
        keyboardInset: 344,
      }),
    ).toEqual({
      mode: "draft-hero-overlay",
      timelineEndInset: 0,
      bottomOffset: 0,
      marginBottom: 0,
    });
  });

  it("does not retain or duplicate footer reservation across repeated height transitions", () => {
    const footerHeights = [132, 236, 236, 148, 132, 212, 132];
    const keyboardInsets = [0, 344, 0, 0, 280, 0, 0];

    const occupiedHeights = footerHeights.map((footerHeight, index) => {
      const layout = resolveChatFooterLayout({
        isDraftHeroState: false,
        dockPhoneDraftComposer: true,
        keyboardInset: keyboardInsets[index] ?? 0,
      });
      expect(layout.timelineEndInset).toBe(0);
      expect(layout.bottomOffset).toBe(0);
      return footerHeight + layout.marginBottom;
    });

    expect(occupiedHeights).toEqual([132, 580, 236, 148, 412, 212, 132]);
  });

  it("follows a resized flow footer only while timeline live-follow remains enabled", () => {
    expect(
      shouldFollowTimelineEndAfterFooterResize({
        layoutMode: "flow",
        liveFollowEnabled: true,
        previousOccupiedHeight: 132,
        nextOccupiedHeight: 476,
      }),
    ).toBe(true);
    expect(
      shouldFollowTimelineEndAfterFooterResize({
        layoutMode: "flow",
        liveFollowEnabled: false,
        previousOccupiedHeight: 132,
        nextOccupiedHeight: 476,
      }),
    ).toBe(false);
  });

  it("does not scroll for the initial measurement, unchanged height, or draft overlays", () => {
    expect(
      shouldFollowTimelineEndAfterFooterResize({
        layoutMode: "flow",
        liveFollowEnabled: true,
        previousOccupiedHeight: null,
        nextOccupiedHeight: 132,
      }),
    ).toBe(false);
    expect(
      shouldFollowTimelineEndAfterFooterResize({
        layoutMode: "flow",
        liveFollowEnabled: true,
        previousOccupiedHeight: 132,
        nextOccupiedHeight: 132,
      }),
    ).toBe(false);
    expect(
      shouldFollowTimelineEndAfterFooterResize({
        layoutMode: "draft-docked-overlay",
        liveFollowEnabled: true,
        previousOccupiedHeight: 132,
        nextOccupiedHeight: 476,
      }),
    ).toBe(false);
  });

  it("dismisses the mobile keyboard only for a valid submit action", () => {
    expect(
      shouldDismissMobileKeyboardOnSubmit({
        isMobileViewport: true,
        submitBlocked: false,
        hasSubmitAction: true,
      }),
    ).toBe(true);
    expect(
      shouldDismissMobileKeyboardOnSubmit({
        isMobileViewport: false,
        submitBlocked: false,
        hasSubmitAction: true,
      }),
    ).toBe(false);
    expect(
      shouldDismissMobileKeyboardOnSubmit({
        isMobileViewport: true,
        submitBlocked: true,
        hasSubmitAction: true,
      }),
    ).toBe(false);
  });
});
