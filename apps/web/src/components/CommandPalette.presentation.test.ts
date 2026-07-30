import { describe, expect, it } from "vite-plus/test";

import { shouldShowCommandPaletteKeybindingLegend } from "./CommandPalette.presentation";

describe("command palette keybinding legend presentation", () => {
  it("hides the physical-keyboard legend in portrait and touch layouts", () => {
    expect(
      shouldShowCommandPaletteKeybindingLegend({
        isNarrowViewport: true,
        hasCoarsePointer: false,
      }),
    ).toBe(false);
    expect(
      shouldShowCommandPaletteKeybindingLegend({
        isNarrowViewport: false,
        hasCoarsePointer: true,
      }),
    ).toBe(false);
  });

  it("keeps the legend on wide desktop keyboard layouts", () => {
    expect(
      shouldShowCommandPaletteKeybindingLegend({
        isNarrowViewport: false,
        hasCoarsePointer: false,
      }),
    ).toBe(true);
  });
});
