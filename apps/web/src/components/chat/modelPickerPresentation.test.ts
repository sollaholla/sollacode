import { describe, expect, it } from "vite-plus/test";

import { shouldUseFullScreenModelPicker } from "./modelPickerPresentation";

describe("model picker presentation", () => {
  it("uses the full-screen modal only in phone portrait", () => {
    expect(shouldUseFullScreenModelPicker({ isPhonePortrait: true })).toBe(true);
    expect(shouldUseFullScreenModelPicker({ isPhonePortrait: false })).toBe(false);
  });
});
