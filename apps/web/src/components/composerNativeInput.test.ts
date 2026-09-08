import { describe, expect, it } from "vite-plus/test";

import { INLINE_TERMINAL_CONTEXT_PLACEHOLDER } from "~/lib/terminalContext";
import {
  composerPromptToNativeText,
  mergeNativeComposerText,
  nativeComposerOffsetToPromptOffset,
  promptOffsetToNativeComposerOffset,
  shouldUseNativeIOSComposer,
} from "./composerNativeInput";

describe("shouldUseNativeIOSComposer", () => {
  it("uses the native editor for iPhone Safari", () => {
    expect(
      shouldUseNativeIOSComposer({
        userAgent:
          "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Version/18.6 Safari/604.1",
        platform: "iPhone",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it("recognises iPadOS desktop-site user agents", () => {
    expect(
      shouldUseNativeIOSComposer({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 5,
      }),
    ).toBe(true);
  });

  it("keeps desktop Safari and Android on the rich editor", () => {
    expect(
      shouldUseNativeIOSComposer({
        userAgent:
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15) AppleWebKit/605.1.15 Version/18.0 Safari/605.1.15",
        platform: "MacIntel",
        maxTouchPoints: 0,
      }),
    ).toBe(false);
    expect(
      shouldUseNativeIOSComposer({
        userAgent: "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/140 Mobile",
        platform: "Linux armv8l",
        maxTouchPoints: 5,
      }),
    ).toBe(false);
  });
});

describe("native composer prompt projection", () => {
  const chip = INLINE_TERMINAL_CONTEXT_PLACEHOLDER;

  it("hides terminal placeholders while preserving offset conversions", () => {
    const prompt = `${chip}hello ${chip}world`;
    expect(composerPromptToNativeText(prompt)).toBe("hello world");
    expect(nativeComposerOffsetToPromptOffset(prompt, 0)).toBe(1);
    expect(nativeComposerOffsetToPromptOffset(prompt, 6)).toBe(8);
    expect(promptOffsetToNativeComposerOffset(prompt, 8)).toBe(6);
  });

  it("projects a dictation final-pass replacement atomically", () => {
    expect(
      mergeNativeComposerText("schedule the meting tomorrow", "schedule the meeting tomorrow"),
    ).toBe("schedule the meeting tomorrow");
  });

  it("preserves hidden terminal contexts through insertions and deletions", () => {
    const inserted = mergeNativeComposerText(`${chip}hello ${chip}world`, "hello brave world");
    expect(composerPromptToNativeText(inserted)).toBe("hello brave world");
    expect(inserted.split(chip)).toHaveLength(3);

    const deleted = mergeNativeComposerText(`hello ${chip}brave world`, "hello world");
    expect(composerPromptToNativeText(deleted)).toBe("hello world");
    expect(deleted.split(chip)).toHaveLength(2);
  });

  it("preserves every context when all visible text is replaced or cleared", () => {
    const replaced = mergeNativeComposerText(`${chip}old ${chip}text`, "new text");
    expect(composerPromptToNativeText(replaced)).toBe("new text");
    expect(replaced.split(chip)).toHaveLength(3);

    const cleared = mergeNativeComposerText(`${chip}old ${chip}text`, "");
    expect(composerPromptToNativeText(cleared)).toBe("");
    expect(cleared).toBe(`${chip}${chip}`);
  });
});
