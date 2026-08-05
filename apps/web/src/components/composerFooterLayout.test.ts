import { describe, expect, it } from "vite-plus/test";

import {
  COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX,
  COMPOSER_FOOTER_OVERFLOW_BREAKPOINT_PX,
  COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX,
  COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX,
  resolveComposerFooterLayoutMode,
  shouldUseCompactComposerPrimaryActions,
} from "./composerFooterLayout";

describe("resolveComposerFooterLayoutMode", () => {
  it("stays fully labelled without a measured width", () => {
    expect(resolveComposerFooterLayoutMode(null)).toBe("full");
  });

  it("uses icons before resorting to the overflow menu", () => {
    expect(resolveComposerFooterLayoutMode(COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX - 1)).toBe(
      "icons",
    );
    expect(resolveComposerFooterLayoutMode(COMPOSER_FOOTER_OVERFLOW_BREAKPOINT_PX)).toBe("icons");
    expect(resolveComposerFooterLayoutMode(COMPOSER_FOOTER_OVERFLOW_BREAKPOINT_PX - 1)).toBe(
      "overflow",
    );
  });

  it("keeps full labels at and above the icon-only breakpoint", () => {
    expect(resolveComposerFooterLayoutMode(COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX)).toBe("full");
    expect(resolveComposerFooterLayoutMode(COMPOSER_FOOTER_ICON_ONLY_BREAKPOINT_PX + 48)).toBe(
      "full",
    );
  });

  it("uses the intermediate icon layout before full labels can clip", () => {
    expect(resolveComposerFooterLayoutMode(800)).toBe("icons");
    expect(resolveComposerFooterLayoutMode(960, { hasWideActions: true })).toBe("icons");
  });

  it("enters icon mode earlier when the primary actions are wide", () => {
    expect(
      resolveComposerFooterLayoutMode(COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe("icons");
    expect(
      resolveComposerFooterLayoutMode(COMPOSER_FOOTER_WIDE_ACTIONS_ICON_ONLY_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe("full");
  });
});

describe("shouldUseCompactComposerPrimaryActions", () => {
  it("compacts wide primary actions independently of the overflow menu", () => {
    expect(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX).toBeGreaterThan(
      COMPOSER_FOOTER_OVERFLOW_BREAKPOINT_PX,
    );
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX - 1, {
        hasWideActions: true,
      }),
    ).toBe(true);
    expect(
      shouldUseCompactComposerPrimaryActions(COMPOSER_PRIMARY_ACTIONS_COMPACT_BREAKPOINT_PX, {
        hasWideActions: true,
      }),
    ).toBe(false);
  });
});
